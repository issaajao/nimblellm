/**
 * AWS `vnd.amazon.eventstream` decoding.
 *
 * Bedrock's `converse-stream` does not use SSE — it returns a sequence of
 * binary frames. Each frame is:
 *
 * ```
 * ┌───────────────┬─────────────────┬─────────────┬─────────┬─────────┬─────────────┐
 * │ total length  │ headers length  │ prelude CRC │ headers │ payload │ message CRC │
 * │   4 bytes     │     4 bytes     │   4 bytes   │   var   │   var   │   4 bytes   │
 * └───────────────┴─────────────────┴─────────────┴─────────┴─────────┴─────────────┘
 * ```
 *
 * CRCs are not verified. They guard against corruption on the wire, which TLS
 * already covers, and skipping them keeps this to arithmetic on a buffer.
 */

import { NimbleError } from '../errors.js';

/** Fixed bytes of a frame: prelude (12) plus the trailing message CRC (4). */
const OVERHEAD = 16;
const PRELUDE = 12;

/**
 * Bytes from any buffer backing. Chunks handed over by `fetch` are not
 * guaranteed to sit on a plain `ArrayBuffer`, so the narrower default that
 * TypeScript infers would reject them.
 */
type Bytes = Uint8Array<ArrayBufferLike>;

export interface EventStreamMessage {
  readonly headers: Readonly<Record<string, string | number | boolean>>;
  readonly payload: Bytes;
}

/**
 * Incremental frame decoder.
 *
 * Network chunks do not align with frame boundaries, so bytes are buffered
 * until at least one whole frame is available.
 */
export class EventStreamDecoder {
  #buffer: Bytes = new Uint8Array(0);

  /** Feed bytes in, get whole frames out. */
  push(chunk: Bytes): EventStreamMessage[] {
    this.#buffer = concat(this.#buffer, chunk);

    const messages: EventStreamMessage[] = [];
    for (;;) {
      const message = this.#shift();
      if (message === undefined) break;
      messages.push(message);
    }
    return messages;
  }

  /** Bytes buffered but not yet forming a complete frame. */
  get pending(): number {
    return this.#buffer.length;
  }

  #shift(): EventStreamMessage | undefined {
    if (this.#buffer.length < PRELUDE) return undefined;

    const view = new DataView(
      this.#buffer.buffer,
      this.#buffer.byteOffset,
      this.#buffer.byteLength,
    );
    const totalLength = view.getUint32(0);
    const headersLength = view.getUint32(4);

    if (totalLength < OVERHEAD + headersLength) {
      throw new NimbleError('bedrock returned a malformed event stream frame', {
        code: 'provider_error',
        provider: 'bedrock',
        retryable: true,
      });
    }
    if (this.#buffer.length < totalLength) return undefined;

    const headers = decodeHeaders(this.#buffer.subarray(PRELUDE, PRELUDE + headersLength));
    const payload = this.#buffer.slice(PRELUDE + headersLength, totalLength - 4);

    this.#buffer = this.#buffer.slice(totalLength);

    return { headers, payload };
  }
}

/**
 * Decode a Bedrock stream into the chunk shapes `BedrockAdapter.parseStreamChunk`
 * expects — `{ contentBlockDelta: … }`, `{ messageStop: … }`, and so on.
 *
 * @throws NimbleError - `provider_error` when the stream carries an exception
 *   frame, which is how Bedrock reports mid-stream failures
 */
export async function* readBedrockStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<unknown, void, undefined> {
  const decoder = new EventStreamDecoder();
  const text = new TextDecoder();
  const reader = stream.getReader();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      for (const message of decoder.push(value)) {
        const messageType = String(message.headers[':message-type'] ?? 'event');
        const eventType = message.headers[':event-type'];
        const body: unknown = parseJson(text.decode(message.payload));

        if (messageType === 'exception' || messageType === 'error') {
          const name = String(message.headers[':exception-type'] ?? 'unknown');
          throw new NimbleError(`bedrock stream failed: ${name}`, {
            code: 'provider_error',
            provider: 'bedrock',
            // Throttling mid-stream is worth another attempt; a validation
            // failure in the frame is not.
            retryable: name.toLowerCase().includes('throttl'),
            cause: body,
          });
        }

        if (typeof eventType === 'string') yield { [eventType]: body };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

const HEADER_TYPE = {
  boolTrue: 0,
  boolFalse: 1,
  byte: 2,
  short: 3,
  integer: 4,
  long: 5,
  byteArray: 6,
  string: 7,
  timestamp: 8,
  uuid: 9,
} as const;

export function decodeHeaders(bytes: Bytes): Record<string, string | number | boolean> {
  const headers: Record<string, string | number | boolean> = {};
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = new TextDecoder();
  let offset = 0;

  while (offset < bytes.length) {
    const nameLength = view.getUint8(offset);
    offset += 1;
    const name = text.decode(bytes.subarray(offset, offset + nameLength));
    offset += nameLength;

    const type = view.getUint8(offset);
    offset += 1;

    switch (type) {
      case HEADER_TYPE.boolTrue:
        headers[name] = true;
        break;
      case HEADER_TYPE.boolFalse:
        headers[name] = false;
        break;
      case HEADER_TYPE.byte:
        headers[name] = view.getInt8(offset);
        offset += 1;
        break;
      case HEADER_TYPE.short:
        headers[name] = view.getInt16(offset);
        offset += 2;
        break;
      case HEADER_TYPE.integer:
        headers[name] = view.getInt32(offset);
        offset += 4;
        break;
      case HEADER_TYPE.long:
      case HEADER_TYPE.timestamp:
        headers[name] = Number(view.getBigInt64(offset));
        offset += 8;
        break;
      case HEADER_TYPE.byteArray:
      case HEADER_TYPE.string: {
        const length = view.getUint16(offset);
        offset += 2;
        headers[name] = text.decode(bytes.subarray(offset, offset + length));
        offset += length;
        break;
      }
      case HEADER_TYPE.uuid:
        headers[name] = Buffer.from(bytes.subarray(offset, offset + 16)).toString('hex');
        offset += 16;
        break;
      default:
        throw new NimbleError(`bedrock sent an event header of unknown type ${type}`, {
          code: 'provider_error',
          provider: 'bedrock',
          retryable: false,
        });
    }
  }

  return headers;
}

function concat(a: Bytes, b: Bytes): Bytes {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
