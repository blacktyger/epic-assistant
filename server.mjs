#!/usr/bin/env node
/**
 * The assistant endpoint.
 *
 * Three routes:
 *   GET  /api/chat/challenge   proof-of-work challenge
 *   POST /api/chat/session     mint a session token
 *   POST /api/chat             stream an answer as SSE
 *   GET  /api/chat/health      liveness plus the spend snapshot
 *
 * Gate ordering is deliberate and runs cheapest-first, so an abusive request is rejected before it
 * costs anything. Origin, then body size, then per-IP rate, then concurrency slot, then session
 * signature, then per-session budget, then the daily ledger, then the answer cache, and only then
 * retrieval and Bedrock. The expensive work is last on purpose.
 *
 * Streaming is SSE over a POST, read with fetch and a ReadableStream on the client. EventSource is not
 * usable: it is GET-only and cannot carry a request body, and the workarounds all cost a round trip or
 * a URL-length ceiling.
 *
 * One answer may now take several Bedrock calls rather than one, because the model can ask for live
 * chain or GitHub data mid-turn. `generate` owns that loop and is the only place it exists; every gate
 * above it still runs exactly once per reader request.
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  server as serverCfg, model as modelCfg, request as requestCfg, retrieval as retrievalCfg,
  spend as spendCfg, session as sessionLimits, tools as toolCfg,
  resolveModel, resolvePublicModel, publicModelChoices, reserveFor, costOf, MODELS,
} from './config.mjs';
import { loadCredentials, converseStream, BedrockStreamError } from './lib/bedrock.mjs';
import { loadRetriever, retrieve, renderDocuments } from './lib/retrieve.mjs';
import { buildPrompt, buildToolResultTurn, retrievalQuery, CANARY } from './lib/prompt.mjs';
import { SpendLedger } from './lib/ledger.mjs';
import { SessionStore, ipKey } from './lib/limits.mjs';
import { OutputGuard, extractCitations, buildCitationIndex } from './lib/guard.mjs';
import { QuestionLog } from './lib/log.mjs';
import { AnswerCache } from './lib/answer-cache.mjs';
import {
  buildToolConfig, runTool, labelFor, toolGroupFor, availableToolNames, toolStats, sweepToolCaches,
  ToolBudget,
} from './lib/tools/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ startup */

const corpusPath = resolve(HERE, serverCfg.corpusPath);
const corePath = resolve(HERE, serverCfg.corePath);
for (const [label, p] of [['corpus', corpusPath], ['core', corePath]]) {
  if (!existsSync(p)) {
    console.error(`Missing ${label} at ${p}\nRun \`npm run corpus\` after building the docs site.`);
    process.exit(1);
  }
}

const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
const core = readFileSync(corePath, 'utf8');
const retriever = loadRetriever(corpus);
const citationIndex = buildCitationIndex(corpus.sections);
const credentials = loadCredentials(resolve(HERE, serverCfg.secretsPath));

const ledger = new SpendLedger({ dir: resolve(HERE, spendCfg.ledgerDir) });
const sessions = new SessionStore();
const questionLog = new QuestionLog({ dir: resolve(HERE, 'var/questions') });
const answers = new AnswerCache(corpus.version);

/** Whole-corpus mode exists only for the A/B comparison in the evaluation harness. */
const fullCorpusDocuments = retrievalCfg.fullCorpus
  ? renderDocuments(corpus.sections)
  : null;

/**
 * Built once at startup, not per request.
 *
 * The schemas are identical on every call and they sit in the cached prompt prefix, so rebuilding them
 * per request would be pure waste. It also means a change to tool availability needs a restart, which
 * is correct: the availability of a node endpoint is a deployment fact, and a prefix that varies
 * between requests would defeat prompt caching.
 */
const toolConfig = buildToolConfig();
const toolsOffered = Boolean(toolConfig);

let inFlight = 0;

setInterval(() => {
  sessions.sweep();
  ledger.prune();
  questionLog.prune();
  sweepToolCaches();
}, 3_600_000).unref();

/* ------------------------------------------------------------------ helpers */

const json = (res, status, body, extra = {}) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...extra,
  });
  res.end(payload);
};

