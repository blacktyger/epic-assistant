#!/usr/bin/env node
/**
 * Unit tests for the parts that are security or cost relevant, where a silent regression would not
 * show up as a visible bug. Plain assertions, no framework, so this runs anywhere Node runs.
 *
 * Covered on purpose:
 *   - IPv6 /64 aggregation, because keying on a full IPv6 address is the same as having no per-IP
 *     limit and it fails silently
 *   - the link allowlist, because an invented wallet URL is the one output that can harm a reader
 *   - the streaming holdback, because releasing a half-written URL would defeat the allowlist
 *   - redaction, because a seed phrase in a log file is worse than any attack defended against here
 *   - ledger durability and fail-closed behaviour, because that is the only fast cost control
 *   - HMAC session verification, including tampering and expiry
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { ipKey, leadingZeroBits, SessionStore, ProofOfWork } from './lib/limits.mjs';
import { sanitiseLinks, isAllowed, flushable, OutputGuard, extractCitations, buildCitationIndex } from './lib/guard.mjs';
import { redact, QuestionLog } from './lib/log.mjs';
import { SpendLedger } from './lib/ledger.mjs';
import { normaliseQuestion, AnswerCache } from './lib/answer-cache.mjs';
import { resolveModel, costOf } from './config.mjs';
import { EventStreamDecoder } from './lib/eventstream.mjs';

let passed = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed += 1; return; }
  failures.push(`${name}\n    expected ${e}\n    actual   ${a}`);
}
function ok(name, cond, detail = '') {
  if (cond) { passed += 1; return; }
  failures.push(`${name}${detail ? `\n    ${detail}` : ''}`);
}
function group(title) {
  console.log(`\n${title}`);
}

/* ================================================================ IP keys */

group('ip keys');
check('ipv4 passes through', ipKey('203.0.113.7'), '203.0.113.7');
check('ipv4-mapped ipv6 unwraps', ipKey('::ffff:203.0.113.7'), '203.0.113.7');
check(
  'ipv6 truncates to /64',
  ipKey('2001:db8:85a3:1234:5678:9abc:def0:1234'),
  '2001:0db8:85a3:1234::/64',
);
// The whole point: two addresses in one /64 must collapse to one key, or an attacker with a
// residential allocation has 2^64 free keys.
ok(
  'two addresses in one /64 share a key',
  ipKey('2001:db8:85a3:1234::1') === ipKey('2001:db8:85a3:1234:ffff:ffff:ffff:ffff'),
  `${ipKey('2001:db8:85a3:1234::1')} vs ${ipKey('2001:db8:85a3:1234:ffff:ffff:ffff:ffff')}`,
);
ok(
  'different /64s do not share a key',
  ipKey('2001:db8:85a3:1234::1') !== ipKey('2001:db8:85a3:9999::1'),
);
check('compressed ipv6 expands before truncating', ipKey('2001:db8::1'), '2001:0db8:0000:0000::/64');
check('zone index is dropped', ipKey('fe80::1%eth0'), 'fe80:0000:0000:0000::/64');
check('empty is handled', ipKey(''), 'unknown');

/* ================================================================ proof of work */

group('proof of work');
check('leadingZeroBits counts a full zero byte', leadingZeroBits(Buffer.from([0x00, 0xff])), 8);
check('leadingZeroBits counts partial', leadingZeroBits(Buffer.from([0x0f])), 4);
check('leadingZeroBits on 0x80 is zero', leadingZeroBits(Buffer.from([0x80])), 0);
check('leadingZeroBits spans bytes', leadingZeroBits(Buffer.from([0x00, 0x00, 0x40])), 17);

{
  const pow = new ProofOfWork();
  const { challenge, bits } = pow.issue();
  // Solve it the way a browser would.
  let nonce = 0;
  for (;;) {
    const d = createHash('sha256').update(`${challenge}:${nonce}`).digest();
    if (leadingZeroBits(d) >= bits) break;
    nonce += 1;
    if (nonce > 5_000_000) break;
  }
  ok('a solvable challenge is solved', leadingZeroBits(createHash('sha256').update(`${challenge}:${nonce}`).digest()) >= bits);
  check('correct solution verifies', pow.verify(challenge, String(nonce)).ok, true);
  check('challenge is single use', pow.verify(challenge, String(nonce)).ok, false);
  check('unknown challenge rejected', pow.verify('deadbeef', '1').ok, false);
  const second = pow.issue();
  check('wrong nonce rejected', pow.verify(second.challenge, '0').ok, false);
}

