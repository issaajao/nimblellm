import { describe, expect, it } from 'vitest';
import { NimbleError } from '../src/errors.js';
import { createRouter, Router } from '../src/router.js';
import type { Capability, ProviderAdapter } from '../src/providers/adapter.js';
import { openaiAdapter } from '../src/providers/openai.js';
import { requiredCapabilities } from '../src/providers/capabilities.js';
import { PNG_BASE64, req, weatherTool } from './helpers.js';

const router = new Router();

describe('Router', () => {
  describe('adapter selection', () => {
    it.each([
      ['openai/gpt-4o', 'openai'],
      ['azure/my-deployment', 'azure'],
      ['bedrock/anthropic.claude-sonnet-4-20250514-v1:0', 'bedrock'],
      ['vertex/gemini-2.0-flash', 'vertex'],
    ])('routes %s to the %s adapter', (model, provider) => {
      const routed = router.route(req({ model }));
      expect(routed.provider).toBe(provider);
      expect(routed.adapter.id).toBe(provider);
    });

    it('registers all four built-in providers', () => {
      expect(router.providers()).toEqual(['openai', 'azure', 'bedrock', 'vertex']);
    });

    it('reports an unregistered provider', () => {
      const empty = new Router({ adapters: [] });
      expect(() => empty.route(req({}))).toThrowError(
        expect.objectContaining({ code: 'unknown_provider' }),
      );
      expect(() => empty.route(req({}))).toThrowError(/Registered: none/);
    });

    it('lets a later registration replace an earlier one', () => {
      const stub: ProviderAdapter = {
        ...openaiAdapter,
        describeRoute: () => ({ method: 'POST', path: 'custom/path' }),
        supports: (c: Capability) => openaiAdapter.supports(c),
        buildPayload: () => ({ custom: true }),
        parseResponse: openaiAdapter.parseResponse.bind(openaiAdapter),
      };

      const custom = new Router().register(stub);
      expect(custom.route(req({})).route.path).toBe('custom/path');
      expect(custom.providers()).toEqual(['openai', 'azure', 'bedrock', 'vertex']);
    });

    it('exposes capability lookup without building a request', () => {
      expect(router.supports('vertex', 'top_k')).toBe(true);
      expect(router.supports('openai', 'top_k')).toBe(false);
    });
  });

  describe('route()', () => {
    it('returns everything needed to make the call', () => {
      const routed = router.route(req({ model: 'openai/gpt-4o', max_tokens: 64 }));

      expect(routed.route).toEqual({
        method: 'POST',
        path: 'v1/chat/completions',
        headers: { 'content-type': 'application/json' },
      });
      expect(routed.payload).toMatchObject({ model: 'gpt-4o', max_completion_tokens: 64 });
    });

    it('builds a provider-specific body for the same canonical request', () => {
      const input = { messages: [{ role: 'user', content: 'hi' }], max_tokens: 64 };

      expect(router.route(req({ ...input, model: 'openai/gpt-4o' })).payload).toHaveProperty(
        'max_completion_tokens',
      );
      expect(
        router.route(req({ ...input, model: 'bedrock/anthropic.claude-sonnet-4-20250514-v1:0' }))
          .payload,
      ).toHaveProperty('inferenceConfig.maxTokens');
      expect(
        router.route(req({ ...input, model: 'vertex/gemini-2.0-flash' })).payload,
      ).toHaveProperty('generationConfig.maxOutputTokens');
    });
  });

  describe('capability enforcement', () => {
    it('rejects JSON schema output on Bedrock, with a hint', () => {
      try {
        router.route(
          req({
            model: 'bedrock/anthropic.claude-sonnet-4-20250514-v1:0',
            response_format: { type: 'json_schema', name: 'X', schema: { type: 'object' } },
          }),
        );
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(NimbleError);
        expect((error as NimbleError).code).toBe('unsupported_feature');
        expect((error as NimbleError).provider).toBe('bedrock');
        expect((error as NimbleError).issues).toEqual([
          { path: 'responseFormat', message: 'not supported by bedrock' },
        ]);
        expect((error as NimbleError).message).toMatch(/tool definition instead/);
      }
    });

    it('rejects topK on OpenAI', () => {
      expect(() => router.route(req({ top_k: 40 }))).toThrowError(/openai does not support: top_k/);
    });

    it('rejects a URL image on Bedrock and suggests inlining it', () => {
      expect(() =>
        router.route(
          req({
            model: 'bedrock/anthropic.claude-sonnet-4-20250514-v1:0',
            messages: [{ role: 'user', content: [{ type: 'image', url: 'https://e.test/a.png' }] }],
          }),
        ),
      ).toThrowError(/inline base64/);
    });

    it('accepts an inline image on Bedrock', () => {
      expect(() =>
        router.route(
          req({
            model: 'bedrock/anthropic.claude-sonnet-4-20250514-v1:0',
            messages: [
              {
                role: 'user',
                content: [{ type: 'image', data: PNG_BASE64, mediaType: 'image/png' }],
              },
            ],
          }),
        ),
      ).not.toThrow();
    });

    it('lists every unsupported feature at once', () => {
      try {
        router.route(
          req({
            model: 'bedrock/anthropic.claude-sonnet-4-20250514-v1:0',
            seed: 1,
            frequency_penalty: 0.5,
            response_format: 'json_object',
          }),
        );
        expect.unreachable('should have thrown');
      } catch (error) {
        expect((error as NimbleError).issues.map((i) => i.path).sort()).toEqual([
          'frequencyPenalty',
          'responseFormat',
          'seed',
        ]);
      }
    });
  });

  describe('range enforcement', () => {
    it('accepts temperature 1.4 on OpenAI and rejects it on Bedrock', () => {
      expect(() => router.route(req({ temperature: 1.4 }))).not.toThrow();

      expect(() =>
        router.route(
          req({ model: 'bedrock/anthropic.claude-sonnet-4-20250514-v1:0', temperature: 1.4 }),
        ),
      ).toThrowError(expect.objectContaining({ code: 'invalid_request' }));
    });

    it('says values are passed through rather than rescaled', () => {
      expect(() =>
        router.route(
          req({ model: 'bedrock/anthropic.claude-sonnet-4-20250514-v1:0', temperature: 1.4 }),
        ),
      ).toThrowError(/passed through rather than rescaled/);
    });

    it('caps stop sequences per provider', () => {
      const stop = ['a', 'b', 'c', 'd', 'e'];
      expect(() => router.route(req({ stop }))).toThrowError(/at most 4 stop sequences/);
      expect(() => router.route(req({ model: 'vertex/gemini-2.0-flash', stop }))).not.toThrow();
    });

    it('leaves stop sequences uncapped on Bedrock, where the limit is model-specific', () => {
      expect(() =>
        router.route(
          req({
            model: 'bedrock/anthropic.claude-sonnet-4-20250514-v1:0',
            stop: ['a', 'b', 'c', 'd', 'e', 'f'],
          }),
        ),
      ).not.toThrow();
    });

    it('reports the unsupported feature before complaining about a range', () => {
      const error = (() => {
        try {
          router.route(
            req({
              model: 'bedrock/anthropic.claude-sonnet-4-20250514-v1:0',
              seed: 1,
              temperature: 1.9,
            }),
          );
          return undefined;
        } catch (e) {
          return e as NimbleError;
        }
      })();

      expect(error?.code).toBe('unsupported_feature');
    });
  });

  describe('candidatesFor', () => {
    it('lists every provider for a plain request', () => {
      expect(router.candidatesFor(req({}))).toEqual(['openai', 'azure', 'bedrock', 'vertex']);
    });

    it('excludes providers that cannot express the request', () => {
      expect(router.candidatesFor(req({ seed: 42 }))).toEqual(['openai', 'azure', 'vertex']);
      expect(router.candidatesFor(req({ top_k: 40 }))).toEqual(['vertex']);
    });

    it('excludes providers whose ranges the request exceeds', () => {
      expect(router.candidatesFor(req({ temperature: 1.5 }))).toEqual([
        'openai',
        'azure',
        'vertex',
      ]);
    });

    it('returns nothing when no provider can serve the request', () => {
      expect(
        router.candidatesFor(req({ top_k: 40, temperature: 1.5, seed: 1, metadata: { a: 'b' } })),
      ).toEqual([]);
    });
  });

  it('createRouter is equivalent to the constructor', () => {
    expect(createRouter().providers()).toEqual(new Router().providers());
  });
});

describe('requiredCapabilities', () => {
  it('reports nothing for a plain text request', () => {
    expect(requiredCapabilities(req({}))).toEqual([]);
  });

  it('reports each feature the request exercises', () => {
    const capabilities = requiredCapabilities(
      req({
        stream: true,
        tools: [weatherTool],
        tool_choice: 'required',
        seed: 1,
        stop: ['END'],
        metadata: { tenant: 'acme' },
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', url: 'https://e.test/a.png' },
              { type: 'image', data: PNG_BASE64, mediaType: 'image/png' },
            ],
          },
        ],
      }),
    );

    expect([...capabilities].sort()).toEqual([
      'image_base64',
      'image_url',
      'metadata',
      'seed',
      'stop_sequences',
      'streaming',
      'tool_choice_required',
      'tools',
    ]);
  });

  it('does not report streaming when stream is explicitly false', () => {
    expect(requiredCapabilities(req({ stream: false }))).toEqual([]);
  });
});