/**
 * Body reader with a hard ceiling enforced while reading rather than after.
 * Reading first and checking later means a large body is already in memory before it is rejected.
 */
async function readBody(req, limitBytes = 8192) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) {
      const err = new Error('body too large');
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const err = new Error('body is not valid JSON');
    err.status = 400;
    throw err;
  }
}

const clientIp = (req) =>
  // Only trusted because nginx sets it and the service binds to loopback. If this ever listens on a
  // public interface, this header becomes attacker-controlled and the rate limits become decorative.
  (req.headers['x-real-ip'] ?? req.socket.remoteAddress ?? '').toString().trim();

/**
 * Constant-time-ish comparison of the admin token.
 *
 * Guards two things: choosing a more expensive model, and bypassing the answer cache. Both would
 * otherwise be free levers for a caller to raise our bill, which is why neither is a query parameter.
 */
function isAdmin(req) {
  if (!modelCfg.adminToken) return false;
  const given = req.headers[modelCfg.adminTokenHeader];
  if (typeof given !== 'string' || given.length !== modelCfg.adminToken.length) return false;
  const a = createHmac('sha256', 'cmp').update(given).digest();
  const b = createHmac('sha256', 'cmp').update(modelCfg.adminToken).digest();
  return timingSafeEqual(a, b);
}

function originAllowed(req) {
  const origin = req.headers.origin;
  // A same-origin fetch from a browser may omit Origin; curl omits it too. This is advice, not a
  // gate: it raises the effort floor for the lazy case and is trivially spoofed otherwise.
  if (!origin) return true;
  return serverCfg.allowedOrigins.includes(origin);
}

/* ------------------------------------------------------------------ SSE */

/**
 * Server-sent events, framed so a proxy cannot buffer them into one lump.
 *
 * `X-Accel-Buffering: no` matters even though the nginx config also sets `proxy_buffering off`: it
 * travels with the response, so it survives a config drift on the server and it is the only lever
 * available when the proxy config is not ours.
 */
function openStream(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  let closed = false;
  const send = (type, data) => {
    if (closed || res.writableEnded) return;
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  // Bedrock's time to first token on a cached prefix was measured at about 1.1 seconds, and a slow
  // start plus an idle-timeout somewhere in the path is how a stream dies silently. A comment frame
  // costs nothing and keeps the connection observably alive.
  const heartbeat = setInterval(() => {
    if (!closed && !res.writableEnded) res.write(': hb\n\n');
  }, 15_000);

  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  };
  return { send, close, get closed() { return closed; } };
}

/* ------------------------------------------------------------------ routes */

const routes = {
  'GET /api/chat/challenge': (req, res) => {
    const { challenge, bits } = sessions.pow.issue();
    json(res, 200, { challenge, bits });
  },

  'POST /api/chat/session': async (req, res) => {
    const body = await readBody(req, 2048);
    const result = sessions.mint({
      ip: clientIp(req),
      challenge: body.challenge,
      nonce: body.nonce === undefined ? undefined : String(body.nonce),
    });
    if (!result.ok) return json(res, result.status, { error: result.reason });
    json(res, 200, {
      token: result.token,
      expiresAt: result.expiresAt,
      // Sent so the panel can show remaining budget and enforce the length cap before a round trip,
      // rather than discovering both from a rejection.
      limits: {
        maxQuestionChars: requestCfg.maxQuestionChars,
        maxRequests: sessionLimits.maxRequests,
        maxTurns: requestCfg.maxTurns,
      },
      /*
       * The picker's contents come from the server rather than being hard-coded in the panel.
       *
       * Not tidiness. The allowlist that decides which model a request may name lives here, so a panel
       * with its own list would offer a choice the server rejects the moment the two drift. This way
       * the only way to add a model to the picker is to add it to the allowlist.
       */
      models: publicModelChoices(),
      /** Lets the panel say the assistant can check live data, without hard-coding that it can. */
      liveData: toolsOffered,
    });
  },

  'GET /api/chat/health': (req, res) => {
    json(res, 200, {
      ok: ledger.state === 'open',
      corpus: { version: corpus.version, sections: corpus.sections.length },
      model: resolveModel(modelCfg.default),
      models: publicModelChoices(),
      spend: ledger.snapshot,
      sessions: sessions.stats,
      answerCache: answers.stats,
      tools: toolStats(),
      inFlight,
    });
  },

  'POST /api/chat': handleChat,
};

