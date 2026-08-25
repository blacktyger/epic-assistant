#!/usr/bin/env node
/**
 * One-shot client, for checking the whole path from outside the browser.
 *
 * Does exactly what the panel does: fetch a challenge, solve the proof of work, mint a session, then
 * stream an answer. Useful when the browser reports a failure and the question is whether the fault is
 * in the panel or behind it.
 *
 *   node ask.mjs "which credential does each api surface need?"
 *   node ask.mjs --base http://127.0.0.1:7772 "how do I mine on usernet?"
 */
import { createHash } from 'node:crypto';
import { leadingZeroBits } from './lib/limits.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};
// 7772 is assistant-preview in ports.json, the single-origin preview. Point --base at 7771 to ask
// the development server instead.
const BASE = flag('base', process.env.EPIC_AI_BASE ?? 'http://127.0.0.1:7772');
const question = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--base').join(' ');

if (!question) {
  console.error('usage: node ask.mjs [--base URL] "your question"');
  process.exit(1);
}

const readJson = async (res, what) => {
  const text = await res.text();
  if (/^\s*<!doctype html|^\s*<html/i.test(text)) {
    throw new Error(
      `${what} returned the documentation HTML instead of JSON, so /api/chat is not routed on ${BASE}. ` +
        'Use the single-origin preview, or restart the dev server so the proxy is active.',
    );
  }
  if (!res.ok) throw new Error(`${what} returned ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
};

/* handshake */
const t0 = Date.now();
const {challenge, bits} = await readJson(
  await fetch(`${BASE}/api/chat/challenge`, {headers: {accept: 'application/json'}}),
  'challenge',
);

let nonce = 0;
while (leadingZeroBits(createHash('sha256').update(`${challenge}:${nonce}`).digest()) < bits) nonce += 1;
const powMs = Date.now() - t0;

const session = await readJson(
  await fetch(`${BASE}/api/chat/session`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({challenge, nonce: String(nonce)}),
  }),
  'session',
);
console.log(`handshake ok: ${bits} bits solved in ${powMs}ms after ${nonce} attempts\n`);

/* stream */
const res = await fetch(`${BASE}/api/chat`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    authorization: `Bearer ${session.token}`,
  },
  body: JSON.stringify({question, history: []}),
});
if (!res.ok || !res.body) {
  console.error(`chat failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  process.exit(1);
}

const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
let buffer = '';
let ttfb = null;
const started = Date.now();
let citations = [];

process.stdout.write(`Q: ${question}\n\n`);

for (;;) {
  const {done, value} = await reader.read();
  if (done) break;
  buffer += value;
  const frames = buffer.split('\n\n');
  buffer = frames.pop() ?? '';
  for (const frame of frames) {
    if (!frame.trim() || frame.startsWith(':')) continue;
    const event = frame.match(/^event: (.+)$/m)?.[1];
    const dataLine = frame.match(/^data: (.+)$/m)?.[1];
    if (!event || !dataLine) continue;
    const data = JSON.parse(dataLine);
    if (event === 'start') {
      console.error(`[retrieved ${data.retrieved} sections, model ${data.model ?? 'cached'}]\n`);
    } else if (event === 'text') {
      if (ttfb === null) ttfb = Date.now() - started;
      process.stdout.write(data.text);
    } else if (event === 'citations') {
      citations = data.citations ?? [];
    } else if (event === 'done') {
      console.log(`\n\n[done in ${Date.now() - started}ms, ttfb ${ttfb}ms, ${citations.length} sources]`);
      citations.forEach((c) => console.log(`  - ${c.breadcrumb ?? c.title}\n    ${c.url}`));
    } else if (event === 'error' || event === 'limit' || event === 'unavailable' || event === 'degraded') {
      console.log(`\n\n[${event}] ${data.message ?? JSON.stringify(data)}`);
    }
  }
}
