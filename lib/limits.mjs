/**
 * Session identity, per-session budgets, per-IP rate limiting and the proof-of-work mint gate.
 *
 * Design decisions worth stating because they look like omissions:
 *
 * No cookie and no localStorage. The session token lives in a JavaScript variable in the page and is
 * sent as an Authorization header. ePrivacy Article 5(3) governs storing or accessing anything on the
 * reader's device; storing nothing means the article never engages and no consent banner is required.
 * The cost is that a page refresh starts a new session, which is acceptable.
 *
 * No database. State is a Map in this process, and the durable part, spend, lives in the ledger. A
 * restart clears sessions, which merely means readers re-mint, and the mint is cheap.
 *
 * Per-IP limits are a volumetric floor, not the primary control. One carrier NAT address can front
 * hundreds of real readers and a mobile client changes address mid-conversation, so an IP limit tight
 * enough to bound cost would lock out exactly the people we want. The per-session budget is the
 * control; the IP limit only stops a flood.
 */
import { createHmac, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { session as sessionCfg, rate as rateCfg, pow as powCfg } from '../config.mjs';

/* ------------------------------------------------------------------ IP handling */

/**
 * Normalises a client address into a rate-limit key.
 *
 * IPv6 is truncated to its /64 prefix. A residential IPv6 allocation is typically a /64 or shorter,
 * which gives one attacker 2^64 addresses; keying on the full address is indistinguishable from
 * having no per-IP limit. This is the most common silent hole in a rate-limit configuration and it is
 * covered by a test.
 */
export function ipKey(remoteAddress) {
  if (!remoteAddress) return 'unknown';
  let ip = remoteAddress;

  // Node reports IPv4-mapped IPv6 as ::ffff:1.2.3.4
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return mapped[1];
  if (!ip.includes(':')) return ip;

  // Expand to full groups so a :: shorthand cannot shift which groups the /64 covers.
  const groups = expandIpv6(ip);
  if (!groups) return ip;
  const keep = rateCfg.ipv6PrefixBits / 16;
  return groups.slice(0, keep).join(':') + '::/' + rateCfg.ipv6PrefixBits;
}

function expandIpv6(ip) {
  const zone = ip.indexOf('%');
  if (zone !== -1) ip = ip.slice(0, zone);
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    return head.map(pad);
  }
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  return [...head, ...Array(missing).fill('0'), ...tail].map(pad);
}
const pad = (g) => (g || '0').padStart(4, '0').toLowerCase();

/* ------------------------------------------------------------------ signing secret */

/**
 * Rotates daily with a grace window, so a token minted just before rotation stays valid rather than
 * failing for a reader mid-question. The secret is process-local: it is not persisted, so a restart
 * invalidates outstanding tokens, which is a re-mint rather than an error.
 */
class RotatingSecret {
  #current = randomBytes(32);
  #previous = null;
  #rotatedAt = Date.now();

  get current() {
    this.#rotateIfNeeded();
    return this.#current;
  }

  keys() {
    this.#rotateIfNeeded();
    return this.#previous
      && Date.now() - this.#rotatedAt < sessionCfg.secretGraceSeconds * 1000
      ? [this.#current, this.#previous]
      : [this.#current];
  }

  #rotateIfNeeded() {
    if (Date.now() - this.#rotatedAt > 86_400_000) {
      this.#previous = this.#current;
      this.#current = randomBytes(32);
      this.#rotatedAt = Date.now();
    }
  }
}

/* ------------------------------------------------------------------ proof of work */

/**
 * A single solve at mint. Its job is to require a JavaScript-executing client, which removes the
 * traffic this endpoint will actually attract: crawlers, scanners and curl loops that never run the
 * page script. It is not a cost control, and the difficulty is set for a slow phone rather than for
 * an attacker, because no tolerable difficulty changes the economics when a CPU-second costs an
 * attacker a thousandth of what the question it unlocks costs us.
 *
 * Challenges are single-use and expire, so one solve cannot mint a stream of sessions.
 */
export class ProofOfWork {
  #issued = new Map(); // challenge -> issuedAt

  issue() {
    this.#sweep();
    const challenge = randomBytes(16).toString('hex');
    this.#issued.set(challenge, Date.now());
    return { challenge, bits: powCfg.bits };
  }