async function handleChat(req, res) {
  const ip = clientIp(req);
  const started = Date.now();

  /* --- gate 1: origin */
  if (!originAllowed(req)) return json(res, 403, { error: 'origin not allowed' });

  /* --- gate 2: body size, enforced during read */
  const body = await readBody(req, 8192);

  /* --- gate 3: per-IP rate */
  const rate = sessions.checkRate(ip);
  if (!rate.allowed) {
    return json(res, 429, { error: rate.reason }, { 'Retry-After': String(rate.retryAfter ?? 30) });
  }

  /* --- gate 4: global concurrency */
  if (inFlight >= requestCfg.maxConcurrent) {
    return json(res, 503, { error: 'busy, try again in a moment' }, { 'Retry-After': '5' });
  }
  const releaseIpSlot = sessions.acquireSlot(ip);
  if (!releaseIpSlot) {
    return json(res, 429, { error: 'too many open answers from this address' });
  }

  /* --- gate 5: session */
  const auth = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const verified = sessions.verify({ token: auth, ip });
  if (!verified.ok) {
    releaseIpSlot();
    return json(res, verified.status, { error: verified.reason, remint: true });
  }

  /* --- gate 6: question shape */
  const question = typeof body.question === 'string' ? body.question.trim() : '';
  if (!question) {
    releaseIpSlot();
    return json(res, 400, { error: 'question is required' });
  }
  if (question.length > requestCfg.maxQuestionChars) {
    releaseIpSlot();
    return json(res, 400, {
      error: `question is too long, the limit is ${requestCfg.maxQuestionChars} characters`,
    });
  }

  /* --- gate 7: per-session budget */
  const sess = sessions.checkSession(verified.sid);
  if (!sess.allowed) {
    releaseIpSlot();
    // 200 with a terminal event, not 429. A 429 on the streaming path renders as a broken widget,
    // and this is a product state rather than an error.
    const stream = openStream(res);
    stream.send('limit', {
      scope: 'session',
      message: 'You have reached the question limit for this session. Reload the page to start a new one, or use the search box.',
      remaining: sess.remaining,
    });
    stream.close();
    return;
  }

  /* --- gate 8: model selection */
  /*
   * Two paths, and the distinction is who is paying for what.
   *
   * A reader may name anything in `model.publicChoices`, which is the picker in the panel. That is a
   * deliberate reversal: the choice used to be admin-only to stop a caller reaching for the expensive
   * model, but Opus 4.6 is 1.67x Sonnet 4.6 rather than an order of magnitude, and the daily ledger
   * bounds the total either way. Withholding it cost the feature readers of a coding assistant expect.
   *
   * The header path still exists and is still gated, and now that is its whole purpose: reaching a
   * model outside the public list, for evaluation runs.
   */
  let modelId;
  let modelKey;
  const requestedModel = req.headers[modelCfg.overrideHeader];
  if (requestedModel) {
    if (!isAdmin(req)) {
      releaseIpSlot();
      return json(res, 403, { error: 'that header requires an admin token; use the model field in the body' });
    }
    const picked = resolveModel(String(requestedModel));
    if (!picked) {
      releaseIpSlot();
      return json(res, 400, { error: `unknown model, allowed: ${Object.keys(MODELS).join(', ')}` });
    }
    modelId = picked;
    modelKey = String(requestedModel);
  } else {
    const chosen = resolvePublicModel(body.model);
    if (!chosen.ok) {
      releaseIpSlot();
      return json(res, 400, { error: chosen.reason });
    }
    modelId = chosen.modelId;
    modelKey = chosen.id;
  }

  /* --- gate 9: answer cache, before the ledger so a hit costs nothing and is never blocked */
  // The bypass exists for the test suite and the evaluation harness, where a cached answer would
  // silently measure a previous run. Admin-gated for the same reason as the model override: without
  // that, any caller could force a fresh generation on every request and defeat the cheapest cost
  // control in the service.
  const skipCache = Boolean(req.headers['x-epic-no-cache']) && isAdmin(req);
  const cached = skipCache ? null : answers.get(question, modelId);
  if (cached) {
    ledger.recordCachedAnswer();
    const stream = openStream(res);
    stream.send('start', {
      cached: true, model: modelId, modelKey,
      retrieved: cached.retrieved ?? 0, sources: cached.sources ?? [],
    });
    stream.send('text', { text: cached.text });
    if (cached.citations?.length) stream.send('citations', { citations: cached.citations });
    // Same shape as the generated path, so the panel has no cached-versus-live special case.
    stream.send('done', {
      stopReason: 'cached',
      cached: true,
      citations: cached.citations?.length ?? 0,
      remaining: sessions.checkSession(verified.sid).remaining,
    });
    stream.close();
    releaseIpSlot();
    questionLog.write({
      sid: verified.sid, ipHash: hashIp(ip), question, model: modelId,
      answerCached: true, citations: cached.citations?.length ?? 0,
      ms: Date.now() - started,
    });
    return;
  }

  /* --- gate 10: daily spend */
  /*
   * The reservation is derived rather than fixed, because the spread between the cheapest and dearest
   * request on this endpoint is now about 5x: a Sonnet lookup against one retrieval pass versus an Opus
   * answer that spends all three tool rounds re-sending an accumulating transcript. A flat reserve
   * either under-protects the expensive case or refuses the cheap one long before the cap.
   */
  const reserveUsd = reserveFor(modelId, { toolRounds: toolsOffered ? toolCfg.maxRounds : 1 });
  const budget = ledger.check(reserveUsd);
  if (!budget.allowed) {
    releaseIpSlot();
    const stream = openStream(res);
    if (budget.tier === 'soft') {
      // Degrade rather than fail: the reader still gets the matching documentation sections, just
      // without a generated answer. The site's own search index is what this mirrors.
      const found = retrieve(retriever, retrievalQuery([], question), { topK: 6 });
      stream.send('degraded', {
        reason: 'daily-soft-cap',
        message: 'The assistant has used its budget for today, so here are the closest sections of the documentation instead.',
        sections: found.sections.map((s) => ({ url: s.url, title: s.heading ?? s.pageTitle, breadcrumb: s.breadcrumb })),
      });
    } else {
      stream.send('unavailable', {
        reason: 'daily-hard-cap',
        message: 'The assistant is unavailable for the rest of today. The search box covers the same documentation.',
      });
    }
    stream.close();
    questionLog.write({
      sid: verified.sid, ipHash: hashIp(ip), question, model: modelId,
      tier: budget.tier, limitHit: budget.reason, ms: Date.now() - started,
    });
    return;
  }

  /* --- everything below costs money */
  inFlight += 1;
  const releaseReservation = ledger.reserve(reserveUsd);
  const stream = openStream(res);
  const abort = new AbortController();
  let finished = false;

  /**
   * Client disconnect must stop generation, not merely stop reading it. A closed tab otherwise bills
   * for a full answer nobody will see, which is the most commonly missed cost leak in a streaming UI.
   *
   * This listens on the response, not the request. The request body is fully consumed by readBody
   * above, so its stream is already ended and its 'close' event does not track the connection for the
   * rest of the exchange. The response's 'close' fires both on normal completion and on a premature
   * connection teardown, which is why the `finished` flag distinguishes them: without it, the
   * end-of-stream close would abort a generation that had already succeeded.
   *
   * The same signal is handed to the tool layer, so an abandoned answer also abandons the node request
   * it was waiting on.
   */
  res.on('close', () => {
    if (!finished) abort.abort();
  });
  const timeout = setTimeout(() => abort.abort(), requestCfg.streamTimeoutMs);

  const history = normaliseHistory(body.history);
  const guard = new OutputGuard({ canary: CANARY });
  const toolBudget = new ToolBudget();

  /**
   * Usage is summed across rounds rather than replaced.
   *
   * Each Bedrock call reports its own usage block, so keeping only the last one would under-report a
   * three-round answer by roughly two thirds. This is the number the ledger and the session quota both
   * read, so getting it wrong silently widens both budgets.
   */
  let usage = null;
  let stopReason = null;
  let errorKind = null;
  let retrieved = { sections: [], tokensApprox: 0 };

  /**
   * Bills the accumulated usage exactly once, whichever way the request ends.
   *
   * There are now three exits: a completed answer, a guard abort mid-stream, and a thrown error. All
   * three may follow rounds Bedrock has already billed for, and the previous shape recorded on only
   * the first of them. That is the direction of mistake that matters, because a guard abort and a
   * throw are the cases most likely to repeat, so the unrecorded spend would compound exactly when
   * the daily cap was the only thing left protecting the account.
   */
  let recorded = false;
  const settleUsage = () => {
    if (recorded || !usage) return 0;
    recorded = true;
    const usd = ledger.record({ modelId, usage, ttl: modelCfg.cacheTtl });
    sessions.recordUsage(verified.sid, usage);
    return usd;
  };

  try {
    if (fullCorpusDocuments) {
      retrieved = { sections: corpus.sections, tokensApprox: corpus.stats.corpusTokensApprox };
    } else {
      retrieved = retrieve(retriever, retrievalQuery(history, question), {
        topK: retrievalCfg.topK,
        tokenBudget: retrievalCfg.tokenBudget,
      });
    }

    const documents = fullCorpusDocuments ?? (retrieved.sections.length ? renderDocuments(retrieved.sections) : '');
    const { system, messages } = buildPrompt({
      core,
      documents,
      history,
      question,
      cacheTtl: modelCfg.cacheTtl,
      tools: toolsOffered,
    });

    stream.send('start', {
      model: modelId,
      modelKey,
      liveData: toolsOffered,
      retrieved: retrieved.sections.length,
      sources: retrieved.sections.slice(0, 8).map((s) => ({
        url: s.url, title: s.heading ?? s.pageTitle, breadcrumb: s.breadcrumb,
      })),
    });

    /*
     * The tool loop.
     *
     * Each pass streams one assistant turn. If it ends with `tool_use`, the requested calls are run,
     * their results are appended as the next user turn, and the loop goes round again. Anything else
     * ends the answer.
     *
     * Three properties worth stating because they are easy to lose:
     *
     * - Text streams to the reader on every pass, not only the last. A model that says "let me check
     *   the current height" before calling a tool has said something useful, and holding it back to
     *   see whether more rounds follow would make the panel look stalled for the length of a node
     *   request.
     * - The assistant turn is replayed from `ev.content`, the blocks Bedrock actually sent, not
     *   rebuilt from the text we happened to keep. A toolResult whose toolUseId is absent from the
     *   preceding assistant message is a validation error, not a degraded answer.
     * - The loop is bounded by round count, not by whether progress is being made. A model that asks
     *   for the same tool three times gets three cached results and then has to answer, which is a
     *   worse answer but a bounded bill.
     */
    for (let round = 0; round < toolCfg.maxRounds; round += 1) {
      toolBudget.spendRound();

      /** Tool calls requested during this pass, run after the stream closes rather than during it. */
      const requested = [];
      let roundContent = [];

      for await (const ev of converseStream({
        credentials, modelId, system, messages,
        maxTokens: modelCfg.maxTokens,
        temperature: modelCfg.temperature,
        // Withheld on the final permitted round. Offering tools the loop has no room to answer
        // produces a turn that stops at `tool_use` with nothing after it, and the reader gets a
        // half-sentence. Removing them forces the model to finish with what it has.
        toolConfig: toolsOffered && round < toolCfg.maxRounds - 1 ? toolConfig : undefined,
        signal: abort.signal,
      })) {
        if (ev.type === 'text') {
          const { emit, abort: abortReason } = guard.push(ev.text);
          if (abortReason) {
            errorKind = abortReason;
            abort.abort();
            break;
          }
          if (emit) stream.send('text', { text: emit });
        } else if (ev.type === 'toolUse') {
          requested.push(ev);
        } else if (ev.type === 'done') {
          usage = addUsage(usage, ev.usage);
          stopReason = ev.stopReason;
          roundContent = ev.content;
        }
      }

      if (errorKind) break;
      if (stopReason !== 'tool_use' || !requested.length) break;

      /*
       * Told to the reader before the calls run, not after.
       *
       * A node request plus a GitHub request is a second or two of silence in the middle of an answer,
       * and silence in a chat interface reads as a hang. The label is written per tool in the registry
       * so the panel can say "Checking the live Epic chain" rather than "running tool".
       */
      stream.send('tool', {
        phase: 'start',
        calls: requested.map((r) => ({
          name: r.name,
          group: toolGroupFor(r.name),
          label: labelFor(r.name, r.input),
        })),
      });

      const results = [];
      for (const call of requested) {
        // Sequential, not parallel. Two calls per round is the realistic maximum, both are usually
        // cache hits, and serialising keeps our load on the node predictable rather than bursty.
        const outcome = call.parseError
          ? { ok: false, tool: call.name, data: { error: call.parseError }, ms: 0 }
          : await runTool(call.name, call.input, { signal: abort.signal, budget: toolBudget });
        results.push({ ...outcome, toolUseId: call.toolUseId, name: call.name });
      }

      stream.send('tool', {
        phase: 'done',
        calls: results.map((r) => ({
          name: r.name,
          group: toolGroupFor(r.name),
          ok: r.ok,
          ms: r.ms,
        })),
      });

      messages.push({ role: 'assistant', content: roundContent });
      messages.push(buildToolResultTurn(results));
    }

    if (!errorKind) {
      const tail = guard.finish();
      if (tail.emit) stream.send('text', { text: tail.emit });

      const { citations, invalid } = extractCitations(guard.text, citationIndex);
      if (citations.length) stream.send('citations', { citations });

      const usd = settleUsage();

      const refused = looksLikeRefusal(guard.text);
      const usedTools = toolBudget.calls > 0;

      /*
       * An answer built on live data is not cached.
       *
       * The answer cache has a 24-hour TTL, which is correct for "what is coinbase maturity" and wrong
       * by 1,440 blocks for "what is the current height". Caching a live answer would be worse than
       * having no live data at all, because it would report a stale figure with the confidence of a
       * fresh one. The tool layer's own short TTLs already remove the repeated cost, so what is lost
       * here is small.
       */
      if (!usedTools) {
        answers.set(question, modelId, {
          text: guard.text,
          citations,
          refused,
          // Carried so a cache hit can reproduce the same start event as a live generation.
          retrieved: retrieved.sections.length,
          sources: retrieved.sections.slice(0, 8).map((s) => ({
            url: s.url, title: s.heading ?? s.pageTitle, breadcrumb: s.breadcrumb,
          })),
        });
      }

      stream.send('done', {
        stopReason,
        citations: citations.length,
        liveData: usedTools,
        remaining: sessions.checkSession(verified.sid).remaining,
      });

      questionLog.write({
        sid: verified.sid, ipHash: hashIp(ip), question, model: modelId,
        refused,
        citations: citations.length,
        citationsInvalid: invalid.length,
        followup: /(^|\n)\s*(Next:|Also worth knowing:)/.test(guard.text),
        guardFindings: guard.findings,
        retrievedSections: retrieved.sections.length,
        retrievedTokens: retrieved.tokensApprox,
        cacheHit: usage ? usage.cacheReadInputTokens > 0 : null,
        tools: toolBudget.summary,
        usage, usd, stopReason,
        ms: Date.now() - started,
      });
    } else {
      settleUsage();
      stream.send('error', {
        kind: errorKind,
        message: 'The answer was stopped by a safety check. Please rephrase, or use the search box.',
        retryable: false,
      });
      questionLog.write({
        sid: verified.sid, ipHash: hashIp(ip), question, model: modelId,
        guardFindings: guard.findings, tools: toolBudget.summary,
        error: errorKind, ms: Date.now() - started,
      });
    }
  } catch (err) {
    const aborted = err?.name === 'AbortError' || /abort/i.test(err?.message ?? '');
    if (aborted && !errorKind) {
      // A reader pressing stop, or a closed tab. Whatever streamed stays on their screen.
      stream.send('aborted', { reason: 'stopped' });
    } else {
      const kind = err instanceof BedrockStreamError ? err.kind : 'server';
      stream.send('error', {
        kind,
        message: messageFor(kind),
        retryable: kind === 'throttled' || kind === 'server',
      });
      console.error(`[chat] ${kind}: ${err?.message}`);
      questionLog.write({
        sid: verified.sid, ipHash: hashIp(ip), question, model: modelId,
        error: kind, tools: toolBudget.summary, ms: Date.now() - started,
      });
    }

    /*
     * Usage from rounds that completed before the failure is still recorded.
     *
     * Bedrock billed for them whether or not the answer arrived, so skipping this on the error path
     * would let a request that failed on its third round spend two rounds' worth of budget invisibly.
     * A repeated failure is exactly when the ledger most needs to be right.
     */
    settleUsage();
  } finally {
    finished = true;
    clearTimeout(timeout);
    releaseReservation();
    releaseIpSlot();
    inFlight -= 1;
    stream.close();
  }
}

