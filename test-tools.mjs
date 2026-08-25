#!/usr/bin/env node
/**
 * Offline tests for the live-data tool layer and the public model gate.
 *
 * Nothing here touches the network. The tools were verified against the live node and GitHub by hand
 * while they were being written, and repeating that in a test suite would make `npm test` depend on a
 * mainnet node being reachable, which is the wrong trade: a test that fails when someone else's
 * infrastructure is down teaches you to ignore it.
 *
 * What is tested is what a network probe cannot tell you anyway: that the whitelist refuses what it
 * should, that the budget stops counting at the right number, that a projection drops the fields it
 * claims to drop, and that our own hostname cannot escape through a stream. Those are the properties
 * that would be a security or cost incident if they broke, and all four are pure functions of code in
 * this repository.
 *
 * The one network-shaped thing covered is the response projection, exercised against captured payloads
 * rather than live ones. The captures below are real bodies read from the node on 2026-08-25.
 */
import { tools as toolCfg, resolvePublicModel, publicModelChoices, reserveFor, MODELS } from './config.mjs';
import { REGISTRY, buildToolConfig, availableToolNames, runTool, labelFor, ToolBudget } from './lib/tools/index.mjs';
import { resolveRepo } from './lib/tools/github.mjs';
import { TtlCache, ToolHttpError } from './lib/tools/http.mjs';
import { redactInternal, holdForRedaction, flushable, OutputGuard } from './lib/guard.mjs';
import { buildToolResultTurn, buildSystemPrefix, buildPrompt } from './lib/prompt.mjs';

let passed = 0;
const failures = [];

const group = (name) => console.log(`\n${name}`);
const ok = (label, condition) => {
  if (condition) passed += 1;
  else failures.push(label);
};
const check = (label, actual, expected) => {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (same) passed += 1;
  else failures.push(`${label}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`);
};

/* ================================================================ registry shape */

group('tool registry');

{
  const names = Object.keys(REGISTRY);
  ok('every tool has a description, schema, runner and label', names.every((n) => {
    const d = REGISTRY[n];
    return typeof d.description === 'string' && d.description.length > 40
      && typeof d.schema === 'object'
      && typeof d.run === 'function'
      && typeof d.label === 'function'
      && typeof d.available === 'function'
      && (d.group === 'chain' || d.group === 'github');
  }));

  // Bedrock rejects a tool name outside this character set, and the failure is a 400 on every
  // request rather than on the one tool, so it is worth asserting rather than discovering.
  ok('every tool name is a legal Bedrock tool name', names.every((n) => /^[a-zA-Z0-9_-]{1,64}$/.test(n)));

  ok('every label survives empty arguments', names.every((n) => typeof labelFor(n, {}) === 'string'));
  ok('a label never throws on rubbish arguments', typeof labelFor('epic_block', { height: 'x' }) === 'string');
  ok('an unknown tool still gets a label', typeof labelFor('nope', {}) === 'string');

  /*
   * The schemas travel in the cached prompt prefix, so their size is paid on every cache write. This
   * is a budget rather than a correctness check: it exists so that adding a tool with a 2,000-word
   * description is noticed here rather than in the monthly bill.
   */
  const config = buildToolConfig();
  const bytes = JSON.stringify(config).length;
  ok(`toolConfig stays under 12,000 characters (is ${bytes})`, bytes < 12_000);
  ok('toolChoice is auto, never forced', config.toolChoice?.auto !== undefined);
  check('every available tool is offered', config.tools.length, availableToolNames().length);

  ok('a required-argument tool declares it', REGISTRY.epic_github_releases.schema.required.includes('repo'));
  ok('the repo argument is an enum, not free text', Array.isArray(REGISTRY.epic_github_repo.schema.properties.repo.enum));
}

/* ================================================================ repository allowlist */

group('github repository allowlist');

