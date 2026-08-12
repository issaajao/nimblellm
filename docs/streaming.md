# Streaming

`client.stream()` returns an async iterable of canonical events. The providers
frame streams very differently — OpenAI, Azure and Vertex use server-sent
events, Bedrock uses a binary format of its own — and all of it arrives here as
the same four event types.

```ts
for await (const event of client.stream({ model, messages })) {
  if (event.type === 'text_delta') process.stdout.write(event.text);
}
```

Full program: [example 03](../examples/03-streaming.ts).

## Events

```ts
type NimbleStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call_delta'; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; finishReason: FinishReason; usage?: TokenUsage }
  | { type: 'error'; error: unknown };
```

**`usage` is separate from `finish`** because providers report token counts on
their own schedule: OpenAI in a trailing chunk _after_ the finish reason,
Bedrock in a `metadata` frame, Vertex on every chunk. Take whichever arrives:

```ts
let usage: TokenUsage | undefined;

for await (const event of client.stream(request)) {
  if (event.type === 'usage') usage = event.usage;
  if (event.type === 'finish') usage ??= event.usage;
}
```

## Accumulating tool calls

Arguments arrive as JSON fragments, keyed by `index`. Concatenate per index and
parse once the stream ends:

```ts
const calls = new Map<number, { id?: string; name?: string; args: string }>();

for await (const event of client.stream({ model, messages, tools })) {
  if (event.type !== 'tool_call_delta') continue;

  const call = calls.get(event.index) ?? { args: '' };
  if (event.id !== undefined) call.id = event.id;
  if (event.name !== undefined) call.name = event.name;
  if (event.argumentsDelta !== undefined) call.args += event.argumentsDelta;
  calls.set(event.index, call);
}

for (const call of calls.values()) {
  const args = JSON.parse(call.args || '{}');
  // …
}
```

Gemini is the exception: it emits each function call whole rather than in
fragments, so `argumentsDelta` holds the complete JSON in a single event. The
accumulating code above handles that correctly without a special case.

## Cancellation

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 5_000);

for await (const event of client.stream(request, { signal: controller.signal })) {
  // …
}
```

Breaking out of the loop also closes the underlying response.

## What streaming does not do

**Streamed calls are not retried.** Once the first byte is out the status is
already 200, so a mid-stream failure surfaces as a terminal `error` event
rather than another attempt. Failures _before_ the first byte — authentication,
routing, a 429 — are retried normally, because nothing has been committed yet.

If you need retry-on-failure for streams, buffer the deltas and re-issue the
request yourself when an `error` event arrives.

## Through the gateway

The HTTP gateway re-emits canonical events as SSE, terminated by `[DONE]`:

```
data: {"type":"text_delta","text":"Ray"}
data: {"type":"text_delta","text":"leigh"}
data: {"type":"finish","finishReason":"stop"}
data: {"type":"usage","usage":{"inputTokens":8,"outputTokens":2,"totalTokens":10}}
data: [DONE]
```

The first event is fetched before the 200 is written, so a failure that happens
before streaming starts still arrives as a real status code rather than an
empty successful stream. A failure _after_ that arrives as
`{"type":"error","error":{…}}` in the stream.

Client code: [example 09](../examples/09-gateway-client.ts).

## Per-provider notes

| Provider | Transport           | Notes                                                           |
| -------- | ------------------- | --------------------------------------------------------------- |
| OpenAI   | SSE                 | `stream_options.include_usage` is set, or usage is never sent   |
| Azure    | SSE                 | Same as OpenAI                                                  |
| Bedrock  | binary event stream | `converse-stream`; frames decoded internally, CRCs not verified |
| Vertex   | SSE                 | `?alt=sse` is added, or the endpoint returns a JSON array       |

For what has and has not been checked against a real provider — Bedrock's frame
decoder in particular — see
[Known limitations](../KNOWN_LIMITATIONS.md#verification-status).
