import { afterEach, describe, expect, it, vi } from 'vitest';
import { NimbleClient } from '../../src/client.js';
import { loadServerConfig, type ServerConfig } from '../../src/server/config.js';
import { startServer, type StartedServer } from '../../src/server/server.js';

const OPENAI_RESPONSE = {
  id: 'chatcmpl-1',
  created: 1_700_000_000,
  model: 'gpt-4o-2024-08-06',
  choices: [{ message: { role: 'assistant', content: 'Blue.' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
};

const KEY = 'gw-test-key';
const body = { model: 'openai/gpt-4o', messages: [{ role: 'user', content: 'why?' }] };

/** A provider stub: JSON by default, SSE when the request asks to stream. */
function providerFetch(response: unknown = OPENAI_RESPONSE, status = 200) {
  return vi.fn(async (_url: unknown, init: unknown) => {
    const sent = JSON.parse(String((init as { body?: unknown }).body ?? '{}'));

    // A failing provider fails whether or not the request asked to stream.
    if (status !== 200) {
      return new Response(JSON.stringify(response), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (sent.stream === true) {
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode('data: {"choices":[{"delta":{"content":"Bl"}}]}\n\n'),
            );
            controller.enqueue(
              encoder.encode('data: {"choices":[{"delta":{"content":"ue"}}]}\n\n'),
            );
            controller.enqueue(
              encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'),
            );
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    }

    return new Response(JSON.stringify(response), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof globalThis.fetch;
}

let running: StartedServer | undefined;
const logs: Record<string, unknown>[] = [];

async function serve(
  options: {
    env?: Record<string, string>;
    server?: Partial<ServerConfig>;
    fetch?: typeof globalThis.fetch;
  } = {},
): Promise<string> {
  const client = new NimbleClient({
    env: options.env ?? { OPENAI_API_KEY: 'sk-test' },
    fetch: options.fetch ?? providerFetch(),
    sleep: async () => {},
  });

  const config: ServerConfig = {
    ...loadServerConfig({ NIMBLE_SERVER_API_KEYS: KEY, NIMBLE_HOST: '127.0.0.1' }),
    port: 0,
    ...options.server,
  };

  logs.length = 0;
  running = await startServer({ client, config, log: (line) => logs.push(line) });
  return `http://127.0.0.1:${running.port}`;
}

const call = (base: string, path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${KEY}`,
      'content-type': 'application/json',
      ...init.headers,
    },
  });

afterEach(async () => {
  await running?.close();
  running = undefined;
});

describe('gateway server', () => {
  describe('health and readiness', () => {
    it('serves liveness without a gateway key', async () => {
      const base = await serve();
      const response = await fetch(`${base}/health`);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: 'ok' });
    });

    it('reports ready when a provider is configured', async () => {
      const base = await serve();
      const response = await fetch(`${base}/ready`);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: 'ready', providers: ['openai'] });
    });

    it('reports 503 when no provider is configured', async () => {
      const base = await serve({ env: {} });
      const response = await fetch(`${base}/ready`);

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ providers: [] });
    });
  });

  describe('gateway authentication', () => {
    it('rejects a request with no key', async () => {
      const base = await serve();
      const response = await fetch(`${base}/v1/chat/completions`, { method: 'POST' });

      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: 'unauthorized' } });
    });

    it('rejects a wrong key', async () => {
      const base = await serve();
      const response = await fetch(`${base}/v1/providers`, {
        headers: { authorization: 'Bearer wrong' },
      });
      expect(response.status).toBe(401);
    });

    it('does not log the presented key', async () => {
      const base = await serve();
      await fetch(`${base}/v1/providers`, { headers: { authorization: 'Bearer sneaky-value' } });

      expect(JSON.stringify(logs)).not.toContain('sneaky-value');
    });

    it('serves without a key when anonymous access is enabled', async () => {
      const base = await serve({ server: { allowAnonymous: true, apiKeys: [] } });
      expect((await fetch(`${base}/v1/providers`)).status).toBe(200);
    });
  });

  describe('POST /v1/chat/completions', () => {
    it('returns a canonical response', async () => {
      const base = await serve();
      const response = await call(base, '/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify(body),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        provider: 'openai',
        finishReason: 'stop',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Blue.' }] },
        usage: { totalTokens: 12 },
      });
    });

    it('accepts OpenAI spellings in the request body', async () => {
      const fetchImpl = providerFetch();
      const base = await serve({ fetch: fetchImpl });

      await call(base, '/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ ...body, max_tokens: 64, top_p: 0.9 }),
      });

      const sent = JSON.parse(
        String((vi.mocked(fetchImpl).mock.calls[0]?.[1] as RequestInit).body),
      );
      expect(sent).toMatchObject({ max_completion_tokens: 64, top_p: 0.9 });
    });

    it('serves the same handler at /v1/completions', async () => {
      const base = await serve();
      const response = await call(base, '/v1/completions', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
    });

    it('returns 400 for a body that is not JSON', async () => {
      const base = await serve();
      const response = await call(base, '/v1/chat/completions', {
        method: 'POST',
        body: 'not json',
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { message: 'request body is not valid JSON' },
      });
    });

    it('returns 400 with field issues for an invalid request', async () => {
      const base = await serve();
      const response = await call(base, '/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ ...body, temperature: 9 }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: 'invalid_request', issues: [{ path: 'temperature' }] },
      });
    });

    it('returns 413 when the body exceeds the limit', async () => {
      const base = await serve({ server: { maxBodyBytes: 256 } });
      const response = await call(base, '/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ ...body, messages: [{ role: 'user', content: 'x'.repeat(500) }] }),
      });

      expect(response.status).toBe(413);
    });

    it('maps a provider rate limit to 429', async () => {
      const base = await serve({
        fetch: providerFetch({ error: { message: 'slow down' } }, 429),
      });
      const response = await call(base, '/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify(body),
      });

      expect(response.status).toBe(429);
      expect(await response.json()).toMatchObject({ error: { code: 'rate_limited' } });
    });

    it('maps a provider failure to 502, not 500', async () => {
      const base = await serve({ fetch: providerFetch({ error: { message: 'boom' } }, 500) });
      const response = await call(base, '/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify(body),
      });

      expect(response.status).toBe(502);
    });

    it('maps its own missing credentials to 502, since the caller cannot fix them', async () => {
      const base = await serve({ env: {} });
      const response = await call(base, '/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify(body),
      });

      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({ error: { code: 'authentication_error' } });
    });

    it('never echoes a provider credential in an error body', async () => {
      const base = await serve({
        env: { OPENAI_API_KEY: 'sk-supersecretvalue' },
        fetch: providerFetch({ error: { message: 'key sk-supersecretvalue rejected' } }, 401),
      });
      const response = await call(base, '/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify(body),
      });

      expect(await response.text()).not.toContain('sk-supersecretvalue');
    });
  });

  describe('streaming', () => {
    it('streams canonical events as SSE, terminated by [DONE]', async () => {
      const base = await serve();
      const response = await call(base, '/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ ...body, stream: true }),
      });

      expect(response.headers.get('content-type')).toBe('text/event-stream');

      const text = await response.text();
      const events = text
        .split('\n\n')
        .filter((block) => block.startsWith('data: '))
        .map((block) => block.slice(6));

      expect(events.at(-1)).toBe('[DONE]');
      expect(events.slice(0, -1).map((event) => JSON.parse(event))).toEqual([
        { type: 'text_delta', text: 'Bl' },
        { type: 'text_delta', text: 'ue' },
        { type: 'finish', finishReason: 'stop' },
      ]);
    });

    it('reports a pre-stream failure as a normal status, not a 200 stream', async () => {
      const base = await serve({ fetch: providerFetch({ error: { message: 'nope' } }, 500) });
      const response = await call(base, '/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ ...body, stream: true }),
      });

      expect(response.status).toBe(502);
      expect(response.headers.get('content-type')).toBe('application/json');
    });
  });

  describe('GET /v1/providers', () => {
    it('describes each adapter and whether it is configured', async () => {
      const base = await serve();
      const payload = (await (await call(base, '/v1/providers')).json()) as {
        providers: { id: string; configured: boolean; capabilities: string[] }[];
      };

      expect(payload.providers.map((entry) => entry.id)).toEqual([
        'openai',
        'azure',
        'bedrock',
        'vertex',
      ]);

      const openai = payload.providers.find((entry) => entry.id === 'openai');
      expect(openai?.configured).toBe(true);
      expect(openai?.capabilities).toContain('json_schema');
      expect(openai?.capabilities).not.toContain('top_k');

      expect(payload.providers.find((entry) => entry.id === 'bedrock')?.configured).toBe(false);
    });
  });

  describe('routing and headers', () => {
    it('returns 404 for an unknown path', async () => {
      const base = await serve();
      const response = await call(base, '/nope');

      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: 'not_found' } });
    });

    it('sets a request id on every response', async () => {
      const base = await serve();
      const response = await fetch(`${base}/health`);
      expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('sends CORS headers only when an origin is configured', async () => {
      const bare = await serve();
      expect((await fetch(`${bare}/health`)).headers.get('access-control-allow-origin')).toBeNull();
      await running?.close();

      const cors = await serve({ server: { corsOrigin: 'https://app.test' } });
      const response = await fetch(`${cors}/health`);
      expect(response.headers.get('access-control-allow-origin')).toBe('https://app.test');
    });

    it('answers a preflight request', async () => {
      const base = await serve({ server: { corsOrigin: '*' } });
      const response = await fetch(`${base}/v1/chat/completions`, { method: 'OPTIONS' });
      expect(response.status).toBe(204);
    });
  });

  describe('logging', () => {
    it('logs one structured line per request', async () => {
      const base = await serve();
      await fetch(`${base}/health`);

      expect(logs).toContainEqual(
        expect.objectContaining({ level: 'info', method: 'GET', path: '/health', status: 200 }),
      );
    });

    it('stays silent when told to', async () => {
      const base = await serve({ server: { logLevel: 'silent' } });
      await fetch(`${base}/health`);
      expect(logs).toEqual([]);
    });
  });

  describe('shutdown', () => {
    it('stops accepting connections after close', async () => {
      const base = await serve();
      await running?.close();
      running = undefined;

      await expect(fetch(`${base}/health`)).rejects.toThrow();
    });
  });
});
