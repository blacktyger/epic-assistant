/**
 * Live chain reads against the Epic node we operate.
 *
 * Scope, stated precisely because "the assistant can query a node" invites a wider reading than this
 * is: five fixed questions, all read-only, all against `/v1`. There is no method parameter and no way
 * for a caller to compose a request. The functions below are the complete set of things the model can
 * make this service ask a node.
 *
 * What is deliberately absent, and why each one is absent rather than merely unimplemented:
 *
 * - `validate_chain` and `compact_chain` run on the node's API thread over 3.6 M blocks. A reader
 *   asking an idle question must not be able to stall the node for minutes.
 * - `ban_peer` and `unban_peer` change who the node talks to. Nothing a documentation reader asks
 *   should mutate anything.
 * - `/v1/chain/outputs/byheight` and `/v1/txhashset/outputs` have no range cap in the node, so they
 *   will walk the whole chain when asked. The hazard is to us, in response size and time, not to the
 *   node, and the projection ceiling would truncate them into something misleading anyway.
 * - `push_transaction` and `submit_block` exist on this host and are the reason `guards.redactHosts`
 *   keeps its name out of answers. They are not reachable from here at all.
 *
 * Every projection is hand-written. Nothing upstream is passed through verbatim, which bounds the
 * token cost of a tool result and means a field appearing upstream cannot silently start reaching the
 * model. Raw `/v1/peers/connected` is 15.8 KB, for instance, and becomes about 300 bytes here.
 */
import { tools as toolCfg } from '../../config.mjs';
import { fetchJson, TtlCache, ToolHttpError } from './http.mjs';

const cache = new TtlCache({ maxEntries: 300 });

/** Algorithms in the order Epic reports them, so a rendered result reads consistently. */
const ALGOS = ['randomx', 'progpow', 'cuckatoo', 'cuckaroo'];

/* ------------------------------------------------------------------ client */

/**
 * Resolves the endpoint and credential once.
 *
 * Returns null rather than throwing when either is missing, so a deployment without node access still
 * starts and simply does not advertise these tools. The alternative, failing at boot, would couple the
 * documentation assistant's availability to ours holding a node, which is a worse trade.
 */
function client() {
  const url = (toolCfg.node.url ?? '').replace(/\/+$/, '');
  const secret = process.env.EPIC_NODE_API_SECRET ?? '';
  if (!url || !secret) return null;
  return {
    url,
    // Built once and held in a closure. Never logged, never returned, never placed in a tool result.
    auth: `Basic ${Buffer.from(`${toolCfg.node.user}:${secret}`).toString('base64')}`,
    network: toolCfg.node.network,
  };
}

export function nodeAvailable() {
  return toolCfg.enabled && toolCfg.node.enabled && client() !== null;
}

async function get(path, { signal, maxBytes } = {}) {
  const c = client();
  if (!c) throw new ToolHttpError('upstream', 'no node endpoint is configured');
  const { json } = await fetchJson(`${c.url}${path}`, {
    headers: { Authorization: c.auth, Accept: 'application/json' },
    timeoutMs: toolCfg.timeoutMs,
    maxBytes: maxBytes ?? 400_000,
    signal,
  });
  return json;
}

/* ------------------------------------------------------------------ status */

/**
 * The tip, and enough around it to answer "is this height current" and "is the chain moving".
 *
 * Two upstream requests, `/v1/status` for the tip and `/v1/headers/<height>` for its timestamp and
 * algorithm, because status alone cannot say when the last block arrived. `secondsSinceTip` is the
 * value most questions actually want: against a 60-second target block time, a number in the
 * thousands means the chain has stalled and no amount of correct height reporting conveys that.
 */
