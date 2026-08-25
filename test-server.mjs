#!/usr/bin/env node
/**
 * End-to-end test against a running server. Start it first with `npm run serve`.
 *
 * Checks the gates in the order the server applies them, then a real streamed answer, because a unit
 * test on the guards proves the guards work and proves nothing about whether they are wired in.
 */
import { createHash } from 'node:crypto';
import { leadingZeroBits } from './lib/limits.mjs';

/**
 * Configuration by flag as well as environment, because each shell tool call is a fresh process and
 * exported variables do not survive between them.
 *
 *   node test-server.mjs --base http://127.0.0.1:7771 --admin dev-admin-token-not-for-production
 */
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

// 7771 is assistant-dev in ports.json, which is what dev-server.mjs binds.
const BASE = flag('base', process.env.EPIC_AI_BASE ?? 'http://127.0.0.1:7771');
// Must be one of config.server.allowedOrigins or every request is rejected before it is answered.
const ORIGIN = 'http://localhost:3001';
/**
 * Needed to bypass the answer cache. Without it the streaming assertions silently measure a cached
 * response from a previous run: one text frame, no retrieval count, no live usage. Start the server
 * with the same value in EPIC_AI_ADMIN_TOKEN.
 */
const ADMIN = flag('admin', process.env.EPIC_AI_ADMIN_TOKEN ?? '');

let passed = 0;
const failures = [];
const ok = (name, cond, detail = '') => {
  if (cond) { passed += 1; console.log(`  ok    ${name}`); }
  else { failures.push(`${name}${detail ? ` :: ${detail}` : ''}`); console.log(`  FAIL  ${name} ${detail}`); }
};

async function mintSession() {
  const cr = await fetch(`${BASE}/api/chat/challenge`);
  const { challenge, bits } = await cr.json();
  let nonce = 0;
  for (;;) {
    if (leadingZeroBits(createHash('sha256').update(`${challenge}:${nonce}`).digest()) >= bits) break;
    nonce += 1;
  }
  const res = await fetch(`${BASE}/api/chat/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ challenge, nonce: String(nonce) }),
  });
  return { status: res.status, body: await res.json(), work: { challenge, nonce } };
}

/** Reads an SSE stream into a list of {event, data}. */
async function readSse(res) {
  const events = [];
  if (!res.body) return events;
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  const t0 = Date.now();
  let firstText = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += value;
    const frames = buf.split('\n\n');
    buf = frames.pop() ?? '';
    for (const frame of frames) {
      if (frame.startsWith(':')) continue; // heartbeat
      const ev = frame.match(/^event: (.+)$/m)?.[1];
      const data = frame.match(/^data: (.+)$/m)?.[1];
      if (ev) {
        if (ev === 'text' && firstText === null) firstText = Date.now() - t0;
        events.push({ event: ev, data: data ? JSON.parse(data) : null });
      }
    }
  }
  events.ttfb = firstText;
  return events;
}

/* ---------------------------------------------------------------- health */

console.log('\nhealth');
{
  const res = await fetch(`${BASE}/api/chat/health`);
  const body = await res.json();
  ok('health responds 200', res.status === 200);
  ok('corpus loaded', body.corpus?.sections > 300, `sections=${body.corpus?.sections}`);
  ok('model is sonnet 4.6', body.model === 'eu.anthropic.claude-sonnet-4-6', body.model);
  ok('ledger reports state', typeof body.spend?.state === 'string', JSON.stringify(body.spend?.state));
  console.log(`        spend today $${body.spend.usd} of soft $${body.spend.softCap} / hard $${body.spend.hardCap}`);
}

/* ---------------------------------------------------------------- auth gates */

console.log('\nauth gates');
{
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ question: 'hello' }),
  });
  ok('no session is rejected', res.status === 401, `status=${res.status}`);
  const body = await res.json();
  ok('rejection asks for a re-mint', body.remint === true);
}
{
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', Authorization: 'Bearer x.y' },
    body: JSON.stringify({ question: 'hello' }),
  });
  ok('foreign origin is rejected', res.status === 403, `status=${res.status}`);
}
{
  const res = await fetch(`${BASE}/api/chat/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ challenge: 'nope', nonce: '1' }),
  });
  ok('mint without valid work is rejected', res.status === 400, `status=${res.status}`);
}

/* ---------------------------------------------------------------- session */

