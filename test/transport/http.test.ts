import { describe, expect, it, vi } from 'vitest';
import { Secret } from '../../src/config/secret.js';
import { codeForStatus, messageFrom, retryAfterMs, send } from '../../src/transport/http.js';

const request = {
  method: 'POST',
  url: new URL('https://api.openai.com/v1/chat/completions'),
  headers: { 'content-type': 'application/json' },
  body: '{}',
};

/** A fetch stub that returns each response in turn. */
function responder(...responses: (Response | Error)[]) {
  let call = 0;
  const fetchImpl = vi.fn(async () => {
    const next = responses[Math.min(call, responses.length - 1)];
    call += 1;
    if (next instanceof Error) throw next;
    return next as Response;
  });
  return fetchImpl as unknown as typeof globalThis.fetch;
}

const ok = () => new Response('{"ok":true}', { status: 200 });
const fail = (status: number, body = '', headers: Record<string, string> = {}) =>
  new Response(body, { status, headers });

const options = (overrides: Record<string, unknown> = {}) => ({
  provider: 'openai' as const,
  timeoutMs: 1000,
  maxRetries: 0,
  sleep: async () => {},
  ...overrides,
});

describe('codeForStatus', () => {
  it.each([
    [401, 'authentication_error', false],
    [403, 'authentication_error', false],
    [429, 'rate_limited', true],
    [408, 'timeout', true],
    [400, 'invalid_request', false],
    [404, 'invalid_request', false],
    [500, 'provider_error', true],
    [503, 'provider_error', true],
  ])('maps %i to %s', (status, code, retryable) => {
    expect(codeForStatus(status)).toEqual({ code, retryable });
  });
});

describe('messageFrom', () => {
  it('reads the OpenAI and Vertex envelope', () => {
    expect(messageFrom('{"error":{"message":"bad key","type":"invalid_request_error"}}')).toBe(
      'bad key',
    );
  });

  it('reads the Anthropic envelope, which nests under a top-level error type', () => {
    expect(
      messageFrom('{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}'),
    ).toBe('slow down');
  });

  it('reads the Bedrock envelope, in either capitalization', () => {
    expect(messageFrom('{"message":"throttled"}')).toBe('throttled');
    expect(messageFrom('{"Message":"throttled"}')).toBe('throttled');
  });

  it('reads a bare error string', () => {
    expect(messageFrom('{"error":"invalid_grant"}')).toBe('invalid_grant');
  });

  it('passes non-JSON bodies through', () => {
    expect(messageFrom('<html>502 Bad Gateway</html>')).toBe('<html>502 Bad Gateway</html>');
  });

  it('truncates a very long non-JSON body', () => {
    expect(messageFrom('x'.repeat(900))).toHaveLength(501);
  });

  it('returns nothing for an empty body or an unrecognized shape', () => {
    expect(messageFrom('')).toBeUndefined();
    expect(messageFrom('{"unexpected":1}')).toBeUndefined();
  });
});

describe('retryAfterMs', () => {
  it('reads a delay in seconds', () => {
    expect(retryAfterMs(fail(429, '', { 'retry-after': '2' }))).toBe(2000);
  });

  it('reads an HTTP-date', () => {
    const when = new Date(Date.now() + 3000).toUTCString();
    expect(retryAfterMs(fail(429, '', { 'retry-after': when }))).toBeGreaterThan(1000);
  });

  it('caps an absurd delay', () => {
    expect(retryAfterMs(fail(429, '', { 'retry-after': '9999' }))).toBe(20_000);
  });

  it('ignores an absent or unparseable header', () => {
    expect(retryAfterMs(fail(429))).toBeUndefined();
    expect(retryAfterMs(fail(429, '', { 'retry-after': 'soon' }))).toBeUndefined();
  });
});

