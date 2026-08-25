/**
 * Every tunable number for the assistant, in one place.
 *
 * The point of collecting them here is that tightening a limit during an incident must never require
 * reading application logic. Anything that can be turned down under pressure lives in this file, and
 * anything in this file can be overridden by an environment variable so a change does not need a
 * rebuild.
 *
 * Values are deliberately generous. The operator's position is that the account runs on credits and
 * that comfortable use matters more than a tight ceiling, so these are sized to stop obvious abuse
 * while never inconveniencing somebody genuinely reading the documentation. The hard daily cap is the
 * backstop that makes the worst case bounded regardless of everything else.
 */
import { readSecretsInto } from './lib/secrets.mjs';

/**
 * The .secrets file fills in anything the environment has not already set.
 *
 * Done here, at the top of the one module everything else imports, rather than in the code that
 * needs a credential. Two things depend on it being visible this early: `tools.node.url`, which is a
 * configured value rather than something looked up per call, and `guards.redactHosts`, which derives
 * the hostnames that must never reach a reader from that same URL. Resolving the secret later would
 * mean the redaction list was computed before the host it is supposed to protect was known.
 *
 * The environment still wins, so a unit file or a test can override any of it, and a missing file is
 * not an error: only the Bedrock credential is genuinely required, and bedrock.mjs says so itself.
 */
readSecretsInto(process.env, new URL('../.secrets', import.meta.url));

