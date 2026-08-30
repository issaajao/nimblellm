# Anthropic

Uses the [Messages API](https://docs.anthropic.com/en/api/messages) directly,
rather than through a compatibility shim.

> **Checked against the live API on 30 August 2026** — a real completion and a
> real stream, both through `npm run verify:live`. Tool calls and images were
> not part of that check and remain unit-tested only. See
> [Known limitations](../../KNOWN_LIMITATIONS.md#verification-status) for the
> current status.

## Setup

**1. Create an API key** in the [Anthropic Console](https://console.anthropic.com/)
under **API keys**. Keys are scoped to a workspace, so a key for a test
workspace cannot spend a production budget — worth using for the live check
below.

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

```ts
await createClient().complete({
  model: 'anthropic/claude-sonnet-4-5-20250929',
  messages: [{ role: 'user', content: 'Why is the sky blue?' }],
  temperature: 0.5, // 0–1 here, not 0–2
});
```

Two optional variables:

| Variable             | Default                     | Purpose                                           |
| -------------------- | --------------------------- | ------------------------------------------------- |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | A proxy, or a compatible gateway                  |
| `ANTHROPIC_VERSION`  | `2023-06-01`                | The `anthropic-version` header sent on every call |

The version is pinned rather than tracking latest, because the version header is
what keeps response shapes stable. `2023-06-01` is the one the mappings here are
written against; changing it is opting into shapes this adapter has not seen.

## Authentication

Anthropic is the one provider that uses neither a bearer token nor a computed
signature. The key goes in `x-api-key`, unprefixed, alongside the version:

```
x-api-key: sk-ant-...
anthropic-version: 2023-06-01
```

Both headers are added by the credentials layer, so neither appears in the
request body and neither can be overridden through `providerOptions`.

## Model references

`anthropic/<model>` — the model id exactly as the Anthropic docs list it.

```
anthropic/claude-sonnet-4-5-20250929
anthropic/claude-haiku-4-5-20251001
anthropic/claude-opus-4-5
```

`claude/` is accepted as an alias of `anthropic/`.

Note that these are **not** the Bedrock ids. The same model is
`anthropic.claude-sonnet-4-5-20250929-v1:0` there, with a vendor prefix and a
version suffix, and often a geo prefix as well. Moving a request between the
two providers means changing the id, not just the routing prefix.

## `max_tokens` is required — and defaulted

Anthropic requires `max_tokens` on every request and supplies no server-side
default. It is the only such parameter across the five providers.

An adapter has two options here, and this one fills the field in rather than
rejecting the request:

```ts
// No maxOutputTokens. Works on every other provider, so it works here too.
await client.complete({ model: 'anthropic/claude-sonnet-4-5-20250929', messages });
// → sent as { ..., max_tokens: 4096 }
```

**Why a default rather than an error.** Rejecting would mean the simplest
canonical request — a model and one message — succeeds on four providers and
fails on the fifth, which is exactly the portability this library exists to
provide. Absorbing a provider-specific required field is the job. It follows the
same precedent as the Azure API version and the Vertex location: a required
field with no canonical equivalent gets a documented default.

**Why 4096.** Large enough that ordinary answers are not truncated, small enough
to bound a runaway generation. It is a ceiling, not a target — you are billed
for tokens produced, not for this number.

**When it is wrong for you**, either of these overrides it:

```ts
await client.complete({
  model: 'anthropic/claude-sonnet-4-5-20250929',
  messages,
  maxOutputTokens: 16_000, // the canonical field, portable across providers
  // ...or the provider-native one, which wins over both:
  // providerOptions: { anthropic: { max_tokens: 16_000 } },
});
```

A response cut off by the budget reports `finishReason: 'length'`, so a budget
that turns out to be too small is visible rather than silent. If you are using
extended thinking, note that the budget covers thinking _plus_ the reply.

## What is supported

| Feature                      | Supported                          |
| ---------------------------- | ---------------------------------- |
| Streaming                    | ✅ SSE                             |
| Tools / forced tool use      | ✅ including `toolChoice: 'none'`  |
| Images — inline base64       | ✅ png, jpeg, gif, webp            |
| Images — by URL              | ✅ fetched by Anthropic            |
| `stop`                       | ✅ no documented limit             |
| `topK`                       | ✅ natively — one of two providers |
| `metadata`                   | ✅ `user_id` only — see below      |
| JSON mode / JSON schema      | ❌ use a tool instead — see below  |
| `seed`                       | ❌                                 |
| Frequency / presence penalty | ❌                                 |
| Temperature range            | **0–1**                            |

**Temperature is 0–1, not 0–2**, the same as Bedrock. A request with
`temperature: 1.5` is rejected with `invalid_request` rather than rescaled — the
same number must mean the same thing wherever a request is routed.

**`topK` is native here.** Anthropic and Vertex are the only two providers that
accept it as a canonical parameter; on Bedrock it has to go through
`providerOptions`, because the field name varies by model family.

### No JSON mode or JSON schema output

Anthropic has no equivalent of OpenAI's `response_format`. There is a
well-known workaround — declare one tool whose input schema is the shape you
want, force it with `toolChoice`, and read the arguments as the result — and
this adapter deliberately does **not** apply it behind your back.

Emulating it silently would mean rewriting the response: reporting a
`tool_calls` finish reason as `stop`, presenting tool arguments as message
content, and injecting a tool that could collide with one you declared. A
request for structured output would be answered by something that is not quite
a completion, and nothing at the call site would say so.

So `responseFormat` fails fast with `unsupported_feature`, and the workaround is
yours to apply explicitly:

```ts
const response = await client.complete({
  model: 'anthropic/claude-sonnet-4-5-20250929',
  messages,
  tools: [
    {
      name: 'record_planet',
      description: 'Record the planet described by the user.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          diameterKm: { type: 'number' },
          hasRings: { type: 'boolean' },
        },
        required: ['name', 'diameterKm', 'hasRings'],
      },
    },
  ],
  toolChoice: { type: 'tool', name: 'record_planet' },
});

const planet = response.message.toolCalls?.[0]?.arguments;
```

The model is constrained the same way, the finish reason still says
`tool_calls`, and the code reads as what it is. Bedrock reaches the same
conclusion for the same reason.

### `metadata` accepts only `user_id`

Anthropic's `metadata` is not a free-form tag bag. `user_id` is the only key it
takes, and per Anthropic's guidance it should be an opaque identifier rather
than anything that identifies a person.

```ts
await client.complete({ model, messages, metadata: { user_id: 'a4f1…' } }); // fine
await client.complete({ model, messages, metadata: { tenant: 'acme' } }); // invalid_request
```

Anything else is **rejected rather than dropped**, so tags you set for another
provider fail loudly here instead of vanishing on the way out.

## Mapping details

Three constraints shape the request mapping, and they are the same three the
Bedrock adapter deals with — unsurprisingly, since Converse generalizes this
API:

- **Only `user` and `assistant` roles exist.** The system prompt goes in a
  top-level `system` field, which is a plain string here rather than Bedrock's
  block array. Canonical `tool` messages become `user` turns carrying a
  `tool_result` block.
- **Roles must alternate.** Neighbouring turns that map to the same role are
  merged, so `user → assistant → tool → tool` collapses correctly.
- **The conversation must start with `user`.** One that starts with an assistant
  turn is rejected with a clear message rather than an API validation error.

Two things differ from every OpenAI-shaped provider:

- **Tool calls are content blocks**, inline with the text, not a sibling
  `tool_calls` array — and their `input` is a JSON _object_, not the JSON
  _string_ OpenAI sends. Nothing has to be parsed on the way back in, so the
  malformed-arguments failure mode does not exist here.
- **Tool schemas are `input_schema`**, not `parameters` inside a `function`
  envelope.

`thinking` and `redacted_thinking` blocks in a response are not flattened into
the message content. They are not model output in the ordinary sense, and they
stay reachable on `response.raw`.

## Streaming

Anthropic streams a typed event sequence — `message_start`,
`content_block_start`, `content_block_delta`, `content_block_stop`,
`message_delta`, `message_stop` — rather than repeated snapshots of one object.
These map onto the canonical events like this:

| Anthropic event                             | Canonical                       |
| ------------------------------------------- | ------------------------------- |
| `content_block_delta` / `text_delta`        | `text_delta`                    |
| `content_block_start` of a `tool_use` block | `tool_call_delta` (id and name) |
| `content_block_delta` / `input_json_delta`  | `tool_call_delta` (arguments)   |
| `message_delta`                             | `usage`, then `finish`          |
| `error`                                     | `error`                         |
| everything else                             | nothing                         |

One wrinkle is worth knowing about if you are reading the code: input tokens are
reported once at `message_start`, output tokens only at `message_delta`, so
neither event alone can produce a complete usage figure. They are stitched
together in
[`transport/anthropic-stream.ts`](../../src/transport/anthropic-stream.ts)
rather than in the adapter, because adapters are shared singletons and anything
remembered between chunks in one would leak across concurrent streams.

## Common problems

**`401 authentication_error`** — the key is wrong, revoked, or belongs to a
different workspace. `x-api-key` takes the key alone; a `Bearer ` prefix is an
OpenAI habit and will not authenticate here.

**`400 invalid_request_error: max_tokens: Field required`** — should not reach
you, since the adapter always sends one. If it does, something has overwritten
the payload through `providerOptions`.

**`400 … max_tokens: … greater than the maximum allowed`** — the per-model
ceiling is lower than the budget you asked for. Model ceilings differ; check the
model's page.

**`404 not_found_error`** — the model id is wrong. Check it is the Anthropic id
and not the Bedrock spelling of the same model.

**`429 rate_limit_error`** — surfaces as `rate_limited` and is retried
automatically, honouring `retry-after`.

**`529 overloaded_error`** — Anthropic is under load. Retryable, and retried.

**`invalid_request` for `temperature`** — the ceiling is 1, not 2.

## Re-verifying it

The text and streaming paths have been checked against the real API; tool calls
and images have not. To re-check at any time:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm run verify:live
```

That makes two real, billable calls — one non-streaming, one streaming — and
prints what came back. Use a key from a non-production workspace. Record what
you find in
[Known limitations](../../KNOWN_LIMITATIONS.md#verification-status), which is
where the rest of the repository reads verification status from.
