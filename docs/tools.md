# Tools and structured output

Two ways to get something other than prose out of a model. Tools work
everywhere; JSON schema output does not.

## Tools

Declare them once, in one shape, and each adapter translates:

```ts
import type { NimbleTool } from 'nimblellm';

const tools: NimbleTool[] = [
  {
    type: 'function',
    name: 'get_weather',
    description: 'Current weather for a city.',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
  },
];
```

`parameters` is JSON Schema and must be `type: 'object'`. Names are limited to
1–64 characters of letters, digits, underscores and hyphens — the intersection
of what every provider accepts. Duplicate names are rejected.

### The round trip

```ts
const messages: NimbleMessage[] = [
  { role: 'user', content: [{ type: 'text', text: 'Weather in Lagos?' }] },
];

const first = await client.complete({ model, messages, tools });

if (first.finishReason === 'tool_calls') {
  // Keep the assistant turn verbatim — providers reject a result whose call is
  // missing from the history.
  messages.push(first.message);

  for (const call of first.message.toolCalls ?? []) {
    const result = await run(call.name, call.arguments);

    messages.push({
      role: 'tool',
      toolCallId: call.id,
      content: [{ type: 'text', text: JSON.stringify(result) }],
    });
  }

  const second = await client.complete({ model, messages, tools });
}
```

`call.arguments` is **already-parsed JSON**, whichever provider it came from.
OpenAI sends a string; that is unwrapped for you.

Full program: [example 04](../examples/04-tool-calling.ts).

### Reporting a tool failure

```ts
messages.push({
  role: 'tool',
  toolCallId: call.id,
  content: [{ type: 'text', text: 'Upstream returned 503' }],
  isError: true,
});
```

Send an error string rather than an empty result; an empty tool result is
rejected.

### Choosing

```ts
toolChoice: { type: 'auto' }              // default when tools are present
toolChoice: { type: 'none' }              // do not call a tool
toolChoice: { type: 'required' }          // must call some tool
toolChoice: { type: 'tool', name: 'get_weather' }  // must call this one
```

Shorthand strings work too: `toolChoice: 'required'`.

A forced tool that is not declared is rejected before the request goes out.

> On Bedrock, `toolChoice: 'none'` withholds the tools from that turn entirely —
> Converse has no "none" mode, and not offering the tools is what "must not call
> a tool" means.

### Tool-call ids

Every provider except Gemini issues ids. For Vertex, ids are synthesized
positionally (`call_0`, `call_1`) on the way out, and a `toolCallId` is resolved
back to a function name by looking at the assistant turn that made the call.
Sending a tool result whose call is absent from the history fails there with a
clear error, because there would be no name to send.

## Structured output

```ts
const response = await client.complete({
  model,
  messages,
  responseFormat: {
    type: 'json_schema',
    name: 'planet',
    schema: {
      type: 'object',
      properties: { name: { type: 'string' }, diameterKm: { type: 'number' } },
      required: ['name', 'diameterKm'],
      additionalProperties: false,
    },
    strict: true,
  },
});

const planet = JSON.parse(
  response.message.content
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join(''),
);
```

`{ type: 'json_object' }` asks for valid JSON without constraining its shape.

Full program: [example 05](../examples/05-structured-output.ts).

### Support

| Provider | JSON mode | JSON schema |
| -------- | :-------: | :---------: |
| OpenAI   |    ✅     |     ✅      |
| Azure    |    ✅     |     ✅¹     |
| Bedrock  |    ❌     |     ❌      |
| Vertex   |    ✅     |     ✅      |

¹ Depends on the `api-version`; older versions reject it.

**Bedrock supports neither.** A request carrying `responseFormat` is rejected
before it is sent, rather than returning prose you then fail to parse:

```
NimbleError: bedrock does not support: json_schema
  code: 'unsupported_feature'
  issues: [{ path: 'responseFormat', message: 'not supported by bedrock' }]
```

## Structured output on Bedrock

Use a tool as the schema. The model is constrained the same way, and this
pattern works on every provider:

```ts
const tools: NimbleTool[] = [
  {
    type: 'function',
    name: 'record_planet',
    description: 'Record the described planet.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' }, diameterKm: { type: 'number' } },
      required: ['name', 'diameterKm'],
    },
  },
];

const response = await client.complete({
  model: 'bedrock/anthropic.claude-haiku-4-5-20251001-v1:0',
  messages,
  tools,
  toolChoice: { type: 'tool', name: 'record_planet' },
});

const planet = response.message.toolCalls?.[0]?.arguments;
```

## Knowing before you send

Capability checks are pure, so you can ask without spending a request:

```ts
client.router.supports('bedrock', 'json_schema'); // false
client.router.candidatesFor(normalizeRequest(request)); // ['openai', 'azure', 'vertex']
```

Fallback across providers: [example 07](../examples/07-fallback.ts).