const num = (name, fallback) => {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got ${JSON.stringify(v)}`);
  return n;
};
const str = (name, fallback) => process.env[name] ?? fallback;
const bool = (name, fallback) => {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v === '1' || v.toLowerCase() === 'true';
};

/* ------------------------------------------------------------------ model */

/**
 * Only these are selectable. Sonnet 4.6 is the default because it is both the strongest and the
 * fastest Anthropic model this account can reach: measured at 971 ms against 1,524 ms for Opus 4.6
 * and 1,544 ms for Haiku 4.5 on a trivial prompt.
 *
 * Sonnet 5, Opus 4.7, Opus 4.8, Opus 5 and Fable 5 are absent on purpose. They fail with
 * `agreementAvailability: NOT_AVAILABLE` for this account, so listing them would only produce a 403
 * at request time.
 */
export const MODELS = {
  'sonnet-4-6': 'eu.anthropic.claude-sonnet-4-6',
  'opus-4-6': 'eu.anthropic.claude-opus-4-6-v1',
  'sonnet-4-5': 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0',
  'haiku-4-5': 'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
};

/**
 * The models a reader may pick from in the panel, in the order they are offered.
 *
 * Deliberately two. A picker is only useful if the choice means something, and these two differ in a
 * way a reader can feel: Sonnet answers a lookup in about a second, Opus is slower but holds a longer
 * chain of reasoning together, which shows up when it is asked to write a working script against
 * several API methods at once. Adding Haiku would offer a choice nobody has a reason to make.
 *
 * `note` is shown to the reader, so it describes the tradeoff rather than the price.
 */
export const MODEL_CHOICES = [
  { id: 'sonnet-4-6', label: 'Sonnet 4.6', note: 'Fast. Best for lookups.' },
  { id: 'opus-4-6', label: 'Opus 4.6', note: 'Slower. Better at writing code.' },
];

export const model = {
  default: str('EPIC_AI_MODEL', 'sonnet-4-6'),

  /**
   * Which models an unauthenticated reader may select, as a request field rather than a header.
   *
   * This used to be admin-only, on the reasoning that a public parameter lets any caller pick the
   * most expensive model. That reasoning was overweighted. Opus 4.6 is 1.67x Sonnet 4.6 per token,
   * not the order of magnitude that argument implies, and the daily ledger caps total spend
   * regardless of which model burns it. Withholding the choice bought a 40% saving on the fraction of
   * traffic that would have chosen Opus, at the cost of the one control readers of a coding assistant
   * expect to have.
   *
   * The list is still an allowlist, so a caller cannot name a model that is merely present in MODELS.
   * `overrideHeader` survives for anything outside it, which is now the whole point of the admin path.
   */
  publicChoices: (str('EPIC_AI_PUBLIC_MODELS', MODEL_CHOICES.map((m) => m.id).join(',')))
    .split(',').map((s) => s.trim()).filter(Boolean),

  /**
   * Per-request model override beyond the public list. Still gated behind a shared secret, because
   * this is the lever that reaches models with no cost ceiling agreed for them.
   */
  overrideHeader: 'x-epic-model',
  adminTokenHeader: 'x-epic-admin',
  adminToken: str('EPIC_AI_ADMIN_TOKEN', ''),

  /**
   * 2,000, raised from 1,200 when code authoring became part of the job. A documentation lookup lands
   * well under the old ceiling, but a working Python or Rust example against three API methods plus
   * the prose around it does not, and the failure mode of a low ceiling is the worst kind: the answer
   * stops mid-function and the reader copies a truncated script.
   *
   * Output tokens are the expensive half, 16.50 against 3.30 per million on Sonnet 4.6, so this is
   * the single number with the most direct effect on cost per answer. It is a ceiling and not a
   * target: the format instructions still ask for brevity, and measured answers sit far below it.
   */
  maxTokens: num('EPIC_AI_MAX_TOKENS', 2000),

  /**
   * Low but not zero. A grounded lookup wants determinism, and 0 makes repeated identical questions
   * produce byte-identical answers, which makes the answer cache more useful and makes the golden
   * set stable enough to diff.
   */
  temperature: num('EPIC_AI_TEMPERATURE', 0.2),

  /**
   * 5 minutes, not 1 hour, and this is the counter-intuitive one. Bedrock accepts both. A 1-hour cache
   * write costs 2.0x a plain input token while a 5-minute write costs 1.25x, so on sporadic traffic
   * the long TTL loses money: it only pays once a second question lands inside the window. With
   * retrieval the cached prefix is just the core block and instructions, roughly 2,400 tokens, so the
   * stakes are small either way. Switch to 1h only if traffic becomes steady.
   */
  cacheTtl: str('EPIC_AI_CACHE_TTL', '5m'),
};

/* ------------------------------------------------------------------ retrieval */

export const retrieval = {
  /**
   * 16 sections. The sweep in test-retrieval.mjs shows recall over 30 questions saturating at 100% by
   * topK 6, so this is not buying recall, it is buying headroom for questions whose answer spans
   * several sections. A usernet mining setup needs four separate config sections.
   */
  topK: num('EPIC_AI_TOP_K', 16),

  /** Backstop for a query that selects several oversized code-example sections. */
  tokenBudget: num('EPIC_AI_TOKEN_BUDGET', 14000),

  /** Stops one long API page crowding out the concept page that explains the reader's question. */
  maxPerPage: num('EPIC_AI_MAX_PER_PAGE', 8),

  /** Set to send the whole corpus instead of retrieving. Exists for the A/B comparison, not for use. */
  fullCorpus: bool('EPIC_AI_FULL_CORPUS', false),
};

/* ------------------------------------------------------------------ live data tools */

/**
 * The tools the model may call, and the only external surfaces it may reach.
 *
 * The design rule here is that a tool is a fixed question, never a pipe. There is no
 * `call_any_node_method` and no `fetch_url`: each tool names one read, validates its own arguments,
 * and returns a projection this file controls. That is what makes "whitelisted" true rather than
 * aspirational, and it is why a prompt injection inside a retrieved document cannot turn a tool into
 * a request against something else.
 *
 * Three separate reasons the caps below are tight, worth keeping distinct because they pull in
 * different directions:
 *
 * 1. Cost. Every tool round re-sends the whole conversation plus the accumulated results, so a
 *    3-round answer costs roughly 3x a plain one in input tokens. `maxRounds` is the ceiling on that.
 * 2. Blast radius on our own node. Every reader who triggers a chain question spends a request against
 *    the host in #epic-remote-node. The TTL caches mean traffic against it is bounded by the clock
 *    rather than by how many readers are asking, which is the only property that makes this safe to
 *    put behind a public endpoint at all.
 * 3. GitHub's unauthenticated budget, measured at 60 requests per hour per IP. Without caching, 60
 *    readers an hour would exhaust it and every later answer would carry a rate-limit error. With a
 *    10-minute TTL the worst case is 6 requests per distinct question shape per hour.
 */
export const tools = {
  enabled: bool('EPIC_AI_TOOLS', true),

  /**
   * How many times the model may stop, receive results and continue. 3 allows the realistic worst
   * case: ask the chain for the tip, notice the reader's number is stale, then check the release list
   * to say which version that height implies. A fourth round has never been needed in testing and is
   * where a confused model starts looping.
   */
  maxRounds: num('EPIC_AI_TOOL_MAX_ROUNDS', 3),

  /** Total tool invocations across all rounds of one answer, regardless of how they are distributed. */
  maxCallsPerAnswer: num('EPIC_AI_TOOL_MAX_CALLS', 6),

  /**
   * Per-call wall clock. Short on purpose: a reader is watching a spinner, and a stale-but-cached
   * answer plus a note that the live check timed out beats a 30-second stall. The node answered
   * /v1/status in well under a second when measured.
   */
  timeoutMs: num('EPIC_AI_TOOL_TIMEOUT_MS', 6000),

  /**
   * Ceiling on the JSON handed back to the model, per call. Every tool already projects its response
   * down to fields chosen by hand, so this is the backstop for a surface changing shape under us
   * rather than the primary control.
   */
  maxResultChars: num('EPIC_AI_TOOL_MAX_RESULT_CHARS', 6000),

  node: {
    enabled: bool('EPIC_AI_TOOL_NODE', true),

    /**
     * Read from .secrets as EPIC_NODE_URL. Never sent to a reader and never quoted in an answer: see
     * `guards.redactHosts`. The host runs an unauthenticated /v2/foreign that accepts
     * push_transaction and submit_block, which is the shipped Epic default rather than our
     * misconfiguration, so publishing the name of it would be handing out a free submission endpoint.
     */
    url: str('EPIC_NODE_URL', ''),
    user: str('EPIC_NODE_API_USER', 'epic'),

    /**
     * Which chain the configured node is on. Stated rather than detected because /v1/status does not
     * report it: the response carries a user agent and a height but nothing that distinguishes
     * mainnet from floonet. An answer that says "the chain is at height 3,680,932" is wrong in a
     * damaging way if the height came from a test network, so this travels with every tool result.
     */
    network: str('EPIC_NODE_NETWORK', 'mainnet'),

    /**
     * 30 seconds against a 60-second block time. Long enough that a burst of readers costs two
     * requests, short enough that the height is never wrong by more than a block, which is inside
     * what any answer about the tip should claim anyway.
     */
    statusTtlSeconds: num('EPIC_AI_TOOL_NODE_STATUS_TTL', 30),

    /** A buried block is immutable, so this is only bounded by memory. */
    blockTtlSeconds: num('EPIC_AI_TOOL_NODE_BLOCK_TTL', 600),

    /** The mempool is the one value that is interesting precisely because it changes. */
    poolTtlSeconds: num('EPIC_AI_TOOL_NODE_POOL_TTL', 20),

    peersTtlSeconds: num('EPIC_AI_TOOL_NODE_PEERS_TTL', 300),

    /** Widest window `epic_chain_window` will look back over. 1,440 blocks is about a day. */
    maxWindowBlocks: num('EPIC_AI_TOOL_NODE_MAX_WINDOW', 1440),
  },

  github: {
    enabled: bool('EPIC_AI_TOOL_GITHUB', true),

    /**
     * The whole of the allowlist. Three repositories, the ones the documentation is about.
     *
     * Adding one is a single entry here, and that is the intended way to grow this: epicbox, the
     * explorer and the GUI wallet are all plausible next entries. Keeping the list explicit rather
     * than allowing any `EpicCash/*` repository matters because the organisation also holds
     * integration repos whose contents we have not audited and would not want quoted as guidance.
     */
    repos: (str(
      'EPIC_AI_TOOL_GITHUB_REPOS',
      'EpicCash/epic,EpicCash/epic-wallet,EpicCash/epic-miner',
    )).split(',').map((s) => s.trim()).filter(Boolean),

    /** 10 minutes. A release, a merged PR and a new issue are all fine to be that stale. */
    ttlSeconds: num('EPIC_AI_TOOL_GITHUB_TTL', 600),

    /**
     * Optional. Absent, calls are unauthenticated at 60 requests per hour per IP, which the cache
     * makes workable. A fine-grained read-only token raises it to 5,000 and is worth adding to
     * .secrets as EPIC_GITHUB_TOKEN if this endpoint ever gets real traffic.
     */
    tokenEnvNames: ['EPIC_GITHUB_TOKEN', 'GITHUB_TOKEN'],

    /**
     * Stop calling once the remaining hourly budget drops this low, keeping a reserve for the
     * operator's own debugging rather than letting reader traffic take the last request.
     */
    minRateRemaining: num('EPIC_AI_TOOL_GITHUB_MIN_REMAINING', 4),

    /** Hard ceiling on any list a reader can ask for, whatever the model puts in the arguments. */
    maxItems: num('EPIC_AI_TOOL_GITHUB_MAX_ITEMS', 10),
  },
};

