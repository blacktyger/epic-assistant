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
import { readFileSync } from 'node:fs';
import { iterateEventStream, BedrockStreamError } from './eventstream.mjs';

let cached = null;

/** Reads credentials from the workspace .secrets file, or the environment if already exported. */
export function loadCredentials(secretsPath) {
  if (cached) return cached;

  let token = process.env.AWS_BEARER_TOKEN_BEDROCK;
  let region = process.env.AWS_BEDROCK_REGION;

  if ((!token || !region) && secretsPath) {
    const text = readFileSync(secretsPath, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^(\w+)=(.*)$/);
      if (!m) continue;
      if (m[1] === 'AWS_BEARER_TOKEN_BEDROCK' && !token) token = m[2];
      if (m[1] === 'AWS_BEDROCK_REGION' && !region) region = m[2];
    }
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
 * Streaming Converse. Yields `{type: 'text', text}` for each delta and finally
 * `{type: 'done', stopReason, usage}`.
 *
 * `signal` is forwarded into fetch, so aborting stops the HTTP request and therefore stops billing
 * for tokens nobody will read. That is the most commonly missed cost leak in streaming chat UIs and
 * the reason this function takes a signal rather than owning its own.
 */
export async function* converseStream({
  credentials, modelId, system, messages, maxTokens, temperature, signal,
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
      }),
      signal,
    },
  );

  if (!res.ok) throw await bedrockError(res, await res.text());
  if (!res.body) throw new BedrockStreamError('no-body', 'response carried no stream');

  let stopReason = null;
  let usage = null;

  for await (const event of iterateEventStream(res.body)) {
    switch (event.type) {
      case 'contentBlockDelta': {
        const t = event.body?.delta?.text;
        if (t) yield { type: 'text', text: t };
        break;
      }
      case 'messageStop':
        stopReason = event.body?.stopReason ?? null;
        break;
      case 'metadata':
        usage = normaliseUsage(event.body?.usage);
        break;
      // messageStart, contentBlockStart and contentBlockStop carry nothing a text-only
      // consumer needs, so they are dropped rather than forwarded as empty events.
      default:
        break;
    }
  }

  yield { type: 'done', stopReason, usage };
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
