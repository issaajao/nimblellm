# API reference

Everything is exported from the package root.

```ts
import { createClient, normalizeRequest, Router, NimbleError, Secret } from 'nimblellm';
```

## Client

### `createClient(options?)` · `new NimbleClient(options?)`

```ts
interface ClientOptions {
  config?: ConfigOverrides; // overrides on top of the environment
  env?: Env; // where to read from; defaults to process.env
  router?: Router; // defaults to the built-in adapters
  fetch?: typeof fetch; // injectable transport
  now?: () => number; // injectable clock (OAuth expiry)
  sleep?: (ms: number) => Promise<void>; // injectable backoff
  onRetry?: (attempt: number, delayMs: number, error: NimbleError) => void;
}
```

**`complete(input, options?): Promise<NimbleResponse>`**
**`stream(input, options?): AsyncGenerator<NimbleStreamEvent>`**

```ts
interface CallOptions {
  signal?: AbortSignal;
  timeoutMs?: number; // per attempt
  maxRetries?: number;
}
```

**`configuredProviders(): readonly string[]`** — providers with credentials.
**`config: NimbleConfig`** — resolved configuration; safe to log.
**`router: Router`**

## Normalization

### `normalizeRequest(input, options?): NimbleRequest`

Validates and canonicalizes. Resolves aliases, hoists system messages, coerces
content into parts, checks cross-field invariants. The result is deeply frozen.

```ts
normalizeRequest(input, { defaultProvider: 'openai' });
```

Idempotent: feeding a normalized request back in returns an equal request.

Throws `invalid_request` or `unknown_provider`.

### `parseModelRef(raw, options?): ModelRef`

Splits `provider/model` on the **first** slash, so nested ids survive
(`vertex/publishers/google/models/…`). Recognizes aliases: `aws` → `bedrock`,
`google`/`gcp` → `vertex`, `azure-openai` → `azure`.

### `normalizeMessages(raw, path?): NormalizedConversation`

The conversation half on its own — returns `{ system, messages }`.

## Routing

### `new Router(options?)` · `createRouter(options?)`

```ts
new Router({ adapters: [...builtInAdapters, myAdapter] });
```

**`route(request): RoutedRequest`** — selects the adapter, checks capabilities
then ranges, and builds the call. Performs no I/O.

```ts
interface RoutedRequest {
  provider: ProviderId;
  adapter: ProviderAdapter;
  route: ProviderRoute; // { method, path, query?, headers? }
  payload: unknown; // provider-native body
}
```

**`candidatesFor(request): readonly ProviderId[]`** — which registered providers
could serve this request as written.
**`supports(provider, capability): boolean`**
**`adapterFor(provider): ProviderAdapter`**
**`register(adapter): this`** — a later registration replaces an earlier one
with the same id.
**`providers(): readonly ProviderId[]`**

## Adapters

```ts
interface ProviderAdapter<TPayload = unknown, TRaw = unknown> {
  readonly id: ProviderId;
  readonly limits: ProviderLimits;
  supports(capability: Capability): boolean;
  describeRoute(request: NimbleRequest): ProviderRoute;
  buildPayload(request: NimbleRequest): TPayload;
  parseResponse(raw: TRaw, request: NimbleRequest): NimbleResponse;
  parseStreamChunk?(chunk: unknown, request: NimbleRequest): readonly NimbleStreamEvent[];
}
```

Built in: `openaiAdapter`, `azureAdapter`, `bedrockAdapter`, `vertexAdapter`,
plus `builtInAdapters` and `adaptersById`.

`Capability` is one of `streaming`, `tools`, `tool_choice_required`,
`json_mode`, `json_schema`, `image_url`, `image_base64`, `seed`,
`stop_sequences`, `frequency_penalty`, `presence_penalty`, `top_k`, `metadata`.

Also exported: `requiredCapabilities(request)`, `assertCapabilities`,
`assertWithinLimits`.

## Types

```ts
interface NimbleRequest {
  model: ModelRef; // { provider, model, raw }
  system?: string;
  messages: readonly NimbleMessage[]; // user | assistant | tool — never system

  maxOutputTokens?: number;
  temperature?: number; // 0–2 canonical; 0–1 on Bedrock and Anthropic
  topP?: number; // 0–1
  topK?: number; // Vertex and Anthropic only
  frequencyPenalty?: number; // -2–2
  presencePenalty?: number; // -2–2
  stop?: readonly string[];
  seed?: number;
  stream?: boolean;

  responseFormat?: ResponseFormat;
  tools?: readonly NimbleTool[];
  toolChoice?: ToolChoice;

  metadata?: Readonly<Record<string, string>>;
  providerOptions?: Readonly<Partial<Record<ProviderId, Record<string, unknown>>>>;
}
```

```ts
interface NimbleResponse {
  id: string;
  provider: ProviderId;
  model: string; // what the provider says it served
  createdAt: string; // ISO-8601
  finishReason: FinishReason;
  message: AssistantMessage;
  usage: TokenUsage; // { inputTokens, outputTokens, totalTokens }
  raw?: unknown; // untouched provider payload
}
```

`ContentPart` is `{ type: 'text'; text }` or `{ type: 'image'; source }`, where
`source` is `{ kind: 'url'; url }` or `{ kind: 'base64'; mediaType; data }`.

`FinishReason` is `stop` · `length` · `tool_calls` · `content_filter` ·
`unknown`.

`MessageRole` is `user` · `assistant` · `tool`. System instructions live in
`request.system`.

## Errors

```ts
class NimbleError extends Error {
  readonly code: NimbleErrorCode;
  readonly issues: readonly NimbleIssue[]; // { path, message }
  readonly provider: string | undefined;
  readonly status: number | undefined;
  readonly retryable: boolean;
  toJSON(): Record<string, unknown>;
}
```

See [Errors and retries](./errors.md).

## Configuration and secrets

`loadConfig(env?)`, `withOverrides(base, overrides)`, `configuredProviders(config)`,
`secretsIn(config)`.

```ts
class Secret {
  reveal(): string; // the actual value
  hint(): string; // '…bcd1'
  readonly length: number;
  equals(other: Secret): boolean;
  // toString, toJSON and console.log all yield '[redacted]'
}
```

`redact(text, secrets)` scrubs known values from text.

## Credentials

`CredentialRegistry`, `OpenAICredentials`, `AnthropicCredentials`,
`AzureCredentials`, `BedrockCredentials`, `VertexCredentials`.

```ts
interface Credentials {
  readonly provider: ProviderId;
  readonly baseUrl: string;
  authorize(context: SigningContext): Promise<Record<string, string>>;
}
```

`signRequest(input): SignedRequest` — AWS SigV4, exposing `canonicalRequest`
and `stringToSign` for debugging.

`ServiceAccountTokenSource`, `StaticTokenSource` — Google OAuth tokens.

## Transport

`send(request, options)` — fetch with deadlines, retries and error
classification. `codeForStatus(status)`.

`readEventStream(stream)`, `readJsonEventStream(stream)` — SSE.
`EventStreamDecoder`, `readBedrockStream(stream)` — AWS binary frames.
`readAnthropicStream(stream)` — Anthropic's event sequence, with usage stitched
across events.

## Server

`createGatewayServer(options)`, `startServer(options)`, `loadServerConfig(env?)`,
`isAuthorized(config, header)`. See [Running as a gateway](./gateway.md).

## Stability

Pre-1.0, the API may change without a major version bump. Error `code` values
are the most stable part of the surface and are intended to be safe to switch
on. See [KNOWN_LIMITATIONS §8](../KNOWN_LIMITATIONS.md#8-pre-10-api-stability).