/* ------------------------------------------------------------------ per-request caps */

export const request = {
  /**
   * 2,000 characters, roughly 500 tokens. The longest genuine documentation question I could
   * construct ran about 400 characters, so this is 5x headroom. Rejected with 400 rather than
   * truncated, because silently answering a different question than the one asked is worse.
   */
  maxQuestionChars: num('EPIC_AI_MAX_QUESTION_CHARS', 2000),

  /**
   * 6 user turns. History sits after the cached prefix so it never invalidates the cache, but it is
   * uncached input, so it is the one part of the prompt a caller can grow.
   */
  maxTurns: num('EPIC_AI_MAX_TURNS', 6),

  /** Aborts the Bedrock call, which stops billing rather than merely abandoning the response. */
  streamTimeoutMs: num('EPIC_AI_STREAM_TIMEOUT_MS', 90_000),

  /** Bounds worst-case burn rate. At the measured per-question cost this caps roughly $0.25/second. */
  maxConcurrent: num('EPIC_AI_MAX_CONCURRENT', 8),
};

/* ------------------------------------------------------------------ session */

export const session = {
  /** 2 hours. Long enough for a real reading session, short enough that a leaked token rots. */
  ttlSeconds: num('EPIC_AI_SESSION_TTL', 7200),

  /** A genuinely curious reader asks 5 to 10 questions. 40 is comfortable headroom. */
  maxRequests: num('EPIC_AI_SESSION_MAX_REQUESTS', 40),

  /**
   * Non-cached tokens only, so cache reads do not count against a reader. Binds the case where
   * somebody maximises every other dimension without hitting the request count.
   */
  maxTokens: num('EPIC_AI_SESSION_MAX_TOKENS', 60_000),

  /**
   * The real budget multiplier, and the number to tighten first under attack. A token is worthless
   * unless minting is limited: unlimited mints means unlimited budget however tight the per-session
   * caps are.
   */
  maxMintsPerIpHour: num('EPIC_AI_MAX_MINTS_PER_IP_HOUR', 30),

  /** Signing secret rotates daily; the previous secret stays valid for this long afterwards. */
  secretGraceSeconds: num('EPIC_AI_SECRET_GRACE', 7200),

  /**
   * Regenerating an answer costs exactly what asking costs, so it counts against the same quota.
   * Otherwise it is the cheapest way to spend the budget.
   */
  maxRegensPerTurn: num('EPIC_AI_MAX_REGENS', 1),
};

