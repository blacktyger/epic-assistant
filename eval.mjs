#!/usr/bin/env node
/**
 * Evaluation harness, and the gate on the retrieval decision.
 *
 * The prefilter was chosen on a cost argument: it cuts context from 81,161 tokens to about 4,000 and
 * per-question cost from roughly $0.31 to $0.03. The risk it introduces is that keyword retrieval
 * misses a section the answer needed. Recall over 30 questions is already 100% in test-retrieval.mjs,
 * but recall measures whether the right page was retrieved, not whether the answer was right. This
 * measures the answer.
 *
 * Calls the libraries directly rather than the HTTP endpoint, so the answer cache, the session gates
 * and the rate limiter cannot colour the result.
 *
 * Usage:
 *   node eval.mjs                          prefilter arm over the whole set
 *   node eval.mjs --compare                adds full-corpus and prefilter-32 over the subset
 *   node eval.mjs --arms prefilter-16      pick arms explicitly
 *   node eval.mjs --only usernet-mining    single case, for iterating on the prompt
 *   node eval.mjs --model haiku-4-5        cross-model comparison
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GOLDEN, COMPARISON_SUBSET } from './eval/golden.mjs';
import { loadCredentials, converse } from './lib/bedrock.mjs';
import { loadRetriever, retrieve, renderDocuments } from './lib/retrieve.mjs';
import { buildPrompt, CANARY } from './lib/prompt.mjs';
import { sanitiseLinks, extractCitations, buildCitationIndex } from './lib/guard.mjs';
import { resolveModel, costOf, model as modelCfg } from './config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const corpus = JSON.parse(readFileSync(resolve(HERE, 'dist/corpus.json'), 'utf8'));
const core = readFileSync(resolve(HERE, 'dist/core.txt'), 'utf8');
const retriever = loadRetriever(corpus);
const citationIndex = buildCitationIndex(corpus.sections);
const credentials = loadCredentials(resolve(HERE, '..', '.secrets'));

const modelId = resolveModel(flag('model', modelCfg.default));
if (!modelId) {
  console.error(`unknown model ${flag('model', '')}`);
  process.exit(1);
}

const ARMS = {
  'prefilter-16': { topK: 16, full: false },
  'prefilter-32': { topK: 32, full: false },
  'full-corpus': { topK: 0, full: true },
};

let arms = ['prefilter-16'];
if (has('compare')) arms = ['prefilter-16', 'prefilter-32', 'full-corpus'];
if (flag('arms', null)) arms = flag('arms', '').split(',').map((s) => s.trim());

const only = flag('only', null);
let cases = only ? GOLDEN.filter((c) => c.id === only) : GOLDEN;
if (has('subset')) cases = cases.filter((c) => COMPARISON_SUBSET.includes(c.id));
if (!cases.length) {
  console.error(`no case matching --only ${only}`);
  process.exit(1);
}

// Full corpus costs roughly ten times a prefilter request, so it runs over the subset unless asked
// otherwise. Spending $12 to learn what $4 teaches is not diligence.
const fullCorpusDocuments = renderDocuments(corpus.sections);

/* ------------------------------------------------------------------ scoring */

/**
 * A model's own "I could not find it" means "not in what I was given", never "not in the corpus", so
 * refusal is detected from the text rather than trusted from a self-report field.
 *
 * Contractions are expanded first. An earlier version matched only "does not cover" and scored four
 * correct refusals as failures because the model wrote "the documents don't cover this" and "I don't
 * offer investment advice". Normalising is more honest than stacking alternatives, because the next
 * phrasing would have slipped through too.
 */
