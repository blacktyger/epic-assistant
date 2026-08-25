/**
 * The tool registry: the complete list of things the model can make this service do.
 *
 * One file, one table. If a capability is not in `REGISTRY` below, the model cannot reach it, because
 * `runTool` dispatches by exact name against this object and answers anything else with an error rather
 * than a guess. That property is the whole security argument for the feature, so it is worth keeping
 * the table boring enough to audit at a glance.
 *
 * Two things live here rather than in the individual tool modules:
 *
 * - The Bedrock `toolConfig`, because the schemas travel in the cached prompt prefix and their token
 *   cost is a property of the set rather than of any one tool. Eight tools cost roughly 700 tokens,
 *   paid once per cache write rather than per question.
 * - The budget. Rounds and total calls are counted per answer in a `ToolBudget` the server owns, so a
 *   model that decides to ask the same question five times stops costing money at a known point.
 *
 * Descriptions are written for the model, not for us, and they are the actual control surface for when
 * a tool fires. A description that says what a tool returns produces a model that never calls it; one
 * that says which reader questions require it produces a model that calls it when it should. Each of
 * the descriptions below therefore leads with the trigger condition.
 */
import { tools as toolCfg } from '../../config.mjs';
import { ToolHttpError } from './http.mjs';
import * as node from './node.mjs';
import * as github from './github.mjs';

/* ------------------------------------------------------------------ shared schema pieces */

const repoProperty = {
  type: 'string',
  enum: toolCfg.github.repos,
  description: 'Which EpicCash repository to read. These are the only repositories available.',
};

/* ------------------------------------------------------------------ registry */

/**
 * @typedef {object} ToolDefinition
 * @property {string} description        shown to the model
 * @property {object} schema             JSON Schema for the arguments
 * @property {(input: object, ctx: {signal: AbortSignal}) => Promise<object>} run
 * @property {(input: object) => string} label   one short line for the reader while it runs
 * @property {() => boolean} available
 * @property {'chain'|'github'} group
 */