/* ------------------------------------------------------------------ proof of work */

export const pow = {
  enabled: bool('EPIC_AI_POW', true),

  /**
   * Leading zero bits on a SHA-256 of challenge + nonce.
   *
   * 14 bits is about 16,000 expected hashes. The browser solves it with SubtleCrypto rather than a
   * bundled SHA-256 implementation, and an awaited digest per attempt costs more in promise overhead
   * than in hashing, so the practical budget is a few tens of thousands of attempts before a slow
   * phone notices. 14 keeps it well inside that.
   *
   * Be clear about what this is for. It is a script filter: a client that does not run JavaScript never
   * solves it, which removes crawlers and curl loops, the traffic this endpoint will actually see. It
   * is not a cost control. An attacker's CPU-second costs about $0.00001 and unlocks a question
   * costing us $0.026, so no tolerable difficulty closes a 2,500-to-1 gap. The per-session budget is
   * the control, and raising this number would inconvenience readers without touching an attacker.
   */
  bits: num('EPIC_AI_POW_BITS', 14),

  /** A solved challenge is single-use and expires, so one solve cannot mint a stream of sessions. */
  challengeTtlSeconds: num('EPIC_AI_POW_TTL', 300),
};

/* ------------------------------------------------------------------ rate limits */

/**
 * The application-side limiter. nginx carries the first layer, but these exist so the service is
 * still bounded when it is run directly, in development or behind a proxy that was misconfigured.
 * Two layers disagreeing is better than one layer absent.
 */