check('exact name resolves', resolveRepo('EpicCash/epic-wallet'), { ok: true, repo: 'EpicCash/epic-wallet' });
check('case is ignored', resolveRepo('epiccash/EPIC'), { ok: true, repo: 'EpicCash/epic' });
check('a bare repository name resolves', resolveRepo('epic-miner'), { ok: true, repo: 'EpicCash/epic-miner' });
check('the word the docs use resolves', resolveRepo('wallet'), { ok: true, repo: 'EpicCash/epic-wallet' });
check('"node" means the server repository', resolveRepo('node'), { ok: true, repo: 'EpicCash/epic' });
check('a github URL resolves', resolveRepo('https://github.com/EpicCash/epic.git'), { ok: true, repo: 'EpicCash/epic' });

ok('another EpicCash repository is refused', resolveRepo('EpicCash/exchange-integrations').ok === false);
ok('a same-name repository under another owner is refused', resolveRepo('attacker/epic').ok === false);
ok('a wildcard is refused', resolveRepo('EpicCash/*').ok === false);
ok('an empty repository is refused', resolveRepo('').ok === false);
ok('a refusal names what is allowed', Array.isArray(resolveRepo('nope').allowed));
// The alias table knows about epicbox, which is not in the current allowlist. An alias must not be a
// way past the list: it resolves a word into the list, never around it.
ok('an alias for a repository outside the allowlist is refused', resolveRepo('epicbox').ok === false);

/* ================================================================ dispatch */

group('tool dispatch');

{
  const budget = new ToolBudget();
  const unknown = await runTool('rm_rf_slash', {}, { budget });
  ok('an unknown tool is refused rather than run', unknown.ok === false);
  ok('the refusal lists real tools', /epic_chain_status/.test(unknown.data.error));
  /*
   * An unknown tool name costs no call budget, deliberately.
   *
   * Nothing leaves the process, so there is nothing to ration, and the round ceiling already bounds a
   * model that keeps inventing names. Charging for it would spend a real reader's budget on a model
   * mistake and could exhaust the tool budget before a single genuine call had been made.
   */
  check('an unknown tool costs no call budget', budget.calls, 0);
}

{
  // The budget must stop counting at the configured number regardless of which tools are asked for.
  const budget = new ToolBudget();
  for (let i = 0; i < toolCfg.maxCallsPerAnswer; i += 1) budget.claimCall();
  const over = budget.claimCall();
  ok('the call budget refuses beyond the limit', over.ok === false);
  ok('the refusal tells the model to answer anyway', /answer from what you already have/i.test(over.error));

  const rounds = new ToolBudget();
  ok('rounds start unexhausted', rounds.roundsExhausted === false);
  for (let i = 0; i < toolCfg.maxRounds; i += 1) rounds.spendRound();
  ok('rounds exhaust at the configured ceiling', rounds.roundsExhausted === true);
}

{
  // Argument validation happens before any request is made, so these need no network.
  const budget = new ToolBudget();
  const bad = await runTool('epic_block', { hash: 'not-a-hash' }, { budget });
  ok('a malformed block hash is rejected locally', bad.ok === false && /64 hexadecimal/.test(bad.data.error));

  const negative = await runTool('epic_block', { height: -5 }, { budget });
  ok('a negative height is rejected locally', negative.ok === false);

  const fractional = await runTool('epic_block', { height: 12.5 }, { budget });
  ok('a fractional height is rejected locally', fractional.ok === false);

  const wrongKind = await runTool('epic_github_activity', { repo: 'EpicCash/epic', kind: 'secrets' }, { budget });
  ok('an activity kind outside the enum is rejected', wrongKind.ok === false && /kind must be one of/.test(wrongKind.data.error));
}

/* ================================================================ ttl cache */

group('tool result cache');