const CONTRACTIONS = [
  [/[\u2018\u2019]/g, "'"],
  [/\bdon't\b/g, 'do not'], [/\bdoesn't\b/g, 'does not'], [/\bdidn't\b/g, 'did not'],
  [/\bwon't\b/g, 'will not'], [/\bcan't\b/g, 'cannot'], [/\bcannot\b/g, 'cannot'],
  [/\bisn't\b/g, 'is not'], [/\baren't\b/g, 'are not'], [/\bwasn't\b/g, 'was not'],
  [/\bhaven't\b/g, 'have not'], [/\bhasn't\b/g, 'has not'], [/\bwouldn't\b/g, 'would not'],
];

const REFUSAL_SIGNALS = [
  // Negated coverage of the corpus.
  /(do not|does not|will not|cannot) (cover|contain|mention|describe|include|apply|address)/,
  /no (information|section|coverage|mention|documentation) (about|on|for|covering)/,
  /not (in|part of|covered by) (the )?(docs|documentation|scope)/,
  /could not find|nothing (in the )?(docs|documentation)/,
  // Negated capability, which is how a false premise gets corrected.
  /(do|does|did) not (support|have|exist|implement|allow|provide|offer|use)/,
  /(has|have) no [\w\s]{0,25}(staking|smart contract|scripting|virtual machine|account|balance|mechanism|layer)/,
  /there (is|are) no [\w\s]{0,25}(staking|smart contract|scripting|virtual machine|contract|mechanism)/,
  // Declining to act or advise.
  /(do not|does not|will not|cannot) (give|help|assist)/,
  /(will not|cannot) help with/,
  /not something i can/,
  // Scope statements.
  /outside (the |my |what )/,
  /only (help|assist) with|limited to (epic|questions about)/,
  /not applicable|do not apply|does not apply/,
];

/**
 * Two factors, because a single prose match is not enough in either direction.
 *
 * The signal must appear near the start, and the answer must be short. A genuine refusal leads with
 * the decline and stays brief. A legitimate in-scope answer that happens to contain "does not have" —
 * for instance explaining that the foreign API has no authentication by default — is long and buries
 * that phrase in substance. Requiring both position and brevity separates them, where a verb list
 * alone kept producing a false verdict on one side or the other.
 */
const REFUSAL_HEAD_CHARS = 300;
const REFUSAL_MAX_CHARS = 1500;

function detectRefusal(text) {
  const expand = (s) => {
    let out = s.toLowerCase();
    for (const [re, to] of CONTRACTIONS) out = out.replace(re, to);
    return out;
  };
  if (text.length > REFUSAL_MAX_CHARS) return false;
  const head = expand(text.slice(0, REFUSAL_HEAD_CHARS));
  return REFUSAL_SIGNALS.some((re) => re.test(head));
}

function scoreCase(c, answer, citations, invalidCitations) {
  const reasons = [];
  const refused = detectRefusal(answer);

  if (c.expectRefusal && !refused) reasons.push('should have refused but answered');
  if (c.mustNotRefuse && refused) reasons.push('refused a legitimate in-scope question');

  for (const re of c.mustInclude ?? []) {
    if (!re.test(answer)) reasons.push(`missing required ${re}`);
  }
  for (const re of c.mustNotInclude ?? []) {
    if (re.test(answer)) reasons.push(`contains forbidden ${re}`);
  }

  // Citation expectations only apply where an answer was given. A refusal legitimately cites nothing
  // relevant, and demanding a citation there would push the model to cite something irrelevant.
  if (!c.expectRefusal && (c.expectPages?.length ?? 0) > 0) {
    const urls = citations.map((x) => x.url);
    const hit = c.expectPages.some((p) => urls.some((u) => u.includes(p)));
    if (!hit) reasons.push(`no citation to any of ${c.expectPages.join(' | ')} (got ${urls.length ? urls.join(', ') : 'none'})`);
  }
  if (!c.expectRefusal && !refused && citations.length === 0) {
    reasons.push('answered with no citation at all');
  }
  if (invalidCitations.length) {
    reasons.push(`${invalidCitations.length} citation(s) point at anchors that do not exist: ${invalidCitations.join(', ')}`);
  }
  if (answer.includes(CANARY)) reasons.push('system prompt leaked');

  return { pass: reasons.length === 0, reasons, refused };
}

/* ------------------------------------------------------------------ rescore */

/**
 * Re-scores a previous run's stored answers with the current scoring code, without calling Bedrock.
 *
 * The scorer is code, so it has bugs, and its bugs look exactly like product failures. Four correct
 * refusals were reported as failures because the detector did not understand contractions. Being able
 * to fix the scorer and re-check against recorded output, for free and in a second, is what keeps a
 * scoring bug from being mistaken for a regression.
 */
if (has('rescore')) {
  const dir = resolve(HERE, 'var/eval');
  const file = flag('file', null) ?? readdirSync(dir).sort().at(-1);
  const prev = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  console.log(`rescoring ${file} with the current scorer\n`);

  let changed = 0;
  for (const [arm, rs] of Object.entries(prev.results)) {
    let pass = 0;
    for (const r of rs) {
      const c = GOLDEN.find((x) => x.id === r.id);
      if (!c) continue;
      const { citations, invalid } = extractCitations(r.answer ?? '', citationIndex);
      const now = scoreCase(c, r.answer ?? '', citations, invalid);
      if (now.pass) pass += 1;
      if (now.pass !== r.pass) {
        changed += 1;
        console.log(`  ${r.id}: was ${r.pass ? 'pass' : 'fail'}, now ${now.pass ? 'pass' : 'fail'}`);
        (now.pass ? r.reasons : now.reasons)?.forEach((x) => console.log(`      ${x}`));
      }
    }
    console.log(`\n${arm}: ${pass}/${rs.length} with the current scorer`);
  }
  console.log(`\n${changed} verdict(s) changed. No API calls made.`);
  process.exit(0);
}

/* ------------------------------------------------------------------ run */

async function runCase(c, armName) {
  const arm = ARMS[armName];
  const t0 = Date.now();

  let documents;
  let retrievedCount;
  let retrievedTokens;
  if (arm.full) {
    documents = fullCorpusDocuments;
    retrievedCount = corpus.sections.length;
    retrievedTokens = corpus.stats.corpusTokensApprox;
  } else {
    const r = retrieve(retriever, c.q, { topK: arm.topK });
    documents = r.sections.length ? renderDocuments(r.sections) : '';
    retrievedCount = r.sections.length;
    retrievedTokens = r.tokensApprox;
  }

  const { system, messages } = buildPrompt({
    core, documents, history: [], question: c.q, cacheTtl: modelCfg.cacheTtl,
  });

  const res = await converse({
    credentials, modelId, system, messages,
    maxTokens: modelCfg.maxTokens,
    temperature: modelCfg.temperature,
  });

  // Same guard the server applies, so the harness scores what a reader would actually see.
  const { text: answer, findings } = sanitiseLinks(res.text);
  const { citations, invalid } = extractCitations(answer, citationIndex);
  const score = scoreCase(c, answer, citations, invalid);

  return {
    ...score,
    id: c.id,
    kind: c.kind,
    q: c.q,
    answer,
    citations: citations.length,
    citationUrls: citations.map((x) => x.url),
    invalidCitations: invalid.length,
    guardFindings: findings,
    retrievedCount,
    retrievedTokens,
    usage: res.usage,
    usd: costOf(modelId, res.usage, modelCfg.cacheTtl),
    ms: Date.now() - t0,
    followup: /(^|\n)\s*(Next:|Also worth knowing:)/.test(answer),
  };
}

const results = {};

for (const armName of arms) {
  if (!ARMS[armName]) {
    console.error(`unknown arm ${armName}, choose from ${Object.keys(ARMS).join(', ')}`);
    process.exit(1);
  }
  // With --subset every arm runs the same cases, which is what makes the comparison controlled.
  // Otherwise the cheap arm covers everything and the expensive arms cover the subset only.
  const subset = has('subset') || only || armName === 'prefilter-16'
    ? cases
    : cases.filter((c) => COMPARISON_SUBSET.includes(c.id));

  console.log(`\n${'='.repeat(78)}`);
  console.log(`arm ${armName}  model ${modelId}  ${subset.length} cases`);
  console.log('='.repeat(78));

  const armResults = [];
  for (const c of subset) {
    let r;
    try {
      r = await runCase(c, armName);
    } catch (e) {
      r = {
        id: c.id, kind: c.kind, q: c.q, pass: false,
        reasons: [`request failed: ${e.kind ?? ''} ${e.message}`.trim()],
        answer: '', citations: 0, invalidCitations: 0, retrievedCount: 0, retrievedTokens: 0,
        usage: null, usd: 0, ms: 0,
      };
    }
    armResults.push(r);
    const mark = r.pass ? 'ok  ' : 'FAIL';
    console.log(
      `${mark} ${r.id.padEnd(30)} ${String(r.kind).padEnd(10)} ${String(r.citations).padStart(2)}cit ${String(r.retrievedTokens).padStart(6)}tok ${String(r.ms).padStart(6)}ms $${r.usd.toFixed(4)}`,
    );
    if (!r.pass) r.reasons.forEach((x) => console.log(`       ${x}`));
  }
  results[armName] = armResults;
}

/* ------------------------------------------------------------------ report */

function summarise(rs) {
  const n = rs.length;
  const passed = rs.filter((r) => r.pass).length;
  const refusalCases = rs.filter((r) => GOLDEN.find((c) => c.id === r.id)?.expectRefusal);
  const adjacentCases = rs.filter((r) => GOLDEN.find((c) => c.id === r.id)?.mustNotRefuse);
  return {
    cases: n,
    passed,
    passRate: Math.round((passed / n) * 100),
    refusalCorrect: refusalCases.length
      ? `${refusalCases.filter((r) => r.refused).length}/${refusalCases.length}`
      : 'n/a',
    overRefusals: adjacentCases.filter((r) => r.refused).length,
    invalidCitations: rs.reduce((a, r) => a + r.invalidCitations, 0),
    noCitation: rs.filter((r) => !r.refused && r.citations === 0).length,
    followupRate: Math.round((rs.filter((r) => r.followup).length / n) * 100),
    meanTokens: Math.round(rs.reduce((a, r) => a + r.retrievedTokens, 0) / n),
    meanMs: Math.round(rs.reduce((a, r) => a + r.ms, 0) / n),
    usdPerQuestion: rs.reduce((a, r) => a + r.usd, 0) / n,
    totalUsd: rs.reduce((a, r) => a + r.usd, 0),
  };
}

console.log(`\n${'='.repeat(78)}`);
console.log('summary');
console.log('='.repeat(78));
console.log(
  'arm'.padEnd(15) + 'pass'.padStart(9) + 'refuse'.padStart(8) + 'over'.padStart(6) +
  'badcit'.padStart(8) + 'nocit'.padStart(7) + 'follow'.padStart(8) + 'tokens'.padStart(8) +
  'ms'.padStart(7) + '$/q'.padStart(9),
);
const summaries = {};
for (const [arm, rs] of Object.entries(results)) {
  const s = summarise(rs);
  summaries[arm] = s;
  console.log(
    arm.padEnd(15) +
    `${s.passed}/${s.cases}`.padStart(9) +
    String(s.refusalCorrect).padStart(8) +
    String(s.overRefusals).padStart(6) +
    String(s.invalidCitations).padStart(8) +
    String(s.noCitation).padStart(7) +
    `${s.followupRate}%`.padStart(8) +
    String(s.meanTokens).padStart(8) +
    String(s.meanMs).padStart(7) +
    `$${s.usdPerQuestion.toFixed(4)}`.padStart(9),
  );
}

console.log('\nover = in-scope questions wrongly refused, the failure that matters most here');
console.log('badcit = citations pointing at anchors that do not exist');
console.log('follow = share of answers carrying a "Next:" suffix; over about 40% means it over-fires');

// Where two arms disagree on the same case, that is the evidence the comparison exists to produce.
if (Object.keys(results).length > 1) {
  const base = 'prefilter-16';
  console.log(`\ndisagreements against ${base}`);
  let found = 0;
  for (const [arm, rs] of Object.entries(results)) {
    if (arm === base) continue;
    for (const r of rs) {
      const b = results[base].find((x) => x.id === r.id);
      if (!b || b.pass === r.pass) continue;
      found += 1;
      console.log(`  ${r.id}: ${base}=${b.pass ? 'pass' : 'fail'} ${arm}=${r.pass ? 'pass' : 'fail'}`);
      (b.pass ? r.reasons : b.reasons).forEach((x) => console.log(`      ${x}`));
    }
  }
  if (!found) console.log('  none: the arms agree on every case');
}

const totalSpend = Object.values(results).flat().reduce((a, r) => a + r.usd, 0);
console.log(`\ntotal spend for this run: $${totalSpend.toFixed(4)}`);

mkdirSync(resolve(HERE, 'var/eval'), { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = resolve(HERE, `var/eval/${stamp}.json`);
writeFileSync(out, JSON.stringify({ modelId, corpusVersion: corpus.version, summaries, results }, null, 2));
console.log(`written to ${out}`);

const failed = Object.values(results).flat().filter((r) => !r.pass).length;
if (failed) process.exitCode = 1;