export const rate = {
  perIpPerMinute: num('EPIC_AI_IP_PER_MINUTE', 20),
  perIpBurst: num('EPIC_AI_IP_BURST', 6),
  perIpConcurrent: num('EPIC_AI_IP_CONCURRENT', 4),

  /**
   * IPv6 is aggregated to a /64 before it becomes a rate-limit key. A residential /64 gives one
   * attacker 2^64 distinct addresses, so keying on a full IPv6 address is the same as having no
   * per-IP limit at all. This is the most common silent hole in a rate-limit configuration.
   */
  ipv6PrefixBits: 64,
};

/* ------------------------------------------------------------------ spend */

/**
 * eu-central-1 rates, USD per million tokens.
 *
 * Nova and Titan figures came from the AWS Price List API. Anthropic bills through Marketplace SKUs
 * that carry no model attribute, so Claude rates are derived: list price times the 1.1 EU regional
 * multiplier observed in that same offer file, where base 2/5/10/25/50 appear as 2.2/5.5/11/27.5/55.
 * The multipliers below come from the same source: cache read 0.10x input, 5-minute cache write
 * 1.25x, 1-hour write 2.0x. Cross-region inference carries no surcharge; "Regional CRIS" and
 * "Regional" price identically.
 *
 * Marked derived, not read. Reconcile against the first invoice and correct here.
 */
export const PRICING = {
  'eu.anthropic.claude-sonnet-4-6': { in: 3.30, out: 16.50 },
  'eu.anthropic.claude-sonnet-4-5-20250929-v1:0': { in: 3.30, out: 16.50 },
  'eu.anthropic.claude-opus-4-6-v1': { in: 5.50, out: 27.50 },
  'eu.anthropic.claude-haiku-4-5-20251001-v1:0': { in: 1.10, out: 5.50 },
};

export const CACHE_MULTIPLIER = { read: 0.10, write5m: 1.25, write1h: 2.0 };

export const spend = {
  /** Stop calling Bedrock and fall back to the site's offline search index. */
  softDailyUsd: num('EPIC_AI_SOFT_DAILY_USD', 40),

  /** Kill switch. Composer replaced by a static message. */
  hardDailyUsd: num('EPIC_AI_HARD_DAILY_USD', 75),

  /**
   * Assumed worst-case cost of a request, checked against the remaining budget before the call
   * rather than after. Checking afterwards means the cap is always breached by one request.
   *
   * A floor rather than the figure actually used: `reserveFor` below derives a request's reserve from
   * the model and the tool round ceiling, and takes whichever is larger. A single flat number was
   * correct while every request was one Sonnet call with a retrieved context. It stopped being correct
   * the moment a reader could select Opus and the model could spend three rounds re-sending an
   * accumulating transcript, which together move the worst case by about 5x.
   */
  reserveUsdPerRequest: num('EPIC_AI_RESERVE_USD', 0.08),

  ledgerDir: str('EPIC_AI_LEDGER_DIR', 'var/spend'),
  keepDays: num('EPIC_AI_LEDGER_KEEP_DAYS', 90),
};

/* ------------------------------------------------------------------ output guards */