/* ================================================================ link allowlist */

group('link allowlist');
ok('docs host allowed', isAllowed('https://devdocs.epiccash.com/api/'));
ok('github allowed', isAllowed('https://github.com/EpicCash/epic'));
ok('subdomain of allowed host allowed', isAllowed('https://www.epiccash.com/x'));
ok('telegram allowed', isAllowed('https://t.me/EpicCash'));
ok('relative allowed', isAllowed('/guides/build'));
ok('anchor allowed', isAllowed('#step-1'));
ok('unknown host refused', !isAllowed('https://evil.example/wallet.exe'));
ok('lookalike host refused', !isAllowed('https://devdocs-epiccash.com/x'));
ok('host suffix trick refused', !isAllowed('https://notepiccash.com/x'));
ok('javascript scheme refused', !isAllowed('javascript:alert(1)'));
ok('data scheme refused', !isAllowed('data:text/html,<script>'));
ok('file scheme refused', !isAllowed('file:///etc/passwd'));

{
  const r = sanitiseLinks('Download it from [here](https://evil.example/wallet.exe) now.');
  check('bad markdown link keeps label, drops href', r.text, 'Download it from here now.');
  ok('finding recorded', r.findings.some((f) => f.startsWith('link-stripped')));
}
{
  const r = sanitiseLinks('See [the guide](https://devdocs.epiccash.com/guides/build/) first.');
  check('good link untouched', r.text, 'See [the guide](https://devdocs.epiccash.com/guides/build/) first.');
  check('no findings for a good link', r.findings, []);
}
{
  const r = sanitiseLinks('Grab https://evil.example/x and run it.');
  check('bare bad url removed', r.text, 'Grab [link removed] and run it.');
}
{
  const r = sanitiseLinks('![diagram](https://evil.example/a.png)');
  check('image stripped to its alt text', r.text, 'diagram');
  ok('image finding recorded', r.findings.includes('image-stripped'));
}
{
  // An image from the docs host is still stripped: this project self-hosts assets and rejected
  // third-party requests, so a model-authored image tag has no legitimate use.
  const r = sanitiseLinks('![x](https://devdocs.epiccash.com/img/a.png)');
  check('image from own host also stripped', r.text, 'x');
}

/* ================================================================ streaming holdback */

group('streaming holdback');
check('complete text is fully releasable', flushable('hello world'), 11);
ok('unclosed markdown link is held', flushable('see [the guide](https://evil') < 'see [the guide](https://evil'.length);
check('closed link is releasable', flushable('a [b](https://x.test/y) c'), 25);
ok('partial bare url is held', flushable('go to https://ev') <= 6);
ok('partial scheme is held', flushable('word ht') <= 5);
ok('a bracket that is not a link does not stall forever', flushable('array[0] = 1') > 0);