export async function chainStatus({ signal } = {}) {
  const hit = await cache.get('status', toolCfg.node.statusTtlSeconds, async () => {
    const status = await get('/v1/status', { signal });
    const height = status?.tip?.height;
    let header = null;
    if (Number.isInteger(height)) {
      // A failure here is not fatal: the tip height is the answer to most questions and losing the
      // timestamp should not lose it.
      header = await get(`/v1/headers/${height}`, { signal }).catch(() => null);
    }
    return { status, header, at: Date.now() };
  });

  const { status, header } = hit.value;
  const tipTime = header?.timestamp ? Date.parse(header.timestamp) : null;

  return withMeta(hit, {
    network: client()?.network ?? 'unknown',
    nodeVersion: userAgentVersion(status?.user_agent),
    syncStatus: status?.sync_status ?? null,
    synced: status?.sync_status === 'no_sync',
    connectedPeers: status?.connections ?? null,
    tipHeight: status?.tip?.height ?? null,
    tipHash: status?.tip?.last_block_pushed ?? null,
    tipTimestamp: header?.timestamp ?? null,
    tipAlgorithm: header?.proof ?? null,
    secondsSinceTip: tipTime ? Math.max(0, Math.round((Date.now() - tipTime) / 1000)) : null,
    targetBlockSeconds: 60,
    circulatingSupplyEpic: status?.supply ?? null,
    maxSupplyEpic: status?.max_supply ?? null,
    blocksToNextHalving: status?.blocks_to_next_halving ?? null,
    cumulativeDifficulty: pickAlgos(status?.tip?.total_difficulty),
    note:
      'cumulativeDifficulty is the running total of work per algorithm since genesis, not the ' +
      'difficulty of one block. For per-block difficulty use epic_chain_window.',
  });
}

/* ------------------------------------------------------------------ difficulty window */

/**
 * Current network difficulty per algorithm, and block timing, over a window ending at the tip.
 *
 * Two header fetches, not one per block, which is what makes this affordable on a public endpoint.
 * Each algorithm's `total_difficulty` in a header is an independent running accumulator, and the
 * measurement below rests on a property of it that had to be verified rather than assumed: every
 * accumulator advances on every block, each by its own algorithm's current difficulty. So the
 * difference between two headers divided by the block count is that algorithm's average difficulty
 * per block across the span, which is what "network difficulty" means.
 *
 * Checked against reality on 2026-08-25 before this shape was settled. Over a 60-block window the
 * derived ProgPow difficulty was 685,122,047,078 and the two ProgPow blocks measured individually
 * from consecutive headers were 695,250,829,312 and 692,290,070,528; derived RandomX was 441,701,217
 * against measured 442,522,922 and 441,902,020. Agreement to within normal retarget drift.
 *
 * The first version of this reported a "work share" percentage per algorithm and it was wrong in a way
 * worth recording, because the output looked entirely plausible. Difficulty units are not comparable
 * between algorithms: ProgPow difficulty is in the hundreds of billions and RandomX in the hundreds of
 * millions for the same 60 seconds of block time. Dividing one by their sum produced "ProgPow is
 * 99.93% of network work", which is an artefact of the units and not a fact about the network. The
 * split of blocks between algorithms is not derivable from two headers at all, and saying so is the
 * honest answer.
 */
export async function chainWindow({ blocks = 60, signal } = {}) {
  const span = clampInt(blocks, 1, toolCfg.node.maxWindowBlocks, 60);

  const hit = await cache.get(`window:${span}`, toolCfg.node.statusTtlSeconds * 2, async () => {
    const status = await get('/v1/status', { signal });
    const tipHeight = status?.tip?.height;
    if (!Number.isInteger(tipHeight)) throw new ToolHttpError('upstream', 'node returned no tip height');

    const fromHeight = Math.max(0, tipHeight - span);
    const [tip, from] = await Promise.all([
      get(`/v1/headers/${tipHeight}`, { signal }),
      get(`/v1/headers/${fromHeight}`, { signal }),
    ]);
    return { tip, from, at: Date.now() };
  });

  const { tip, from } = hit.value;
  const blocksCovered = tip.height - from.height;
  const spanSeconds = Math.round((Date.parse(tip.timestamp) - Date.parse(from.timestamp)) / 1000);

  const added = {};
  const perBlock = {};
  for (const algo of ALGOS) {
    const delta = Number(tip.total_difficulty?.[algo] ?? 0) - Number(from.total_difficulty?.[algo] ?? 0);
    added[algo] = delta;
    perBlock[algo] = blocksCovered > 0 ? Math.round(delta / blocksCovered) : null;
  }

  return withMeta(hit, {
    network: client()?.network ?? 'unknown',
    fromHeight: from.height,
    toHeight: tip.height,
    blocksCovered,
    spanSeconds,
    averageBlockSeconds: blocksCovered > 0 ? Number((spanSeconds / blocksCovered).toFixed(1)) : null,
    targetBlockSeconds: 60,
    networkDifficulty: perBlock,
    difficultyAddedOverWindow: added,
    note:
      'networkDifficulty is the average difficulty per block for each algorithm across this window, ' +
      'which is what network difficulty means for that algorithm. Each algorithm has its own ' +
      'independent difficulty and the numbers are not comparable to each other: ProgPow and RandomX ' +
      'run in different units for the same block time, so neither a ratio nor a percentage share ' +
      'between them means anything. A figure at or near 1 means that algorithm is effectively not ' +
      'being mined. How many blocks each algorithm produced cannot be derived from this.',
  });
}

