/**
 * Server-sent event parsing.
 *
 * OpenAI, Azure and Vertex all stream as SSE. Only the `data:` field matters
 * here — no provider uses `event:` or `id:` in a way that changes decoding —
 * so this yields data payloads and leaves interpretation to the adapter.
 */

/**
 * Yield the `data` payload of each event in an SSE byte stream.
 *
 * Multi-line `data:` fields are joined with newlines, per the SSE spec, and
 * the terminal `[DONE]` sentinel is swallowed rather than yielded.
 *
 * @param stream - the response body
 */
export async function* readEventStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, undefined> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Events are separated by a blank line; \r\n is tolerated for proxies
      // that rewrite line endings.
      let boundary = findBoundary(buffer);
      while (boundary !== undefined) {
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);

        const data = dataOf(block);
        if (data !== undefined) {
          if (data === '[DONE]') return;
          yield data;
        }

        boundary = findBoundary(buffer);
      }
    }

    // A stream that ends without a trailing blank line still has one event.
    const trailing = dataOf(buffer + decoder.decode());
    if (trailing !== undefined && trailing !== '[DONE]') yield trailing;
  } finally {
    reader.releaseLock();
  }
}

/** Parse each event as JSON, skipping payloads that are not objects. */
export async function* readJsonEventStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<unknown, void, undefined> {
  for await (const data of readEventStream(stream)) {
    try {
      yield JSON.parse(data);
    } catch {
      // A keep-alive comment or a partial frame at shutdown; nothing to decode.
    }
  }
}

function findBoundary(buffer: string): { index: number; length: number } | undefined {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');

  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
  if (lf !== -1) return { index: lf, length: 2 };
  return undefined;
}

/** Collect the `data:` lines of one event block. */
function dataOf(block: string): string | undefined {
  const lines: string[] = [];

  for (const rawLine of block.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line.startsWith('data:')) continue;
    // A single leading space after the colon is part of the framing, not data.
    const value = line.slice(5);
    lines.push(value.startsWith(' ') ? value.slice(1) : value);
  }

  return lines.length === 0 ? undefined : lines.join('\n');
}