/* ------------------------------------------------------------------ small helpers */

/**
 * Sums the usage blocks from every round of one answer.
 *
 * Bedrock reports usage per call, so a three-round answer arrives as three blocks. Cache reads are
 * summed alongside the rest and that is correct rather than surprising: the cached prefix is read once
 * per round, so a three-round answer genuinely pays three cache reads, at a tenth of input price each.
 */
function addUsage(into, next) {
  if (!next) return into;
  if (!into) return { ...next };
  return {
    inputTokens: into.inputTokens + next.inputTokens,
    outputTokens: into.outputTokens + next.outputTokens,
    cacheReadInputTokens: into.cacheReadInputTokens + next.cacheReadInputTokens,
    cacheWriteInputTokens: into.cacheWriteInputTokens + next.cacheWriteInputTokens,
    totalTokens: (into.totalTokens ?? 0) + (next.totalTokens ?? 0),
  };
}

function normaliseHistory(raw) {  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string')
    .slice(-requestCfg.maxTurns * 2)
    .map((m) => ({
      role: m.role,
      // History is caller-supplied, so it is capped independently. Without this a caller could grow
      // the prompt without limit through history while every other cap looked satisfied.
      text: m.text.slice(0, requestCfg.maxQuestionChars),
    }));
}

/**
 * Used only as a logging flag and to keep refusals out of the answer cache. Deliberately not shown to
 * the reader as a judgement, because a model's own "not found" means "not in what I was given" and
 * never "not in the corpus".
 */
