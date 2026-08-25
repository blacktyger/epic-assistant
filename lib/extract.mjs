/**
 * Turns the built Docusaurus site into retrievable sections.
 *
 * Reads `site/build`, not `site/docs`, and the difference is not a preference. The rendered HTML is
 * 90,150 tokens against roughly 48,000 for the MDX source, because `<RpcGroup>` expands
 * `src/data/rpcSpec.js` into the full JSON-RPC method tables and `<Ver k="node" />` only becomes
 * "4.0.3" at render time. A source-based extractor silently drops the entire API reference, which is
 * the part developers ask about most.
 *
 * Known gap this module closes deliberately: the extractor takes the <article> element, so the site
 * footer never reaches the corpus. During the proof run the model answered a refusal with a Telegram
 * link that was correct but absent from the context it was given, sourced from pretraining rather
 * than from the docs. Community links therefore belong in the core block, not in extracted sections.
 */

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#x27;': "'",
  '&nbsp;': ' ', '&mdash;': '\u2014', '&ndash;': '\u2013', '&hellip;': '...',
  '&rsquo;': '\u2019', '&lsquo;': '\u2018', '&ldquo;': '\u201c', '&rdquo;': '\u201d',
  '&times;': '\u00d7', '&larr;': '<-', '&rarr;': '->', '&copy;': '\u00a9', '&middot;': '\u00b7',
};

export function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&[a-z]+;/gi, (m) => ENTITIES[m] ?? m);
}

/** Docusaurus heading slug, matching what the site actually emits so anchors resolve. */
export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

/**
 * Converts one page's article HTML into markdown-ish text.
 *
 * Code fences are emitted whole and never split, because for this corpus the fenced content is
 * frequently the answer itself: `only_randomx = true` and `--min_conf 3` are what a reader came for.
 */
export function articleToText(html) {
  const article = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  let s = article ? article[1] : '';
  if (!s) return '';

  // Theme chrome that carries no page content.
  s = s.replace(/<(script|style|svg|nav|button|form)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<div class="theme-doc-breadcrumbs[^"]*"[^>]*>[\s\S]*?<\/div>/gi, ' ');
  s = s.replace(/<div class="theme-doc-toc[^"]*"[^>]*>[\s\S]*?<\/div>/gi, ' ');
  // "Edit this page" and prev/next footer inside the article.
  s = s.replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, ' ');

  // Code blocks first, so later tag stripping cannot touch their contents.
  const fences = [];
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner) => {
    const lang = inner.match(/language-([a-z0-9]+)/i)?.[1] ?? '';
    // Docusaurus wraps each line in a span; the line structure lives in those, not in newlines.
    const lines = [...inner.matchAll(/<span[^>]*class="[^"]*token-line[^"]*"[^>]*>([\s\S]*?)<\/span>\s*(?=<span[^>]*class="[^"]*token-line|$)/gi)];
    let code;
    if (lines.length) {
      code = lines.map((m) => decodeEntities(m[1].replace(/<[^>]+>/g, ''))).join('\n');
    } else {
      code = decodeEntities(inner.replace(/<[^>]+>/g, ''));
    }
    code = code.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/gm, '').trim();
    fences.push('```' + lang + '\n' + code + '\n```');
    return `\n\u0000FENCE${fences.length - 1}\u0000\n`;
  });

  // Headings, dropping the anchor hash link Docusaurus appends.
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lvl, inner) => {
    const t = decodeEntities(
      inner.replace(/<a\b[^>]*class="[^"]*hash-link[^"]*"[^>]*>[\s\S]*?<\/a>/gi, '').replace(/<[^>]+>/g, ''),
    ).replace(/\s+/g, ' ').trim();
    return `\n\n${'#'.repeat(Number(lvl))} ${t}\n`;
  });

  // Tables as pipe rows. The widest config tables are the densest content on the site.
  s = s.replace(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi, (_, row) => {
    const cells = [...row.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((m) =>
      decodeEntities(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(),
    );
    return cells.length ? `\n| ${cells.join(' | ')} |` : '';
  });

  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<\/(p|div|section|ul|ol|table|blockquote|dl|dt|dd|details|summary)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);

  s = s
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n');

  // Restore fences last.
  s = s.replace(/\u0000FENCE(\d+)\u0000/g, (_, i) => fences[Number(i)]);
  return s.trim();
}

