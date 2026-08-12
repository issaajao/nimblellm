import { describe, expect, it } from 'vitest';
import { readEventStream, readJsonEventStream } from '../../src/transport/sse.js';

/** Build a byte stream, optionally split into arbitrary chunks. */
function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) out.push(item);
  return out;
}

describe('readEventStream', () => {
  it('yields the data field of each event', async () => {
    const events = await collect(readEventStream(streamOf('data: one\n\ndata: two\n\n')));
    expect(events).toEqual(['one', 'two']);
  });

  it('strips only the single framing space after the colon', async () => {
    const events = await collect(readEventStream(streamOf('data:  padded\n\n')));
    expect(events).toEqual([' padded']);
  });

  it('joins multi-line data fields with newlines', async () => {
    const events = await collect(readEventStream(streamOf('data: first\ndata: second\n\n')));
    expect(events).toEqual(['first\nsecond']);
  });

  it('reassembles events split across chunk boundaries', async () => {
    const events = await collect(readEventStream(streamOf('data: hel', 'lo\n', '\ndata: x\n\n')));
    expect(events).toEqual(['hello', 'x']);
  });

  it('handles CRLF line endings', async () => {
    const events = await collect(readEventStream(streamOf('data: one\r\n\r\ndata: two\r\n\r\n')));
    expect(events).toEqual(['one', 'two']);
  });

  it('stops at the [DONE] sentinel', async () => {
    const events = await collect(
      readEventStream(streamOf('data: one\n\ndata: [DONE]\n\ndata: never\n\n')),
    );
    expect(events).toEqual(['one']);
  });

  it('ignores comments and other fields', async () => {
    const events = await collect(
      readEventStream(streamOf(': keep-alive\n\nevent: ping\nid: 1\n\ndata: real\n\n')),
    );
    expect(events).toEqual(['real']);
  });

  it('yields a final event that arrives without a trailing blank line', async () => {
    expect(await collect(readEventStream(streamOf('data: last')))).toEqual(['last']);
  });

  it('yields nothing for an empty stream', async () => {
    expect(await collect(readEventStream(streamOf()))).toEqual([]);
  });
});

describe('readJsonEventStream', () => {
  it('parses each event as JSON', async () => {
    const events = await collect(
      readJsonEventStream(streamOf('data: {"a":1}\n\ndata: {"b":2}\n\n')),
    );
    expect(events).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('skips payloads that are not JSON rather than failing the stream', async () => {
    const events = await collect(
      readJsonEventStream(streamOf('data: {"a":1}\n\ndata: not json\n\ndata: {"b":2}\n\n')),
    );
    expect(events).toEqual([{ a: 1 }, { b: 2 }]);
  });
});