function looksLikeRefusal(text) {
  return /\b(do(es)? not (cover|contain|describe|mention)|not in the (docs|documentation)|could not find|no section)\b/i
    .test(text.slice(0, 400));
}

function messageFor(kind) {
  switch (kind) {
    case 'throttled': return 'The model is busy. Try again in a few seconds.';
    case 'model-not-entitled': return 'That model is not available on this account.';
    case 'needs-inference-profile': return 'Server misconfiguration: the model needs an inference profile.';
    case 'validation': return 'The request was rejected by the model service.';
    case 'truncated': return 'The answer was cut off in transit. Try again.';
    default: return 'Something went wrong generating the answer. Try again.';
  }
}

/** Keyed, truncated, and the key rotates daily, so yesterday's hashes cannot be relinked. */
function hashIp(ip) {
  return createHmac('sha256', String(process.pid)).update(ipKey(ip)).digest('base64url').slice(0, 12);
}

/* ------------------------------------------------------------------ static preview */

/**
 * Optionally serves the built docs site alongside the API, on one origin.
 *
 * Development only. In production nginx serves the static files and proxies /api/chat, and this stays
 * unset. It exists because the panel calls a relative `/api/chat`, so during development the site and
 * the API have to appear on the same origin: the site's CSP is `connect-src 'self'`, which means a
 * cross-origin call to another port is refused by the browser regardless of any CORS header the server
 * sends. Serving both here reproduces the production shape exactly, with one process to start.
 *
 * `npm run serve` in the site directory cannot do this, because it serves static files with no proxy.
 */