  /** @returns {{ok: true} | {ok: false, reason: string}} */
  verify(challenge, nonce) {
    if (!powCfg.enabled) return { ok: true };
    this.#sweep();
    if (typeof challenge !== 'string' || typeof nonce !== 'string') {
      return { ok: false, reason: 'malformed' };
    }
    if (!this.#issued.has(challenge)) return { ok: false, reason: 'unknown or expired challenge' };

    const digest = createHash('sha256').update(`${challenge}:${nonce}`).digest();
    if (leadingZeroBits(digest) < powCfg.bits) return { ok: false, reason: 'insufficient work' };

    this.#issued.delete(challenge); // single use
    return { ok: true };
  }

  #sweep() {
    const cutoff = Date.now() - powCfg.challengeTtlSeconds * 1000;
    for (const [c, at] of this.#issued) if (at < cutoff) this.#issued.delete(c);
    // Bound memory if somebody requests challenges in a loop without solving them.
    if (this.#issued.size > 50_000) {
      const excess = this.#issued.size - 50_000;
      let i = 0;
      for (const c of this.#issued.keys()) {
        if (i++ >= excess) break;
        this.#issued.delete(c);
      }
    }
  }
}

export function leadingZeroBits(buf) {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) { bits += 8; continue; }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

/* ------------------------------------------------------------------ sessions */

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(s, 'base64url');

export class SessionStore {
  #secret = new RotatingSecret();
  #state = new Map();  // sid -> counters
  #mints = new Map();  // ipKey -> timestamps
  #requests = new Map(); // ipKey -> timestamps
  #concurrent = new Map(); // ipKey -> count
  pow = new ProofOfWork();

  /* ---------------- minting */

  /** @returns {{ok: true, token: string, expiresAt: number} | {ok: false, status: number, reason: string}} */
  mint({ ip, challenge, nonce }) {
    const key = ipKey(ip);

    const solved = this.pow.verify(challenge, nonce);
    if (!solved.ok) return { ok: false, status: 400, reason: solved.reason };

    this.#sweepWindow(this.#mints, key, 3_600_000);
    const mints = this.#mints.get(key) ?? [];
    if (mints.length >= sessionCfg.maxMintsPerIpHour) {
      return { ok: false, status: 429, reason: 'too many sessions from this address in the last hour' };
    }
    mints.push(Date.now());
    this.#mints.set(key, mints);

    const sid = randomBytes(16).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      sid,
      iat: now,
      exp: now + sessionCfg.ttlSeconds,
      // A keyed hash, never the address. Rotating the key daily means yesterday's hashes cannot be
      // relinked to an address even by us, which is what keeps the logs out of scope as personal data.
      ipk: this.#ipHash(key),
    };
    const body = b64u(JSON.stringify(payload));
    const sig = b64u(createHmac('sha256', this.#secret.current).update(body).digest());

    this.#state.set(sid, {
      requests: 0,
      tokens: 0,
      regens: 0,
      lastTurnId: null,
      createdAt: Date.now(),
      expiresAt: payload.exp * 1000,
    });

    return { ok: true, token: `${body}.${sig}`, expiresAt: payload.exp * 1000 };
  }

  #ipHash(key) {
    return createHmac('sha256', this.#secret.current).update(key).digest('base64url').slice(0, 12);
  }

  /* ---------------- verification */

  /**
   * @returns {{ok: true, sid: string, strict: boolean} | {ok: false, status: number, reason: string}}
   *
   * A mismatched IP hash does not reject. A mobile reader changes address on a cell handover, and
   * rejecting them mid-conversation punishes exactly the audience this is for. Such a session is
   * marked `strict` and gets the tighter per-request budget instead.
   */
  verify({ token, ip }) {
    if (typeof token !== 'string' || !token.includes('.')) {
      return { ok: false, status: 401, reason: 'missing session' };
    }
    const [body, sig] = token.split('.', 2);

    let matched = false;
    for (const key of this.#secret.keys()) {
      const expect = createHmac('sha256', key).update(body).digest();
      const given = unb64u(sig);
      if (given.length === expect.length && timingSafeEqual(given, expect)) { matched = true; break; }
    }
    if (!matched) return { ok: false, status: 401, reason: 'bad session signature' };

    let payload;
    try {
      payload = JSON.parse(unb64u(body).toString('utf8'));
    } catch {
      return { ok: false, status: 401, reason: 'malformed session' };
    }

    const now = Math.floor(Date.now() / 1000);
    if (!payload.exp || payload.exp < now) return { ok: false, status: 401, reason: 'session expired' };

    const state = this.#state.get(payload.sid);
    if (!state) {
      // Signature valid but the process restarted, or the session was evicted. Ask for a re-mint
      // rather than trusting a token whose counters we no longer hold, since an unbacked token has
      // no budget attached to it.
      return { ok: false, status: 401, reason: 'session no longer held, re-mint' };
    }

    const strict = payload.ipk !== this.#ipHash(ipKey(ip));
    return { ok: true, sid: payload.sid, strict, state };
  }

