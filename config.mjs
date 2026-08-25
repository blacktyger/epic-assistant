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

export const model = {
  default: str('EPIC_AI_MODEL', 'sonnet-4-6'),

  /**
   * Per-request model override. Gated behind a shared secret rather than exposed as a query
   * parameter, because a public parameter lets any caller select the most expensive model. Opus 4.6
   * is roughly twice Sonnet 4.6 per token, so this is a cost control, not just tidiness.
   */
  overrideHeader: 'x-epic-model',
  adminTokenHeader: 'x-epic-admin',
  adminToken: str('EPIC_AI_ADMIN_TOKEN', ''),

  maxTokens: num('EPIC_AI_MAX_TOKENS', 1200),

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
   * The localhost ports are the development shapes, both assigned in ports.json: 3001 is the
   * Docusaurus dev server, which proxies to dev-server.mjs so its Origin is the one the browser
   * sends, and 7772 is the single-origin preview in preview.mjs.
   */
  allowedOrigins: (str(
    'EPIC_AI_ALLOWED_ORIGINS',
    [
      'https://devdocs.epiccash.com',
      'http://localhost:3001', 'http://127.0.0.1:3001',
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