const STATIC_DIR = process.env.EPIC_AI_STATIC_DIR
  ? resolve(HERE, process.env.EPIC_AI_STATIC_DIR)
  : null;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

async function serveStatic(req, res, pathname) {
  if (!STATIC_DIR) return false;

  // Reject traversal before touching the filesystem.
  const decoded = decodeURIComponent(pathname);
  if (decoded.includes('\0')) return false;
  let target = join(STATIC_DIR, decoded);
  if (!target.startsWith(STATIC_DIR)) return false;

  try {
    let info = statSync(target);
    if (info.isDirectory()) {
      target = join(target, 'index.html');
      info = statSync(target);
    }
    const body = readFileSync(target);
    res.writeHead(200, {
      'Content-Type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
    });
    res.end(body);
    return true;
  } catch {
    // Fall back to the site's own 404 page so a wrong path looks like the real site, not like a
    // server error.
    try {
      const body = readFileSync(join(STATIC_DIR, '404.html'));
      res.writeHead(404, {'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length});
      res.end(body);
      return true;
    } catch {
      return false;
    }
  }
}

/* ------------------------------------------------------------------ listen */

/**
 * The paths this server owns, derived from the route table rather than restated.
 *
 * Used to decide what must never fall through to the static site. Keeping it derived means adding a
 * route cannot forget to update it, and it stays a set of exact paths so the documentation's own
 * `/api/*` pages are untouched.
 */
const ownApiPaths = new Set(Object.keys(routes).map((key) => key.slice(key.indexOf(' ') + 1)));

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const key = `${req.method} ${url.pathname}`;
  const handler = routes[key];

  if (!handler) {
    /*
     * Anything that is not one of this server's own routes may be a page, when static preview is
     * enabled.
     *
     * Matched against the exact declared route paths, not an `/api/` prefix. A prefix test was wrong
     * in a way that hid a lot: the documentation has its own `/api/` section, 16 reference pages, and
     * excluding that prefix from static serving made every one of them return a JSON 404 on this
     * origin. Production has the same trap waiting in nginx, so `deploy/nginx.conf` must proxy the
     * three paths below rather than `location /api/`.
     */
    if (req.method === 'GET' && !ownApiPaths.has(url.pathname)) {
      if (await serveStatic(req, res, url.pathname)) return;
    }
    return json(res, 404, {error: 'not found'});
  }

  try {
    await handler(req, res);
  } catch (err) {
    const status = err?.status ?? 500;
    if (status >= 500) console.error(`[server] ${req.method} ${url.pathname}:`, err);
    if (!res.headersSent) json(res, status, { error: err?.message ?? 'internal error' });
    else if (!res.writableEnded) res.end();
  }
});