/**
 * Splits page text into sections at h2 and h3.
 *
 * Each section carries the heading breadcrumb, which is prepended to the indexed text. That single
 * trick is the highest-value, lowest-cost retrieval improvement available on a heading-structured
 * corpus: "Wallet Owner API v3 > Methods by what they can do" disambiguates a section that would
 * otherwise be an unlabelled table of method names.
 *
 * Sections longer than `maxChars` are sub-split, because one oversized section defeats the point of a
 * prefilter: the largest here is a complete worked client at 20,206 characters, roughly 6,100 tokens,
 * which costs as much to retrieve as fourteen median sections. Sub-splits break on code-fence and
 * paragraph boundaries only, never inside a fence, since a half-shown config snippet is worse than no
 * snippet. Every part keeps the parent breadcrumb and anchor so citations still resolve.
 */
export function splitSections({ text, url, title, maxChars = 3500 }) {
  const lines = text.split('\n');
  const sections = [];
  let current = null;
  let h2 = null;
  let inFence = false;

  const push = () => {
    if (!current) return;
    const body = current.lines.join('\n').trim();
    if (body) {
      current.text = body;
      sections.push(current);
    }
  };

  const start = (heading, level) => {
    push();
    const anchor = heading ? slugify(heading) : '';
    const crumbs = [title];
    if (level === 3 && h2) crumbs.push(h2);
    if (heading) crumbs.push(heading);
    current = {
      id: `${url}#${anchor}`,
      url: anchor ? `${url}#${anchor}` : url,
      pageUrl: url,
      pageTitle: title,
      heading: heading ?? null,
      level,
      breadcrumb: crumbs.join(' > '),
      lines: [],
    };
  };

  start(null, 1); // preamble before the first h2

  for (const line of lines) {
    if (/^```/.test(line)) inFence = !inFence;
    // A "## " inside a fence is shell output or a comment, not a heading.
    if (!inFence) {
      const m = line.match(/^(#{2,3}) (.+)$/);
      if (m) {
        const level = m[1].length;
        const heading = m[2].trim();
        if (level === 2) h2 = heading;
        start(heading, level);
        continue;
      }
      if (/^# (.+)$/.test(line)) continue; // page h1 duplicates the title
    }
    current.lines.push(line);
  }
  push();

  return sections.flatMap((s) => {
    delete s.lines;
    return s.text.length > maxChars ? subSplit(s, maxChars) : [s];
  });
}

/** Break an oversized section into parts on fence and blank-line boundaries. */
function subSplit(section, maxChars) {
  const blocks = [];
  let buf = [];
  let inFence = false;

  for (const line of section.text.split('\n')) {
    const fenceEdge = /^```/.test(line);
    if (fenceEdge && !inFence) {
      // A fence starts: the preceding prose is its own block so the fence stays whole.
      if (buf.length) { blocks.push(buf.join('\n')); buf = []; }
      inFence = true;
      buf.push(line);
      continue;
    }
    if (fenceEdge && inFence) {
      inFence = false;
      buf.push(line);
      blocks.push(buf.join('\n'));
      buf = [];
      continue;
    }
    if (!inFence && line.trim() === '' && buf.length) {
      blocks.push(buf.join('\n'));
      buf = [];
      continue;
    }
    buf.push(line);
  }
  if (buf.length) blocks.push(buf.join('\n'));

  const parts = [];
  let acc = [];
  let accLen = 0;
  const flush = () => {
    if (!acc.length) return;
    parts.push(acc.join('\n\n').trim());
    acc = [];
    accLen = 0;
  };
  for (const b of blocks) {
    // An indivisible block bigger than the budget goes out alone rather than being cut.
    if (b.length >= maxChars) { flush(); parts.push(b); continue; }
    if (accLen + b.length > maxChars) flush();
    acc.push(b);
    accLen += b.length + 2;
  }
  flush();

  return parts.filter(Boolean).map((text, i) => ({
    ...section,
    id: `${section.id}~${i + 1}`,
    part: i + 1,
    partsTotal: parts.length,
    breadcrumb: parts.length > 1 ? `${section.breadcrumb} (part ${i + 1} of ${parts.length})` : section.breadcrumb,
    text,
  }));
}