/* ------------------------------------------------------------------ one block */

/**
 * A single block, projected down to what a question about it plausibly needs.
 *
 * Commitments, range proofs and Merkle proofs are dropped. They are the bulk of the response, a
 * reader cannot do anything with a commitment quoted in prose, and a 2.9 KB empty block becomes
 * considerably larger once it carries real outputs.
 *
 * `difficulty` is the block's own difficulty for its own algorithm, from the accumulator difference
 * against the previous header. That is the number a miner means by "the difficulty at block N", and it
 * is not present in any single response.
 */
export async function block({ height, hash, signal } = {}) {
  let selector;
  if (typeof hash === 'string' && hash.trim()) {
    const h = hash.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(h)) {
      return { error: 'hash must be 64 hexadecimal characters' };
    }
    selector = h;
  } else {
    const n = Number(height);
    if (!Number.isInteger(n) || n < 0) {
      return { error: 'height must be a non-negative integer, or pass a 64-character hash instead' };
    }
    // Checked against the live tip first, so "block 9,000,000" comes back as a clear statement about
    // where the chain actually is rather than as an upstream 400 the model has to interpret.
    const status = await chainStatus({ signal }).catch(() => null);
    if (status?.tipHeight != null && n > status.tipHeight) {
      return {
        error: 'above the current tip',
        requestedHeight: n,
        tipHeight: status.tipHeight,
        blocksAhead: n - status.tipHeight,
      };
    }
    selector = String(n);
  }

  const hit = await cache.get(`block:${selector}`, toolCfg.node.blockTtlSeconds, async () => {
    const b = await get(`/v1/blocks/${selector}`, { signal, maxBytes: 4_000_000 });
    const h = b?.header;
    let prev = null;
    if (h && Number.isInteger(h.height) && h.height > 0) {
      prev = await get(`/v1/headers/${h.height - 1}`, { signal }).catch(() => null);
    }
    return { block: b, prev, at: Date.now() };
  });

  const b = hit.value.block;
  const h = b?.header;
  if (!h) return { error: 'node returned no block for that selector' };

  const algo = String(h.proof ?? '').toLowerCase();
  const difficulty = hit.value.prev && algo && h.total_difficulty?.[algo] != null
    ? Number(h.total_difficulty[algo]) - Number(hit.value.prev.total_difficulty?.[algo] ?? 0)
    : null;

  const kernels = Array.isArray(b.kernels) ? b.kernels : [];
  const outputs = Array.isArray(b.outputs) ? b.outputs : [];

  return withMeta(hit, {
    network: client()?.network ?? 'unknown',
    height: h.height,
    hash: h.hash,
    previousHash: h.previous,
    timestamp: h.timestamp,
    algorithm: h.proof ?? null,
    difficulty,
    edgeBits: h.edge_bits ?? null,
    secondaryScaling: h.secondary_scaling ?? null,
    inputCount: Array.isArray(b.inputs) ? b.inputs.length : 0,
    outputCount: outputs.length,
    coinbaseOutputCount: outputs.filter((o) => o.output_type === 'Coinbase').length,
    kernelCount: kernels.length,
    totalFeeFreeman: kernels.reduce((sum, k) => sum + Number(k.fee ?? 0), 0),
    kernelFeatures: [...new Set(kernels.map((k) => k.features).filter(Boolean))],
    note:
      'Output commitments, range proofs and Merkle proofs are omitted. Amounts in a MimbleWimble ' +
      'block are blinded, so an output carries no readable value; only kernel fees are in the clear.',
  });
}