/** @type {Record<string, ToolDefinition>} */
export const REGISTRY = {
  epic_chain_status: {
    group: 'chain',
    available: node.nodeAvailable,
    label: () => 'Checking the live Epic chain',
    description:
      'Call this whenever a question depends on the current state of the Epic mainnet chain, or asks ' +
      'you to confirm that a number is up to date. That includes: the current block height, whether ' +
      'a height the reader names is current or stale, whether the chain is moving, how many peers a ' +
      'node sees, the circulating supply, and how far away the next halving is. Also call it when a ' +
      'reader reports a symptom that a stalled or unsynced chain would explain. Returns the tip ' +
      'height, hash, timestamp and proof-of-work algorithm, seconds since that block, sync status, ' +
      'peer count, supply, blocks to the next halving, and cumulative difficulty per algorithm.',
    schema: { type: 'object', properties: {} },
    run: (_input, ctx) => node.chainStatus(ctx),
  },

  epic_chain_window: {
    group: 'chain',
    available: node.nodeAvailable,
    label: (input) => `Measuring difficulty over the last ${clamp(input?.blocks, 60)} blocks`,
    description:
      'Call this for questions about current mining difficulty, or whether blocks are arriving on ' +
      'schedule. Measures a window ending at the current tip and returns the current network ' +
      'difficulty for each proof-of-work algorithm and the average seconds per block. Use a window of ' +
      '60 blocks for "right now" and 1440 for "over the last day". Each algorithm has its own ' +
      'independent difficulty in its own units, so never compare them to each other or express one as ' +
      'a share of the total. It cannot tell you how many blocks each algorithm produced.',
    schema: {
      type: 'object',
      properties: {
        blocks: {
          type: 'integer',
          minimum: 1,
          maximum: toolCfg.node.maxWindowBlocks,
          description: 'How many blocks back from the tip to measure. 60 is about an hour, 1440 about a day.',
        },
      },
    },
    run: (input, ctx) => node.chainWindow({ blocks: input?.blocks, ...ctx }),
  },

  epic_block: {
    group: 'chain',
    available: node.nodeAvailable,
    label: (input) => (input?.hash ? 'Looking up a block by hash' : `Looking up block ${input?.height ?? ''}`.trim()),
    description:
      'Call this to look up one specific block on Epic mainnet by height or by hash, for example when ' +
      'a reader asks what is in a block, which algorithm mined it, what its difficulty was, or ' +
      'whether a height exists yet. Returns the header fields, the block difficulty for its own ' +
      'algorithm, input, output and kernel counts, and total fees in freeman. Output commitments and ' +
      'proofs are omitted, and MimbleWimble amounts are blinded, so a block cannot tell you how much ' +
      'value it moved.',
    schema: {
      type: 'object',
      properties: {
        height: { type: 'integer', minimum: 0, description: 'Block height. Use this or hash, not both.' },
        hash: { type: 'string', description: 'Block hash, 64 hexadecimal characters.' },
      },
    },
    run: (input, ctx) => node.block({ height: input?.height, hash: input?.hash, ...ctx }),
  },

  epic_mempool: {
    group: 'chain',
    available: node.nodeAvailable,
    label: () => 'Checking the transaction pool',
    description:
      'Call this when a reader asks whether the network is busy, how many transactions are waiting, ' +
      'or whether a pending transaction might be stuck in the mempool. Returns the current pool size ' +
      'as seen by one node.',
    schema: { type: 'object', properties: {} },
    run: (_input, ctx) => node.mempool(ctx),
  },

  epic_node_peers: {
    group: 'chain',
    available: node.nodeAvailable,
    label: () => 'Checking which node versions peers are running',
    description:
      'Call this for questions about which node software versions the network is actually running, ' +
      'whether an upgrade has been adopted, or whether peers agree on the chain height. Returns the ' +
      'connected peer count, a histogram of peer user agents, and the spread of heights those peers ' +
      'report. Peer addresses are not returned.',
    schema: { type: 'object', properties: {} },
    run: (_input, ctx) => node.peers(ctx),
  },

  epic_github_releases: {
    group: 'github',
    available: github.githubAvailable,
    label: (input) => `Checking releases of ${shortRepo(input?.repo)}`,
    description:
      'Call this whenever a question involves what the newest published version of the node, wallet ' +
      'or miner is, when it was released, what a release changed, or which download assets it ships. ' +
      'Also call it before stating a version number as current, because the versions in your core ' +
      'facts are what the documentation describes and may be behind what is published. Returns ' +
      'releases newest first with tag, date, prerelease flag, asset names and sizes, and an excerpt ' +
      'of the release notes.',
    schema: {
      type: 'object',
      properties: {
        repo: repoProperty,
        limit: {
          type: 'integer', minimum: 1, maximum: toolCfg.github.maxItems,
          description: 'How many releases to return, newest first. Use 1 for just the latest.',
        },
      },
      required: ['repo'],
    },
    run: (input, ctx) => github.releases({ repo: input?.repo, limit: input?.limit, ...ctx }),
  },

  epic_github_activity: {
    group: 'github',
    available: github.githubAvailable,
    label: (input) => `Checking recent ${String(input?.kind ?? 'commits').replace('_', ' ')} in ${shortRepo(input?.repo)}`,
    description:
      'Call this for questions about recent development activity: open or recently merged pull ' +
      'requests, open or closed issues, or recent commits. Use it when a reader asks what is being ' +
      'worked on, whether a bug is known, whether a fix has landed, or whether a repository is still ' +
      'active. Returns numbers, titles, authors, dates, state and links.',
    schema: {
      type: 'object',
      properties: {
        repo: repoProperty,
        kind: {
          type: 'string',
          enum: ['pull_requests', 'issues', 'commits'],
          description: 'Which kind of activity to list.',
        },
        state: {
          type: 'string',
          enum: ['open', 'closed', 'all'],
          description: 'Only meaningful for pull_requests and issues. Defaults to open.',
        },
        limit: { type: 'integer', minimum: 1, maximum: toolCfg.github.maxItems },
      },
      required: ['repo', 'kind'],
    },
    run: (input, ctx) => github.activity({
      repo: input?.repo, kind: input?.kind, state: input?.state, limit: input?.limit, ...ctx,
    }),
  },

  epic_github_repo: {
    group: 'github',
    available: github.githubAvailable,
    label: (input) => `Checking the state of ${shortRepo(input?.repo)}`,
    description:
      'Call this when a reader asks whether a repository is maintained, when it was last touched, ' +
      'what its default branch is, or what licence it carries. Returns the description, default ' +
      'branch, language, licence, archived flag, star and fork counts, open issue count, and days ' +
      'since the last push.',
    schema: { type: 'object', properties: { repo: repoProperty }, required: ['repo'] },
    run: (input, ctx) => github.repoOverview({ repo: input?.repo, ...ctx }),
  },
};

