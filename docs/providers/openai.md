# OpenAI

Uses the [Chat Completions API](https://platform.openai.com/docs/api-reference/chat).

## Setup

1. Create a key at [platform.openai.com/api-keys](https://platform.openai.com/api-keys).
2. Export it:

```bash
export OPENAI_API_KEY=sk-...
```

That is the whole setup.

```ts
import { createClient } from 'nimblellm';

const response = await createClient().complete({
  model: 'openai/gpt-4o-mini',
  messages: [{ role: 'user', content: 'Why is the sky blue?' }],
});
```

## Model references

`openai/<model>` — the model id exactly as OpenAI documents it.

```
openai/gpt-4o
openai/gpt-4o-mini
openai/o3-mini
```

## Optional settings

| Variable            | Purpose                                            |
| ------------------- | -------------------------------------------------- |
| `OPENAI_BASE_URL`   | A proxy, or an OpenAI-compatible gateway           |
| `OPENAI_ORG_ID`     | Sent as `OpenAI-Organization`                      |
| `OPENAI_PROJECT_ID` | Sent as `OpenAI-Project`; scopes usage and billing |

`OPENAI_BASE_URL` is also how you point at anything that speaks Chat
Completions — vLLM, Ollama, LiteLLM, Together:

```bash
export OPENAI_BASE_URL=http://localhost:11434  # Ollama
export OPENAI_API_KEY=unused                   # required, may be a placeholder
```

Compatibility varies by server; the adapter sends what OpenAI accepts.

## What is supported

| Feature                      | Supported                 |
| ---------------------------- | ------------------------- |
| Streaming                    | ✅                        |
| Tools / forced tool use      | ✅                        |
| JSON mode and JSON schema    | ✅                        |
| Images — URL and inline      | ✅                        |
| `seed`                       | ✅                        |
| `stop`                       | ✅ up to 4                |
| Frequency / presence penalty | ✅                        |
| `metadata`                   | ✅                        |
| `topK`                       | ❌ not exposed by the API |
| Temperature range            | 0–2                       |

`topK` is the only canonical field OpenAI cannot express; a request carrying it
is rejected with `unsupported_feature` rather than silently dropped. Only Vertex
supports it.

## Mapping details

- `maxOutputTokens` → `max_completion_tokens` (not the deprecated `max_tokens`).
- A message whose content is one text part is sent as a plain string; anything
  richer becomes a part array.
- Inline images become `data:` URLs.
- Tool call arguments are serialized to a JSON string on the way out and parsed
  back into an object on the way in.
- Streaming sets `stream_options.include_usage`, without which a streamed
  response reports no token counts.
- `providerOptions.openai` is merged over the payload last, so it can override
  anything and reach fields NimbleLLM does not model:

```ts
await client.complete({
  model: 'openai/gpt-4o',
  messages,
  providerOptions: { openai: { logit_bias: { '1234': -100 }, user: 'account-42' } },
});
```

## Common problems

**`401 Incorrect API key provided`** — the key is wrong, revoked, or belongs to
a different organization. The error message has the key redacted; check
`key.hint()` to confirm which one is loaded.

**`404` for a model that exists** — your organization may not have access to it
yet, or it is a project-scoped model and `OPENAI_PROJECT_ID` is unset.

**`429` that keeps happening** — retried automatically with backoff, honouring
`Retry-After`. Persistent 429s after retries mean the account limit is the
problem, not transient contention.

**Requests to a compatible server fail oddly** — most OpenAI-compatible servers
implement a subset. Try removing `response_format`, `tools`, or `seed`.
