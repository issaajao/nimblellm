import { describe, expect, it } from 'vitest';
import { readAnthropicStream } from '../../src/transport/anthropic-stream.js';

/** An SSE body carrying one `data:` line per event. */
function sseStream(...events: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const event of readAnthropicStream(stream)) out.push(event);
  return out;
}

const MESSAGE_START = {
  type: 'message_start',
  message: { id: 'msg_1', usage: { input_tokens: 8, output_tokens: 1 } },
};

describe('readAnthropicStream', () => {
  it('carries input tokens forward onto message_delta', async () => {
    const events = await collect(
      sseStream(MESSAGE_START, {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 2 },
      }),
    );

    expect(events[1]).toEqual({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { input_tokens: 8, output_tokens: 2 },
    });
  });

  it('passes every other event through untouched', async () => {
    const delta = {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'a' },
    };
    const events = await collect(sseStream(MESSAGE_START, delta, { type: 'message_stop' }));

    expect(events).toEqual([MESSAGE_START, delta, { type: 'message_stop' }]);
  });

  it('does not mutate the message_delta it was given', async () => {
    // The event object also becomes `raw`, so rewriting it in place would make
    // the escape hatch disagree with what the provider actually sent.
    const source = { type: 'message_delta', usage: { output_tokens: 2 } };
    const events = await collect(sseStream(MESSAGE_START, source));

    expect(events[1]).not.toBe(source);
    expect(source.usage).toEqual({ output_tokens: 2 });
  });

  it('lets a reported input count win over the stitched one', async () => {
    const events = await collect(
      sseStream(MESSAGE_START, {
        type: 'message_delta',
        usage: { input_tokens: 99, output_tokens: 2 },
      }),
    );

    expect(events[1]).toMatchObject({ usage: { input_tokens: 99 } });
  });

  it('leaves message_delta alone when no message_start was seen', async () => {
    const orphan = { type: 'message_delta', usage: { output_tokens: 2 } };
    expect(await collect(sseStream(orphan))).toEqual([orphan]);
  });

  it('leaves a message_delta that reports no usage alone', async () => {
    const events = await collect(
      sseStream(MESSAGE_START, { type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
    );

    expect(events[1]).toEqual({ type: 'message_delta', delta: { stop_reason: 'end_turn' } });
  });

  it('ignores a message_start with no usable token count', async () => {
    const events = await collect(
      sseStream({ type: 'message_start', message: {} }, { type: 'message_delta', usage: {} }),
    );

    expect(events[1]).toEqual({ type: 'message_delta', usage: {} });
  });

  it('yields nothing for an empty stream', async () => {
    expect(await collect(sseStream())).toEqual([]);
  });
});