export const guards = {
  /**
   * The highest-value safety control here, and the reason is specific to this project. A
   * cryptocurrency site cannot emit a wallet download link that nobody wrote. Any URL whose host is
   * outside this list is stripped from the answer.
   */
  allowedHosts: (str(
    'EPIC_AI_ALLOWED_HOSTS',
    'devdocs.epiccash.com,epiccash.com,www.epiccash.com,github.com,t.me,www.reddit.com,explorer.epicmine.io',
  )).split(',').map((h) => h.trim()).filter(Boolean),

  /** Repeated identical runs indicate a degenerate loop; abort rather than bill for it. */
  repeatWindow: num('EPIC_AI_REPEAT_WINDOW', 40),
  repeatLimit: num('EPIC_AI_REPEAT_LIMIT', 5),

  /**
   * Hostnames that must never appear in an answer, redacted from the stream before release.
   *
   * This exists because the live-data tools query infrastructure of ours that readers must not reach.
   * The node behind `epic_chain_status` answers with our credential attached, and it also serves an
   * unauthenticated /v2/foreign that accepts push_transaction and submit_block, so its hostname is
   * closer to a credential than to a citation. The allowlist in `allowedHosts` would not catch this
   * on its own: a bare hostname with no scheme is not a URL and would sail through.
   *
   * Derived from the configured node URL rather than hard-coded, so pointing the tools at a different
   * host cannot leave the old name protected and the new one exposed. The literal is included as well
   * because a stale value in a model's pretraining is exactly as damaging as a live one.
   */
  redactHosts: (() => {
    const named = (str('EPIC_AI_REDACT_HOSTS', 'node.btlabs.uk,wallet.btlabs.uk'))
      .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
    const fromUrl = [];
    for (const raw of [tools.node.url]) {
      if (!raw) continue;
      try { fromUrl.push(new URL(raw).hostname.toLowerCase()); } catch { /* not a URL, ignore */ }
    }
    return [...new Set([...named, ...fromUrl])];
  })(),
};

/* ------------------------------------------------------------------ answer cache */

export const answerCache = {
  enabled: bool('EPIC_AI_ANSWER_CACHE', true),
  /** The head of a docs question distribution is steep, so this is the cheapest saving available. */
  maxEntries: num('EPIC_AI_ANSWER_CACHE_ENTRIES', 2000),
  ttlSeconds: num('EPIC_AI_ANSWER_CACHE_TTL', 86_400),
};

/* ------------------------------------------------------------------ logging */

export const logging = {
  dir: str('EPIC_AI_LOG_DIR', 'var/questions'),

  /** Enough to see what was asked, short enough to limit what a paste can leak. */
  maxQuestionChars: num('EPIC_AI_LOG_QUESTION_CHARS', 200),

  /** Deleted by a prune pass on start and daily. An unenforced retention policy is worse than none. */
  retentionDays: num('EPIC_AI_LOG_RETENTION_DAYS', 30),
};

/* ------------------------------------------------------------------ server */

export const server = {
  host: str('EPIC_AI_HOST', '127.0.0.1'),

  /**
   * 6660, the first slot in the production range in ports.json at the workspace root.
   *
   * The literal is here rather than read from the registry because only this directory is deployed,
   * and a service that cannot start without a file from a sibling directory is a new way for the
   * deployment to break. `node tools/ports.mjs check` compares the two, so drift is caught in the
   * repository instead of on the host. The unit file sets EPIC_AI_PORT and wins over this.
   */
  port: num('EPIC_AI_PORT', 6660),

  /**
   * The CSP on the docs site is `connect-src 'self'`, so the browser may only call the same origin.
   * That means nginx proxies /api/chat on the docs host and no CORS is involved at all. This list
   * exists to reject a request whose Origin is something else, which stops the lazy case of somebody
   * pointing their own page at the endpoint. Trivially spoofed by a non-browser client, so it is
   * advice rather than a gate.
   *
   * The localhost ports are the development shapes, all assigned in ports.json: 3001 is the
   * Docusaurus dev server, which proxies to dev-server.mjs so its Origin is the one the browser
   * sends, 7771 is dev-server.mjs itself when EPIC_AI_STATIC_DIR makes it serve the built site on its
   * own origin, and 7772 is the single-origin preview in preview.mjs.
   *
   * 7771 was missing until a browser-driven check hit it: opening the panel from the built site on
   * that port produced a 403 on every question, and the reader-facing message for a 403 is "AI
   * assistant currently unavailable", which says nothing about the cause. Worth noting how it stayed
   * hidden. Every other way of exercising this endpoint omits Origin entirely, curl and the SSE test
   * client included, and the gate lets a missing Origin through. Only a real browser sends it.
   */
  allowedOrigins: (str(
    'EPIC_AI_ALLOWED_ORIGINS',
    [
      'https://devdocs.epiccash.com',
      'http://localhost:3001', 'http://127.0.0.1:3001',
      'http://localhost:7771', 'http://127.0.0.1:7771',
      'http://localhost:7772', 'http://127.0.0.1:7772',
    ].join(','),
  )).split(',').map((s) => s.trim()).filter(Boolean),

  secretsPath: str('EPIC_AI_SECRETS', '../.secrets'),
  corpusPath: str('EPIC_AI_CORPUS', 'dist/corpus.json'),
  corePath: str('EPIC_AI_CORE', 'dist/core.txt'),
};