/* ------------------------------------------------------------------ mempool */

export async function mempool({ signal } = {}) {
  const hit = await cache.get('pool', toolCfg.node.poolTtlSeconds, async () => ({
    pool: await get('/v1/pool', { signal }),
    at: Date.now(),
  }));

  const pool = hit.value.pool;
  return withMeta(hit, {
    network: client()?.network ?? 'unknown',
    poolSize: pool?.pool_size ?? 0,
    note:
      'An empty mempool is normal on Epic rather than a fault. Transactions are built interactively ' +
      'between two wallets and are broadcast only once both rounds are complete, so they spend very ' +
      'little time waiting to be mined.',
  });
}

/* ------------------------------------------------------------------ peers */

/**
 * Aggregate view of the peers this node is connected to.
 *
 * A version histogram rather than a peer list, which is both the interesting answer and the safe one.
 * Interesting because "has the network upgraded to 4.0.3" is a real question the documentation cannot
 * answer and the wire can; safe because a list of peer addresses is not something a public endpoint
 * should hand out, whether or not the addresses are already visible to anyone running a node.
 */
export async function peers({ signal } = {}) {
  const hit = await cache.get('peers', toolCfg.node.peersTtlSeconds, async () => ({
    list: await get('/v1/peers/connected', { signal }),
    at: Date.now(),
  }));

  const list = Array.isArray(hit.value.list) ? hit.value.list : [];
  const byVersion = new Map();
  const heights = [];
  let inbound = 0;
  let outbound = 0;

  for (const p of list) {
    const agent = typeof p.user_agent === 'string' ? p.user_agent : 'unknown';
    byVersion.set(agent, (byVersion.get(agent) ?? 0) + 1);
    if (Number.isInteger(p.height)) heights.push(p.height);
    if (p.direction === 'Inbound') inbound += 1;
    else if (p.direction === 'Outbound') outbound += 1;
  }

  heights.sort((a, b) => a - b);

  return withMeta(hit, {
    network: client()?.network ?? 'unknown',
    connectedPeers: list.length,
    inbound,
    outbound,
    userAgents: [...byVersion.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([agent, count]) => ({ agent, count })),
    peerHeight: heights.length
      ? { min: heights[0], median: heights[Math.floor(heights.length / 2)], max: heights[heights.length - 1] }
      : null,
    note:
      'Peer addresses are deliberately omitted. userAgents is the adoption picture: it shows which ' +
      'node versions the peers of one node are actually running.',
  });
}

/* ------------------------------------------------------------------ helpers */

/**
 * Attaches the freshness metadata to every result.
 *
 * Not decoration. The model is told in its instructions to state how old a live figure is, and it can
 * only do that if the age travels with the value. `stale: true` means a refresh failed and this is the
 * last good reading, which is the one case where an answer must hedge rather than assert.
 */
function withMeta(hit, payload) {
  return {
    ...payload,
    observedAt: new Date(Date.now() - hit.ageSeconds * 1000).toISOString(),
    ageSeconds: hit.ageSeconds,
    ...(hit.stale ? { stale: true, staleReason: 'the live refresh failed, this is the last good reading' } : {}),
  };
}

function pickAlgos(obj) {
  if (!obj) return null;
  const out = {};
  for (const algo of ALGOS) if (obj[algo] != null) out[algo] = obj[algo];
  return out;
}

/** `MW/Epic 4.0.3` becomes `4.0.3`. Anything unexpected is passed through rather than dropped. */
function userAgentVersion(agent) {
  if (typeof agent !== 'string') return null;
  const m = agent.match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : agent;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export const nodeCacheStats = () => cache.stats;
export const sweepNodeCache = () => cache.sweep();
