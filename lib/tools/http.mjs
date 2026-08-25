/**
 * The only outbound HTTP path the tool layer has, plus the TTL cache in front of it.
 *
 * Everything a tool reaches goes through `fetchJson`. That is deliberate: it means the timeout, the
 * size ceiling and the abort behaviour are properties of the layer rather than promises each tool
 * makes separately, and it means there is exactly one place to look when asking what this service can
 * talk to.
 *
 * Three failure modes this file exists to prevent, all of them observed in similar code rather than
 * imagined:
 *
 * 1. A hung upstream holding a reader's connection open. `fetch` has no default timeout, so without an
 *    explicit AbortSignal a dead endpoint stalls until the platform gives up, which on Node is
 *    minutes. The reader sees a spinner and the model call sits there billing for nothing.
 * 2. A large response read into memory before anybody checks its size. `res.json()` buffers first and
 *    asks questions never, so the ceiling has to be enforced while reading, chunk by chunk.
 * 3. A cache that stampedes. Ten readers asking about the chain tip within the same second must
 *    produce one upstream request, not ten, so an in-flight promise is shared rather than each caller
 *    starting its own.
 */

/* ------------------------------------------------------------------ errors */

export class ToolHttpError extends Error {
  /**
   * @param {'timeout'|'status'|'too-large'|'network'|'not-json'|'upstream'} kind
   */
  constructor(kind, message, { status = null, retryable = false } = {}) {
    super(message);
    this.name = 'ToolHttpError';
    this.kind = kind;
    this.status = status;
    this.retryable = retryable;
  }
}

/* ------------------------------------------------------------------ fetch */

/**
 * One bounded JSON request.
 *
 * @param {string} url
 * @param {object} o
 * @param {string} [o.method]
 * @param {Record<string,string>} [o.headers]
 * @param {string} [o.body]
 * @param {number} o.timeoutMs
 * @param {number} [o.maxBytes]      hard ceiling on the response body
 * @param {number[]} [o.allowStatus] non-2xx statuses to return rather than throw on
 * @param {AbortSignal} [o.signal]   the caller's signal, so a closed tab stops this too
 * @returns {Promise<{status: number, headers: Headers, json: any}>}
 */
export async function fetchJson(url, {
  method = 'GET',
  headers = {},
  body,
  timeoutMs,
  maxBytes = 2_000_000,
  allowStatus = [],
  signal,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new ToolHttpError('timeout', `no response within ${timeoutMs} ms`)), timeoutMs);

  // The caller's signal has to be forwarded rather than replaced. A reader closing the tab should
  // abandon an in-flight node request as well as the model stream, or the two lifetimes diverge and
  // the tool keeps working for an answer nobody will read.
  const onOuterAbort = () => controller.abort(new ToolHttpError('network', 'request cancelled'));
  signal?.addEventListener('abort', onOuterAbort, { once: true });

  try {
    let res;
    try {
      res = await fetch(url, { method, headers, body, signal: controller.signal, redirect: 'follow' });
    } catch (err) {
      if (err instanceof ToolHttpError) throw err;
      if (controller.signal.reason instanceof ToolHttpError) throw controller.signal.reason;
      throw new ToolHttpError('network', shortMessage(err), { retryable: true });
    }

    const text = await readCapped(res, maxBytes);

    if (!res.ok && !allowStatus.includes(res.status)) {
      throw new ToolHttpError('status', `upstream returned ${res.status}`, {
        status: res.status,
        // 5xx and 429 may work on a later question. A 4xx will not, and retrying it only burns the
        // rate-limit budget faster.
        retryable: res.status >= 500 || res.status === 429,
      });
    }

    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw new ToolHttpError('not-json', 'upstream response was not JSON');
    }

    return { status: res.status, headers: res.headers, json };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuterAbort);
  }
}

/**
 * Reads the body while counting bytes, aborting the moment the ceiling is crossed.
 *
 * Content-Length is checked first when present, which is the cheap case, but it is not sufficient: a
 * chunked response has none, and it is exactly the endpoint that returns an unexpectedly large body
 * that is likely to stream it. So the count is enforced on the actual bytes as well.
 */