/** Resolves a model key or full profile id to a profile id, rejecting anything not allowlisted. */
export function resolveModel(requested) {
  if (!requested) return MODELS[model.default] ?? MODELS['sonnet-4-6'];
  if (MODELS[requested]) return MODELS[requested];
  if (Object.values(MODELS).includes(requested)) return requested;
  return null;
}

/**
 * Resolves a reader-supplied model choice, which may only name something in `publicChoices`.
 *
 * Separate from `resolveModel` on purpose. That function answers "is this a model this service knows
 * about", which is the question the admin path asks. This one answers "may an anonymous caller spend
 * our money on this", and conflating the two is how a cost control quietly becomes a suggestion.
 *
 * @returns {{ok: true, id: string, modelId: string} | {ok: false, reason: string}}
 */
export function resolvePublicModel(requested) {
  if (!requested) {
    const id = model.publicChoices.includes(model.default) ? model.default : model.publicChoices[0];
    return { ok: true, id, modelId: MODELS[id] };
  }
  const key = String(requested);
  if (!model.publicChoices.includes(key) || !MODELS[key]) {
    return { ok: false, reason: `unknown model, choose one of: ${model.publicChoices.join(', ')}` };
  }
  return { ok: true, id: key, modelId: MODELS[key] };
}

/** The picker payload sent to the panel, so the choices are stated in one place only. */
export function publicModelChoices() {
  const offered = MODEL_CHOICES.filter((m) => model.publicChoices.includes(m.id) && MODELS[m.id]);
  const fallback = model.publicChoices.includes(model.default) ? model.default : offered[0]?.id;
  return { choices: offered, default: fallback ?? null };
}

/**
 * Worst-case cost of one exchange, used to reserve budget before spending it.
 *
 * Built from the ceilings rather than from an average, because that is what a reservation is for.
 * Input is assumed to be the retrieval budget plus the cached prefix, re-sent once per tool round with
 * the accumulated results growing each time; output is assumed to hit `maxTokens` on the final round.
 * The result on the defaults is about $0.05 for a plain Sonnet answer and $0.23 for an Opus answer
 * that spends every tool round, which is the spread a single flat number could not express.
 */
export function reserveFor(modelId, { toolRounds = 1 } = {}) {
  const p = PRICING[modelId];
  if (!p) return spend.reserveUsdPerRequest;

  const perRoundInput = retrieval.tokenBudget + 3000; // documents plus prefix, instructions and history
  const rounds = Math.max(1, toolRounds);
  // Round n re-sends everything from round n-1, so input across rounds grows triangularly.
  const inputTokens = perRoundInput * ((rounds * (rounds + 1)) / 2);
  const outputTokens = model.maxTokens + (rounds - 1) * 300; // tool arguments are short

  const estimate = (inputTokens * p.in) / 1e6 + (outputTokens * p.out) / 1e6;
  return Math.max(spend.reserveUsdPerRequest, estimate);
}

/** Cost of one exchange in USD, from real usage rather than an estimate. */
export function costOf(modelId, usage, ttl = model.cacheTtl) {
  const p = PRICING[modelId];
  if (!p || !usage) return 0;
  const writeMult = ttl === '1h' ? CACHE_MULTIPLIER.write1h : CACHE_MULTIPLIER.write5m;
  return (
    (usage.inputTokens * p.in) / 1e6 +
    (usage.outputTokens * p.out) / 1e6 +
    (usage.cacheReadInputTokens * p.in * CACHE_MULTIPLIER.read) / 1e6 +
    (usage.cacheWriteInputTokens * p.in * writeMult) / 1e6
  );
}
