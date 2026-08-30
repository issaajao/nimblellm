import { describe, expect, it, vi } from 'vitest';
import { buildUrl, createClient, NimbleClient, withProviderDefaults } from '../src/client.js';
import { loadConfig } from '../src/config/config.js';
import { normalizeRequest } from '../src/core/normalize.js';

const messages = [{ role: 'user', content: 'Why is the sky blue?' }];

const ENV = {
  openai: { OPENAI_API_KEY: 'sk-test' },
  azure: {
    AZURE_OPENAI_API_KEY: 'az-key',
    AZURE_OPENAI_ENDPOINT: 'https://my-resource.openai.azure.com',
  },
  bedrock: {
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE',
    AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI',
  },
  vertex: {
    GOOGLE_ACCESS_TOKEN: 'ya29.token',
    GOOGLE_CLOUD_PROJECT: 'my-project',
    VERTEX_LOCATION: 'us-central1',
  },
  anthropic: { ANTHROPIC_API_KEY: 'sk-ant-test' },
} as const;

const OPENAI_RESPONSE = {
  id: 'chatcmpl-1',
  created: 1_700_000_000,
  model: 'gpt-4o-2024-08-06',
  choices: [
    { message: { role: 'assistant', content: 'Rayleigh scattering.' }, finish_reason: 'stop' },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
};

/** A fetch stub that records calls and replies with a fixed JSON body. */
function jsonResponder(body: unknown = OPENAI_RESPONSE, status = 200) {
  const fetchImpl = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
  return fetchImpl as unknown as typeof globalThis.fetch;
}

function sseResponder(...events: unknown[]) {
  const encoder = new TextEncoder();
  const fetchImpl = vi.fn(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const event of events) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            }
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
  );
  return fetchImpl as unknown as typeof globalThis.fetch;
}

/** The single fetch call a test made, as URL plus parsed init. */
function callOf(fetchImpl: typeof globalThis.fetch): {
  url: URL;
  headers: Record<string, string>;
  body: Record<string, unknown>;
} {
  const [url, init] = vi.mocked(fetchImpl).mock.calls[0] as [URL, RequestInit];
  return {
    url,
    headers: init.headers as Record<string, string>,
    body: JSON.parse(String(init.body)),
  };
}

const client = (env: Record<string, string>, fetchImpl: typeof globalThis.fetch) =>
  new NimbleClient({ env, fetch: fetchImpl, sleep: async () => {} });

