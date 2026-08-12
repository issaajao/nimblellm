import { describe, expect, it } from 'vitest';
import { azureAdapter, DEFAULT_AZURE_API_VERSION } from '../../src/providers/azure.js';
import { req, weatherTool } from '../helpers.js';

const azure = (input: Record<string, unknown> = {}) =>
  req({ model: 'azure/my-gpt4o-deployment', ...input });

describe('AzureOpenAIAdapter', () => {
  it('declares its id and ranges', () => {
    expect(azureAdapter.id).toBe('azure');
    expect(azureAdapter.limits.temperature).toEqual({ min: 0, max: 2 });
  });

  it('matches OpenAI’s capabilities', () => {
    expect(azureAdapter.supports('json_schema')).toBe(true);
    expect(azureAdapter.supports('top_k')).toBe(false);
  });

  describe('describeRoute', () => {
    it('puts the deployment in the path and the api version in the query', () => {
      expect(azureAdapter.describeRoute(azure())).toEqual({
        method: 'POST',
        path: 'openai/deployments/my-gpt4o-deployment/chat/completions',
        query: { 'api-version': DEFAULT_AZURE_API_VERSION },
        headers: { 'content-type': 'application/json' },
      });
    });

    it('lets providerOptions override the api version', () => {
      const route = azureAdapter.describeRoute(
        azure({ providerOptions: { azure: { apiVersion: '2025-01-01-preview' } } }),
      );
      expect(route.query).toEqual({ 'api-version': '2025-01-01-preview' });
    });

    it('escapes a deployment name with URL-unsafe characters', () => {
      const route = azureAdapter.describeRoute(req({ model: 'azure/my deployment' }));
      expect(route.path).toBe('openai/deployments/my%20deployment/chat/completions');
    });
  });

  describe('buildPayload', () => {
    it('omits the model, because the deployment is addressed in the URL', () => {
      expect(azureAdapter.buildPayload(azure()).model).toBeUndefined();
    });

    it('otherwise builds the same body as OpenAI', () => {
      const payload = azureAdapter.buildPayload(
        azure({ system: 'Be concise.', max_tokens: 64, tools: [weatherTool] }),
      );

      expect(payload.messages).toEqual([
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'hello' },
      ]);
      expect(payload.max_completion_tokens).toBe(64);
      expect(payload.tools?.[0]).toMatchObject({ type: 'function' });
    });

    it('keeps apiVersion out of the request body', () => {
      const payload = azureAdapter.buildPayload(
        azure({ providerOptions: { azure: { apiVersion: '2025-01-01-preview', user: 'u-1' } } }),
      );
      expect(payload['apiVersion']).toBeUndefined();
      expect(payload['user']).toBe('u-1');
    });

    it('merges nothing when the block held only routing keys', () => {
      const payload = azureAdapter.buildPayload(
        azure({ providerOptions: { azure: { apiVersion: '2025-01-01-preview' } } }),
      );
      expect(Object.keys(payload)).toEqual(['messages']);
    });
  });

  it('parses responses with the shared Chat Completions reader', () => {
    const response = azureAdapter.parseResponse(
      {
        id: 'chatcmpl-az',
        model: 'gpt-4o',
        choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
      },
      azure(),
    );

    expect(response.provider).toBe('azure');
    expect(response.message.content).toEqual([{ type: 'text', text: 'hi' }]);
    expect(response.usage.totalTokens).toBe(5);
  });

  it('falls back to the deployment name when the response omits the model', () => {
    const response = azureAdapter.parseResponse(
      { choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] },
      azure(),
    );
    expect(response.model).toBe('my-gpt4o-deployment');
  });

  it('parses stream chunks with the shared reader', () => {
    expect(azureAdapter.parseStreamChunk({ choices: [{ delta: { content: 'a' } }] })).toEqual([
      { type: 'text_delta', text: 'a' },
    ]);
  });
});
