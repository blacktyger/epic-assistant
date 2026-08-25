/**
 * Question logging.
 *
 * The reason to log at all: every question the assistant could not answer is a page somebody should
 * write. That list is arguably worth more than the assistant, and it only exists if questions are
 * recorded.
 *
 * The reason to be careful: people paste things into a chat box that they would never type into a
 * search box. On a cryptocurrency site somebody will eventually paste a seed phrase, and a seed phrase
 * sitting in a log file is a worse incident than any cost-abuse attack this service is defended
 * against.
 *
 * So redaction runs at the moment of writing, never as a later cleanup pass. "We will clean the logs
 * later" is precisely how secrets end up in backups, and a backup is not covered by a later pass.
 *
 * Not recorded, deliberately: raw IP addresses (a daily-rotated keyed hash only, which is why
 * yesterday's hashes cannot be relinked even by us), User-Agent in the same record as a question, and
 * full model output. Bedrock's own model invocation logging stays off for the same reason: it captures
 * complete prompts and completions with an indefinite default retention, which would convert an
 * observability feature into an EU personal-data store.
 */
import { appendFileSync, mkdirSync, readdirSync, unlinkSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logging as logCfg } from '../config.mjs';

/* ------------------------------------------------------------------ redaction */

/**
 * A BIP39 phrase is 12, 15, 18, 21 or 24 words from a fixed list. Matching the wordlist itself would
 * mean shipping 2,048 words and would still miss other languages, so the shape is matched instead: a
 * long run of short lowercase alphabetic words with no punctuation. That over-matches occasionally,
 * which is the correct direction for this trade.
 */
const SEED_RUN = /\b(?:[a-z]{3,8}\s+){11,}[a-z]{3,8}\b/gi;

const PATTERNS = [
  [SEED_RUN, '[seed-phrase-redacted]'],
  // Private keys, commitments, hashes, signatures.
  [/\b(?:0x)?[0-9a-f]{32,}\b/gi, '[hex-redacted]'],
  // Epicbox addresses are 52 base58 characters; slatepack and base64 blobs run longer.
  [/\b[1-9A-HJ-NP-Za-km-z]{26,}\b/g, '[address-redacted]'],
  [/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '[blob-redacted]'],
  [/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '[email-redacted]'],
  // Anything a reader labelled as a secret themselves.
  [/\b(password|passphrase|mnemonic|seed|secret|api[_-]?secret|private[_-]?key)\b\s*[:=]?\s*\S+/gi, '$1 [value-redacted]'],
];

/**
 * @param {string} text
 * @returns {{text: string, redacted: string[]}}
 *
 * Replacements are staged behind placeholders and restored at the end. Without that, one pattern
 * rewrites another's output: the labelled-secret rule matches the word "seed" inside the marker
 * `[seed-phrase-redacted]` that the seed-phrase rule just inserted, producing nested garbage like
 * `[seed [value-redacted]`. Staging makes the rules order-independent, which matters because the
 * whole point of this function is that it cannot be partially correct.
 */
export function redact(text) {
  const stash = [];
  const park = (marker) => {
    stash.push(marker);
    return `\u0000R${stash.length - 1}\u0000`;
  };

  let out = text;
  const applied = [];
  for (const [re, replacement] of PATTERNS) {
    const before = out;
    out = out.replace(re, (...args) => {
      // The labelled-secret rule keeps its label group, so the replacement is rendered first and
      // only the marker itself is parked.
      const rendered = replacement.replace(/\$1/g, args[1] ?? '');
      const markerMatch = rendered.match(/\[[a-z-]+-redacted\]/);
      if (!markerMatch) return park(rendered);
      const marker = markerMatch[0];
      return rendered.replace(marker, park(marker));
    });
    if (out !== before) {
      applied.push(replacement.replace(/^\$1 /, ''));
    }
  }

  out = out.replace(/\u0000R(\d+)\u0000/g, (_, i) => stash[Number(i)]);
  return { text: out, redacted: [...new Set(applied)] };
}

/* ------------------------------------------------------------------ writer */

export class QuestionLog {
  #dir;

  constructor({ dir = logCfg.dir } = {}) {
    this.#dir = dir;
    mkdirSync(this.#dir, { recursive: true });
    this.prune();
  }

  #path(day = new Date().toISOString().slice(0, 10)) {
    return join(this.#dir, `${day}.jsonl`);
  }

  /**
   * One JSON object per line. Append-only, so a crash cannot corrupt earlier records, and a line is
   * small enough that a single append is atomic in practice.
   */
  write(record) {
    const { text, redacted } = redact(String(record.question ?? ''));
    const line = {
      at: new Date().toISOString(),
      sid: record.sid ?? null,
      ipHash: record.ipHash ?? null,
      question: text.slice(0, logCfg.maxQuestionChars),
      questionChars: String(record.question ?? '').length,
      redacted: redacted.length ? redacted : undefined,
      model: record.model ?? null,
      // Quality and safety metrics, which are the highest value per byte of anything here.
      refused: Boolean(record.refused),
      citations: record.citations ?? 0,
      citationsInvalid: record.citationsInvalid ?? 0,
      followup: Boolean(record.followup),
      guardFindings: record.guardFindings?.length ? record.guardFindings : undefined,
      retrievedSections: record.retrievedSections ?? 0,
      retrievedTokens: record.retrievedTokens ?? 0,
      cacheHit: record.cacheHit ?? null,
      answerCached: Boolean(record.answerCached),
      tier: record.tier ?? 'open',
      limitHit: record.limitHit ?? undefined,
      // Cost and performance.
      usage: record.usage ?? undefined,
      usd: record.usd !== undefined ? Number(record.usd.toFixed(6)) : undefined,
      ms: record.ms ?? undefined,
      stopReason: record.stopReason ?? undefined,
      error: record.error ?? undefined,
    };
    appendFileSync(this.#path(), JSON.stringify(line) + '\n', 'utf8');
  }

  /**
   * Retention, enforced rather than declared. Runs on construction and is called daily by the server.
   */
  prune() {
    if (!existsSync(this.#dir)) return;
    const cutoff = new Date(Date.now() - logCfg.retentionDays * 86_400_000).toISOString().slice(0, 10);
    let removed = 0;
    for (const f of readdirSync(this.#dir)) {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (m && m[1] < cutoff) { unlinkSync(join(this.#dir, f)); removed += 1; }
    }
    return removed;
  }

  /**
   * Content-gap report: the questions that were refused or cited nothing, grouped so a docs author
   * can read it. This is the artefact the whole logging decision exists to produce.
   */
  gaps({ days = 7 } = {}) {
    const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    const counts = new Map();
    for (const f of readdirSync(this.#dir)) {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (!m || m[1] < since) continue;
      for (const line of readJsonLines(join(this.#dir, f))) {
        if (!line.refused && line.citations > 0) continue;
        const key = line.question.toLowerCase().replace(/\s+/g, ' ').trim();
        const entry = counts.get(key) ?? { question: line.question, n: 0, refused: 0 };
        entry.n += 1;
        if (line.refused) entry.refused += 1;
        counts.set(key, entry);
      }
    }
    return [...counts.values()].sort((a, b) => b.n - a.n);
  }
}

function* readJsonLines(path) {
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch { /* skip a partial final line */ }
  }
}