describe('send', () => {
  it('returns a successful response with its body unread', async () => {
    const response = await send(request, options({ fetch: responder(ok()) }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('passes the method, headers and body through', async () => {
    const fetchImpl = responder(ok());
    await send(request, options({ fetch: fetchImpl }));

    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{}');
    expect(init.headers).toEqual({ 'content-type': 'application/json' });
  });

  it('classifies a failure by status and quotes the provider message', async () => {
    const fetchImpl = responder(fail(401, '{"error":{"message":"Incorrect API key"}}'));

    await expect(send(request, options({ fetch: fetchImpl }))).rejects.toMatchObject({
      code: 'authentication_error',
      provider: 'openai',
      status: 401,
      retryable: false,
      message: 'openai returned 401: Incorrect API key',
    });
  });

  it('scrubs configured secrets out of provider text', async () => {
    const key = new Secret('sk-abcdefghijklmnop');
    const fetchImpl = responder(
      fail(400, '{"error":{"message":"key sk-abcdefghijklmnop is bad"}}'),
    );

    await expect(send(request, options({ fetch: fetchImpl, secrets: [key] }))).rejects.toThrowError(
      /key \[redacted\] is bad/,
    );
  });

  it('retries a retryable failure and returns the eventual success', async () => {
    const fetchImpl = responder(fail(503), ok());
    const response = await send(request, options({ fetch: fetchImpl, maxRetries: 1 }));

    expect(response.status).toBe(200);
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(2);
  });

  it('does not retry a failure that will not change', async () => {
    const fetchImpl = responder(fail(400));
    await expect(send(request, options({ fetch: fetchImpl, maxRetries: 3 }))).rejects.toThrow();
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(1);
  });

  it('gives up after the configured number of retries', async () => {
    const fetchImpl = responder(fail(503));
    await expect(send(request, options({ fetch: fetchImpl, maxRetries: 2 }))).rejects.toMatchObject(
      { status: 503 },
    );
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(3);
  });

  it('honours Retry-After over its own backoff', async () => {
    const delays: number[] = [];
    const fetchImpl = responder(fail(429, '', { 'retry-after': '3' }), ok());

    await send(
      request,
      options({
        fetch: fetchImpl,
        maxRetries: 1,
        sleep: async (ms: number) => {
          delays.push(ms);
        },
      }),
    );

    expect(delays).toEqual([3000]);
  });

  it('backs off exponentially when the provider gives no guidance', async () => {
    const delays: number[] = [];
    const fetchImpl = responder(fail(503), fail(503), ok());

    await send(
      request,
      options({
        fetch: fetchImpl,
        maxRetries: 2,
        sleep: async (ms: number) => {
          delays.push(ms);
        },
      }),
    );

    expect(delays).toHaveLength(2);
    expect(delays[0]).toBeGreaterThanOrEqual(250);
    expect(delays[0]).toBeLessThanOrEqual(500);
    expect(delays[1]).toBeGreaterThan(delays[0] ?? 0);
  });

  it('reports each retry to the hook', async () => {
    const onRetry = vi.fn();
    await send(request, options({ fetch: responder(fail(503), ok()), maxRetries: 1, onRetry }));

    expect(onRetry).toHaveBeenCalledOnce();
    expect(onRetry.mock.calls[0]?.[0]).toBe(1);
    expect(onRetry.mock.calls[0]?.[2]).toMatchObject({ status: 503 });
  });

  it('reports a timeout as retryable', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });

    await expect(
      send(request, options({ fetch: responder(timeout), maxRetries: 0 })),
    ).rejects.toMatchObject({ code: 'timeout', retryable: true });
  });

  it('reports a caller cancellation as final', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });

    await expect(
      send(request, options({ fetch: responder(abort), maxRetries: 3 })),
    ).rejects.toMatchObject({ code: 'timeout', retryable: false });
  });

  it('retries a transport failure', async () => {
    const fetchImpl = responder(new Error('ECONNRESET'), ok());
    const response = await send(request, options({ fetch: fetchImpl, maxRetries: 1 }));

    expect(response.status).toBe(200);
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(2);
  });

  it('gives up on a transport failure that keeps happening', async () => {
    await expect(
      send(request, options({ fetch: responder(new Error('ECONNRESET')), maxRetries: 1 })),
    ).rejects.toMatchObject({ code: 'provider_error', retryable: true });
  });
});