describe('NimbleClient', () => {
  it('reports which providers it can reach', () => {
    const instance = new NimbleClient({ env: { ...ENV.openai, ...ENV.bedrock } });
    expect(instance.configuredProviders()).toEqual(['openai', 'bedrock']);
  });

  it('reads configuration from the environment it is given, not the ambient one', () => {
    expect(new NimbleClient({ env: {} }).configuredProviders()).toEqual([]);
  });

  it('accepts explicit config overrides', () => {
    const instance = new NimbleClient({ env: ENV.openai, config: { maxRetries: 7 } });
    expect(instance.config.maxRetries).toBe(7);
  });

  it('createClient is equivalent to the constructor', () => {
    expect(createClient({ env: ENV.openai }).configuredProviders()).toEqual(['openai']);
  });

  describe('complete', () => {
    it('sends an authenticated OpenAI request and normalizes the reply', async () => {
      const fetchImpl = jsonResponder();
      const response = await client(ENV.openai, fetchImpl).complete({
        model: 'openai/gpt-4o',
        messages,
        max_tokens: 128,
      });

      const call = callOf(fetchImpl);
      expect(call.url.toString()).toBe('https://api.openai.com/v1/chat/completions');
      expect(call.headers['authorization']).toBe('Bearer sk-test');
      expect(call.headers['user-agent']).toMatch(/^nimblellm\//);
      expect(call.body).toMatchObject({ model: 'gpt-4o', max_completion_tokens: 128 });

      expect(response).toMatchObject({
        provider: 'openai',
        finishReason: 'stop',
        message: { content: [{ type: 'text', text: 'Rayleigh scattering.' }] },
        usage: { totalTokens: 14 },
      });
    });

    it('addresses an Azure deployment and supplies the configured api version', async () => {
      const fetchImpl = jsonResponder();
      await client(ENV.azure, fetchImpl).complete({ model: 'azure/my-deployment', messages });

      const call = callOf(fetchImpl);
      expect(call.url.origin).toBe('https://my-resource.openai.azure.com');
      expect(call.url.pathname).toBe('/openai/deployments/my-deployment/chat/completions');
      expect(call.url.searchParams.get('api-version')).toBe('2024-10-21');
      expect(call.headers['api-key']).toBe('az-key');
      expect(call.body['model']).toBeUndefined();
    });

    it('lets a per-request api version override the configured one', async () => {
      const fetchImpl = jsonResponder();
      await client(ENV.azure, fetchImpl).complete({
        model: 'azure/my-deployment',
        messages,
        providerOptions: { azure: { apiVersion: '2025-01-01-preview' } },
      });

      expect(callOf(fetchImpl).url.searchParams.get('api-version')).toBe('2025-01-01-preview');
    });

    it('signs a Bedrock request and builds the Converse body', async () => {
      const fetchImpl = jsonResponder({
        output: { message: { content: [{ text: 'Rayleigh scattering.' }] } },
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
      });

      const response = await client(ENV.bedrock, fetchImpl).complete({
        model: 'bedrock/anthropic.claude-sonnet-4-20250514-v1:0',
        messages,
      });

      const call = callOf(fetchImpl);
      expect(call.url.origin).toBe('https://bedrock-runtime.us-east-1.amazonaws.com');
      expect(call.url.pathname).toBe('/model/anthropic.claude-sonnet-4-20250514-v1%3A0/converse');
      expect(call.headers['authorization']).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/);
      expect(call.body).toHaveProperty('messages');

      expect(response.provider).toBe('bedrock');
      expect(response.usage.totalTokens).toBe(14);
    });

    it('qualifies a Vertex path with the configured project and location', async () => {
      const fetchImpl = jsonResponder({
        candidates: [{ content: { parts: [{ text: 'Rayleigh.' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 2, totalTokenCount: 10 },
      });

      const response = await client(ENV.vertex, fetchImpl).complete({
        model: 'vertex/gemini-2.0-flash',
        messages,
      });

      const call = callOf(fetchImpl);
      expect(call.url.origin).toBe('https://us-central1-aiplatform.googleapis.com');
      expect(call.url.pathname).toBe(
        '/v1/projects/my-project/locations/us-central1/publishers/google/models/gemini-2.0-flash:generateContent',
      );
      expect(call.headers['authorization']).toBe('Bearer ya29.token');
      expect(call.body).toHaveProperty('contents');

      expect(response.message.content).toEqual([{ type: 'text', text: 'Rayleigh.' }]);
    });

    it('authenticates Anthropic with x-api-key and a pinned version header', async () => {
      const fetchImpl = jsonResponder({
        id: 'msg_1',
        model: 'claude-sonnet-4-5-20250929',
        content: [{ type: 'text', text: 'Rayleigh scattering.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 4 },
      });

      const response = await client(ENV.anthropic, fetchImpl).complete({
        model: 'anthropic/claude-sonnet-4-5-20250929',
        messages,
      });

      const call = callOf(fetchImpl);
      expect(call.url.toString()).toBe('https://api.anthropic.com/v1/messages');
      // Not a bearer token, which is what makes this provider's auth distinct.
      expect(call.headers['x-api-key']).toBe('sk-ant-test');
      expect(call.headers['authorization']).toBeUndefined();
      expect(call.headers['anthropic-version']).toBe('2023-06-01');
      // Required by the API and absent from the request, so the adapter fills it in.
      expect(call.body).toMatchObject({ model: 'claude-sonnet-4-5-20250929', max_tokens: 4096 });

      expect(response).toMatchObject({
        provider: 'anthropic',
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
      });
    });

    it.each([
      [401, 'authentication_error', false],
      [429, 'rate_limited', true],
      // Anthropic's own code for "overloaded", which is a 5xx and so retryable.
      [529, 'provider_error', true],
    ])(
      'classifies an Anthropic %i into the canonical taxonomy',
      async (status, code, retryable) => {
        const fetchImpl = jsonResponder(
          { type: 'error', error: { type: 'x', message: 'upstream said no' } },
          status,
        );

        await expect(
          client(ENV.anthropic, fetchImpl).complete({
            model: 'anthropic/claude-sonnet-4-5-20250929',
            messages,
          }),
        ).rejects.toThrowError(
          expect.objectContaining({
            code,
            retryable,
            message: expect.stringContaining('upstream said no'),
          }),
        );
      },
    );

    it('keeps the injected project and location out of the request body', async () => {
      const fetchImpl = jsonResponder({
        candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'STOP' }],
      });
      await client(ENV.vertex, fetchImpl).complete({ model: 'vertex/gemini-2.0-flash', messages });

      const { body } = callOf(fetchImpl);
      expect(body['project']).toBeUndefined();
      expect(body['location']).toBeUndefined();
    });

    it('uses the configured default provider for an unprefixed model', async () => {
      const fetchImpl = jsonResponder();
      await client({ ...ENV.openai, NIMBLE_DEFAULT_PROVIDER: 'openai' }, fetchImpl).complete({
        model: 'gpt-4o',
        messages,
      });

      expect(callOf(fetchImpl).body['model']).toBe('gpt-4o');
    });

    it('rejects a request for a provider it has no credentials for', async () => {
      await expect(
        client(ENV.openai, jsonResponder()).complete({
          model: 'vertex/gemini-2.0-flash',
          messages,
        }),
      ).rejects.toMatchObject({ code: 'authentication_error', provider: 'vertex' });
    });

    it('rejects an invalid request before it reaches the network', async () => {
      const fetchImpl = jsonResponder();
      await expect(
        client(ENV.openai, fetchImpl).complete({
          model: 'openai/gpt-4o',
          messages,
          temperature: 9,
        }),
      ).rejects.toMatchObject({ code: 'invalid_request' });

      expect(vi.mocked(fetchImpl)).not.toHaveBeenCalled();
    });

    it('rejects an unsupported feature before it reaches the network', async () => {
      const fetchImpl = jsonResponder();
      await expect(
        client(ENV.bedrock, fetchImpl).complete({
          model: 'bedrock/anthropic.claude-sonnet-4-20250514-v1:0',
          messages,
          seed: 1,
        }),
      ).rejects.toMatchObject({ code: 'unsupported_feature' });

      expect(vi.mocked(fetchImpl)).not.toHaveBeenCalled();
    });

    it('surfaces a provider error with its status and message', async () => {
      const fetchImpl = jsonResponder({ error: { message: 'Rate limit reached' } }, 429);

      await expect(
        client(ENV.openai, fetchImpl).complete(
          { model: 'openai/gpt-4o', messages },
          { maxRetries: 0 },
        ),
      ).rejects.toMatchObject({ code: 'rate_limited', status: 429, retryable: true });
    });

    it('reports a non-JSON success body as a provider error', async () => {
      const fetchImpl = vi.fn(
        async () => new Response('not json', { status: 200 }),
      ) as unknown as typeof globalThis.fetch;

      await expect(
        client(ENV.openai, fetchImpl).complete({ model: 'openai/gpt-4o', messages }),
      ).rejects.toThrowError(/not JSON/);
    });

    it('honours a per-call retry override', async () => {
      let calls = 0;
      const fetchImpl = vi.fn(async () => {
        calls += 1;
        return calls < 3
          ? new Response('{}', { status: 503 })
          : new Response(JSON.stringify(OPENAI_RESPONSE), { status: 200 });
      }) as unknown as typeof globalThis.fetch;

      await client(ENV.openai, fetchImpl).complete(
        { model: 'openai/gpt-4o', messages },
        { maxRetries: 2 },
      );

      expect(calls).toBe(3);
    });
  });

  describe('stream', () => {
    it('sets stream on the request and asks for SSE', async () => {
      const fetchImpl = sseResponder({ choices: [{ delta: { content: 'a' } }] });
      const events = [];
      for await (const event of client(ENV.openai, fetchImpl).stream({
        model: 'openai/gpt-4o',
        messages,
      })) {
        events.push(event);
      }

      const call = callOf(fetchImpl);
      expect(call.body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
      expect(call.headers['accept']).toBe('text/event-stream');
      expect(events).toEqual([{ type: 'text_delta', text: 'a' }]);
    });

    it('yields canonical events in arrival order', async () => {
      const fetchImpl = sseResponder(
        { choices: [{ delta: { content: 'Ray' } }] },
        { choices: [{ delta: { content: 'leigh' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } },
      );

      const events = [];
      for await (const event of client(ENV.openai, fetchImpl).stream({
        model: 'openai/gpt-4o',
        messages,
      })) {
        events.push(event);
      }

      expect(events).toEqual([
        { type: 'text_delta', text: 'Ray' },
        { type: 'text_delta', text: 'leigh' },
        { type: 'finish', finishReason: 'stop' },
        { type: 'usage', usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 } },
      ]);
    });

    it('stitches Anthropic usage together across message_start and message_delta', async () => {
      // Input tokens are reported once, at the start; output tokens only at the
      // end. Neither event alone can produce a complete usage figure.
      const fetchImpl = sseResponder(
        {
          type: 'message_start',
          message: { id: 'msg_1', usage: { input_tokens: 8, output_tokens: 1 } },
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Ray' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'leigh' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
        { type: 'message_stop' },
      );

      const events = [];
      for await (const event of client(ENV.anthropic, fetchImpl).stream({
        model: 'anthropic/claude-sonnet-4-5-20250929',
        messages,
      })) {
        events.push(event);
      }

      expect(callOf(fetchImpl).body).toMatchObject({ stream: true });
      expect(callOf(fetchImpl).headers['accept']).toBe('text/event-stream');
      expect(events).toEqual([
        { type: 'text_delta', text: 'Ray' },
        { type: 'text_delta', text: 'leigh' },
        { type: 'usage', usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 } },
        { type: 'finish', finishReason: 'stop' },
      ]);
    });

    it('routes Bedrock streaming to converse-stream and does not ask for SSE', async () => {
      const fetchImpl = vi.fn(
        async () => new Response(new ReadableStream({ start: (c) => c.close() }), { status: 200 }),
      ) as unknown as typeof globalThis.fetch;

      const events = [];
      for await (const event of client(ENV.bedrock, fetchImpl).stream({
        model: 'bedrock/anthropic.claude-sonnet-4-20250514-v1:0',
        messages,
      })) {
        events.push(event);
      }

      const call = callOf(fetchImpl);
      expect(call.url.pathname).toMatch(/\/converse-stream$/);
      expect(call.headers['accept']).toBeUndefined();
      expect(events).toEqual([]);
    });

    it('asks Vertex for SSE on the streaming endpoint', async () => {
      const fetchImpl = sseResponder({
        candidates: [{ content: { parts: [{ text: 'a' }] } }],
      });

      const events = [];
      for await (const event of client(ENV.vertex, fetchImpl).stream({
        model: 'vertex/gemini-2.0-flash',
        messages,
      })) {
        events.push(event);
      }

      const call = callOf(fetchImpl);
      expect(call.url.pathname).toMatch(/:streamGenerateContent$/);
      expect(call.url.searchParams.get('alt')).toBe('sse');
      expect(events).toEqual([{ type: 'text_delta', text: 'a' }]);
    });

    it('reports an empty stream body', async () => {
      const fetchImpl = vi.fn(
        async () => new Response(null, { status: 200 }),
      ) as unknown as typeof globalThis.fetch;

      const iterator = client(ENV.openai, fetchImpl).stream({ model: 'openai/gpt-4o', messages });
      await expect(iterator.next()).rejects.toThrowError(/empty stream/);
    });
  });
});

describe('buildUrl', () => {
  it('joins a base and a relative path', () => {
    expect(buildUrl('https://api.test', 'v1/chat', undefined).toString()).toBe(
      'https://api.test/v1/chat',
    );
  });

  it('tolerates stray slashes on either side', () => {
    expect(buildUrl('https://api.test/', '/v1/chat', undefined).toString()).toBe(
      'https://api.test/v1/chat',
    );
  });

  it('appends query parameters', () => {
    expect(
      buildUrl('https://api.test', 'v1/chat', { 'api-version': '2024-10-21' }).toString(),
    ).toBe('https://api.test/v1/chat?api-version=2024-10-21');
  });
});

describe('withProviderDefaults', () => {
  const config = loadConfig({ ...ENV.azure, ...ENV.vertex });

  it('fills in the Azure api version', () => {
    const request = normalizeRequest({ model: 'azure/dep', messages });
    expect(withProviderDefaults(request, config).providerOptions?.azure).toEqual({
      apiVersion: '2024-10-21',
    });
  });

  it('fills in the Vertex project and location', () => {
    const request = normalizeRequest({ model: 'vertex/gemini-2.0-flash', messages });
    expect(withProviderDefaults(request, config).providerOptions?.vertex).toEqual({
      project: 'my-project',
      location: 'us-central1',
    });
  });

  it('leaves an explicit value alone', () => {
    const request = normalizeRequest({
      model: 'vertex/gemini-2.0-flash',
      messages,
      providerOptions: { vertex: { project: 'other', location: 'europe-west4' } },
    });
    expect(withProviderDefaults(request, config).providerOptions?.vertex).toEqual({
      project: 'other',
      location: 'europe-west4',
    });
  });

  it('fills in only the half that is missing', () => {
    const request = normalizeRequest({
      model: 'vertex/gemini-2.0-flash',
      messages,
      providerOptions: { vertex: { project: 'other' } },
    });
    expect(withProviderDefaults(request, config).providerOptions?.vertex).toEqual({
      project: 'other',
      location: 'us-central1',
    });
  });

  it('leaves other providers untouched', () => {
    const request = normalizeRequest({ model: 'openai/gpt-4o', messages });
    expect(withProviderDefaults(request, config)).toBe(request);
  });

  it('does nothing when the provider is not configured', () => {
    const request = normalizeRequest({ model: 'azure/dep', messages });
    expect(withProviderDefaults(request, loadConfig({}))).toBe(request);
  });
});
