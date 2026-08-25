#!/usr/bin/env node
/**
 * Builds the assistant corpus from the rendered docs site.
 *
 * Run after `npm run build` in ../epic-devdocs/site, because this reads the build output rather than
 * the MDX source. Emits, into dist/:
 *
 *   corpus.json      sections with breadcrumbs, anchors and a prebuilt minisearch index
 *   core.txt         the always-present, always-cached prompt block
 *   llms.txt         the llmstxt.org index, a free by-product
 *   llms-full.txt    the whole corpus as one document, for agents that want it
 *   stats.json       token and section counts, for the cost model
 *
 * Flags: --scan-only runs the injection gate and nothing else. --stats prints and writes nothing.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import MiniSearch from 'minisearch';

import { articleToText, splitSections, decodeEntities } from './lib/extract.mjs';
import { scanSections } from './lib/scan.mjs';
import { buildCore, buildGlossary, readVersions } from './lib/core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = join(HERE, '..', 'epic-devdocs', 'site');
const BUILD = join(SITE, 'build');
const DIST = join(HERE, 'dist');
const ORIGIN = 'https://devdocs.epiccash.com';

const args = new Set(process.argv.slice(2));
const scanOnly = args.has('--scan-only');
const statsOnly = args.has('--stats');

// Community links live in the site footer, which sits outside <article> and therefore outside the
// extractor's reach. Mirrored here rather than parsed, because the footer markup is theme-owned and
// would break silently on a Docusaurus upgrade. Keep in step with docusaurus.config.js.
const COMMUNITY = [
  { label: 'Telegram', href: 'https://t.me/EpicCash' },
  { label: 'Reddit', href: 'https://www.reddit.com/r/epiccash' },
  { label: 'Project site', href: 'https://epiccash.com' },
  { label: 'Block explorer', href: 'https://explorer.epicmine.io' },
  { label: 'Node issues', href: 'https://github.com/EpicCash/epic/issues' },
  { label: 'Wallet issues', href: 'https://github.com/EpicCash/epic-wallet/issues' },
];

if (!existsSync(BUILD)) {
  console.error(`No build output at ${BUILD}\nRun \`npm run build\` in epic-devdocs/site first.`);
  process.exit(1);
}

/* ---------------------------------------------------------------- collect pages */

const pageFiles = [];
(function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name === 'index.html') pageFiles.push(p);
  }
})(BUILD);

const SKIP_ROUTES = [/^404/, /^search/];

const pages = [];
const sections = [];
let skipped = 0;

for (const file of pageFiles.sort()) {
  const rel = relative(BUILD, file).replaceAll('\\', '/').replace(/index\.html$/, '');
  if (SKIP_ROUTES.some((re) => re.test(rel))) { skipped++; continue; }

  const html = readFileSync(file, 'utf8');
  const text = articleToText(html);
  if (text.length < 200) { skipped++; continue; }

  const rawTitle = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? rel;
  const title = decodeEntities(rawTitle).split('|')[0].trim();
  const description = decodeEntities(
    html.match(/<meta\s+name="description"\s+content="([^"]*)"/i)?.[1] ?? '',
  ).trim();
  const url = `${ORIGIN}/${rel}`;

  pages.push({ url, title, description, chars: text.length });
  sections.push(...splitSections({ text, url, title }));
}

/* ---------------------------------------------------------------- injection gate */

const { findings, failed } = scanSections(sections);

if (findings.length) {
  console.log(`\ncorpus scan: ${findings.length} finding(s)\n`);
  for (const f of findings) {
    console.log(`  [${f.severity}] ${f.rule}  ${f.breadcrumb}`);
    console.log(`      ${f.why}`);
    console.log(`      ${f.excerpt}`);
    console.log(`      ${f.section}\n`);
  }
} else {
  console.log('corpus scan: clean');
}

if (failed) {
  console.error('Refusing to build the corpus: a section contains model-directed text.');
  console.error('Fix the page, or if it is legitimate documentation of an attack, add an exception');
  console.error('in lib/scan.mjs with a comment explaining why.');
  process.exit(2);
}
if (scanOnly) process.exit(0);

/* ---------------------------------------------------------------- core block */

const { versions, repos } = await readVersions(join(SITE, 'src', 'data', 'versions.js'));
const core = [
  buildCore({ versions, repos, pages, community: COMMUNITY }),
  buildGlossary(),
].join('\n\n');

/* ---------------------------------------------------------------- retrieval index */

// Breadcrumb is indexed as its own field and weighted, because a heading path such as
// "Wallet Owner API v3 > Methods by what they can do" is the strongest available signal for a
// section whose body is a bare table of method names.
const docs = sections.map((s, i) => ({
  i,
  id: s.id,
  breadcrumb: s.breadcrumb,
  heading: s.heading ?? '',
  title: s.pageTitle,
  text: s.text,
}));