{
  // The guard must not leak a disallowed URL even when it arrives one character at a time.
  const guard = new OutputGuard({ canary: 'CANARY-X' });
  let out = '';
  for (const ch of 'Get it at https://evil.example/w.exe today.') {
    out += guard.push(ch).emit;
  }
  out += guard.finish().emit;
  ok('char-by-char bad url never leaks', !out.includes('evil.example'), out);
  check('char-by-char output is sanitised', out, 'Get it at [link removed] today.');
}
{
  const guard = new OutputGuard({ canary: 'CANARY-X' });
  const r1 = guard.push('normal text ');
  const r2 = guard.push('CANARY-X leaked');
  check('canary does not emit', r1.emit.length > 0 && r2.emit === '', true);
  check('canary aborts', r2.abort, 'canary');
  ok('canary recorded as a finding', guard.findings.includes('canary'));
}
{
  const guard = new OutputGuard({ canary: 'nope' });
  let aborted = null;
  for (let i = 0; i < 40; i += 1) {
    const r = guard.push('the same forty characters repeated again..');
    if (r.abort) { aborted = r.abort; break; }
  }
  check('degenerate repetition aborts', aborted, 'repetition');
}
{
  // A false positive here silently truncates a legitimate answer, so the guard is checked against a
  // realistic long response with repeated technical vocabulary and repeated code fences.
  const guard = new OutputGuard({ canary: 'nope' });
  const realistic = `To run a usernet chain you need four settings in epic-server.toml.

\`\`\`toml
only_randomx = true
\`\`\`

Without this the policy assigns each height one of several algorithms, so a single CPU miner idles on
most blocks. Setting it changes consensus, so delete chain_data if the chain already has blocks.

\`\`\`toml
peer_min_preferred_outbound_count = 0
\`\`\`

A node below this threshold reports itself as syncing forever, and a syncing node refuses to hand out
mining work. Usernet has no peers by design, so it can never reach the default of 4.

\`\`\`toml
enable_stratum_server = true
\`\`\`

This switches on the mining port, 3416 on usernet. It is off by default on every network.

Then start the wallet listener and the miner. The wallet listens for coinbase output, the miner
connects to the stratum port, and blocks begin arriving about once a second on usernet difficulty.

Next: coinbase maturity on usernet is 3 blocks, but the wallet's minimum_confirmations defaults to 10,
so pass --min_conf 3 on any command that spends.`;

  let aborted = null;
  // Fed in small deltas, the way the model streams it.
  for (let i = 0; i < realistic.length; i += 7) {
    const r = guard.push(realistic.slice(i, i + 7));
    if (r.abort) { aborted = r.abort; break; }
  }
  check('realistic prose does not trip the loop guard', aborted, null);
  guard.finish();
  ok('realistic prose survives intact', guard.text.includes('only_randomx = true') && guard.text.includes('--min_conf 3'));
  ok('no spurious guard findings on clean prose', guard.findings.length === 0, JSON.stringify(guard.findings));
}
{
  // Repeated identical list items are normal in documentation and must not abort.
  const guard = new OutputGuard({ canary: 'nope' });
  let aborted = null;
  for (const line of Array.from({ length: 12 }, (_, i) => `- port ${3410 + i} is used by a wallet instance\n`)) {
    const r = guard.push(line);
    if (r.abort) { aborted = r.abort; break; }
  }
  check('similar-but-distinct lines do not trip the guard', aborted, null);
}

/* ================================================================ citations */

group('citations');
{
  const sections = [
    {
      id: 'https://devdocs.epiccash.com/guides/local-network/#2-create-the-two-wallets',
      url: 'https://devdocs.epiccash.com/guides/local-network/#2-create-the-two-wallets',
      pageUrl: 'https://devdocs.epiccash.com/guides/local-network/',
      pageTitle: 'Run a local network',
      heading: '2. Create the two wallets',
      breadcrumb: 'Run a local network > 2. Create the two wallets',
      text: 'x',
    },
  ];
  const index = buildCitationIndex(sections);

  const good = extractCitations(
    'Edit Bob wallet [2. Create the two wallets](https://devdocs.epiccash.com/guides/local-network/#2-create-the-two-wallets).',
    index,
  );
  check('valid citation extracted', good.citations.length, 1);
  check('no invalid recorded', good.invalid.length, 0);

  const bad = extractCitations(
    'See [invented](https://devdocs.epiccash.com/guides/does-not-exist/#nope).',
    index,
  );
  check('unknown anchor reported invalid', bad.invalid.length, 1);
  check('unknown anchor not returned as a citation', bad.citations.length, 0);

  const page = extractCitations('See [page](https://devdocs.epiccash.com/guides/local-network/).', index);
  check('bare page citation resolves', page.citations.length, 1);

  const relative = extractCitations('See [rel](/guides/local-network/).', index);
  check('relative citation resolves', relative.citations.length, 1);

  const dupe = extractCitations(
    '[a](https://devdocs.epiccash.com/guides/local-network/) and [b](https://devdocs.epiccash.com/guides/local-network/)',
    index,
  );
  check('duplicate citations collapse', dupe.citations.length, 1);

  const foreign = extractCitations('See [gh](https://github.com/EpicCash/epic).', index);
  check('non-docs link is not treated as a citation', foreign.citations.length, 0);
}

