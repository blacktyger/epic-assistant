/**
 * Bedrock Converse client, over plain fetch with a Bedrock API key.
 *
 * Verified facts this file depends on, all measured against the live account rather than read from
 * documentation:
 *
 * - The bearer token authorises `bedrock` and `bedrock-runtime`. It is refused by
 *   `bedrock-agent-runtime`, which is why there is no Knowledge Base or managed Rerank here.
 * - Every Anthropic model in eu-central-1 is inference-profile only. A bare model ID returns 400
 *   telling you to use a profile, so every id below carries the `eu.` prefix.
 * - Prompt cache TTL accepts exactly `5m` and `1h`; anything else is a validation error naming the
 *   enum. A 1-hour cache was still readable after 6.5 minutes.
 * - `bedrock:CountTokens` is denied for this credential, so token accounting comes from the `usage`
 *   block of a real response and never from a pre-flight count.
 */
import { iterateEventStream, BedrockStreamError } from './eventstream.mjs';
import { parseSecrets } from './secrets.mjs';

let cached = null;

/** Reads credentials from the workspace .secrets file, or the environment if already exported. */
export function loadCredentials(secretsPath) {
  if (cached) return cached;

  let token = process.env.AWS_BEARER_TOKEN_BEDROCK;
  let region = process.env.AWS_BEDROCK_REGION;

  if ((!token || !region) && secretsPath) {
    const parsed = parseSecrets(secretsPath);
    token = token || parsed.AWS_BEARER_TOKEN_BEDROCK;
    region = region || parsed.AWS_BEDROCK_REGION;
  }

  if (!token) throw new Error('AWS_BEARER_TOKEN_BEDROCK is not set and was not found in .secrets');
  cached = { token, region: region || 'eu-central-1' };
  return cached;
}

const endpoint = (region) => `https://bedrock-runtime.${region}.amazonaws.com`;

/**
 * Non-streaming Converse. Used by the evaluation harness, where a whole answer is wanted at once.
 */
export async function converse({ credentials, modelId, system, messages, maxTokens, temperature, toolConfig, signal }) {
  const res = await fetch(
    `${endpoint(credentials.region)}/model/${encodeURIComponent(modelId)}/converse`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credentials.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        system,
        messages,
        inferenceConfig: { maxTokens, temperature },
        ...(toolConfig ? { toolConfig } : {}),
      }),
      signal,
    },
  );

  const text = await res.text();
  if (!res.ok) throw await bedrockError(res, text);
  const json = JSON.parse(text);
  return {
    text: json.output?.message?.content?.map((c) => c.text).filter(Boolean).join('') ?? '',
    toolUse: json.output?.message?.content?.find((c) => c.toolUse)?.toolUse ?? null,
    stopReason: json.stopReason,
    usage: normaliseUsage(json.usage),
  };
}

/**
 * Streaming Converse. Yields, in arrival order:
 *
 *   {type: 'text', text}                              a text delta
 *   {type: 'toolUse', toolUseId, name, input}         a completed tool call request
 *   {type: 'done', stopReason, usage, content}        end of the turn
 *
 * `content` on the final event is the assistant message's content blocks, in their original order,
 * ready to be pushed back into `messages` for a follow-up turn. That is not a convenience: a tool
 * round trip requires replaying the assistant turn verbatim, and Bedrock rejects a `toolResult` whose
 * `toolUseId` was not present in the preceding assistant message. Reconstructing it from the text the
 * caller happened to keep would drop the tool blocks and fail.
 *
 * Tool arguments arrive as partial JSON split across `contentBlockDelta` events, so a block is only
 * parseable once its `contentBlockStop` lands. A tool call is therefore emitted at block close rather
 * than at block start, which is also the first moment it is safe to run.
 *
 * `signal` is forwarded into fetch, so aborting stops the HTTP request and therefore stops billing
 * for tokens nobody will read. That is the most commonly missed cost leak in streaming chat UIs and
 * the reason this function takes a signal rather than owning its own.
 */