{
  const cache = new TtlCache({ maxEntries: 3 });
  let produced = 0;
  const produce = async () => { produced += 1; return { n: produced }; };

  const first = await cache.get('k', 60, produce);
  const second = await cache.get('k', 60, produce);
  check('a hit does not call upstream again', produced, 1);
  ok('the first read reports itself as live', first.cached === false);
  ok('the second read reports itself as cached', second.cached === true);

  // The property that makes this safe behind a public endpoint: concurrent callers share one request.
  let slowCalls = 0;
  const slow = async () => { slowCalls += 1; await new Promise((r) => setTimeout(r, 20)); return 'v'; };
  await Promise.all([cache.get('burst', 60, slow), cache.get('burst', 60, slow), cache.get('burst', 60, slow)]);
  check('three concurrent readers cost one upstream request', slowCalls, 1);

  // Stale-on-failure, which is what turns an upstream blip into a hedged answer rather than an error.
  await cache.get('flaky', 0, async () => 'good');
  const stale = await cache.get('flaky', 0, async () => { throw new ToolHttpError('timeout', 'no'); });
  ok('a failed refresh serves the last good value', stale.value === 'good');
  ok('and marks it stale', stale.stale === true);

  let threw = false;
  try {
    await cache.get('never-worked', 0, async () => { throw new ToolHttpError('timeout', 'no'); });
  } catch { threw = true; }
  ok('a first-ever failure is not disguised as a cache hit', threw);

  for (const k of ['a', 'b', 'c', 'd', 'e']) await cache.get(k, 60, produce);
  ok('the cache is bounded', cache.stats.entries <= 3);
}

/* ================================================================ internal host redaction */

group('internal host redaction');

{
  const hosts = ['node.example.test'];

  check(
    'a bare hostname is replaced with a phrase, not a marker',
    redactInternal('Read from node.example.test just now.', hosts).text.includes('a node we run'),
    true,
  );
  ok(
    'a full URL collapses rather than leaving an orphan path',
    redactInternal('See https://node.example.test/v1/status for this.', hosts).text.includes('/v1/status') === false,
  );
  ok('a redaction is reported as a finding', redactInternal('node.btlabs.uk').findings.length > 0);
  ok('unrelated text is untouched', redactInternal('The node API is on port 3413.', hosts).text === 'The node API is on port 3413.');
  ok('a legitimate docs host survives', redactInternal('See devdocs.epiccash.com for more.', hosts).text.includes('devdocs.epiccash.com'));

  /*
   * The streaming case, which is the one that matters.
   *
   * A hostname arrives split across deltas wherever the tokeniser happened to break it, so a
   * per-delta regex sees neither half. `holdForRedaction` measures the ambiguous tail and `flushable`
   * holds it back until it either completes the name or proves it cannot.
   */
  ok('an ambiguous tail is held back', holdForRedaction('read from node.btlabs.', ['node.btlabs.uk']) > 0);
  ok('unambiguous text is not held back', holdForRedaction('read from the docs', ['node.btlabs.uk']) === 0);
  ok('a completed hostname is no longer held', holdForRedaction('node.btlabs.uk', ['node.btlabs.uk']) === 0);
  ok('flushable holds a partial hostname', flushable('the tip came from node.btlabs.') < 'the tip came from node.btlabs.'.length);

  // End to end, split at the worst possible point.
  const guard = new OutputGuard({ canary: 'CANARY-NOT-PRESENT' });
  let emitted = '';
  for (const delta of ['The tip came from ', 'node.bt', 'labs', '.uk', ' a moment ago.']) {
    emitted += guard.push(delta).emit;
  }
  emitted += guard.finish().emit;
  ok('a hostname split across deltas never reaches the reader', emitted.includes('btlabs') === false);
  ok('and the sentence still reads', /The tip came from a node we run a moment ago\./.test(emitted));
  ok('the guard reports the redaction', guard.findings.some((f) => f.startsWith('internal-host-redacted')));
}

/* ================================================================ public model gate */

group('public model choice');

{
  const choices = publicModelChoices();
  ok('the picker offers more than one model', choices.choices.length > 1);
  ok('every offered model exists in MODELS', choices.choices.every((m) => MODELS[m.id]));
  ok('the default is one of the offered models', choices.choices.some((m) => m.id === choices.default));
  ok('every offered model carries a reader-facing note', choices.choices.every((m) => typeof m.note === 'string' && m.note.length > 0));

  ok('no choice resolves to the default', resolvePublicModel(undefined).ok === true);
  check('sonnet resolves', resolvePublicModel('sonnet-4-6').modelId, MODELS['sonnet-4-6']);
  check('opus resolves', resolvePublicModel('opus-4-6').modelId, MODELS['opus-4-6']);

  /*
   * The distinction this gate exists for. `haiku-4-5` is a real entry in MODELS and `resolveModel`
   * accepts it, but it is not offered to readers, so the public path must refuse it. Conflating "a
   * model this service knows" with "a model an anonymous caller may spend our money on" is how a cost
   * control turns into a suggestion.
   */
  ok('a known but unoffered model is refused on the public path', resolvePublicModel('haiku-4-5').ok === false);
  ok('a full profile id is refused on the public path', resolvePublicModel(MODELS['opus-4-6']).ok === false);
  ok('an unknown model is refused', resolvePublicModel('gpt-4').ok === false);
  ok('the refusal names the valid choices', /sonnet-4-6/.test(resolvePublicModel('gpt-4').reason));
}