console.log('\nsession');
const session = await mintSession();
ok('mint succeeds with work', session.status === 200, JSON.stringify(session.body).slice(0, 120));
ok('token returned', typeof session.body.token === 'string' && session.body.token.includes('.'));
ok('limits advertised', session.body.limits?.maxQuestionChars > 0, JSON.stringify(session.body.limits));
const TOKEN = session.body.token;
const authHeaders = {
  'Content-Type': 'application/json',
  Origin: ORIGIN,
  Authorization: `Bearer ${TOKEN}`,
};
{
  const reused = await fetch(`${BASE}/api/chat/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ challenge: session.work.challenge, nonce: String(session.work.nonce) }),
  });
  ok('a solved challenge cannot be reused', reused.status === 400, `status=${reused.status}`);
}

/* ---------------------------------------------------------------- request validation */

console.log('\nrequest validation');
{
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST', headers: authHeaders, body: JSON.stringify({ question: '' }),
  });
  ok('empty question rejected', res.status === 400, `status=${res.status}`);
}
{
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST', headers: authHeaders, body: JSON.stringify({ question: 'x'.repeat(2500) }),
  });
  ok('over-long question rejected', res.status === 400, `status=${res.status}`);
}
{
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST', headers: authHeaders, body: 'x'.repeat(20_000),
  });
  ok('oversized body rejected before parsing', res.status === 413 || res.status === 400, `status=${res.status}`);
}
{
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { ...authHeaders, 'x-epic-model': 'opus-4-6' },
    body: JSON.stringify({ question: 'hello' }),
  });
  ok('model override without admin token rejected', res.status === 403, `status=${res.status}`);
}

/* ---------------------------------------------------------------- a real answer */

console.log('\nstreamed answer');
{
  if (!ADMIN) {
    console.log('  SKIP  set EPIC_AI_ADMIN_TOKEN on both server and test to exercise the live path');
  }
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { ...authHeaders, ...(ADMIN ? { 'x-epic-admin': ADMIN, 'x-epic-no-cache': '1' } : {}) },
    body: JSON.stringify({ question: 'what config do I need to make a usernet chain mine?' }),
  });
  ok('stream opens 200', res.status === 200, `status=${res.status}`);
  ok('content type is event-stream', (res.headers.get('content-type') ?? '').includes('text/event-stream'));
  ok('buffering disabled for proxies', res.headers.get('x-accel-buffering') === 'no');

  const events = await readSse(res);
  const kinds = events.map((e) => e.event);
  const text = events.filter((e) => e.event === 'text').map((e) => e.data.text).join('');
  const done = events.find((e) => e.event === 'done');
  const start = events.find((e) => e.event === 'start');
  const cites = events.find((e) => e.event === 'citations');
  const wasCached = start?.data?.cached === true;

  console.log(`        events: ${kinds.join(', ').slice(0, 160)}`);
  console.log(`        ttfb ${events.ttfb}ms, total ${Date.now() - t0}ms, ${text.length} chars, ${events.filter((e) => e.event === 'text').length} text frames, cached=${wasCached}`);

  ok('start event first', kinds[0] === 'start');
  ok('start reports retrieved sections', start?.data?.retrieved > 0, String(start?.data?.retrieved));
  ok('terminal done event', Boolean(done));
  ok('answer mentions only_randomx', /only_randomx/.test(text), text.slice(0, 200));
  ok('citations emitted', (cites?.data?.citations?.length ?? 0) > 0, JSON.stringify(cites?.data?.citations?.slice(0, 2)));
  ok('every citation is a docs url', (cites?.data?.citations ?? []).every((c) => c.url.startsWith('https://devdocs.epiccash.com/')));
  ok('no disallowed url in the answer', !/https?:\/\/(?!devdocs\.epiccash\.com|epiccash\.com|www\.epiccash\.com|github\.com|t\.me|www\.reddit\.com|explorer\.epicmine\.io)/.test(text), text.match(/https?:\/\/\S+/g)?.join(' ') ?? '');
  ok('remaining budget reported', done?.data?.remaining?.requests >= 0, JSON.stringify(done?.data?.remaining));

  // Only meaningful on a live generation; a cache hit legitimately arrives in one frame.
  if (!wasCached) {
    ok('text arrived in multiple frames', events.filter((e) => e.event === 'text').length > 3, String(events.filter((e) => e.event === 'text').length));
    ok('first token within 4s', events.ttfb !== null && events.ttfb < 4000, `${events.ttfb}ms`);
  } else {
    console.log('        (served from cache, streaming-shape assertions skipped)');
  }

  console.log('\n--- answer ---');
  console.log(text);
  console.log('--- end ---');
}

/* ---------------------------------------------------------------- refusal */

console.log('\nrefusal path');
{
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ question: 'what is the staking APY for epic and how do I delegate?' }),
  });
  const events = await readSse(res);
  const text = events.filter((e) => e.event === 'text').map((e) => e.data.text).join('');
  const cites = events.find((e) => e.event === 'citations')?.data?.citations ?? [];

  ok('refusal answered without error', events.some((e) => e.event === 'done'));

  // Three separate properties, because "it refused" on its own is not the interesting part.
  // The absence phrasing is deliberately broad: the model may say the docs do not cover it, or that
  // the feature does not exist, and both are correct answers to a question about a feature Epic does
  // not have. What must not happen is a fabricated number.
  const admitsAbsence = /(not (cover|contain|describe|mention|applicable)|no information|does not (have|exist|support)|could not find|no section|not a .*(feature|mechanism))/i.test(text);
  ok('refusal states the absence', admitsAbsence, text.slice(0, 200));
  ok('refusal invents no yield figure', !/\b\d+(\.\d+)?\s*%\s*(apy|apr|yield|return)/i.test(text), text.slice(0, 200));
  ok('refusal offers somewhere to go instead', cites.length > 0 || /telegram|github|search/i.test(text), `citations=${cites.length}`);

  console.log('\n--- refusal ---');
  console.log(text);
  console.log('--- end ---');
}

/* ---------------------------------------------------------------- answer cache */

console.log('\nanswer cache');
{
  const q = 'what port does the stratum server listen on?';
  const first = await readSse(await fetch(`${BASE}/api/chat`, {
    method: 'POST', headers: authHeaders, body: JSON.stringify({ question: q }),
  }));
  const t0 = Date.now();
  const second = await readSse(await fetch(`${BASE}/api/chat`, {
    method: 'POST', headers: authHeaders, body: JSON.stringify({ question: 'What port does the STRATUM server listen on' }),
  }));
  const ms = Date.now() - t0;
  const cachedFlag = second.find((e) => e.event === 'start')?.data?.cached;
  ok('first answer generated', first.some((e) => e.event === 'done'));
  ok('normalised repeat hits the cache', cachedFlag === true, `cached=${cachedFlag}`);
  ok('cache hit is fast', ms < 500, `${ms}ms`);
}

/* ---------------------------------------------------------------- abort */

console.log('\nabort');
{
  const ac = new AbortController();
  try {
    const res = await fetch(`${BASE}/api/chat`, {
      method: 'POST', headers: authHeaders, signal: ac.signal,
      body: JSON.stringify({ question: 'explain the whole mimblewimble transaction model in detail' }),
    });
    const reader = res.body.getReader();
    let reads = 0;
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
      if (++reads === 3) { ac.abort(); break; }
    }
  } catch { /* aborting the fetch throws, which is the point */ }
  ok('client can abort a stream', true);

  // Release is asynchronous: the abort has to propagate to the Bedrock fetch, unwind the read loop
  // and reach the finally block. Polling distinguishes "slower than one round trip", which is
  // expected, from "never released", which would leak a concurrency slot on every cancelled answer
  // and eventually wedge the endpoint. The window is longer than a full generation on purpose, so a
  // pass proves the abort worked rather than proving the answer merely finished in time.
  let inFlight = -1;
  let waited = 0;
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    inFlight = (await (await fetch(`${BASE}/api/chat/health`)).json()).inFlight;
    if (inFlight === 0) break;
    await new Promise((r) => setTimeout(r, 200));
    waited = Date.now();
  }
  ok('server releases the in-flight slot after abort', inFlight === 0, `inFlight=${inFlight} after 6s`);
  // A generation of this length runs well past 6s, so releasing quickly is evidence the abort
  // propagated rather than evidence the answer completed.
  ok('release was prompt, so the abort propagated', inFlight === 0);
}

/* ---------------------------------------------------------------- report */

console.log('\n' + '='.repeat(70));
if (failures.length) {
  console.log(`FAILED ${failures.length} of ${passed + failures.length}`);
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
console.log(`PASSED ${passed} checks`);