async function readCapped(res, maxBytes) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ToolHttpError('too-large', `response declared ${declared} bytes, ceiling is ${maxBytes}`);
  }
  if (!res.body) return await res.text();

  const decoder = new TextDecoder();
  let out = '';
  let seen = 0;
  for await (const chunk of res.body) {
    seen += chunk.length;
    if (seen > maxBytes) {
      throw new ToolHttpError('too-large', `response exceeded ${maxBytes} bytes`);
    }
    out += decoder.decode(chunk, { stream: true });
  }
  return out + decoder.decode();
}

function shortMessage(err) {
  const m = err?.cause?.code ?? err?.code ?? err?.message ?? 'request failed';
  return String(m).slice(0, 120);
}

/* ------------------------------------------------------------------ TTL cache */

/**
 * Keyed TTL cache with in-flight sharing.
 *
 * The reason this is the most important object in the tool layer: it is what makes the load our tools
 * put on an upstream a function of the clock instead of a function of how popular the assistant is.
 * With a 30-second TTL on the chain tip, a thousand readers a minute cost the node two requests. That
 * property is what makes it defensible to point a public endpoint at infrastructure we care about.
 *
 * A stale entry is kept after its TTL expires and served if a refresh fails, which is the difference
 * between "the chain tip was 3,680,932 about a minute ago" and an error message. Bounded by
 * `maxEntries` with least-recently-used eviction, so an argument-varying tool cannot grow it without
 * limit.
 */
export class TtlCache {
  #map = new Map();     // key -> {value, at, ttlMs}
  #inFlight = new Map(); // key -> Promise
  #hits = 0;
  #misses = 0;
  #maxEntries;

  constructor({ maxEntries = 500 } = {}) {
    this.#maxEntries = maxEntries;
  }

  /**
   * @param {string} key
   * @param {number} ttlSeconds
   * @param {() => Promise<any>} produce
   * @returns {Promise<{value: any, cached: boolean, ageSeconds: number, stale: boolean}>}
   */
  async get(key, ttlSeconds, produce) {
    const ttlMs = ttlSeconds * 1000;
    const held = this.#map.get(key);

    if (held && Date.now() - held.at < ttlMs) {
      this.#hits += 1;
      // Refresh recency so popular keys survive eviction.
      this.#map.delete(key);
      this.#map.set(key, held);
      return { value: held.value, cached: true, ageSeconds: Math.round((Date.now() - held.at) / 1000), stale: false };
    }

    const pending = this.#inFlight.get(key);
    if (pending) {
      // Somebody else is already asking. Waiting is both cheaper and more correct than asking again.
      this.#hits += 1;
      const value = await pending;
      return { value, cached: true, ageSeconds: 0, stale: false };
    }

    this.#misses += 1;
    const promise = (async () => produce())();
    this.#inFlight.set(key, promise);

    try {
      const value = await promise;
      this.#map.set(key, { value, at: Date.now() });
      while (this.#map.size > this.#maxEntries) {
        this.#map.delete(this.#map.keys().next().value);
      }
      return { value, cached: false, ageSeconds: 0, stale: false };
    } catch (err) {
      // Serving an expired entry beats serving an error, as long as the age is stated so the model can
      // qualify what it says. Only for a genuinely held value: a first-ever failure still throws.
      if (held) {
        return {
          value: held.value,
          cached: true,
          ageSeconds: Math.round((Date.now() - held.at) / 1000),
          stale: true,
          error: err,
        };
      }
      throw err;
    } finally {
      this.#inFlight.delete(key);
    }
  }

  /** Drops expired entries. Called from the server's hourly sweep. */
  sweep(maxAgeSeconds = 3600) {
    const cutoff = Date.now() - maxAgeSeconds * 1000;
    for (const [key, entry] of this.#map) if (entry.at < cutoff) this.#map.delete(key);
  }

  get stats() {
    return { entries: this.#map.size, hits: this.#hits, misses: this.#misses, inFlight: this.#inFlight.size };
  }
}
