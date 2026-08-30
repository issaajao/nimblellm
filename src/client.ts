/**
 * The client.
 *
 * Ties the four layers together: normalize the request, route it, authorize
 * it, send it, normalize the response. Everything below this file is pure or
 * injectable, so this is the only place that touches the network.
 */

import { CredentialRegistry, type Credentials } from './auth/credentials.js';
import {
  loadConfig,
  secretsIn,
  withOverrides,
  type ConfigOverrides,
  type Env,
  type NimbleConfig,
} from './config/config.js';
import type { Secret } from './config/secret.js';
import { normalizeRequest } from './core/normalize.js';
import { NimbleError } from './errors.js';
import { Router, type RoutedRequest } from './router.js';
import { send } from './transport/http.js';
import { readBedrockStream } from './transport/aws-event-stream.js';
import { readAnthropicStream } from './transport/anthropic-stream.js';
import { readJsonEventStream } from './transport/sse.js';
import type { NimbleRequest, NimbleResponse, NimbleStreamEvent, ProviderId } from './types.js';
import { deepFreeze } from './util/freeze.js';
import { VERSION } from './version.js';

export interface ClientOptions {
  /** Overrides applied on top of the environment-derived configuration. */
  readonly config?: ConfigOverrides;
  /** Environment to read configuration from. Defaults to `process.env`. */
  readonly env?: Env;
  /** Router to use. Defaults to one with the built-in adapters. */
  readonly router?: Router;
  /** Injectable for tests; defaults to the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /** Injectable clock, used for OAuth token expiry. */
  readonly now?: () => number;
  /** Injectable sleep, so tests need not wait out retry backoff. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Called before each retry. */
  readonly onRetry?: (attempt: number, delayMs: number, error: NimbleError) => void;
}

/** Per-call options, overriding the client defaults. */
export interface CallOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
}

/**
 * Providers whose streamed bodies need more than plain SSE-to-JSON decoding:
 * Bedrock frames its events as binary event-stream, and Anthropic splits one
 * token count across two events. Everything else decodes chunk by chunk.
 */
const STREAM_READERS: Partial<
  Record<
    ProviderId,
    (stream: ReadableStream<Uint8Array>) => AsyncGenerator<unknown, void, undefined>
  >
> = {
  bedrock: readBedrockStream,
  anthropic: readAnthropicStream,
};

export class NimbleClient {
  /** Resolved configuration. Secrets in it render as `[redacted]`. */
  readonly config: NimbleConfig;
  readonly router: Router;

  readonly #credentials: CredentialRegistry;
  readonly #secrets: readonly Secret[];
  readonly #options: ClientOptions;

  constructor(options: ClientOptions = {}) {
    this.config = withOverrides(loadConfig(options.env), options.config);
    this.router = options.router ?? new Router();
    this.#options = options;
    this.#secrets = secretsIn(this.config);
    this.#credentials = new CredentialRegistry(this.config, {
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }

  /** Providers that have credentials configured on this instance. */
  configuredProviders(): readonly string[] {
    return this.router.providers().filter((provider) => this.#credentials.has(provider));
  }

  /**
   * Run a completion.
   *
   * @param input - a request in any accepted shape; it is normalized here
   * @throws NimbleError - validation, routing, authentication or provider
   *   failures, all carrying a `code`
   *
   * @example
   * ```ts
   * const client = createClient();
   * const response = await client.complete({
   *   model: 'openai/gpt-4o',
   *   messages: [{ role: 'user', content: 'Why is the sky blue?' }],
   * });
   * response.message.content; // [{ type: 'text', text: '…' }]
   * response.usage.totalTokens;
   * ```
   */
  async complete(input: unknown, options: CallOptions = {}): Promise<NimbleResponse> {
    const { request, routed, response } = await this.#dispatch(input, options, false);
    const body: unknown = await response.json().catch((cause: unknown) => {
      throw new NimbleError(`${routed.provider} returned a body that is not JSON`, {
        code: 'provider_error',
        provider: routed.provider,
        retryable: true,
        cause,
      });
    });

    return routed.adapter.parseResponse(body, request);
  }

  /**
   * Run a streaming completion.
   *
   * @returns canonical events in arrival order — `text_delta`,
   *   `tool_call_delta`, `usage`, then `finish`
   *
   * @example
   * ```ts
   * for await (const event of client.stream({ model: 'openai/gpt-4o', messages })) {
   *   if (event.type === 'text_delta') process.stdout.write(event.text);
   * }
   * ```
   */
  async *stream(
    input: unknown,
    options: CallOptions = {},
  ): AsyncGenerator<NimbleStreamEvent, void, undefined> {
    const { request, routed, response } = await this.#dispatch(input, options, true);

    if (response.body === null) {
      throw new NimbleError(`${routed.provider} returned an empty stream`, {
        code: 'provider_error',
        provider: routed.provider,
        retryable: true,
      });
    }

    const chunks = (STREAM_READERS[routed.provider] ?? readJsonEventStream)(response.body);

    const parse = routed.adapter.parseStreamChunk?.bind(routed.adapter);
    /* c8 ignore next 6 -- every built-in adapter implements it */
    if (parse === undefined) {
      throw new NimbleError(`${routed.provider} cannot decode streamed responses`, {
        code: 'unsupported_feature',
        provider: routed.provider,
      });
    }

    for await (const chunk of chunks) {
      yield* parse(chunk, request);
    }
  }

  /**
   * Normalize, route, authorize and send — everything the two public methods
   * share.
   */
  async #dispatch(
    input: unknown,
    options: CallOptions,
    streaming: boolean,
  ): Promise<{ request: NimbleRequest; routed: RoutedRequest; response: Response }> {
    const raw = streaming ? { ...asObject(input), stream: true } : input;

    const normalized = normalizeRequest(raw, {
      ...(this.config.defaultProvider === undefined
        ? {}
        : { defaultProvider: this.config.defaultProvider }),
    });

    const request = withProviderDefaults(normalized, this.config);
    const routed = this.router.route(request);
    const credentials = this.#credentials.for(routed.provider);

    const url = buildUrl(credentials.baseUrl, routed.route.path, routed.route.query);
    const body = JSON.stringify(routed.payload);

    const baseHeaders: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': `nimblellm/${VERSION}`,
      ...routed.route.headers,
      ...(streaming && routed.provider !== 'bedrock' ? { accept: 'text/event-stream' } : {}),
    };

    const authHeaders = await credentials.authorize({
      method: routed.route.method,
      url,
      body,
      headers: baseHeaders,
    });

    const response = await send(
      { method: routed.route.method, url, headers: { ...baseHeaders, ...authHeaders }, body },
      {
        provider: routed.provider,
        timeoutMs: options.timeoutMs ?? this.config.timeoutMs,
        maxRetries: options.maxRetries ?? this.config.maxRetries,
        secrets: this.#secrets,
        ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
        ...(this.#options.sleep === undefined ? {} : { sleep: this.#options.sleep }),
        ...(this.#options.onRetry === undefined ? {} : { onRetry: this.#options.onRetry }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );

    return { request, routed, response };
  }
}

/** Convenience constructor, for callers who prefer not to use `new`. */
export function createClient(options: ClientOptions = {}): NimbleClient {
  return new NimbleClient(options);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fill in the `providerOptions` that routing needs but a caller should not
 * have to repeat — Azure's API version, and the Vertex project and location
 * that make up its resource path. An explicit value always wins.
 */
export function withProviderDefaults(request: NimbleRequest, config: NimbleConfig): NimbleRequest {
  const provider = request.model.provider;

  if (provider === 'azure' && config.azure !== undefined) {
    if (request.providerOptions?.azure?.['apiVersion'] === undefined) {
      return mergeProviderOptions(request, 'azure', { apiVersion: config.azure.apiVersion });
    }
  }

  if (provider === 'vertex' && config.vertex !== undefined) {
    const existing = request.providerOptions?.vertex;
    const missing: Record<string, unknown> = {};
    if (existing?.['project'] === undefined) missing['project'] = config.vertex.project;
    if (existing?.['location'] === undefined) missing['location'] = config.vertex.location;
    if (Object.keys(missing).length > 0) return mergeProviderOptions(request, 'vertex', missing);
  }

  return request;
}

function mergeProviderOptions(
  request: NimbleRequest,
  provider: 'azure' | 'vertex',
  additions: Record<string, unknown>,
): NimbleRequest {
  return deepFreeze({
    ...request,
    providerOptions: {
      ...request.providerOptions,
      [provider]: { ...request.providerOptions?.[provider], ...additions },
    },
  });
}

/** Join a base URL and a relative path, then append query parameters. */
export function buildUrl(
  baseUrl: string,
  path: string,
  query: Readonly<Record<string, string>> | undefined,
): URL {
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`);
  for (const [name, value] of Object.entries(query ?? {})) {
    url.searchParams.set(name, value);
  }
  return url;
}

function asObject(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw NimbleError.atPath('(root)', 'expected a request object');
  }
  return input as Record<string, unknown>;
}

export type { Credentials };