export async function* converseStream({
  credentials, modelId, system, messages, maxTokens, temperature, toolConfig, signal,
}) {
  const res = await fetch(
    `${endpoint(credentials.region)}/model/${encodeURIComponent(modelId)}/converse-stream`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credentials.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        system,
        messages,
        inferenceConfig: { maxTokens, temperature },
        ...(toolConfig ? { toolConfig } : {}),
      }),
      signal,
    },
  );

  if (!res.ok) throw await bedrockError(res, await res.text());
  if (!res.body) throw new BedrockStreamError('no-body', 'response carried no stream');

  let stopReason = null;
  let usage = null;

  /**
   * Blocks under construction, keyed by index.
   *
   * Keyed rather than pushed to an array because `contentBlockIndex` is authoritative and the events
   * for two blocks may interleave. Assuming arrival order matches block order works right up until it
   * does not, and the failure is a tool call assembled from another block's argument fragments.
   */
  const open = new Map(); // index -> {kind, text} | {kind, toolUseId, name, json}
  const content = [];     // finished blocks, in index order

  for await (const event of iterateEventStream(res.body)) {
    switch (event.type) {
      case 'contentBlockStart': {
        const idx = event.body?.contentBlockIndex ?? 0;
        const tool = event.body?.start?.toolUse;
        if (tool) {
          open.set(idx, { kind: 'toolUse', toolUseId: tool.toolUseId, name: tool.name, json: '' });
        } else {
          open.set(idx, { kind: 'text', text: '' });
        }
        break;
      }

      case 'contentBlockDelta': {
        const idx = event.body?.contentBlockIndex ?? 0;
        // A text-only turn may carry no contentBlockStart at all, so a block is created on demand.
        let block = open.get(idx);
        const toolDelta = event.body?.delta?.toolUse?.input;
        const textDelta = event.body?.delta?.text;

        if (toolDelta !== undefined) {
          if (!block || block.kind !== 'toolUse') {
            block = { kind: 'toolUse', toolUseId: null, name: null, json: '' };
            open.set(idx, block);
          }
          block.json += toolDelta;
        } else if (textDelta) {
          if (!block) { block = { kind: 'text', text: '' }; open.set(idx, block); }
          block.text += textDelta;
          yield { type: 'text', text: textDelta };
        }
        break;
      }

      case 'contentBlockStop': {
        const idx = event.body?.contentBlockIndex ?? 0;
        const block = open.get(idx);
        open.delete(idx);
        if (!block) break;

        if (block.kind === 'text') {
          content[idx] = { text: block.text };
          break;
        }

        /*
         * An empty argument string means a tool with no parameters, which Bedrock sends as no delta at
         * all rather than as "{}". Treating that as a parse failure would break every no-argument tool,
         * which here is three of the eight.
         */
        let input = {};
        let parseError = null;
        if (block.json.trim()) {
          try {
            input = JSON.parse(block.json);
          } catch {
            parseError = `arguments were not valid JSON: ${block.json.slice(0, 200)}`;
          }
        }

        content[idx] = { toolUse: { toolUseId: block.toolUseId, name: block.name, input } };
        yield {
          type: 'toolUse',
          toolUseId: block.toolUseId,
          name: block.name,
          input,
          parseError,
        };
        break;
      }

      case 'messageStop':
        stopReason = event.body?.stopReason ?? null;
        break;

      case 'metadata':
        usage = normaliseUsage(event.body?.usage);
        break;

      // messageStart carries only the role, which is always assistant here.
      default:
        break;
    }
  }

  yield {
    type: 'done',
    stopReason,
    usage,
    // Sparse array positions are possible if a block index never closed; drop them rather than send
    // Bedrock a content array containing nulls, which it rejects.
    content: content.filter(Boolean),
  };
}

/**
 * Bedrock reports the same condition through several shapes depending on where it failed, so the
 * caller gets one classified error instead of three. `kind` drives the user-facing message: a
 * throttle is retryable and worth saying so, a validation failure is our bug and must not be
 * presented as "try again".
 */
async function bedrockError(res, text) {
  let message = text;
  try {
    const j = JSON.parse(text);
    message = j.message ?? j.Message ?? text;
  } catch { /* keep the raw body */ }

  const errType = res.headers.get('x-amzn-errortype') ?? '';
  let kind = 'unknown';
  if (res.status === 429 || /Throttling|TooManyRequests/i.test(errType)) kind = 'throttled';
  else if (res.status === 403 && /not available for this account/i.test(message)) kind = 'model-not-entitled';
  else if (res.status === 403) kind = 'forbidden';
  else if (res.status === 400 && /inference profile/i.test(message)) kind = 'needs-inference-profile';
  else if (res.status === 400) kind = 'validation';
  else if (res.status >= 500) kind = 'server';

  const err = new BedrockStreamError(kind, message.slice(0, 400));
  err.status = res.status;
  return err;
}

/**
 * Bedrock returns both `cacheReadInputTokens` and `cacheReadInputTokenCount` for the same quantity.
 * Normalised once here so cost accounting cannot silently read the field that happens to be absent.
 */
function normaliseUsage(u) {
  if (!u) return null;
  return {
    inputTokens: u.inputTokens ?? 0,
    outputTokens: u.outputTokens ?? 0,
    cacheReadInputTokens: u.cacheReadInputTokens ?? u.cacheReadInputTokenCount ?? 0,
    cacheWriteInputTokens: u.cacheWriteInputTokens ?? u.cacheWriteInputTokenCount ?? 0,
    totalTokens: u.totalTokens ?? 0,
  };
}

export { BedrockStreamError };