/* ================================================================ redaction */

group('redaction');
{
  const seed = 'my seed is abandon ability able about above absent absorb abstract absurd abuse access and it broke';
  const r = redact(seed);
  ok('12-word run redacted', r.text.includes('[seed-phrase-redacted]'), r.text);
  ok('seed words gone', !r.text.includes('abandon ability able'), r.text);
}
{
  const r = redact('key 4f3c2b1a9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b');
  ok('long hex redacted', r.text.includes('[hex-redacted]'), r.text);
}
{
  const r = redact('send to esdFcVEHnBLbW3Y4CE3wZFhwqfEXPBJCFuUiTfCEcT8YV3xkAvXk');
  ok('base58 address redacted', /\[(address|blob)-redacted\]/.test(r.text), r.text);
}
{
  const r = redact('contact me at someone@example.com please');
  ok('email redacted', r.text.includes('[email-redacted]'), r.text);
}
{
  const r = redact('password: hunter2');
  ok('labelled secret redacted', r.text.includes('[value-redacted]'), r.text);
  ok('label kept for context', /password/i.test(r.text), r.text);
}
{
  const r = redact('how do I set only_randomx = true in epic-server.toml');
  check('ordinary question untouched', r.text, 'how do I set only_randomx = true in epic-server.toml');
  check('no redaction flags on a clean question', r.redacted, []);
}
{
  // Guard against over-matching: a normal sentence of twelve short words must survive.
  const r = redact('the node will not sync when the peer count stays at zero for long');
  ok('plain prose is not treated as a seed phrase', !r.text.includes('[seed-phrase-redacted]'), r.text);
}

/* ================================================================ ledger */

