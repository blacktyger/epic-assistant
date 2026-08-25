/**
 * Output guards. These run over the model's output, not its input.
 *
 * Input-side jailbreak detection is deliberately absent. Regex matching on a reader's question has a
 * high false-positive rate on exactly the subjects this documentation covers, and a bot that refuses
 * "how do I verify a signature" or "where is my seed stored" is worse than useless on a privacy-coin
 * site. The blast radius here is also small: the model has no tools, no side effects and nothing
 * private to leak, since its whole context is public documentation. So the guards target the one
 * output that can actually harm a reader.
 *
 * That output is a link. This is a cryptocurrency project, and an invented wallet download URL is a
 * real user-harm event in a way that a jailbroken poem is not. The allowlist is the highest-value
 * control in this file.
 */
import { guards as guardCfg } from '../config.mjs';

/* ------------------------------------------------------------------ streaming guard */

/**
 * Wraps a token stream and enforces the guards as text arrives.
 *
 * Links have to be handled on a completed buffer rather than per delta, because a markdown link
 * arrives across several deltas and a half-written URL cannot be judged. So text is released to the
 * client only once it can no longer be part of an unfinished link, which is what `flushable` computes.
 * The visible effect is that text occasionally arrives a few characters behind; the alternative is
 * emitting a URL and retracting it, which is worse.
 */
export class OutputGuard {
  #buffer = '';
  #released = '';
  #canary;
  #findings = [];
  /**
   * A rolling tail of everything the model has produced, used only for loop detection.
   *
   * Kept separately from #buffer because #buffer is drained on almost every push once the text is
   * safe to release, so repeated output never accumulates there and a check against it can never
   * fire. Bounded so a long answer does not grow this without limit.
   */
  #tail = '';

  constructor({ canary }) {
    this.#canary = canary;
  }

