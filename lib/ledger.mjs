/**
 * Daily spend ledger and kill switch.
 *
 * This is the only cost control that acts in seconds. AWS Budgets can genuinely stop spend by
 * attaching a deny policy, but its data updates roughly every 8 to 12 hours, so it is a
 * backstop-to-the-backstop rather than a brake. A CloudWatch alarm on Bedrock token metrics gets that
 * down to a minute or so. Neither is fast enough to be the primary control, so this is.
 *
 * Durability with no database: one JSON file per UTC day, written temp then fsync then rename. Rename
 * is a single inode operation, so a crash mid-write leaves the previous good file rather than a
 * truncated one. On start the current day is read back, which means a trip survives `systemctl
 * restart`, an OOM kill and a reboot. Keeping the files also gives a free 90-day cost history.
 *
 * Cost is computed from the `usage` block of the real response, never from an estimate, because
 * `bedrock:CountTokens` is denied for this credential and a pre-flight guess would drift.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, openSync, fsyncSync, closeSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spend as spendConfig, costOf } from '../config.mjs';

const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);

const EMPTY = (date) => ({
  date,
  requests: 0,
  cachedAnswers: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  usdMicros: 0,
  byModel: {},
  state: 'open',
  trippedAt: null,
  softTrippedAt: null,
});

export class SpendLedger {
  #dir;
  #day;
  #data;
  #reserved = 0;

  constructor({ dir = spendConfig.ledgerDir } = {}) {
    this.#dir = dir;
    mkdirSync(this.#dir, { recursive: true });
    this.#day = utcDay();
    this.#data = this.#read(this.#day) ?? EMPTY(this.#day);
    this.prune();
  }

  #path(day) {
    return join(this.#dir, `${day}.json`);
  }

  #read(day) {
    const p = this.#path(day);
    if (!existsSync(p)) return null;
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8'));
      // A ledger that cannot be parsed must not silently reset the day's spend to zero, because that
      // would hand an attacker a budget reset by corrupting one file.
      if (typeof parsed.usdMicros !== 'number' || parsed.date !== day) {
        throw new Error('ledger shape unexpected');
      }
      return parsed;
    } catch (e) {
      const quarantine = `${p}.corrupt-${Date.now()}`;
      renameSync(p, quarantine);
      // Fail closed: assume the hard cap is reached rather than assume zero spent.
      const closed = EMPTY(day);
      closed.state = 'tripped';
      closed.trippedAt = new Date().toISOString();
      closed.note = `previous ledger unreadable (${e.message}), quarantined at ${quarantine}, failing closed`;
      return closed;
    }
  }

  /** Atomic: write a sibling temp file, flush it to disk, then rename over the target. */
  #persist() {
    const p = this.#path(this.#day);
    const tmp = `${p}.tmp`;
    const body = JSON.stringify(this.#data, null, 2);
    const fd = openSync(tmp, 'w');
    try {
      writeFileSync(fd, body, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, p);
  }

  /** Rolls to a new file when the UTC day changes, which is how the cap resets. */
  #rollIfNeeded() {
    const today = utcDay();
    if (today !== this.#day) {
      this.#day = today;
      this.#data = this.#read(today) ?? EMPTY(today);
      this.#reserved = 0;
      this.prune();
    }
  }

  get usd() {
    return this.#data.usdMicros / 1e6;
  }

  get state() {
    return this.#data.state;
  }

  get snapshot() {
    this.#rollIfNeeded();
    return {
      ...this.#data,
      usd: Number(this.usd.toFixed(4)),
      reservedUsd: Number(this.#reserved.toFixed(4)),
      softCap: spendConfig.softDailyUsd,
      hardCap: spendConfig.hardDailyUsd,
    };
  }

  /**
   * Checked before the call, not after. Checking afterwards means the cap is always exceeded by one
   * request, and with in-flight concurrency by up to `maxConcurrent` requests. In-flight cost is
   * reserved up front and reconciled against real usage when the response lands.
   *
   * `reserveUsd` is passed by the caller rather than read from config because the worst case is no
   * longer one number. A reader may select a more expensive model, and a question that triggers live
   * data spends several Bedrock rounds on an accumulating transcript, so the same endpoint now has a
   * range of about 5x between its cheapest and dearest request. `config.reserveFor` derives it.
   *
   * @param {number} [reserveUsd]
   * @returns {{allowed: boolean, tier: 'open'|'soft'|'hard', reason?: string}}
   */
  check(reserveUsd = spendConfig.reserveUsdPerRequest) {
    this.#rollIfNeeded();

    if (this.#data.state === 'tripped') {
      return { allowed: false, tier: 'hard', reason: 'daily hard cap reached' };
    }

    const projected = this.usd + this.#reserved + reserveUsd;

    if (projected > spendConfig.hardDailyUsd) {
      this.trip('hard cap reached by projection');
      return { allowed: false, tier: 'hard', reason: 'daily hard cap reached' };
    }
    if (projected > spendConfig.softDailyUsd) {
      if (!this.#data.softTrippedAt) {
        this.#data.softTrippedAt = new Date().toISOString();
        this.#persist();
      }
      return { allowed: false, tier: 'soft', reason: 'daily soft cap reached' };
    }
    return { allowed: true, tier: 'open' };
  }

  /**
   * Holds budget for an in-flight request so concurrent calls cannot collectively overshoot.
   *
   * The release closure captures the amount it reserved. Reading it from config on release would
   * subtract the wrong figure once the amount became per-request, and the drift is one-directional:
   * reserved budget would leak upward until the cap tripped on requests that had already finished.
   */
  reserve(reserveUsd = spendConfig.reserveUsdPerRequest) {
    this.#reserved += reserveUsd;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#reserved = Math.max(0, this.#reserved - reserveUsd);
    };
  }

  /** Records real usage. Called once per completed Bedrock response. */
  record({ modelId, usage, ttl }) {
    this.#rollIfNeeded();
    const usd = costOf(modelId, usage, ttl);

    this.#data.requests += 1;
    this.#data.inputTokens += usage?.inputTokens ?? 0;
    this.#data.outputTokens += usage?.outputTokens ?? 0;
    this.#data.cacheReadTokens += usage?.cacheReadInputTokens ?? 0;
    this.#data.cacheWriteTokens += usage?.cacheWriteInputTokens ?? 0;
    this.#data.usdMicros += Math.round(usd * 1e6);

    const m = (this.#data.byModel[modelId] ??= { requests: 0, usdMicros: 0 });
    m.requests += 1;
    m.usdMicros += Math.round(usd * 1e6);

    if (this.usd > spendConfig.hardDailyUsd && this.#data.state !== 'tripped') {
      this.trip('hard cap reached by recorded spend');
    } else {
      this.#persist();
    }
    return usd;
  }

  /** A cached answer costs nothing but is worth counting, so the hit rate is visible. */
  recordCachedAnswer() {
    this.#rollIfNeeded();
    this.#data.cachedAnswers += 1;
    this.#persist();
  }

  /**
   * Trips the switch. Also the manual kill: write `"state": "tripped"` into today's file and the
   * next `#rollIfNeeded` picks it up, or restart the service and it reads it on start. No deploy.
   */
  trip(reason) {
    this.#data.state = 'tripped';
    this.#data.trippedAt = new Date().toISOString();
    this.#data.tripReason = reason;
    this.#persist();
  }

  /** Deliberate reopen, for use after raising a cap or after investigating. */
  reset() {
    this.#data.state = 'open';
    this.#data.trippedAt = null;
    this.#data.tripReason = null;
    this.#persist();
  }

  /** Retention. An unenforced policy is worse than an honest longer one. */
  prune() {
    const cutoff = new Date(Date.now() - spendConfig.keepDays * 86_400_000).toISOString().slice(0, 10);
    for (const f of readdirSync(this.#dir)) {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
      if (m && m[1] < cutoff) unlinkSync(join(this.#dir, f));
    }
  }
}