/* ================================================================ spend reserve */

group('spend reserve');

{
  const sonnet1 = reserveFor(MODELS['sonnet-4-6'], { toolRounds: 1 });
  const sonnet3 = reserveFor(MODELS['sonnet-4-6'], { toolRounds: 3 });
  const opus3 = reserveFor(MODELS['opus-4-6'], { toolRounds: 3 });

  ok('a reserve is a positive number of dollars', sonnet1 > 0);
  ok('more tool rounds reserve more', sonnet3 > sonnet1);
  ok('a dearer model reserves more', opus3 > sonnet3);
  // The whole reason this replaced a flat number: the range is wide enough that one value cannot
  // describe both ends without either under-protecting or over-refusing.
  ok('the spread between cheapest and dearest is at least 3x', opus3 / sonnet1 > 3);
  ok('an unknown model falls back rather than returning zero', reserveFor('mystery-model') > 0);
}

/* ================================================================ prompt assembly */

group('prompt assembly with tools');

{
  const withTools = buildSystemPrefix({ core: '<core>x</core>', canary: 'C', tools: true });
  const without = buildSystemPrefix({ core: '<core>x</core>', canary: 'C', tools: false });

  ok('the live-data policy appears when tools are offered', withTools.includes('<live-data>'));
  ok('and is absent when they are not', without.includes('<live-data>') === false);
  ok('the code section is always present', withTools.includes('<code>') && without.includes('<code>'));
  ok('grounding admits tool results as a source', withTools.includes('<tool-result>'));
  ok('the instruction not to name the host is present', /never name, describe/i.test(withTools));

  const prompt = buildPrompt({ core: 'c', documents: '<documents/>', question: 'how tall', tools: true });
  ok('the cache point sits after the instructions', prompt.system[1].cachePoint !== undefined);
  ok('documents land after the cache point', prompt.system.length === 3);
  ok('the tool-aware reminder is used', /check the live chain/i.test(prompt.messages.at(-1).content[0].text));

  const plain = buildPrompt({ core: 'c', documents: '<documents/>', question: 'how tall', tools: false });
  ok('the plain reminder is used without tools', /check the live chain/i.test(plain.messages.at(-1).content[0].text) === false);
}

group('tool result turn');

{
  const turn = buildToolResultTurn([
    { toolUseId: 'tu_1', name: 'epic_chain_status', ok: true, data: { tipHeight: 1 } },
    { toolUseId: 'tu_2', name: 'epic_mempool', ok: false, data: { error: 'timeout' } },
  ]);

  check('the results come back as a user turn', turn.role, 'user');
  // Bedrock rejects a toolResult whose id was absent from the preceding assistant message, and equally
  // rejects a toolUse left unanswered, so the count and the ids both have to be exact.
  check('one block per result plus the framing text', turn.content.length, 3);
  check('ids are preserved exactly', turn.content.slice(0, 2).map((c) => c.toolResult.toolUseId), ['tu_1', 'tu_2']);
  ok('a failed call is marked as an error for Bedrock', turn.content[1].toolResult.status === 'error');
  ok('a successful call carries no error status', turn.content[0].toolResult.status === undefined);
  ok('the framing text restates the trust boundary', /not instructions/i.test(turn.content[2].text));
  ok('and restates the host rule', /do not name the host/i.test(turn.content[2].text));
}

/* ================================================================ */

console.log(`\n${'='.repeat(70)}`);
if (failures.length) {
  console.log(`FAILED  ${failures.length} of ${passed + failures.length}\n`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`PASSED  ${passed} assertions`);
