# NimbleLLM

**One request shape for OpenAI, Anthropic, AWS Bedrock, Azure OpenAI and Google Vertex AI.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

> **Status: early development.** All six build phases are complete: NimbleLLM
> works as a library and as a containerized gateway, is fully documented, and has
> CI. See [Roadmap](#roadmap).
>
> **Before production use, read
> [KNOWN_LIMITATIONS.md](./KNOWN_LIMITATIONS.md#verification-status)** — it
> records what has and has not been checked against real providers, and is kept
> current. The API may change before 1.0.

---

## Why

Every LLM provider has settled on roughly the same idea — a list of messages, a
few sampling knobs, some tools — and then spelled it differently.
`max_tokens` here, `maxOutputTokens` there, `maxTokenCount` somewhere else.
System prompts live inside the message list on one API and in a top-level field
on the next. Tool arguments arrive as a JSON string from one provider and as a
parsed object from another.

The result is that "let's try this on a different model" turns into a
refactor, and every application ends up growing its own half-finished
translation layer.

NimbleLLM is that layer, extracted and done properly:

- **One request shape.** Write against a single canonical schema; the provider
  is a routing prefix on the model name (`openai/gpt-4o`,
  `bedrock/anthropic.claude-sonnet-4-20250514-v1:0`).
- **One response shape.** Content parts, tool calls, finish reasons and token
  usage are normalized on the way back out.
- **One error type.** Validation failures and provider errors both surface as a
  `NimbleError` with a stable `code` you can switch on.
- **Strict by default.** A typo like `max_tokns` is rejected at the call site
  rather than silently dropped somewhere over the wire.
- **No lock-in.** Provider-specific features stay reachable through an explicit
  `providerOptions` escape hatch instead of being flattened away.
- **Runs as a library or a container.** Import it into a Node service, or run
  it as a standalone gateway (phase 4).

### Non-goals

NimbleLLM is not a prompt framework, an agent runtime, or a vector store. It
normalizes requests and responses and gets out of the way.

---

## Documentation

|                                                                                          |                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Quick start](./docs/quickstart.md)                                                      | Installed and calling a model                                                                                                                                                                          |
| [Configuration](./docs/configuration.md)                                                 | Every variable; how secrets are held                                                                                                                                                                   |
| [Provider setup](./docs/README.md#provider-setup)                                        | [OpenAI](./docs/providers/openai.md) · [Anthropic](./docs/providers/anthropic.md) · [Azure](./docs/providers/azure.md) · [Bedrock](./docs/providers/bedrock.md) · [Vertex](./docs/providers/vertex.md) |
| [Streaming](./docs/streaming.md) · [Tools](./docs/tools.md) · [Errors](./docs/errors.md) | Guides                                                                                                                                                                                                 |
| [Gateway](./docs/gateway.md)                                                             | Running the container                                                                                                                                                                                  |
| [API reference](./docs/api-reference.md)                                                 | Types and exports                                                                                                                                                                                      |
| [Examples](./examples)                                                                   | Nine runnable programs, all executed by the test suite                                                                                                                                                 |
| [Known limitations](./KNOWN_LIMITATIONS.md)                                              | Deliberate limitations, and what has been checked against real providers                                                                                                                               |

---

## Quick start

```bash
npm install nimblellm
```

```bash
export OPENAI_API_KEY=sk-...
```

```ts
import { createClient } from 'nimblellm';

const client = createClient(); // reads credentials from the environment

const response = await client.complete({
  model: 'openai/gpt-4o',
  messages: [
    { role: 'system', content: 'You are a concise assistant.' },
    { role: 'user', content: 'Why is the sky blue?' },
  ],
  maxOutputTokens: 200,
});

console.log(response.message.content); // [{ type: 'text', text: '…' }]
console.log(response.usage.totalTokens);
```

Point the same code at another provider by changing one string — and supplying
that provider's credentials:

```ts
model: 'anthropic/claude-sonnet-4-5-20250929';
model: 'bedrock/anthropic.claude-sonnet-4-20250514-v1:0';
model: 'azure/my-gpt4o-deployment'; // the deployment name, not the model name
model: 'vertex/gemini-2.0-flash';
```

Streaming yields canonical events, whatever the provider's wire format:

```ts
for await (const event of client.stream({ model: 'openai/gpt-4o', messages })) {
  if (event.type === 'text_delta') process.stdout.write(event.text);
  if (event.type === 'usage') console.log('\n', event.usage.totalTokens);
}
```

---

## Running as a gateway

The same thing ships as a container: one service in front of every provider, so
that credentials live in one place instead of in every application that needs a
model.

The quickest way to try it is the published image, which needs no checkout:

```bash
docker run -p 8080:8080 \
  -e NIMBLE_SERVER_API_KEYS=dev-key \
  -e OPENAI_API_KEY=sk-... \
  ghcr.io/issaajao/nimblellm:0.1.0
```

It is public, builds for `linux/amd64` and `linux/arm64`, and carries a
provenance attestation you can check before running it:

```bash
gh attestation verify oci://ghcr.io/issaajao/nimblellm:0.1.0 --owner issaajao
```

In production, pin the digest rather than the tag — tags move, digests do not.

**Or build from source**, to run a specific commit or to try a change you are
working on. With compose:

```bash
cp .env.example .env      # fill in the providers you use
docker compose up --build
```

Or without:

```bash
docker build -t nimblellm:local .
docker run -p 8080:8080 --env-file .env nimblellm:local
```

Either way, the gateway answers the same:

```bash
curl localhost:8080/v1/chat/completions \
  -H "authorization: Bearer $NIMBLE_SERVER_API_KEYS" \
  -H 'content-type: application/json' \
  -d '{"model":"openai/gpt-4o","messages":[{"role":"user","content":"Why is the sky blue?"}]}'
```

| Endpoint                    | Auth | Purpose                                             |
| --------------------------- | ---- | --------------------------------------------------- |
| `POST /v1/chat/completions` | yes  | Completion; `stream: true` returns SSE              |
| `POST /v1/completions`      | yes  | The same handler, under a shorter name              |
| `GET /v1/providers`         | yes  | Configured providers, their limits and capabilities |
| `GET /health`               | no   | Liveness — is the process up                        |
| `GET /ready`                | no   | Readiness — 503 until a provider is configured      |

> **The gateway speaks the canonical shape, not the OpenAI wire format.**
> Request bodies may use OpenAI spellings, but responses are `NimbleResponse`.
> Pointing an existing OpenAI SDK at this gateway will not work.

### Gateway authentication

Callers present `Authorization: Bearer <key>`, checked against
`NIMBLE_SERVER_API_KEYS` (comma-separated, so keys can be rotated without
downtime). **The server refuses to start without one** — a gateway with nothing
in front of it is an open proxy onto your paid provider credentials. If that is
genuinely what you want, set `NIMBLE_ALLOW_ANONYMOUS=true` and it will start,
loudly.

Gateway keys authenticate _callers_. They do not select which provider
credentials get used — see limitation 5.

### Deployment

[`deploy/kubernetes.yaml`](./deploy/kubernetes.yaml) is a starting point:
Deployment, Service, ConfigMap, a Secret template and an HPA, with probes,
resource limits and a hardened `securityContext`.

Points worth attention wherever you deploy:

- **Shutdown drains in-flight completions.** SIGTERM stops new connections and
  waits up to `NIMBLE_SHUTDOWN_GRACE_MS` (default 10s). Keep that _below_ your
  orchestrator's termination grace period, or long completions are cut off
  mid-token during a rollout.
- **Readiness is not liveness.** `/health` asks whether the process is up;
  `/ready` additionally requires a configured provider, so a misconfigured
  instance is kept out of the load balancer rather than restarted forever.
- **The image runs as non-root** with a read-only root filesystem and all
  capabilities dropped. `dumb-init` is PID 1 so signals are forwarded.
- **Logs are structured JSON on stdout** and never contain request bodies or
  credentials.

Server settings: `NIMBLE_PORT` (8080), `NIMBLE_HOST` (0.0.0.0),
`NIMBLE_SERVER_API_KEYS`, `NIMBLE_ALLOW_ANONYMOUS`, `NIMBLE_MAX_BODY_BYTES`
(4 MiB), `NIMBLE_LOG_LEVEL`, `NIMBLE_CORS_ORIGIN`, `NIMBLE_SHUTDOWN_GRACE_MS`.

---

## Verifying against real providers

Every test in this repository runs against mocked transports. To check the code
against real endpoints — **most importantly Bedrock, whose SigV4 signature this
codebase computes rather than copies** — run:

```bash
npm run verify:live
```

It performs one real, billable completion per configured provider and prints
pass/fail for each. On a Bedrock failure it prints the raw AWS response
alongside the exact request that was signed, so a `SignatureDoesNotMatch` is
immediately visible.

It is manual and on-demand by design: it needs credentials, it costs money, and
it fails for reasons unrelated to the code. **It is not part of `npm test` and
must not be added to CI.**

---

## Configuration

Credentials come from the environment. Copy [`.env.example`](./.env.example)
and fill in only the providers you use — configuring OpenAI does not oblige you
to configure Azure. Routing to a provider with no credentials fails with
`authentication_error` naming the variables it wanted.

| Provider | Required                                                                               | Optional                                                |
| -------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| OpenAI   | `OPENAI_API_KEY`                                                                       | `OPENAI_BASE_URL`, `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID` |
| Azure    | `AZURE_OPENAI_ENDPOINT` + `AZURE_OPENAI_API_KEY` or `…_ACCESS_TOKEN`                   | `AZURE_OPENAI_API_VERSION`                              |
| Bedrock  | `AWS_REGION` + `AWS_BEARER_TOKEN_BEDROCK` or `AWS_ACCESS_KEY_ID`/`…_SECRET_ACCESS_KEY` | `AWS_SESSION_TOKEN`, `BEDROCK_BASE_URL`                 |
| Vertex   | `GOOGLE_CLOUD_PROJECT` + `GOOGLE_APPLICATION_CREDENTIALS` or `GOOGLE_ACCESS_TOKEN`     | `GOOGLE_CLOUD_LOCATION`, `GOOGLE_SERVICE_ACCOUNT_JSON`  |

Client-wide: `NIMBLE_DEFAULT_PROVIDER`, `NIMBLE_TIMEOUT_MS` (default 120000),
`NIMBLE_MAX_RETRIES` (default 2).

Anything read from the environment can be overridden in code:

```ts
createClient({
  config: { maxRetries: 5, defaultProvider: 'openai' },
  onRetry: (attempt, delayMs, error) => log.warn({ attempt, delayMs, code: error.code }),
});
```

### Authentication, per provider

- **OpenAI** — bearer token.
- **Azure** — the resource key in `api-key`, or an Entra ID bearer token. When
  both are configured the Entra token wins, being the narrower credential.
- **Bedrock** — a Bedrock API key is sent as a bearer token. Otherwise IAM
  credentials are signed with **SigV4**, implemented here over `node:crypto`
  rather than pulled from the AWS SDK.
- **Vertex** — a service account key is exchanged for an OAuth access token via
  the JWT bearer grant, cached until a minute before it expires and shared
  between concurrent callers. A pre-obtained `GOOGLE_ACCESS_TOKEN` is used
  as-is.

### Secrets do not leak by accident

Every credential is wrapped in a `Secret`. The default rendering of one is
harmless, so the usual accidents — a config object in a log line, an error
serialized to JSON — do not disclose anything:

```ts
const key = config.openai?.apiKey;

`${key}`; // '[redacted]'
JSON.stringify({ key }); // '{"key":"[redacted]"}'
console.log(key); // Secret(OPENAI_API_KEY) [redacted]
key.hint(); // '…bcd1' — enough to tell which key is loaded
key.reveal(); // the actual value, only when asked outright
```

Provider error text is scrubbed of every configured secret before it becomes a
`NimbleError` message. That is a backstop rather than the primary defence: it
can only remove values it knows about.

### Errors and retries

`rate_limited`, `timeout` and 5xx `provider_error` are retried with exponential
backoff and full jitter; `Retry-After` is honoured when the provider sends it.
Everything in the 4xx range is final — the same body will get the same answer.

---

## Under the hood

The client is a thin composition of four layers, each usable on its own.
Everything below the client is pure or injectable, so only `client.ts` touches
the network.

### Normalization

`normalizeRequest` takes loosely-typed input and returns a validated, deeply
frozen canonical request.

```ts
import { normalizeRequest } from 'nimblellm';

const request = normalizeRequest({
  model: 'bedrock/anthropic.claude-sonnet-4-20250514-v1:0',
  messages: [
    { role: 'system', content: 'Be concise.' },
    { role: 'user', content: 'Why is the sky blue?' },
  ],
  max_tokens: 256, // alias of maxOutputTokens
  stop_sequences: 'END', // scalar is widened to an array
});

request.model; // { provider: 'bedrock', model: 'anthropic.claude-...', raw: '...' }
request.system; // 'Be concise.'  ← hoisted out of the message list
request.maxOutputTokens; // 256
request.stop; // ['END']
request.messages; // [{ role: 'user', content: [{ type: 'text', text: 'Why is the sky blue?' }] }]
```

### What normalization does

| Input                                                   | Canonical result                                  |
| ------------------------------------------------------- | ------------------------------------------------- |
| `max_tokens`, `maxTokens`, `max_completion_tokens`      | `maxOutputTokens`                                 |
| `top_p` / `top_k` / `stop_sequences`                    | `topP` / `topK` / `stop`                          |
| `content: 'hello'`                                      | `content: [{ type: 'text', text: 'hello' }]`      |
| `{ role: 'system', ... }` messages                      | hoisted into the top-level `system` field         |
| `{ type: 'image', url }`                                | `{ type: 'image', source: { kind: 'url', url } }` |
| OpenAI `tool_calls[].function.arguments` (a string)     | `toolCalls[].arguments` (a parsed object)         |
| `tool_choice: { type: 'function', function: { name } }` | `toolChoice: { type: 'tool', name }`              |

It also enforces the invariants that would otherwise fail deep inside a
provider call: temperature within 0–2, `topP` within 0–1, positive integer
token budgets, unique tool names, tool results that actually reference a
preceding tool call, and a forced `toolChoice` that names a declared tool.

Normalization is **idempotent** — feeding a normalized request back in returns
an equal request — which makes it safe to apply at more than one layer.

### Error handling

Everything throws a `NimbleError` carrying a machine-readable `code` and, for
validation failures, one issue per problem with the path that caused it.

```ts
import { NimbleError, normalizeRequest } from 'nimblellm';

try {
  normalizeRequest({ model: 'openai/gpt-4o', messages: [], temperature: 5 });
} catch (error) {
  if (error instanceof NimbleError) {
    error.code; // 'invalid_request'
    error.issues; // [{ path: 'messages', message: 'must contain at least one message' }]
    error.retryable; // false
  }
}
```

Codes: `invalid_request`, `unknown_provider`, `unsupported_feature`,
`authentication_error`, `rate_limited`, `timeout`, `provider_error`,
`internal_error`.

---

## The canonical request

```ts
interface NimbleRequest {
  model: { provider: 'openai' | 'azure' | 'bedrock' | 'vertex'; model: string; raw: string };
  system?: string;
  messages: NimbleMessage[]; // user | assistant | tool — never system

  maxOutputTokens?: number;
  temperature?: number; // 0–2 canonical; narrower on some providers
  topP?: number; // 0–1
  topK?: number;
  frequencyPenalty?: number; // -2–2
  presencePenalty?: number; // -2–2
  stop?: string[];
  seed?: number;
  stream?: boolean;

  responseFormat?:
    { type: 'text' | 'json_object' } | { type: 'json_schema'; name; schema; strict? };
  tools?: NimbleTool[];
  toolChoice?: { type: 'auto' | 'none' | 'required' } | { type: 'tool'; name: string };

  metadata?: Record<string, string>;
  providerOptions?: Partial<Record<ProviderId, Record<string, unknown>>>;
}
```

Two design notes worth calling out:

**System prompts are hoisted.** Bedrock and Vertex both carry system
instructions in a dedicated top-level field rather than in the message list.
Hoisting once, here, keeps every adapter from re-deriving it. A top-level
`system` field and `system` messages can both be supplied; they are
concatenated, standing instruction first.

**Values are passed through, never rescaled.** Temperature is the same softmax
temperature on every provider — OpenAI simply allows a wider range (0–2) than
Bedrock does (0–1). Rescaling `0.7` to `0.35` on the way to Bedrock would mean
the same request sampled differently depending on where it was routed, so a
value outside a provider's range is rejected with `invalid_request` instead.
Use [`candidatesFor`](#choosing-a-provider) to find out where a request can go
before you send it.

---

## Routing

`Router` picks the adapter, verifies the request against it, and builds the
provider-native call. It performs no I/O — credentials and transport arrive in
phase 3 — so the routing decision is fully testable on its own.

```ts
import { createRouter, normalizeRequest } from 'nimblellm';

const router = createRouter();

const { provider, route, payload } = router.route(
  normalizeRequest({
    model: 'bedrock/anthropic.claude-sonnet-4-20250514-v1:0',
    messages: [{ role: 'user', content: 'Why is the sky blue?' }],
    maxOutputTokens: 256,
  }),
);

provider; // 'bedrock'
route.path; // 'model/anthropic.claude-sonnet-4-20250514-v1%3A0/converse'
payload; // { messages: [...], inferenceConfig: { maxTokens: 256 } }
```

The same canonical request routed elsewhere produces a different body and a
different path, with no change at the call site:

| Model prefix | Path                                               | Body shape                           |
| ------------ | -------------------------------------------------- | ------------------------------------ |
| `openai/`    | `v1/chat/completions`                              | `{ model, messages, ... }`           |
| `anthropic/` | `v1/messages`                                      | `{ model, messages, max_tokens, … }` |
| `azure/`     | `openai/deployments/{deployment}/chat/completions` | same, minus `model`                  |
| `bedrock/`   | `model/{modelId}/converse`                         | `{ messages, inferenceConfig, … }`   |
| `vertex/`    | `publishers/google/models/{model}:generateContent` | `{ contents, generationConfig, … }`  |

Responses come back through `adapter.parseResponse(raw, request)` as a
`NimbleResponse`, and streamed chunks through `adapter.parseStreamChunk(chunk)`
as canonical events (`text_delta`, `tool_call_delta`, `usage`, `finish`).

### Capabilities

Providers do not offer the same feature set. Rather than let a request fail
with an opaque 400 several layers down, the router checks it up front and
reports every problem at once, with a hint for each.

```ts
router.route(
  normalizeRequest({
    model: 'bedrock/anthropic.claude-sonnet-4-20250514-v1:0',
    messages: [{ role: 'user', content: 'hi' }],
    seed: 42,
  }),
);
// NimbleError: bedrock does not support: seed
//   code: 'unsupported_feature'
//   issues: [{ path: 'seed', message: 'not supported by bedrock' }]
```

|                    | OpenAI | Anthropic | Azure | Bedrock | Vertex |
| ------------------ | :----: | :-------: | :---: | :-----: | :----: |
| streaming          |   ✅   |    ✅     |  ✅   |   ✅    |   ✅   |
| tools              |   ✅   |    ✅     |  ✅   |   ✅    |   ✅   |
| forced tool use    |   ✅   |    ✅     |  ✅   |   ✅    |   ✅   |
| JSON mode          |   ✅   |    ❌     |  ✅   |   ❌    |   ✅   |
| JSON schema output |   ✅   |    ❌     |  ✅   |   ❌    |   ✅   |
| images by URL      |   ✅   |    ✅     |  ✅   |   ❌    |   ✅   |
| inline images      |   ✅   |    ✅     |  ✅   |   ✅    |   ✅   |
| `seed`             |   ✅   |    ❌     |  ✅   |   ❌    |   ✅   |
| `stop`             |  ✅ 4  |    ✅     | ✅ 4  |   ✅    |  ✅ 5  |
| frequency penalty  |   ✅   |    ❌     |  ✅   |   ❌    |   ✅   |
| presence penalty   |   ✅   |    ❌     |  ✅   |   ❌    |   ✅   |
| `topK`             |   ❌   |    ✅     |  ❌   |   ❌    |   ✅   |
| `metadata`         |   ✅   |   ✅ ¹    |  ✅   |   ❌    |   ❌   |
| temperature range  |  0–2   |    0–1    |  0–2  |   0–1   |  0–2   |

¹ Anthropic's `metadata` accepts `user_id` and nothing else; any other key is
rejected with `invalid_request` rather than dropped. Anthropic is also the one
provider with a **required** parameter the canonical shape leaves optional —
`max_tokens` — so the adapter fills in a documented default. Both are covered in
[its setup page](./docs/providers/anthropic.md).

Anything a provider offers but NimbleLLM does not model — Bedrock guardrails,
Vertex labels, per-model `topK` on Bedrock — stays reachable through
`providerOptions`, which is merged over the payload after it is built.

### Choosing a provider

```ts
router.candidatesFor(request); // ['openai', 'azure', 'vertex']
router.supports('vertex', 'top_k'); // true
```

`candidatesFor` returns the registered providers that could serve a request as
written, which is the building block for fallback chains.

### `nimblellm check` — the same answer from the terminal

That analysis is also a command, so you can ask it of a request without wiring
anything up. No credentials, no network call, no client:

```bash
npx nimblellm check request.json
```

```
nimblellm check · support-bot.json

                      openai  azure  bedrock  vertex  anthropic
  streaming             ✓       ✓       ✓       ✓         ✓
  tools                 ✓       ✓       ✓       ✓         ✓
  JSON schema output    ✓       ✓       ✗       ✓         ✗
  seed                  ✓       ✓       ✗       ✓         ✗
  temperature (0.7)     ✓       ✓       ✓       ✓         ✓

  Portable across: 3/5 providers (openai, azure, vertex)

  Blocked on bedrock    JSON schema output, seed
  Blocked on anthropic  JSON schema output, seed

  Your request names openai, which can serve it.
```

Or without a file, for a quick question:

```bash
npx nimblellm check --model claude-sonnet --tools --json-schema
```

It exits `0` when some provider can serve the request, `1` on a validation
failure — reported with the library's own error, not a CLI rewording — and `2`
when nothing can serve it, which makes it usable as a CI guard.

Every cell comes from `router.supports()` and `assertWithinLimits()`, the same
functions the router calls on the real path, so the report cannot drift out of
step with routing. Full flag list and exit codes in [the CLI docs](./docs/cli.md).

### Adding a provider

Adapters are registered, not hard-coded. Implement `ProviderAdapter` and hand
it to the router; a later registration replaces an earlier one with the same
id, so a built-in can be swapped out without forking.

```ts
createRouter({ adapters: [...builtInAdapters, myAdapter] });
// or
createRouter().register(myAdapter);
```

---

## Project structure

```
src/
  index.ts            Public API surface
  types.ts            Canonical request/response types
  errors.ts           NimbleError and the error-code taxonomy
  core/
    normalize.ts      normalizeRequest() — the entry point
    keys.ts           Field-alias folding (max_tokens → maxOutputTokens)
    model.ts          "provider/model" reference parsing
    messages.ts       Conversation, content parts and tool calls
    params.ts         Sampling params, tools, tool choice, response format
  client.ts           createClient() — the only file that touches the network
  router.ts           Adapter registry, capability checks, call construction
  bin/
    nimblellm.ts      Binary entrypoint: gateway, or `check`
  cli/
    check.ts          `nimblellm check` — offline capability report
  scripts/
    verify-live.ts    Manual live-provider check (never run by CI)
  server/
    server.ts         The HTTP gateway, on node:http
    config.ts         Server settings and gateway-key checking
  config/
    secret.ts         Secret wrapper; redacts by default
    config.ts         Environment loading and validation
  auth/
    credentials.ts    Config → request headers, per provider
    sigv4.ts          AWS Signature Version 4
    google.ts         Service-account JWT → cached OAuth token
  transport/
    http.ts           fetch, deadlines, retries, error classification
    sse.ts            Server-sent events (OpenAI, Azure, Vertex, Anthropic)
    aws-event-stream.ts  Bedrock's binary frame format
    anthropic-stream.ts  Anthropic's event sequence, with usage stitched
  providers/
    adapter.ts        The ProviderAdapter contract
    capabilities.ts   Capability derivation and range enforcement
    openai-compatible.ts  Chat Completions wire format (OpenAI + Azure)
    openai.ts         OpenAI
    azure.ts          Azure OpenAI (deployment in the URL)
    bedrock.ts        AWS Bedrock Converse
    vertex.ts         Google Vertex Gemini generateContent
    anthropic.ts      Anthropic Messages
    shared.ts         Helpers used by more than one adapter
  util/
    freeze.ts         Deep freeze for normalized requests
test/                 Vitest suites, one per module
  providers/          One suite per adapter
  examples.test.ts    Runs every example against a stub provider
docs/                 Guides and per-provider setup
examples/             Nine runnable programs
Dockerfile            Multi-stage build; non-root runtime
docker-compose.yml
deploy/kubernetes.yaml
KNOWN_LIMITATIONS.md  Deliberate limitations + verification status
```

---

## Development

```bash
npm install
npm test          # vitest — includes running every example
npm run typecheck # tsc --noEmit
npm run build     # emits dist/
npm run verify:live  # manual: real calls to real providers
```

Requires Node 20.19 or newer. Running the examples as `.ts` directly needs
Node 22.6+; on Node 20 use `npx tsx`.

## Roadmap

| Phase | Scope                                                            | Status      |
| ----- | ---------------------------------------------------------------- | ----------- |
| 1     | Project structure, request normalization core                    | ✅ Complete |
| 2     | Provider routing and adapters for OpenAI, Bedrock, Azure, Vertex | ✅ Complete |
| 3     | Credential management and secure config (per-instance)           | ✅ Complete |
| 4     | Docker image and deployment configuration                        | ✅ Complete |
| 5     | Full documentation: quick start, per-provider setup, examples    | ✅ Complete |
| 6     | GitHub Actions CI, contribution guidelines, public release       | ✅ Complete |

v1 is single-instance: one deployment, one set of credentials. Multi-tenant
credential routing is deliberately out of scope.

## Known limitations

[KNOWN_LIMITATIONS.md](./KNOWN_LIMITATIONS.md) is the single source of truth for
[what has been checked against real providers](./KNOWN_LIMITATIONS.md#verification-status),
where provider behaviour was modelled conservatively, and which operational
pieces are missing. Worth reading before you depend on this.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) — setup, the conventions that are
load-bearing, and what adding a provider adapter involves. Participation is
governed by the [Code of Conduct](./CODE_OF_CONDUCT.md).

Security issues go through [SECURITY.md](./SECURITY.md), not public issues.

CI runs formatting, types, the full test suite and a build on Node 20.19, 22 and
24 for every push and pull request, entirely against mocked transports — no
credentials, and a workflow that references the live provider check fails the
build by design.

## License

[MIT](./LICENSE) © NimbleLLM contributors
