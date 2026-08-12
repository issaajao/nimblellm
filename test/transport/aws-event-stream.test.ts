import { describe, expect, it } from 'vitest';
import {
  decodeHeaders,
  EventStreamDecoder,
  readBedrockStream,
} from '../../src/transport/aws-event-stream.js';

/** Encode one string header entry: name length, name, type 7, value length, value. */
function stringHeader(name: string, value: string): Uint8Array {
  const nameBytes = Buffer.from(name, 'utf8');
  const valueBytes = Buffer.from(value, 'utf8');
  const out = Buffer.alloc(1 + nameBytes.length + 1 + 2 + valueBytes.length);

  let offset = 0;
  out.writeUInt8(nameBytes.length, offset);
  offset += 1;
  nameBytes.copy(out, offset);
  offset += nameBytes.length;
  out.writeUInt8(7, offset);
  offset += 1;
  out.writeUInt16BE(valueBytes.length, offset);
  offset += 2;
  valueBytes.copy(out, offset);

  return new Uint8Array(out);
}

/** Assemble a complete frame. CRC fields are zeroed; the decoder ignores them. */
function frame(headers: Record<string, string>, payload: unknown): Uint8Array {
  const headerBytes = Buffer.concat(
    Object.entries(headers).map(([name, value]) => Buffer.from(stringHeader(name, value))),
  );
  const payloadBytes = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
  const total = 16 + headerBytes.length + payloadBytes.length;

  const out = Buffer.alloc(total);
  out.writeUInt32BE(total, 0);
  out.writeUInt32BE(headerBytes.length, 4);
  out.writeUInt32BE(0, 8); // prelude CRC
  headerBytes.copy(out, 12);
  payloadBytes.copy(out, 12 + headerBytes.length);
  out.writeUInt32BE(0, total - 4); // message CRC

  return new Uint8Array(out);
}

function event(eventType: string, payload: unknown): Uint8Array {
  return frame({ ':message-type': 'event', ':event-type': eventType }, payload);
}

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) out.push(item);
  return out;
}

describe('decodeHeaders', () => {
  it('reads string headers', () => {
    const bytes = Buffer.concat([
      Buffer.from(stringHeader(':message-type', 'event')),
      Buffer.from(stringHeader(':event-type', 'contentBlockDelta')),
    ]);

    expect(decodeHeaders(new Uint8Array(bytes))).toEqual({
      ':message-type': 'event',
      ':event-type': 'contentBlockDelta',
    });
  });

  it('reads the scalar header types', () => {
    const bytes = Buffer.alloc(0);
    const parts: Buffer[] = [];

    const push = (name: string, type: number, write: (buffer: Buffer) => void, size: number) => {
      const nameBytes = Buffer.from(name);
      const header = Buffer.alloc(1 + nameBytes.length + 1 + size);
      header.writeUInt8(nameBytes.length, 0);
      nameBytes.copy(header, 1);
      header.writeUInt8(type, 1 + nameBytes.length);
      write(header.subarray(2 + nameBytes.length));
      parts.push(header);
    };

    push('t', 0, () => {}, 0);
    push('f', 1, () => {}, 0);
    push('i', 4, (b) => b.writeInt32BE(7), 4);
    push('l', 5, (b) => b.writeBigInt64BE(9n), 8);

    expect(decodeHeaders(new Uint8Array(Buffer.concat([bytes, ...parts])))).toEqual({
      t: true,
      f: false,
      i: 7,
      l: 9,
    });
  });

  it('rejects an unknown header type', () => {
    const bytes = new Uint8Array([1, 0x61, 99]);
    expect(() => decodeHeaders(bytes)).toThrowError(/unknown type 99/);
  });

  it('reads nothing from empty headers', () => {
    expect(decodeHeaders(new Uint8Array(0))).toEqual({});
  });
});

describe('EventStreamDecoder', () => {
  it('decodes a whole frame', () => {
    const decoder = new EventStreamDecoder();
    const messages = decoder.push(event('messageStop', { stopReason: 'end_turn' }));

    expect(messages).toHaveLength(1);
    expect(messages[0]?.headers).toEqual({
      ':message-type': 'event',
      ':event-type': 'messageStop',
    });
    expect(JSON.parse(new TextDecoder().decode(messages[0]?.payload))).toEqual({
      stopReason: 'end_turn',
    });
  });

  it('decodes several frames from one chunk', () => {
    const decoder = new EventStreamDecoder();
    const bytes = Buffer.concat([Buffer.from(event('a', {})), Buffer.from(event('b', {}))]);
    expect(decoder.push(new Uint8Array(bytes))).toHaveLength(2);
  });

  it('buffers a frame split across chunks', () => {
    const decoder = new EventStreamDecoder();
    const bytes = event('messageStop', { stopReason: 'end_turn' });

    expect(decoder.push(bytes.slice(0, 8))).toEqual([]);
    expect(decoder.pending).toBe(8);
    expect(decoder.push(bytes.slice(8, 20))).toEqual([]);
    expect(decoder.push(bytes.slice(20))).toHaveLength(1);
    expect(decoder.pending).toBe(0);
  });

  it('holds bytes that begin a frame it cannot yet complete', () => {
    const decoder = new EventStreamDecoder();
    const bytes = Buffer.concat([Buffer.from(event('a', {})), Buffer.from(event('b', {}))]);

    expect(decoder.push(new Uint8Array(bytes.subarray(0, bytes.length - 5)))).toHaveLength(1);
    expect(decoder.pending).toBeGreaterThan(0);
  });

  it('rejects a frame whose lengths cannot be reconciled', () => {
    const bad = Buffer.alloc(20);
    bad.writeUInt32BE(20, 0);
    bad.writeUInt32BE(100, 4); // headers longer than the frame
    expect(() => new EventStreamDecoder().push(new Uint8Array(bad))).toThrowError(
      /malformed event stream frame/,
    );
  });
});

describe('readBedrockStream', () => {
  it('yields chunks in the shape the Bedrock adapter parses', async () => {
    const chunks = await collect(
      readBedrockStream(
        streamOf(
          event('contentBlockDelta', { delta: { text: 'Hel' }, contentBlockIndex: 0 }),
          event('messageStop', { stopReason: 'end_turn' }),
          event('metadata', { usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } }),
        ),
      ),
    );

    expect(chunks).toEqual([
      { contentBlockDelta: { delta: { text: 'Hel' }, contentBlockIndex: 0 } },
      { messageStop: { stopReason: 'end_turn' } },
      { metadata: { usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } } },
    ]);
  });

  it('skips frames that carry no event type', async () => {
    const chunks = await collect(
      readBedrockStream(streamOf(frame({ ':message-type': 'event' }, { ignored: true }))),
    );
    expect(chunks).toEqual([]);
  });

  it('raises an exception frame as a provider error', async () => {
    const exception = frame(
      { ':message-type': 'exception', ':exception-type': 'validationException' },
      { message: 'bad input' },
    );

    await expect(collect(readBedrockStream(streamOf(exception)))).rejects.toMatchObject({
      code: 'provider_error',
      provider: 'bedrock',
      retryable: false,
    });
  });

  it('treats a mid-stream throttle as retryable', async () => {
    const exception = frame(
      { ':message-type': 'exception', ':exception-type': 'throttlingException' },
      { message: 'slow down' },
    );

    await expect(collect(readBedrockStream(streamOf(exception)))).rejects.toMatchObject({
      retryable: true,
    });
  });
});