httpServer.listen(serverCfg.port, serverCfg.host, () => {
  console.log(`epic-assistant on http://${serverCfg.host}:${serverCfg.port}`);
  console.log(`  model    ${resolveModel(modelCfg.default)}`);
  console.log(`  picker   ${publicModelChoices().choices.map((m) => m.id).join(', ') || 'none'}`);
  console.log(`  corpus   ${corpus.sections.length} sections, built ${corpus.version}`);
  console.log(`  retrieval topK=${retrievalCfg.topK}${retrievalCfg.fullCorpus ? ' (FULL CORPUS MODE)' : ''}`);
  /*
   * Printed at startup because the failure mode is silent. A missing EPIC_NODE_URL or node secret
   * leaves the chain tools out of `toolConfig`, the model never mentions them, and every live question
   * gets a documentation answer that looks entirely reasonable. Naming what is offered turns that into
   * something visible on the first line of the log.
   */
  const t = toolStats();
  console.log(`  tools    ${availableToolNames().join(', ') || 'none'}`);
  console.log(`           chain ${t.node.available ? 'ready' : 'unavailable, check EPIC_NODE_URL and EPIC_NODE_API_SECRET'}`);
  console.log(`           github ${t.github.available ? t.github.repos.join(', ') : 'unavailable'}${t.github.rate.authenticated ? '' : ' (unauthenticated, 60 requests per hour)'}`);
  console.log(`  spend    $${ledger.usd.toFixed(4)} today, soft $${spendCfg.softDailyUsd}, hard $${spendCfg.hardDailyUsd}, state ${ledger.state}`);
  if (STATIC_DIR) {
    console.log(`  static   serving ${STATIC_DIR}`);
    console.log(`  open     http://${serverCfg.host}:${serverCfg.port}/`);
  } else {
    console.log('  static   off (set EPIC_AI_STATIC_DIR to preview the built site on this origin)');
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n${sig}, closing`);
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