const mini = new MiniSearch({
  idField: 'i',
  fields: ['breadcrumb', 'heading', 'title', 'text'],
  storeFields: ['id'],
  // Identifiers are the queries that matter here: epicbox, only_randomx, --min_conf,
  // minimum_confirmations, init_send_tx. Splitting on underscores and dashes as well as
  // whitespace means a reader can search either the whole key or a word inside it.
  tokenize: (str) => str.split(/[\s\-_./:()[\]{}<>,;"'`=|]+/u).filter(Boolean),
  processTerm: (term) => (term.length > 1 ? term.toLowerCase() : null),
  searchOptions: {
    boost: { breadcrumb: 3, heading: 3, title: 2 },
    prefix: true,
    fuzzy: 0.15,
  },
});
mini.addAll(docs);

/* ---------------------------------------------------------------- stats */

// Calibrated, not guessed. An earlier measurement through Bedrock's own `usage` field reported
// 90,150 tokens for 297,884 characters of this same corpus, which is 3.30 characters per token.
// Technical prose with code and long identifiers runs denser than the usual 4.0 rule of thumb.
const CHARS_PER_TOKEN = 3.3;
const approxTokens = (s) => Math.round(s.length / CHARS_PER_TOKEN);
const corpusText = sections.map((s) => s.text).join('\n\n');

const oversized = sections.filter((s) => s.text.length > 4000);

const stats = {
  builtAt: new Date().toISOString(),
  docsVerifiedAgainst: versions.verifiedAgainst,
  node: versions.node,
  wallet: versions.wallet,
  pages: pages.length,
  skipped,
  sections: sections.length,
  subSplitParts: sections.filter((s) => s.part).length,
  corpusChars: corpusText.length,
  corpusTokensApprox: approxTokens(corpusText),
  coreChars: core.length,
  coreTokensApprox: approxTokens(core),
  medianSectionChars: median(sections.map((s) => s.text.length)),
  medianSectionTokensApprox: Math.round(median(sections.map((s) => s.text.length)) / CHARS_PER_TOKEN),
  p90SectionChars: percentile(sections.map((s) => s.text.length), 0.9),
  largestSectionChars: Math.max(...sections.map((s) => s.text.length)),
  largestSection: sections.reduce((a, b) => (b.text.length > a.text.length ? b : a)).breadcrumb,
  sectionsOver4kChars: oversized.length,
  scanFindings: findings.length,
};

// What a retrieval request actually costs, which is the number the whole design turns on.
const TOP_K = 24;
const topKChars = [...sections.map((s) => s.text.length)].sort((a, b) => b - a).slice(0, TOP_K);
stats.worstCaseTopKTokens = Math.round(topKChars.reduce((a, b) => a + b, 0) / CHARS_PER_TOKEN);
stats.typicalTopKTokens = Math.round((stats.medianSectionChars * TOP_K) / CHARS_PER_TOKEN);

console.log('');
for (const [k, v] of Object.entries(stats)) console.log(`${k}: ${v}`);

// A section far larger than the rest defeats the point of a prefilter, because retrieving it
// costs as much as several. Report rather than fail; the fix is a heading in the page.
if (oversized.length) {
  console.log(`\n${oversized.length} section(s) over 4000 chars, which weaken the prefilter:`);
  oversized
    .sort((a, b) => b.text.length - a.text.length)
    .forEach((s) => console.log(`  ${String(s.text.length).padStart(6)}  ${s.breadcrumb}`));
}

if (statsOnly) process.exit(0);

/* ---------------------------------------------------------------- emit */

mkdirSync(DIST, { recursive: true });

writeFileSync(
  join(DIST, 'corpus.json'),
  JSON.stringify(
    {
      version: stats.builtAt,
      stats,
      pages,
      sections: sections.map(({ id, url, pageUrl, pageTitle, heading, level, breadcrumb, text, part, partsTotal }) => ({
        id, url, pageUrl, pageTitle, heading, level, breadcrumb, text,
        ...(part ? { part, partsTotal } : {}),
      })),
      index: mini.toJSON(),
    },
    null,
    0,
  ),
  'utf8',
);
writeFileSync(join(DIST, 'core.txt'), core, 'utf8');

// llms.txt, per llmstxt.org. Costs nothing here and is immediately useful to any agent, with or
// without the assistant existing.
const llms = [
  '# Epic Cash Developer Documentation',
  '',
  `> Developer documentation for Epic Cash, a MimbleWimble privacy coin. Documented against node ${versions.node}, wallet ${versions.wallet}, epicbox protocol ${versions.epicboxProtocol}. Facts verified against source on ${versions.verifiedAgainst}.`,
  '',
  '## Pages',
  '',
  ...pages.map((p) => `- [${p.title}](${p.url})${p.description ? `: ${p.description}` : ''}`),
  '',
  '## Community',
  '',
  ...COMMUNITY.map((c) => `- [${c.label}](${c.href})`),
  '',
];
writeFileSync(join(DIST, 'llms.txt'), llms.join('\n'), 'utf8');

const llmsFull = [
  llms.join('\n'),
  '',
  '---',
  '',
  ...sections.map((s) => `## ${s.breadcrumb}\n\nSource: ${s.url}\n\n${s.text}`),
];
writeFileSync(join(DIST, 'llms-full.txt'), llmsFull.join('\n\n'), 'utf8');

writeFileSync(join(DIST, 'stats.json'), JSON.stringify(stats, null, 2), 'utf8');

console.log(`\nwrote dist/corpus.json, core.txt, llms.txt, llms-full.txt, stats.json`);

function median(nums) {
  return percentile(nums, 0.5);
}

function percentile(nums, p) {
  const s = [...nums].sort((a, b) => a - b);
  if (!s.length) return 0;
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}
