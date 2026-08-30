/**
 * Anthropic's streaming event sequence.
 *
 * The framing is ordinary SSE, so decoding is `readJsonEventStream`'s job and
 * this file does not repeat it. What it adds is the one thing that cannot be
 * done a chunk at a time: Anthropic reports input tokens once, at
 * `message_start`, and output tokens later, at `message_delta`. Neither event
 * alone can produce a complete `TokenUsage`.
 *
 * That state lives here rather than in the adapter because adapters are shared
 * singletons — `anthropicAdapter` is one object serving every request in the
 * process — so anything remembered between chunks there would leak across
 * concurrent streams. A generator, by contrast, gets one instance per call.
 *
 * @see https://docs.anthropic.com/en/docs/build-with-claude/streaming
 */

import { readJsonEventStream } from './sse.js';

/**
 * Decode an Anthropic SSE body into its events, with usage stitched together.
 *
 * Every event is passed through untouched except `message_delta`, which gains
 * the `input_tokens` seen at `message_start`. The copy is shallow and the
 * original event object is not mutated, so `raw` stays faithful to the wire.
 *
 * @param stream - the response body
 */
export async function* readAnthropicStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<unknown, void, undefined> {
  let inputTokens: number | undefined;

  for await (const event of readJsonEventStream(stream)) {
    if (type(event) === 'message_start') {
      const reported = field(field(field(event, 'message'), 'usage'), 'input_tokens');
      if (typeof reported === 'number') inputTokens = reported;
    }

    if (type(event) === 'message_delta' && inputTokens !== undefined) {
      const usage = field(event, 'usage');
      if (typeof usage === 'object' && usage !== null) {
        yield {
          ...(event as Record<string, unknown>),
          usage: { input_tokens: inputTokens, ...(usage as Record<string, unknown>) },
        };
        continue;
      }
    }

    yield event;
  }
}

function type(value: unknown): unknown {
  return field(value, 'type');
}

function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}
