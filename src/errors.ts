/**
 * Error taxonomy for NimbleLLM.
 *
 * Every failure surfaced by this library — whether it originates in our own
 * validation layer or in a provider's HTTP response — is reported as a
 * {@link NimbleError} so that callers only ever need one `catch` shape.
 */

import type { ZodError } from 'zod';

/**
 * Stable, machine-readable failure categories.
 *
 * These strings are part of the public API: they are safe to switch on and
 * will not change meaning across minor versions.
 */
export type NimbleErrorCode =
  /** The request did not satisfy the canonical schema. Caller-side bug. */
  | 'invalid_request'
  /** The model reference named a provider NimbleLLM does not know about. */
  | 'unknown_provider'
  /** The request is valid, but the selected provider cannot express it. */
  | 'unsupported_feature'
  /** Credentials were missing, malformed, or rejected by the provider. */
  | 'authentication_error'
  /** The provider applied rate limiting or quota exhaustion. */
  | 'rate_limited'
  /** The request exceeded the configured deadline. */
  | 'timeout'
  /** The provider returned an error we could not classify more precisely. */
  | 'provider_error'
  /** A defect in NimbleLLM itself. */
  | 'internal_error';

/** A single validation problem, addressed by its location in the request. */
export interface NimbleIssue {
  /** Dotted/bracketed path into the request, e.g. `messages[2].content[0].text`. */
  readonly path: string;
  /** Human-readable description of what is wrong at `path`. */
  readonly message: string;
}

export interface NimbleErrorOptions {
  /** Machine-readable category. */
  readonly code: NimbleErrorCode;
  /** Per-field validation problems, when the code is `invalid_request`. */
  readonly issues?: readonly NimbleIssue[];
  /** Provider the failure is attributed to, when it is provider-specific. */
  readonly provider?: string;
  /** HTTP status returned by the provider, when there was one. */
  readonly status?: number;
  /** Whether retrying the identical request could plausibly succeed. */
  readonly retryable?: boolean;
  /** Underlying error, preserved for debugging. */
  readonly cause?: unknown;
}

/**
 * The single error type thrown by NimbleLLM.
 *
 * @example
 * ```ts
 * try {
 *   normalizeRequest(input);
 * } catch (err) {
 *   if (err instanceof NimbleError && err.code === 'invalid_request') {
 *     console.error(err.issues);
 *   }
 * }
 * ```
 */
export class NimbleError extends Error {
  override readonly name = 'NimbleError';
  readonly code: NimbleErrorCode;
  readonly issues: readonly NimbleIssue[];
  readonly provider: string | undefined;
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(message: string, options: NimbleErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = options.code;
    this.issues = options.issues ?? [];
    this.provider = options.provider;
    this.status = options.status;
    this.retryable = options.retryable ?? RETRYABLE_BY_DEFAULT.has(options.code);
  }

  /** Build an `invalid_request` error from one or more field-level issues. */
  static invalidRequest(message: string, issues: readonly NimbleIssue[] = []): NimbleError {
    return new NimbleError(message, { code: 'invalid_request', issues });
  }

  /** Build an `invalid_request` error for a single field. */
  static atPath(path: string, message: string): NimbleError {
    return new NimbleError(`${path}: ${message}`, {
      code: 'invalid_request',
      issues: [{ path, message }],
    });
  }

  /** Structured form, suitable for logging or returning over HTTP. */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      ...(this.issues.length > 0 ? { issues: this.issues } : {}),
      ...(this.provider !== undefined ? { provider: this.provider } : {}),
      ...(this.status !== undefined ? { status: this.status } : {}),
      retryable: this.retryable,
    };
  }
}

const RETRYABLE_BY_DEFAULT = new Set<NimbleErrorCode>(['rate_limited', 'timeout']);

/** Render a Zod path array as `a.b[0].c`, matching the shape used in `NimbleIssue`. */
export function formatPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      out += `[${segment}]`;
    } else if (out === '') {
      out += String(segment);
    } else {
      out += `.${String(segment)}`;
    }
  }
  return out === '' ? '(root)' : out;
}

/**
 * Convert a `ZodError` into a `NimbleError` with one issue per problem found.
 *
 * @param error - the validation failure raised by a schema parse
 * @param prefix - path segments to prepend, when the schema validated a subtree
 */
export function fromZodError(error: ZodError, prefix: readonly PropertyKey[] = []): NimbleError {
  const issues: NimbleIssue[] = error.issues.map((issue) => ({
    path: formatPath([...prefix, ...issue.path]),
    message: issue.message,
  }));

  const summary =
    issues.length === 1 && issues[0] !== undefined
      ? `${issues[0].path}: ${issues[0].message}`
      : `Request failed validation with ${issues.length} issues`;

  return NimbleError.invalidRequest(summary, issues);
}
