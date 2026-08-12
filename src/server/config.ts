/**
 * Gateway server configuration.
 *
 * Separate from {@link NimbleConfig}, which holds *provider* credentials. This
 * is about the server itself: where it listens, who may call it, and how much
 * it will accept in one request.
 */

import { NimbleError } from '../errors.js';
import type { Env } from '../config/config.js';
import { Secret } from '../config/secret.js';

export const DEFAULT_PORT = 8080;
export const DEFAULT_HOST = '0.0.0.0';
/** 4 MiB — large enough for inline images, small enough to bound memory. */
export const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;
export const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;

export type LogLevel = 'debug' | 'info' | 'error' | 'silent';

export interface ServerConfig {
  readonly port: number;
  readonly host: string;
  /**
   * Keys accepted in `Authorization: Bearer …`. Empty only when
   * {@link allowAnonymous} is set.
   */
  readonly apiKeys: readonly Secret[];
  /** Serve without gateway authentication. Local development only. */
  readonly allowAnonymous: boolean;
  readonly maxBodyBytes: number;
  readonly logLevel: LogLevel;
  /** Value for `Access-Control-Allow-Origin`, or `undefined` to send none. */
  readonly corsOrigin?: string;
  /** How long in-flight requests get to finish after SIGTERM. */
  readonly shutdownGraceMs: number;
}

/**
 * Build server configuration from the environment.
 *
 * Refuses to produce an unauthenticated configuration by accident: a gateway
 * with no key in front of it is an open proxy onto someone's paid provider
 * credentials, so that has to be asked for explicitly.
 *
 * @throws NimbleError - `invalid_request` when a variable is malformed, or
 *   when no gateway key is set and anonymous access was not requested
 */
export function loadServerConfig(env: Env = process.env): ServerConfig {
  const apiKeys = readKeys(env['NIMBLE_SERVER_API_KEYS'] ?? env['NIMBLE_SERVER_API_KEY']);
  const allowAnonymous = readBool(env['NIMBLE_ALLOW_ANONYMOUS'], 'NIMBLE_ALLOW_ANONYMOUS');

  if (apiKeys.length === 0 && !allowAnonymous) {
    throw configError(
      'no gateway key is configured. Set NIMBLE_SERVER_API_KEYS to one or more keys ' +
        '(comma-separated), or set NIMBLE_ALLOW_ANONYMOUS=true if this instance is ' +
        'genuinely meant to be open — it fronts your provider credentials.',
      'NIMBLE_SERVER_API_KEYS',
    );
  }

  const corsOrigin = readString(env['NIMBLE_CORS_ORIGIN']);

  return {
    port: readPort(env['NIMBLE_PORT']) ?? DEFAULT_PORT,
    host: readString(env['NIMBLE_HOST']) ?? DEFAULT_HOST,
    apiKeys,
    allowAnonymous,
    maxBodyBytes:
      readPositiveInt(env['NIMBLE_MAX_BODY_BYTES'], 'NIMBLE_MAX_BODY_BYTES') ??
      DEFAULT_MAX_BODY_BYTES,
    logLevel: readLogLevel(env['NIMBLE_LOG_LEVEL']),
    ...(corsOrigin === undefined ? {} : { corsOrigin }),
    shutdownGraceMs:
      readPositiveInt(env['NIMBLE_SHUTDOWN_GRACE_MS'], 'NIMBLE_SHUTDOWN_GRACE_MS') ??
      DEFAULT_SHUTDOWN_GRACE_MS,
  };
}

/**
 * Check a presented bearer token against the configured keys.
 *
 * Compares every key rather than stopping at the first match, so the answer
 * does not depend on key order.
 */
export function isAuthorized(config: ServerConfig, header: string | undefined): boolean {
  if (config.allowAnonymous) return true;

  const presented = bearerOf(header);
  if (presented === undefined) return false;

  let matched = false;
  for (const key of config.apiKeys) {
    if (key.equals(presented)) matched = true;
  }
  return matched;
}

function bearerOf(header: string | undefined): Secret | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token === undefined || token === '' ? undefined : new Secret(token, 'presented key');
}

function readKeys(raw: string | undefined): readonly Secret[] {
  const value = readString(raw);
  if (value === undefined) return [];

  return value
    .split(',')
    .map((key) => key.trim())
    .filter((key) => key !== '')
    .map((key) => new Secret(key, 'NIMBLE_SERVER_API_KEYS'));
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function readBool(value: string | undefined, name: string): boolean {
  const raw = readString(value)?.toLowerCase();
  if (raw === undefined) return false;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw configError(`must be true or false, received "${raw}"`, name);
}

function readLogLevel(value: string | undefined): LogLevel {
  const raw = readString(value)?.toLowerCase() ?? 'info';
  if (raw === 'debug' || raw === 'info' || raw === 'error' || raw === 'silent') return raw;
  throw configError(
    `must be one of debug, info, error, silent; received "${raw}"`,
    'NIMBLE_LOG_LEVEL',
  );
}

function readPort(value: string | undefined): number | undefined {
  const port = readPositiveInt(value, 'NIMBLE_PORT');
  if (port !== undefined && port > 65_535) {
    throw configError(`must be a valid port, received "${value}"`, 'NIMBLE_PORT');
  }
  return port;
}

function readPositiveInt(value: string | undefined, name: string): number | undefined {
  const raw = readString(value);
  if (raw === undefined) return undefined;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw configError(`must be a positive integer, received "${raw}"`, name);
  }
  return parsed;
}

function configError(message: string, variable: string): NimbleError {
  return new NimbleError(`${variable}: ${message}`, {
    code: 'invalid_request',
    issues: [{ path: variable, message }],
  });
}