group('spend ledger');
{
  const dir = mkdtempSync(join(tmpdir(), 'epic-ledger-'));
  try {
    const l1 = new SpendLedger({ dir });
    check('starts open', l1.check().allowed, true);

    const usage = { inputTokens: 10_000, outputTokens: 500, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 };
    const usd = l1.record({ modelId: 'eu.anthropic.claude-sonnet-4-6', usage, ttl: '5m' });
    ok('cost is positive and sane', usd > 0 && usd < 1, String(usd));
    check('cost matches the pricing table', Number(usd.toFixed(6)), Number(costOf('eu.anthropic.claude-sonnet-4-6', usage, '5m').toFixed(6)));

    // Durability: a fresh instance over the same directory must see the spend.
    const l2 = new SpendLedger({ dir });
    ok('spend survives a restart', Math.abs(l2.usd - l1.usd) < 1e-9, `${l2.usd} vs ${l1.usd}`);

    // Tripping survives a restart too, which is the property that makes it a kill switch.
    l2.trip('test');
    const l3 = new SpendLedger({ dir });
    check('trip survives a restart', l3.state, 'tripped');
    check('tripped ledger refuses', l3.check().tier, 'hard');
    l3.reset();
    check('reset reopens', l3.check().allowed, true);

    // Reservation must bound concurrent requests, not just sequential ones.
    const l4 = new SpendLedger({ dir });
    const releases = [];
    for (let i = 0; i < 5; i += 1) releases.push(l4.reserve());
    ok('reservations accumulate', l4.snapshot.reservedUsd > 0);
    releases.forEach((r) => r());
    check('reservations release', l4.snapshot.reservedUsd, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  // Fail closed: a corrupt ledger must not read as zero spent, which would hand out a budget reset.
  const dir = mkdtempSync(join(tmpdir(), 'epic-ledger-bad-'));
  try {
    const day = new Date().toISOString().slice(0, 10);
    writeFileSync(join(dir, `${day}.json`), '{ not json', 'utf8');
    const l = new SpendLedger({ dir });
    check('corrupt ledger fails closed', l.state, 'tripped');
    check('corrupt ledger refuses requests', l.check().allowed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ================================================================ sessions */

group('sessions');
{
  const store = new SessionStore();
  const pow = store.pow;
  const { challenge, bits } = pow.issue();
  let nonce = 0;
  for (;;) {
    if (leadingZeroBits(createHash('sha256').update(`${challenge}:${nonce}`).digest()) >= bits) break;
    nonce += 1;
  }

  const minted = store.mint({ ip: '203.0.113.9', challenge, nonce: String(nonce) });
  check('mint succeeds with valid work', minted.ok, true);

  const v = store.verify({ token: minted.token, ip: '203.0.113.9' });
  check('verify succeeds', v.ok, true);
  check('same ip is not strict', v.strict, false);

  const other = store.verify({ token: minted.token, ip: '198.51.100.4' });
  check('different ip still verifies', other.ok, true);
  ok('different ip is marked strict rather than rejected', other.strict === true);

  const tampered = minted.token.slice(0, -2) + (minted.token.endsWith('AA') ? 'BB' : 'AA');
  check('tampered signature rejected', store.verify({ token: tampered, ip: '203.0.113.9' }).ok, false);
  check('garbage token rejected', store.verify({ token: 'nope', ip: '203.0.113.9' }).ok, false);
  check('empty token rejected', store.verify({ token: '', ip: '203.0.113.9' }).ok, false);

  // A token whose payload claims a different session must not be accepted.
  const [body] = minted.token.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), sid: 'forged' })).toString('base64url');
  check('forged sid rejected', store.verify({ token: `${forged}.${minted.token.split('.')[1]}`, ip: '203.0.113.9' }).ok, false);

  // Per-session budget.
  const sid = v.sid;
  check('session starts allowed', store.checkSession(sid).allowed, true);
  for (let i = 0; i < 40; i += 1) store.recordUsage(sid, { inputTokens: 1, outputTokens: 1, cacheWriteInputTokens: 0 });
  check('request cap enforced', store.checkSession(sid).allowed, false);

  // Concurrency slots.
  const slots = [];
  for (let i = 0; i < 4; i += 1) slots.push(store.acquireSlot('203.0.113.10'));
  ok('four slots granted', slots.every(Boolean));
  check('fifth slot refused', store.acquireSlot('203.0.113.10'), null);
  slots[0]();
  ok('slot is reusable after release', Boolean(store.acquireSlot('203.0.113.10')));

  // Rate limit.
  const store2 = new SessionStore();
  let allowedCount = 0;
  for (let i = 0; i < 100; i += 1) if (store2.checkRate('203.0.113.11').allowed) allowedCount += 1;
  ok('rate limit bites', allowedCount < 100 && allowedCount >= 20, String(allowedCount));
  ok('a different /64 is unaffected', store2.checkRate('2001:db8:1:2::5').allowed);
}

/* ================================================================ mint limit */

group('mint limit');
{
  const store = new SessionStore();
  let minted = 0;
  let refused = 0;
  for (let i = 0; i < 40; i += 1) {
    const { challenge, bits } = store.pow.issue();
    let nonce = 0;
    for (;;) {
      if (leadingZeroBits(createHash('sha256').update(`${challenge}:${nonce}`).digest()) >= bits) break;
      nonce += 1;
    }
    const r = store.mint({ ip: '203.0.113.50', challenge, nonce: String(nonce) });
    if (r.ok) minted += 1; else refused += 1;
  }
  ok('mints are capped per ip-hour', minted <= 30 && refused > 0, `minted=${minted} refused=${refused}`);
}

/* ================================================================ model allowlist */

group('model allowlist');
check('default resolves', resolveModel(undefined), 'eu.anthropic.claude-sonnet-4-6');
check('short key resolves', resolveModel('opus-4-6'), 'eu.anthropic.claude-opus-4-6-v1');
check('full profile id passes', resolveModel('eu.anthropic.claude-haiku-4-5-20251001-v1:0'), 'eu.anthropic.claude-haiku-4-5-20251001-v1:0');
check('unentitled model refused', resolveModel('eu.anthropic.claude-opus-5'), null);
check('arbitrary string refused', resolveModel('gpt-4'), null);
check('bare anthropic id refused', resolveModel('anthropic.claude-sonnet-4-6'), null);

/* ================================================================ answer cache */

group('answer cache');
check('normalisation collapses punctuation and case', normaliseQuestion('How do I MINE?!'), 'how do i mine');
{
  const cache = new AnswerCache('v1');
  cache.set('What is epicbox?', 'm', { text: 'A relay.', citations: [] });
  ok('hit on a differently punctuated question', cache.get('what is epicbox', 'm') !== null);
  ok('miss on a different model', cache.get('what is epicbox', 'other') === null);
  cache.set('refused one', 'm', { text: 'not in the docs', refused: true });
  ok('refusals are not cached', cache.get('refused one', 'm') === null);
}

/* ================================================================ event stream decoder */

group('event stream decoder');
{
  // Build a frame the way Bedrock does and confirm the decoder reads it, including when it is split
  // across chunk boundaries, which is the case that breaks naive implementations.
  const payload = Buffer.from(JSON.stringify({ delta: { text: 'hi' } }), 'utf8');
  const headerName = ':event-type';
  const headerValue = 'contentBlockDelta';
  const header = Buffer.concat([
    Buffer.from([headerName.length]),
    Buffer.from(headerName, 'utf8'),
    Buffer.from([7]),
    (() => { const b = Buffer.alloc(2); b.writeUInt16BE(headerValue.length); return b; })(),
    Buffer.from(headerValue, 'utf8'),
  ]);
  const total = 12 + header.length + payload.length + 4;
  const frame = Buffer.alloc(total);
  frame.writeUInt32BE(total, 0);
  frame.writeUInt32BE(header.length, 4);
  frame.writeUInt32BE(0, 8);
  header.copy(frame, 12);
  payload.copy(frame, 12 + header.length);
  frame.writeUInt32BE(0, total - 4);

  const d1 = new EventStreamDecoder();
  const whole = d1.push(frame);
  check('whole frame decodes', whole.length, 1);
  check('header parsed', whole[0].headers[':event-type'], 'contentBlockDelta');
  check('payload parsed', JSON.parse(whole[0].payload.toString()).delta.text, 'hi');

  const d2 = new EventStreamDecoder();
  check('split frame yields nothing yet', d2.push(frame.subarray(0, 7)).length, 0);
  check('nothing on a mid-header boundary', d2.push(frame.subarray(7, 20)).length, 0);
  check('completes on the final byte', d2.push(frame.subarray(20)).length, 1);
  check('no bytes left pending', d2.pending, 0);

  const d3 = new EventStreamDecoder();
  check('two frames in one chunk', d3.push(Buffer.concat([frame, frame])).length, 2);

  const d4 = new EventStreamDecoder();
  let threw = false;
  try { d4.push(Buffer.from([0xff, 0xff, 0xff, 0xff, 0, 0, 0, 4, 0, 0, 0, 0])); } catch { threw = true; }
  ok('a nonsense length throws rather than hanging', threw);
}

/* ================================================================ question log */

group('question log');
{
  const dir = mkdtempSync(join(tmpdir(), 'epic-qlog-'));
  try {
    const log = new QuestionLog({ dir });
    log.write({
      sid: 's1', question: 'how do I mine on usernet', model: 'm',
      refused: false, citations: 2, usage: { inputTokens: 10, outputTokens: 5 }, usd: 0.001, ms: 900,
    });
    log.write({
      sid: 's1', question: 'my seed is abandon ability able about above absent absorb abstract absurd abuse access account',
      model: 'm', refused: true, citations: 0, ms: 200,
    });
    const day = new Date().toISOString().slice(0, 10);
    const lines = readFileSync(join(dir, `${day}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    check('two records written', lines.length, 2);
    ok('question retained for the clean one', lines[0].question.includes('usernet'));
    ok('seed phrase never reaches disk', !lines[1].question.includes('abandon ability'), lines[1].question);
    ok('redaction flagged', Array.isArray(lines[1].redacted) && lines[1].redacted.length > 0);
    const gaps = log.gaps({ days: 1 });
    ok('gap report finds the refusal', gaps.some((g) => g.refused > 0), JSON.stringify(gaps));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ================================================================ report */

console.log('\n' + '='.repeat(70));
if (failures.length) {
  console.log(`FAILED  ${failures.length} of ${passed + failures.length}\n`);
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
console.log(`PASSED  ${passed} assertions`);