/* ------------------------------------------------------------------ toolConfig */

/** Tool names currently offered, which is the registry minus anything whose backing is unavailable. */
export function availableToolNames() {
  if (!toolCfg.enabled) return [];
  return Object.entries(REGISTRY).filter(([, def]) => def.available()).map(([name]) => name);
}

/**
 * The `toolConfig` block for Converse, or null when nothing is available.
 *
 * Null rather than an empty tools array on purpose: Bedrock rejects `toolConfig` with no tools, and
 * more usefully, returning null lets the caller omit the field entirely and keep the exact prompt
 * shape the service had before tools existed. That is what makes a misconfigured node degrade into
 * plain documentation answers instead of a 400.
 *
 * No `cachePoint` is placed inside `tools`. The schemas are identical on every request, so they sit in
 * the stable prefix ahead of the system cache point and are covered by it already; a second cache
 * point would pay a second write for the same bytes.
 */
export function buildToolConfig() {
  const names = availableToolNames();
  if (!names.length) return null;
  return {
    tools: names.map((name) => ({
      toolSpec: {
        name,
        description: REGISTRY[name].description,
        inputSchema: { json: REGISTRY[name].schema },
      },
    })),
    // Auto, never `any`. Forcing a tool call would make every documentation lookup pay for a chain
    // request it does not need.
    toolChoice: { auto: {} },
  };
}

/* ------------------------------------------------------------------ budget */

/**
 * Per-answer accounting, owned by the request rather than by the module.
 *
 * Counts rounds and calls separately because they bound different things. Rounds bound token cost,
 * since each one re-sends the accumulated transcript. Calls bound upstream load, since a single round
 * may contain several tool uses that Bedrock expects to be answered together.
 *
 * A refused call returns an error result rather than throwing, so an over-budget model receives "you
 * have used your tool budget" as data and writes its answer from what it already has. Throwing would
 * lose a partially useful answer.
 */
export class ToolBudget {
  rounds = 0;
  calls = 0;
  used = [];

  get roundsExhausted() {
    return this.rounds >= toolCfg.maxRounds;
  }

  spendRound() {
    this.rounds += 1;
  }

  /** @returns {{ok: true} | {ok: false, error: string}} */
  claimCall() {
    if (this.calls >= toolCfg.maxCallsPerAnswer) {
      return { ok: false, error: `tool budget spent: ${toolCfg.maxCallsPerAnswer} calls is the limit for one answer. Answer from what you already have.` };
    }
    this.calls += 1;
    return { ok: true };
  }

  get summary() {
    return { rounds: this.rounds, calls: this.calls, used: this.used };
  }
}

/* ------------------------------------------------------------------ dispatch */

/**
 * Runs one tool call and always returns a result the model can read.
 *
 * Never throws. A tool failure is information: "the node did not answer in time" lets the model say
 * the live check failed and fall back to the documented figure, whereas an exception would abort a
 * generation that was going to be mostly useful. The one thing it must not do is return something that
 * looks like success, so every failure path carries `ok: false`.
 *
 * @param {string} name
 * @param {object} input
 * @param {{signal?: AbortSignal, budget: ToolBudget}} ctx
 */
