import { createVerify, generateKeyPairSync } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ServiceAccountTokenSource, StaticTokenSource } from '../../src/auth/google.js';
import { Secret } from '../../src/config/secret.js';
import type { VertexServiceAccount } from '../../src/config/config.js';

let account: VertexServiceAccount;
let publicKey: string;

beforeAll(() => {
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  publicKey = pair.publicKey;
  account = {
    clientEmail: 'bot@example.iam.gserviceaccount.com',
    privateKey: new Secret(pair.privateKey),
  };
});

/** A token endpoint stub that records what it was called with. */
function tokenEndpoint(
  body: unknown = { access_token: 'ya29.first', expires_in: 3600 },
  status = 200,
): { fetch: typeof globalThis.fetch; calls: { url: string; body: string }[] } {
  const calls: { url: string; body: string }[] = [];

  const fetchImpl = vi.fn(async (url: unknown, init: unknown) => {
    calls.push({
      url: String(url),
      body: String((init as { body?: unknown } | undefined)?.body ?? ''),
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });

  return { fetch: fetchImpl as unknown as typeof globalThis.fetch, calls };
}

describe('StaticTokenSource', () => {
  it('returns the token it was given', async () => {
    const token = new Secret('ya29.static');
    expect((await new StaticTokenSource(token).token()).reveal()).toBe('ya29.static');
  });
});

describe('ServiceAccountTokenSource', () => {
  it('exchanges a signed assertion for an access token', async () => {
    const endpoint = tokenEndpoint();
    const source = new ServiceAccountTokenSource(account, { fetch: endpoint.fetch });

    expect((await source.token()).reveal()).toBe('ya29.first');
    expect(endpoint.calls[0]?.url).toBe('https://oauth2.googleapis.com/token');

    const params = new URLSearchParams(endpoint.calls[0]?.body ?? '');
    expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(params.get('assertion')).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it('signs the assertion with the service account key', async () => {
    const endpoint = tokenEndpoint();
    const now = () => 1_700_000_000_000;
    await new ServiceAccountTokenSource(account, { fetch: endpoint.fetch, now }).token();

    const assertion = new URLSearchParams(endpoint.calls[0]?.body ?? '').get('assertion') ?? '';
    const [header, claims, signature] = assertion.split('.');

    expect(JSON.parse(Buffer.from(header ?? '', 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    expect(JSON.parse(Buffer.from(claims ?? '', 'base64url').toString())).toEqual({
      iss: account.clientEmail,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      aud: 'https://oauth2.googleapis.com/token',
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });

    const verified = createVerify('RSA-SHA256')
      .update(`${header}.${claims}`)
      .verify(publicKey, Buffer.from(signature ?? '', 'base64url'));
    expect(verified).toBe(true);
  });

  it('caches the token until shortly before it expires', async () => {
    const endpoint = tokenEndpoint();
    let clock = 0;
    const source = new ServiceAccountTokenSource(account, {
      fetch: endpoint.fetch,
      now: () => clock,
    });

    await source.token();
    clock = 3_000_000; // still inside the hour
    await source.token();

    expect(endpoint.calls).toHaveLength(1);
  });

  it('refreshes once the cached token is inside the safety margin', async () => {
    const endpoint = tokenEndpoint();
    let clock = 0;
    const source = new ServiceAccountTokenSource(account, {
      fetch: endpoint.fetch,
      now: () => clock,
    });

    await source.token();
    clock = 3_600_000 - 59_000; // inside the 60s refresh margin
    await source.token();

    expect(endpoint.calls).toHaveLength(2);
  });

  it('shares one exchange between concurrent callers', async () => {
    const endpoint = tokenEndpoint();
    const source = new ServiceAccountTokenSource(account, { fetch: endpoint.fetch });

    const [a, b] = await Promise.all([source.token(), source.token()]);

    expect(endpoint.calls).toHaveLength(1);
    expect(a.reveal()).toBe(b.reveal());
  });

  it('reports Google’s rejection reason without echoing the key', async () => {
    const endpoint = tokenEndpoint(
      { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' },
      400,
    );
    const source = new ServiceAccountTokenSource(account, { fetch: endpoint.fetch });

    await expect(source.token()).rejects.toThrowError(/Invalid JWT Signature/);
    await expect(source.token()).rejects.toMatchObject({
      code: 'authentication_error',
      provider: 'vertex',
      retryable: false,
    });
  });

  it('treats a server-side rejection as retryable', async () => {
    const endpoint = tokenEndpoint({ error: 'backend_error' }, 503);
    const source = new ServiceAccountTokenSource(account, { fetch: endpoint.fetch });
    await expect(source.token()).rejects.toMatchObject({ retryable: true });
  });

  it('reports a response with no access_token', async () => {
    const endpoint = tokenEndpoint({ token_type: 'Bearer' });
    const source = new ServiceAccountTokenSource(account, { fetch: endpoint.fetch });
    await expect(source.token()).rejects.toThrowError(/contained no access_token/);
  });

  it('reports a network failure as retryable', async () => {
    const source = new ServiceAccountTokenSource(account, {
      fetch: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof globalThis.fetch,
    });

    await expect(source.token()).rejects.toMatchObject({
      code: 'authentication_error',
      retryable: true,
    });
  });

  it('reports an unusable private key clearly', async () => {
    const source = new ServiceAccountTokenSource(
      { clientEmail: 'bot@example.test', privateKey: new Secret('not-a-pem') },
      { fetch: tokenEndpoint().fetch },
    );

    await expect(source.token()).rejects.toThrowError(/full PEM block/);
  });
});