  /**
   * @param {string} delta
   * @returns {{emit: string, abort?: string}}
   */
  push(delta) {
    this.#buffer += delta;
    this.#tail = (this.#tail + delta).slice(-guardCfg.repeatWindow * (guardCfg.repeatLimit + 2));

    // The canary means the system prompt is being echoed. Stop immediately: this is the one guard
    // that aborts rather than sanitises, because a stream that is reciting instructions is not going
    // to become a useful answer.
    if (this.#buffer.includes(this.#canary) || this.#tail.includes(this.#canary)) {
      this.#findings.push('canary');
      return { emit: '', abort: 'canary' };
    }

    if (this.#degenerate()) {
      this.#findings.push('repetition');
      return { emit: '', abort: 'repetition' };
    }

    const cut = flushable(this.#buffer);
    if (cut === 0) return { emit: '' };

    const ready = this.#buffer.slice(0, cut);
    this.#buffer = this.#buffer.slice(cut);
    const { text, findings } = sanitiseLinks(ready);
    this.#findings.push(...findings);
    this.#released += text;
    return { emit: text };
  }

  /** Releases whatever is left once the model has stopped. */
  finish() {
    if (!this.#buffer) return { emit: '' };
    const { text, findings } = sanitiseLinks(this.#buffer);
    this.#buffer = '';
    this.#findings.push(...findings);
    this.#released += text;
    return { emit: text };
  }

  get text() {
    return this.#released;
  }

  get findings() {
    return [...new Set(this.#findings)];
  }

  /**
   * Catches a model stuck in a loop.
   *
   * Counts occurrences of the most recent window inside the rolling tail rather than comparing
   * adjacent windows. Adjacent comparison silently assumes the loop period equals the window size: a
   * model repeating a 41-character phrase against a 40-character window never lines up, so the check
   * reads as clean while the loop runs. Occurrence counting is period-agnostic.
   */
  #degenerate() {
    const w = guardCfg.repeatWindow;
    if (this.#tail.length < w * (guardCfg.repeatLimit + 1)) return false;

    const unit = this.#tail.slice(-w);
    // A unit of whitespace or one repeated character is not evidence of a loop.
    if (/^\s*$/.test(unit) || new Set(unit).size <= 2) return false;

    let count = 0;
    let from = 0;
    for (;;) {
      const at = this.#tail.indexOf(unit, from);
      if (at === -1) break;
      count += 1;
      if (count >= guardCfg.repeatLimit) return true;
      from = at + 1; // overlapping occurrences still count as repetition
    }
    return false;
  }
}

/**
 * How much of the buffer is safe to release.
 *
 * Holds back a trailing fragment that could still become a markdown link or a bare URL. Anything
 * before the last unmatched '[' or the last whitespace-delimited token that looks like the start of a
 * scheme is releasable.
 */
export function flushable(buf) {
  let hold = buf.length;

  // An unclosed markdown link or image.
  const lastOpen = Math.max(buf.lastIndexOf('['), buf.lastIndexOf('!['));
  if (lastOpen !== -1) {
    const after = buf.slice(lastOpen);
    // Closed and fully formed: '[text](url)' can be judged, so it does not need holding.
    if (!/^!?\[[^\]]*\]\([^)]*\)/.test(after)) hold = Math.min(hold, lastOpen);
  }

  // A bare URL still being typed. Only the final token matters.
  const lastSpace = Math.max(buf.lastIndexOf(' '), buf.lastIndexOf('\n'), buf.lastIndexOf('\t'));
  const tail = buf.slice(lastSpace + 1);
  if (tail && /^(h|ht|htt|http|https|https:|https:\/|https:\/\/|http:|http:\/|http:\/\/)/i.test(tail)) {
    hold = Math.min(hold, lastSpace + 1);
  } else if (/^[a-z][a-z0-9+.-]*:\/\/\S*$/i.test(tail)) {
    hold = Math.min(hold, lastSpace + 1);
  }

  return Math.max(0, hold);
}

/* ------------------------------------------------------------------ link allowlist */

const MD_LINK = /(!?)\[([^\]]*)\]\(\s*([^)\s]+)(\s+"[^"]*")?\s*\)/g;
const BARE_URL = /\b([a-z][a-z0-9+.-]*:\/\/[^\s<>"'`)\]]+)/gi;

/**
 * Strips links whose host is not allowlisted, and all images.
 *
 * Images are removed outright rather than filtered. The docs render markdown from a model, and an
 * image URL causes the reader's browser to fetch a remote asset; this project self-hosts fonts and
 * rejected Algolia specifically to avoid third-party requests, so a model-authored image is a
 * violation of that stance by construction. There is no case where the assistant needs one.
 */
export function sanitiseLinks(text) {
  const findings = [];

  let out = text.replace(MD_LINK, (whole, bang, label, url) => {
    if (bang === '!') {
      findings.push('image-stripped');
      return label || '';
    }
    if (isAllowed(url)) return whole;
    findings.push(`link-stripped:${hostOf(url) ?? url.slice(0, 40)}`);
    // Keep the words, drop the link. The sentence still reads.
    return label || '';
  });

  out = out.replace(BARE_URL, (url) => {
    if (isAllowed(url)) return url;
    findings.push(`url-stripped:${hostOf(url) ?? url.slice(0, 40)}`);
    return '[link removed]';
  });

  return { text: out, findings };
}

export function isAllowed(url) {
  // Relative links are same-origin by definition, so they are fine and common in citations.
  if (url.startsWith('/') || url.startsWith('#')) return true;
  const host = hostOf(url);
  if (!host) return false;
  return guardCfg.allowedHosts.some((h) => host === h || host.endsWith(`.${h}`));
}

function hostOf(url) {
  try {
    const u = new URL(url);
    // Only web schemes. A javascript:, data: or file: URL has no business in an answer.
    if (u.protocol !== 'https:' && u.protocol !== 'http:' && u.protocol !== 'mailto:') return null;
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ citations */

/**
 * Extracts citations and validates each against the anchors the corpus actually contains.
 *
 * This is what makes citations reliable rather than decorative. The instruction to cite is advice and
 * the model can drift; this is the gate. A citation that 404s is worse than no citation, because it
 * looks like evidence and is not.
 *
 * Note honestly what a citation attests to here: the model used a section that was supplied to it.
 * With retrieval that is stronger than whole-corpus stuffing, where a citation was only a claim, but
 * it is still not a retrieval trace. Precise anchors are what let a reader check in one click.
 */
export function extractCitations(text, knownById) {
  const seen = new Map();
  const invalid = [];

  for (const m of text.matchAll(MD_LINK)) {
    if (m[1] === '!') continue;
    const url = m[3];
    const label = m[2];
    if (!url.includes('devdocs.epiccash.com') && !url.startsWith('/')) continue;

    const normalised = normaliseDocUrl(url);
    const section = knownById.get(normalised);
    if (section) {
      if (!seen.has(normalised)) {
        seen.set(normalised, {
          url: section.url,
          title: section.heading ?? section.pageTitle,
          breadcrumb: section.breadcrumb,
          pageTitle: section.pageTitle,
          label,
        });
      }
    } else {
      invalid.push(url);
    }
  }

  return { citations: [...seen.values()], invalid };
}

/**
 * Sub-split sections carry ids like `<url>#<anchor>~3`, which are internal. A citation to the anchor
 * should resolve to the section regardless of which part the model was shown, so ids are matched on
 * the anchor and the part suffix is ignored.
 */
export function buildCitationIndex(sections) {
  const map = new Map();
  for (const s of sections) {
    const key = normaliseDocUrl(s.url);
    if (!map.has(key)) map.set(key, s);
    // Also index the bare page, since a citation to a page without an anchor is legitimate.
    const page = normaliseDocUrl(s.pageUrl);
    if (!map.has(page)) map.set(page, { ...s, heading: s.pageTitle, url: s.pageUrl });
  }
  return map;
}

function normaliseDocUrl(url) {
  let u = url.trim();
  u = u.replace(/~\d+$/, '');
  if (u.startsWith('/')) u = `https://devdocs.epiccash.com${u}`;
  u = u.replace(/^http:/, 'https:');
  // Trailing slash before the anchor is how Docusaurus emits routes; normalise both forms.
  const [base, anchor] = u.split('#');
  const withSlash = base.endsWith('/') ? base : `${base}/`;
  return anchor ? `${withSlash}#${anchor}` : withSlash;
}
