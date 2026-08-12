/**
 * Google OAuth access tokens for Vertex AI.
 *
 * A service account key is exchanged for a short-lived access token using the
 * JWT bearer grant: sign a claim set with the account's private key, hand it
 * to Google's token endpoint, get an hour-long token back. Tokens are cached
 * until shortly before they expire, so a busy process mints roughly one per
 * hour rather than one per request.
 */

import { createSign } from 'node:crypto';
import { NimbleError } from '../errors.js';
import type { VertexServiceAccount } from '../config/config.js';
import { Secret } from '../config/secret.js';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer';

/** Refresh this many milliseconds before expiry, to cover clock skew and latency. */
const REFRESH_MARGIN_MS = 60_000;

/** Anything that can produce a bearer token for Vertex. */
export interface TokenSource {
  token(): Promise<Secret>;
}

/** A token supplied by the caller, refreshed outside NimbleLLM. */
export class StaticTokenSource implements TokenSource {
  readonly #token: Secret;

  constructor(token: Secret) {
    this.#token = token;
  }

  async token(): Promise<Secret> {
    return this.#token;
  }
}

export interface ServiceAccountTokenSourceOptions {
  /** Injectable for tests; defaults to the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /** Injectable clock, in milliseconds since the epoch. */
  readonly now?: () => number;
}

/** Mints and caches access tokens from a service account key. */
export class ServiceAccountTokenSource implements TokenSource {
  readonly #account: VertexServiceAccount;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;

  #cached: { token: Secret; expiresAt: number } | undefined;
  /** In-flight request, so concurrent callers share one exchange. */
  #pending: Promise<Secret> | undefined;

  constructor(account: VertexServiceAccount, options: ServiceAccountTokenSourceOptions = {}) {
    this.#account = account;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
  }

  async token(): Promise<Secret> {
    const cached = this.#cached;
    if (cached !== undefined && cached.expiresAt > this.#now()) return cached.token;

    this.#pending ??= this.#exchange().finally(() => {
      this.#pending = undefined;
    });

    return this.#pending;
  }

  async #exchange(): Promise<Secret> {
    const assertion = this.#assertion();

    let response: Response;
    try {
      response = await this.#fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: GRANT_TYPE, assertion }).toString(),
      });
    } catch (cause) {
      throw new NimbleError('could not reach Google’s token endpoint', {
        code: 'authentication_error',
        provider: 'vertex',
        retryable: true,
        cause,
      });
    }

    const body: unknown = await response.json().catch(() => undefined);

    if (!response.ok) {
      // Google reports the reason in `error_description`; it names the problem
      // (bad key, clock skew, disabled account) without echoing the key itself.
      const detail =
        readString(body, 'error_description') ?? readString(body, 'error') ?? response.statusText;
      throw new NimbleError(`Google rejected the service account key: ${detail}`, {
        code: 'authentication_error',
        provider: 'vertex',
        status: response.status,
        retryable: response.status >= 500,
      });
    }

    const accessToken = readString(body, 'access_token');
    if (accessToken === undefined) {
      throw new NimbleError('Google’s token response contained no access_token', {
        code: 'authentication_error',
        provider: 'vertex',
        retryable: true,
      });
    }

    const expiresIn = readNumber(body, 'expires_in') ?? 3600;
    const token = new Secret(accessToken, 'google access token');

    this.#cached = {
      token,
      expiresAt: this.#now() + Math.max(expiresIn * 1000 - REFRESH_MARGIN_MS, 0),
    };

    return token;
  }

  /** Build and sign the JWT that stands in for the account's credentials. */
  #assertion(): string {
    const issuedAt = Math.floor(this.#now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const claims = {
      iss: this.#account.clientEmail,
      scope: SCOPE,
      aud: TOKEN_ENDPOINT,
      iat: issuedAt,
      exp: issuedAt + 3600,
    };

    const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claims))}`;

    let signature: string;
    try {
      signature = createSign('RSA-SHA256')
        .update(unsigned)
        .sign(this.#account.privateKey.reveal(), 'base64url');
    } catch (cause) {
      throw new NimbleError(
        'could not sign with the service account private key; check that it is the full PEM block, newlines included',
        { code: 'authentication_error', provider: 'vertex', cause },
      );
    }

    return `${unsigned}.${signature}`;
  }
}

function base64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function readString(value: unknown, key: string): string | undefined {
  const field = readField(value, key);
  return typeof field === 'string' && field !== '' ? field : undefined;
}

function readNumber(value: unknown, key: string): number | undefined {
  const field = readField(value, key);
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined;
}

function readField(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}
