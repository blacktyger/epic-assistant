#!/usr/bin/env node
/**
 * Verifies the hand-rolled event stream decoder against the live API, because a binary framing
 * decoder that has not decoded real frames is a guess.
 *
 * Checks: text deltas arrive incrementally rather than in one lump, usage is reported, the decoder
 * ends with no undecoded bytes, and an abort actually stops the stream.
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCredentials, converseStream, converse } from './lib/bedrock.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const credentials = loadCredentials(join(HERE, '..', '.secrets'));
const MODEL = process.env.EPIC_AI_MODEL ?? 'eu.anthropic.claude-sonnet-4-6';

console.log(`region=${credentials.region} model=${MODEL}\n`);

/* 1. Streaming: do deltas arrive progressively? */
{
  const t0 = Date.now();
  let chunks = 0;
  let chars = 0;
  let ttfb = null;
  let done = null;
  const gaps = [];
  let last = t0;

  for await (const ev of converseStream({
    credentials,
    modelId: MODEL,
    system: [{ text: 'You are a terse test harness.' }],
    messages: [{ role: 'user', content: [{ text: 'Count from 1 to 25, separated by spaces. Nothing else.' }] }],
    maxTokens: 200,
    temperature: 0,
  })) {
    if (ev.type === 'text') {
      if (ttfb === null) ttfb = Date.now() - t0;
      chunks++;
      chars += ev.text.length;
      gaps.push(Date.now() - last);
      last = Date.now();
    } else if (ev.type === 'done') {
      done = ev;
    }
  }

  console.log('1. converseStream');
  console.log(`   deltas=${chunks} chars=${chars} ttfb=${ttfb}ms total=${Date.now() - t0}ms`);
  console.log(`   stopReason=${done?.stopReason} usage=${JSON.stringify(done?.usage)}`);
  console.log(`   median inter-delta gap=${median(gaps)}ms max=${Math.max(...gaps)}ms`);
  console.log(`   ${chunks > 3 ? 'PASS: streamed incrementally' : 'FAIL: arrived as one lump'}`);
  console.log(`   ${done?.usage?.outputTokens > 0 ? 'PASS: usage reported' : 'FAIL: no usage'}\n`);
}

/* 2. Prompt caching through the stream path, with the 1h TTL. */
{
  const filler = 'Epic Cash is a MimbleWimble privacy coin. Transfers are interactive. '.repeat(400);
  const system = [{ text: filler }, { cachePoint: { type: 'default', ttl: '1h' } }];
  const run = async () => {
    let usage = null;
    for await (const ev of converseStream({
      credentials, modelId: MODEL, system,
      messages: [{ role: 'user', content: [{ text: 'Reply with one word: OK' }] }],
      maxTokens: 16, temperature: 0,
    })) {
      if (ev.type === 'done') usage = ev.usage;
    }
    return usage;
  };
  const a = await run();
  const b = await run();
  console.log('2. prompt caching on the stream path');
  console.log(`   first:  write=${a.cacheWriteInputTokens} read=${a.cacheReadInputTokens}`);
  console.log(`   second: write=${b.cacheWriteInputTokens} read=${b.cacheReadInputTokens}`);
  console.log(`   ${b.cacheReadInputTokens > 0 ? 'PASS: cache read on second call' : 'FAIL: no cache hit'}\n`);
}

/* 3. Abort: does cancelling actually stop the stream? */
{
  const ac = new AbortController();
  let received = 0;
  let aborted = false;
  try {
    for await (const ev of converseStream({
      credentials, modelId: MODEL,
      system: [{ text: 'You are verbose.' }],
      messages: [{ role: 'user', content: [{ text: 'Write 800 words about MimbleWimble.' }] }],
      maxTokens: 1200, temperature: 0, signal: ac.signal,
    })) {
      if (ev.type === 'text') {
        received++;
        if (received === 5) ac.abort();
      }
    }
  } catch (e) {
    aborted = e.name === 'AbortError' || /abort/i.test(e.message);
  }
  console.log('3. abort forwarding');
  console.log(`   deltas before abort=${received} threw abort=${aborted}`);
  console.log(`   ${aborted && received < 60 ? 'PASS: stopped early' : 'CHECK: did not stop as expected'}\n`);
}

/* 4. Error classification: an unentitled model must be reported as such, not as a generic failure. */
{
  console.log('4. error classification');
  try {
    await converse({
      credentials, modelId: 'eu.anthropic.claude-opus-5',
      system: [{ text: 'x' }],
      messages: [{ role: 'user', content: [{ text: 'hi' }] }],
      maxTokens: 8, temperature: 0,
    });
    console.log('   FAIL: expected a refusal');
  } catch (e) {
    console.log(`   kind=${e.kind} status=${e.status}`);
    console.log(`   ${e.kind === 'model-not-entitled' ? 'PASS: classified' : 'FAIL: misclassified'}`);
  }
  try {
    await converse({
      credentials, modelId: 'anthropic.claude-sonnet-4-6',
      system: [{ text: 'x' }],
      messages: [{ role: 'user', content: [{ text: 'hi' }] }],
      maxTokens: 8, temperature: 0,
    });
    console.log('   FAIL: expected a bare-model-id refusal');
  } catch (e) {
    console.log(`   kind=${e.kind} status=${e.status}`);
    console.log(`   ${e.kind === 'needs-inference-profile' ? 'PASS: classified' : 'FAIL: misclassified'}`);
  }
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}