  /* ---------------- per-session budget */

  /** @returns {{allowed: boolean, reason?: string, remaining: {requests: number, tokens: number}}} */
  checkSession(sid) {
    const s = this.#state.get(sid);
    if (!s) return { allowed: false, reason: 'unknown session', remaining: { requests: 0, tokens: 0 } };

    const remaining = {
      requests: Math.max(0, sessionCfg.maxRequests - s.requests),
      tokens: Math.max(0, sessionCfg.maxTokens - s.tokens),
    };
    if (s.requests >= sessionCfg.maxRequests) {
      return { allowed: false, reason: 'session question limit reached', remaining };
    }
    if (s.tokens >= sessionCfg.maxTokens) {
      return { allowed: false, reason: 'session token limit reached', remaining };
    }
    return { allowed: true, remaining };
  }

  /** Counts non-cached tokens only, so a cache read is free to the reader as well as to us. */
  recordUsage(sid, usage) {
    const s = this.#state.get(sid);
    if (!s) return;
    s.requests += 1;
    s.tokens += (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0) + (usage?.cacheWriteInputTokens ?? 0);
  }

  /** Regenerating costs what asking costs, so it draws on the same quota. */
  checkRegen(sid, turnId) {
    const s = this.#state.get(sid);
    if (!s) return { allowed: false, reason: 'unknown session' };
    if (s.lastTurnId !== turnId) { s.lastTurnId = turnId; s.regens = 0; }
    if (s.regens >= sessionCfg.maxRegensPerTurn) {
      return { allowed: false, reason: 'already regenerated this answer once' };
    }
    s.regens += 1;
    return { allowed: true };
  }

  /* ---------------- per-IP rate limiting */

  /** Sliding window, which avoids the fixed-window edge where a caller gets double the limit. */
  checkRate(ip) {
    const key = ipKey(ip);
    this.#sweepWindow(this.#requests, key, 60_000);
    const hits = this.#requests.get(key) ?? [];
    if (hits.length >= rateCfg.perIpPerMinute + rateCfg.perIpBurst) {
      return { allowed: false, reason: 'too many requests, wait a moment', retryAfter: 30 };
    }
    hits.push(Date.now());
    this.#requests.set(key, hits);
    return { allowed: true };
  }

  /**
   * Concurrency matters more than request rate for a streaming endpoint, because one request occupies
   * a connection for the whole generation rather than for a few milliseconds.
   */
  acquireSlot(ip) {
    const key = ipKey(ip);
    const n = this.#concurrent.get(key) ?? 0;
    if (n >= rateCfg.perIpConcurrent) return null;
    this.#concurrent.set(key, n + 1);
    return () => {
      const c = (this.#concurrent.get(key) ?? 1) - 1;
      if (c <= 0) this.#concurrent.delete(key);
      else this.#concurrent.set(key, c);
    };
  }

  #sweepWindow(map, key, windowMs) {
    const cutoff = Date.now() - windowMs;
    const arr = (map.get(key) ?? []).filter((t) => t >= cutoff);
    if (arr.length) map.set(key, arr);
    else map.delete(key);
  }

  /** Called periodically. Bounds memory and drops expired sessions. */
  sweep() {
    const now = Date.now();
    for (const [sid, s] of this.#state) if (s.expiresAt < now) this.#state.delete(sid);
    if (this.#state.size > 50_000) {
      const sorted = [...this.#state.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
      for (const [sid] of sorted.slice(0, this.#state.size - 50_000)) this.#state.delete(sid);
    }
  }

  get stats() {
    return {
      sessions: this.#state.size,
      trackedIps: this.#requests.size,
      inFlight: [...this.#concurrent.values()].reduce((a, b) => a + b, 0),
    };
  }
}