export async function runTool(name, input, { signal, budget } = {}) {
  const started = Date.now();
  const def = REGISTRY[name];

  if (!def) {
    return fail(name, `no tool named ${name} exists. Available: ${availableToolNames().join(', ') || 'none'}`, started);
  }
  if (!toolCfg.enabled || !def.available()) {
    return fail(name, `${name} is not available on this deployment`, started);
  }

  const claim = budget?.claimCall() ?? { ok: true };
  if (!claim.ok) return fail(name, claim.error, started);

  try {
    const raw = await def.run(input ?? {}, { signal });
    const data = capResult(raw);
    const ok = !(data && typeof data === 'object' && 'error' in data);
    budget?.used.push({ name, ms: Date.now() - started, ok, cached: data?.ageSeconds > 0 });
    return { ok, tool: name, data, ms: Date.now() - started };
  } catch (err) {
    const message = err instanceof ToolHttpError
      ? explain(err)
      : `the call failed: ${String(err?.message ?? 'unknown error').slice(0, 160)}`;
    budget?.used.push({ name, ms: Date.now() - started, ok: false });
    return fail(name, message, started);
  }
}

/** Reader-facing label for the SSE event, so the panel says what is happening rather than "tool". */
export function labelFor(name, input) {
  try {
    return REGISTRY[name]?.label(input ?? {}) ?? 'Checking live data';
  } catch {
    return 'Checking live data';
  }
}

export function toolGroupFor(name) {
  return REGISTRY[name]?.group ?? 'unknown';
}

/* ------------------------------------------------------------------ helpers */

function fail(name, error, started) {
  return { ok: false, tool: name, data: { error }, ms: Date.now() - started };
}

/**
 * Rewrites a transport failure into something the model can act on.
 *
 * The distinction that matters to an answer is whether the live figure is unavailable right now or
 * unavailable in principle, because the first justifies "I could not check just now, the documented
 * value is X" and the second justifies not mentioning a live check at all.
 */
function explain(err) {
  switch (err.kind) {
    case 'timeout': return 'the live source did not respond in time. Answer from the documentation and say the live check timed out.';
    case 'too-large': return 'the response was too large to read. Ask for a smaller window or a single item.';
    case 'not-json': return 'the live source returned something unreadable.';
    case 'network': return 'the live source could not be reached.';
    case 'status': return `the live source returned HTTP ${err.status}.`;
    default: return err.message.slice(0, 200);
  }
}

/**
 * Last-resort ceiling on what one result contributes to the prompt.
 *
 * Every tool already projects by hand, so this should never fire. It exists for the case where an
 * upstream grows a field: a surprise is a cost problem the day it happens, not the day somebody
 * notices. Truncation is reported in the payload rather than done silently, because a model handed a
 * clipped list must not summarise it as complete.
 */
function capResult(data) {
  const json = JSON.stringify(data);
  if (json === undefined) return { error: 'the tool returned nothing serialisable' };
  if (json.length <= toolCfg.maxResultChars) return data;
  return {
    truncated: true,
    truncatedFrom: json.length,
    note: `The result was ${json.length} characters, over the ${toolCfg.maxResultChars} limit, so it was cut. Ask for fewer items.`,
    preview: json.slice(0, toolCfg.maxResultChars),
  };
}

function clamp(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

function shortRepo(repo) {
  const s = String(repo ?? 'the repository');
  return s.includes('/') ? s.split('/')[1] : s;
}

/* ------------------------------------------------------------------ observability */

export function toolStats() {
  return {
    enabled: toolCfg.enabled,
    available: availableToolNames(),
    node: { available: node.nodeAvailable(), cache: node.nodeCacheStats() },
    github: {
      available: github.githubAvailable(),
      repos: toolCfg.github.repos,
      cache: github.githubCacheStats(),
      rate: github.githubRateState(),
    },
  };
}

export function sweepToolCaches() {
  node.sweepNodeCache();
  github.sweepGithubCache();
}
