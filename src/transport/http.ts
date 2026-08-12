/**
 * HTTP transport.
 *
 * One place that knows how to make a provider call: deadlines, retries with
 * backoff, and the translation of four different error envelopes into the one
 * `NimbleError` shape callers already handle.
 */

import { NimbleError, type NimbleErrorCode } from '../errors.js';
import { redact } from '../config/secret.js';
import type { Secret } from '../config/secret.js';
import type { ProviderId } from '../types.js';

export interface HttpRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface SendOptions {
  readonly provider: ProviderId;
  /** Deadline for each individual attempt. */
  readonly timeoutMs: number;
  /** Extra attempts after the first, for retryable failures only. */
  readonly maxRetries: number;
  /** Injectable for tests; defaults to the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /** Caller cancellation, honoured alongside the timeout. */
  readonly signal?: AbortSignal | undefined;
  /** Secrets to scrub from any provider text that ends up in an error. */
  readonly secrets?: readonly Secret[];
  /** Sleep function, injectable so tests do not wait out the backoff. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Observability hook, called before each retry. */
  readonly onRetry?: (attempt: number, delayMs: number, error: NimbleError) => void;
}

/** Base for exponential backoff; attempt *n* waits roughly `500ms * 2^n`. */
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 20_000;

/**
 * Send a request, retrying retryable failures.
 *
 * @returns the successful response, with its body still unread so that
 *   streaming callers can consume it incrementally
 * @throws NimbleError - classified by status, or `timeout` when the deadline
 *   passes on every attempt
 */
export async function send(request: HttpRequest, options: SendOptions): Promise<Response> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? defaultSleep;
  const secrets = options.secrets ?? [];

  let lastError: NimbleError | undefined;

  for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
    let response: Response;

    try {
      response = await fetchImpl(request.url, {
        method: request.method,
        headers: { ...request.headers },
        body: request.body,
        signal: deadline(options.timeoutMs, options.signal),
      });
    } catch (cause) {
      lastError = fromNetworkError(cause, options.provider, options.timeoutMs);
      if (!lastError.retryable || attempt === options.maxRetries) throw lastError;
      await backoff(attempt, undefined, sleep, lastError, options.onRetry);
      continue;
    }

    if (response.ok) return response;

    const text = await response.text().catch(() => '');
    lastError = fromResponse(response, text, options.provider, secrets);

    if (!lastError.retryable || attempt === options.maxRetries) throw lastError;
    await backoff(attempt, retryAfterMs(response), sleep, lastError, options.onRetry);
  }

  /* c8 ignore next 2 -- the loop either returns or throws */
  throw lastError ?? new NimbleError('request failed', { code: 'internal_error' });
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Map an HTTP status onto a canonical code.
 *
 * 408 and 5xx are retryable because they describe the request's fate rather
 * than its content; 4xx are not, because sending the same body again will
 * produce the same answer.
 */
export function codeForStatus(status: number): { code: NimbleErrorCode; retryable: boolean } {
  if (status === 401 || status === 403) return { code: 'authentication_error', retryable: false };
  if (status === 429) return { code: 'rate_limited', retryable: true };
  if (status === 408) return { code: 'timeout', retryable: true };
  if (status >= 500) return { code: 'provider_error', retryable: true };
  if (status >= 400) return { code: 'invalid_request', retryable: false };
  /* c8 ignore next -- only reached for a non-ok status below 400 */
  return { code: 'provider_error', retryable: false };
}

/** Build a `NimbleError` from a failed response and its body. */
export function fromResponse(
  response: Response,
  body: string,
  provider: ProviderId,
  secrets: readonly Secret[] = [],
): NimbleError {
  const { code, retryable } = codeForStatus(response.status);
  const detail = redact(messageFrom(body) ?? response.statusText ?? '', secrets);

  return new NimbleError(
    `${provider} returned ${response.status}${detail === '' ? '' : `: ${detail}`}`,
    { code, provider, status: response.status, retryable },
  );
}

/**
 * Pull a human-readable message out of a provider's error envelope.
 *
 * OpenAI and Vertex nest it under `error.message`; Bedrock uses a top-level
 * `message` (capitalised in some operations).
 */
export function messageFrom(body: string): string | undefined {
  if (body === '') return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Not JSON — an HTML error page or a proxy's plain-text response.
    return body.length > 500 ? `${body.slice(0, 500)}…` : body;
  }

  const nested = field(field(parsed, 'error'), 'message');
  if (typeof nested === 'string' && nested !== '') return nested;

  for (const key of ['message', 'Message', 'error']) {
    const value = field(parsed, key);
    if (typeof value === 'string' && value !== '') return value;
  }

  return undefined;
}

function fromNetworkError(cause: unknown, provider: ProviderId, timeoutMs: number): NimbleError {
  const name = field(cause, 'name');

  if (name === 'TimeoutError') {
    return new NimbleError(`${provider} did not respond within ${timeoutMs}ms`, {
      code: 'timeout',
      provider,
      retryable: true,
      cause,
    });
  }

  if (name === 'AbortError') {
    return new NimbleError(`the request to ${provider} was cancelled`, {
      code: 'timeout',
      provider,
      retryable: false,
      cause,
    });
  }

  return new NimbleError(`could not reach ${provider}`, {
    code: 'provider_error',
    provider,
    retryable: true,
    cause,
  });
}

// ---------------------------------------------------------------------------
// Retries
// ---------------------------------------------------------------------------

async function backoff(
  attempt: number,
  retryAfter: number | undefined,
  sleep: (ms: number) => Promise<void>,
  error: NimbleError,
  onRetry: SendOptions['onRetry'],
): Promise<void> {
  const delay = retryAfter ?? jittered(attempt);
  onRetry?.(attempt + 1, delay, error);
  await sleep(delay);
}

/** Exponential backoff with full jitter, which avoids synchronized retries. */
function jittered(attempt: number): number {
  const ceiling = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
}

/** Honour `Retry-After`, in either seconds or HTTP-date form. */
export function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (header === null) return undefined;

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_DELAY_MS);

  const date = Date.parse(header);
  if (Number.isNaN(date)) return undefined;
  return Math.min(Math.max(date - Date.now(), 0), MAX_DELAY_MS);
}

/** Combine the per-attempt deadline with any caller-supplied cancellation. */
function deadline(timeoutMs: number, signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([timeout, signal]);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}
