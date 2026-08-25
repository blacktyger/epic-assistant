/**
 * Decoder for the AWS event stream framing that `ConverseStream` returns as
 * `application/vnd.amazon.eventstream`.
 *
 * Deliberately hand-rolled instead of taking `@aws-sdk/client-bedrock-runtime`, which the plan
 * originally specified. Three reasons:
 *
 * 1. Plain `fetch` with `Authorization: Bearer` is already proven against this account for Converse,
 *    ListFoundationModels and InvokeModel, so the SDK would be carried purely to decode one binary
 *    format. The credential path does not need it.
 * 2. The SDK brings its whole middleware stack, credential providers and retry machinery for a single
 *    call on a server we want small enough to audit.
 * 3. Abort forwarding is the cost control that matters most here, and owning the read loop makes
 *    "tab closed, stop paying" a plain `AbortSignal` rather than a question about SDK internals.
 *
 * Frame layout, big-endian throughout:
 *
 *   4  total byte length, inclusive of everything
 *   4  headers byte length
 *   4  prelude CRC32
 *   n  headers
 *   m  payload, where m = total - 16 - headers length
 *   4  message CRC32
 *
 * Header layout, repeated until the headers section is consumed:
 *
 *   1  name length
 *   n  name
 *   1  value type
 *   ?  value, which for the string type (7) is a 2-byte length then the bytes
 *
 * CRCs are not verified. The stream arrives over TLS, which already provides integrity, so a
 * mismatch would indicate a bug in this decoder rather than corruption on the wire, and the length
 * bounds check below catches a desynchronised parse more usefully than a checksum would.
 */

const STRING_TYPE = 7;
const MAX_FRAME = 64 * 1024 * 1024; // sanity bound; a Converse delta is a few hundred bytes

/**
 * Incremental decoder. Feed it chunks in arrival order; it yields whole messages only.
 */
export class EventStreamDecoder {
  #buf = Buffer.alloc(0);

  /**
   * @param {Uint8Array} chunk
   * @returns {{headers: Record<string, string>, payload: Buffer}[]}
   */
  push(chunk) {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : Buffer.from(chunk);
    const out = [];

    for (;;) {
      if (this.#buf.length < 12) break;

      const total = this.#buf.readUInt32BE(0);
      const headersLen = this.#buf.readUInt32BE(4);

      if (total < 16 || total > MAX_FRAME || headersLen > total - 16) {
        throw new Error(
          `event stream desynchronised: total=${total} headersLen=${headersLen} buffered=${this.#buf.length}`,
        );
      }
      if (this.#buf.length < total) break; // wait for the rest of the frame

      const frame = this.#buf.subarray(0, total);
      this.#buf = this.#buf.subarray(total);

      const headers = parseHeaders(frame.subarray(12, 12 + headersLen));
      const payload = frame.subarray(12 + headersLen, total - 4);
      out.push({ headers, payload: Buffer.from(payload) });
    }

    return out;
  }

  /** Bytes held back because a frame is incomplete. Non-zero at end of stream means truncation. */
  get pending() {
    return this.#buf.length;
  }
}

function parseHeaders(section) {
  const headers = {};
  let off = 0;
  while (off < section.length) {
    const nameLen = section.readUInt8(off);
    off += 1;
    const name = section.toString('utf8', off, off + nameLen);
    off += nameLen;
    const type = section.readUInt8(off);
    off += 1;

    if (type === STRING_TYPE || type === 6) {
      const len = section.readUInt16BE(off);
      off += 2;
      headers[name] = section.toString('utf8', off, off + len);
      off += len;
    } else if (type === 0 || type === 1) {
      headers[name] = type === 0;
    } else if (type === 2) {
      headers[name] = section.readInt8(off); off += 1;
    } else if (type === 3) {
      headers[name] = section.readInt16BE(off); off += 2;
    } else if (type === 4) {
      headers[name] = section.readInt32BE(off); off += 4;
    } else if (type === 5 || type === 8) {
      headers[name] = Number(section.readBigInt64BE(off)); off += 8;
    } else if (type === 9) {
      headers[name] = section.toString('hex', off, off + 16); off += 16;
    } else {
      // An unknown header type means the layout is no longer trustworthy, so stop rather than
      // guess a width and silently mis-read every following header.
      throw new Error(`unknown event stream header type ${type} for header "${name}"`);
    }
  }
  return headers;
}

/**
 * Turns a fetch Response body carrying the event stream into an async iterator of
 * `{ type, body }`, where type is the `:event-type` header and body the parsed JSON payload.
 *
 * Bedrock signals failures inside the stream as well as by status code: a mid-stream throttle or
 * validation failure arrives as a frame whose `:message-type` is `exception`. Those are surfaced as
 * a thrown BedrockStreamError so a caller cannot mistake a failed generation for a short one.
 */
export async function* iterateEventStream(body) {
  const decoder = new EventStreamDecoder();
  for await (const chunk of body) {
    for (const msg of decoder.push(chunk)) {
      const type = msg.headers[':event-type'];
      const messageType = msg.headers[':message-type'];
      let parsed;
      try {
        parsed = msg.payload.length ? JSON.parse(msg.payload.toString('utf8')) : {};
      } catch {
        parsed = { raw: msg.payload.toString('utf8') };
      }

      if (messageType === 'exception' || messageType === 'error') {
        const kind = msg.headers[':exception-type'] ?? msg.headers[':error-code'] ?? 'unknown';
        throw new BedrockStreamError(kind, parsed.message ?? parsed.Message ?? '');
      }
      yield { type, body: parsed };
    }
  }
  if (decoder.pending) {
    throw new BedrockStreamError('truncated', `${decoder.pending} bytes left undecoded at end of stream`);
  }
}

export class BedrockStreamError extends Error {
  constructor(kind, detail) {
    super(`bedrock stream ${kind}${detail ? `: ${detail}` : ''}`);
    this.name = 'BedrockStreamError';
    this.kind = kind;
  }
}
