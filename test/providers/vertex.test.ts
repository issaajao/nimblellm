import { describe, expect, it } from 'vitest';
import { vertexAdapter } from '../../src/providers/vertex.js';
import type { GeminiPayload } from '../../src/providers/vertex.js';
import { PNG_BASE64, req, toolConversation, weatherTool } from '../helpers.js';

const vertex = (input: Record<string, unknown> = {}) =>
  req({ model: 'vertex/gemini-2.0-flash', ...input });
const build = (input: Record<string, unknown> = {}): GeminiPayload =>
  vertexAdapter.buildPayload(vertex(input));

describe('VertexAdapter', () => {
  it('declares its id and ranges', () => {
    expect(vertexAdapter.id).toBe('vertex');
    expect(vertexAdapter.limits.temperature).toEqual({ min: 0, max: 2 });
    expect(vertexAdapter.limits.maxStopSequences).toBe(5);
  });

  it('is the only adapter that offers topK', () => {
    expect(vertexAdapter.supports('top_k')).toBe(true);
    expect(vertexAdapter.supports('json_schema')).toBe(true);
    expect(vertexAdapter.supports('metadata')).toBe(false);
  });

  describe('describeRoute', () => {
    it('builds a relative resource path when project and location are unknown', () => {
      expect(vertexAdapter.describeRoute(vertex())).toEqual({
        method: 'POST',
        path: 'publishers/google/models/gemini-2.0-flash:generateContent',
        headers: { 'content-type': 'application/json' },
      });
    });

    it('qualifies the path when project and location are supplied', () => {
      const route = vertexAdapter.describeRoute(
        vertex({ providerOptions: { vertex: { project: 'p-1', location: 'us-central1' } } }),
      );
      expect(route.path).toBe(
        'v1/projects/p-1/locations/us-central1/publishers/google/models/gemini-2.0-flash:generateContent',
      );
    });

    it('leaves an already-qualified model id alone', () => {
      const route = vertexAdapter.describeRoute(
        req({ model: 'vertex/publishers/meta/models/llama-3.3-70b-instruct-maas' }),
      );
      expect(route.path).toBe('publishers/meta/models/llama-3.3-70b-instruct-maas:generateContent');
    });

    it('asks for SSE when streaming', () => {
      const route = vertexAdapter.describeRoute(vertex({ stream: true }));
      expect(route.path).toMatch(/:streamGenerateContent$/);
      expect(route.query).toEqual({ alt: 'sse' });
    });
  });

  describe('buildPayload', () => {
    it('carries the system prompt as systemInstruction', () => {
      expect(build({ system: 'Be concise.' }).systemInstruction).toEqual({
        parts: [{ text: 'Be concise.' }],
      });
    });

    it('renames the assistant role to model', () => {
      const payload = build({
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' },
          { role: 'user', content: 'bye' },
        ],
      });

      expect(payload.contents.map((c) => c.role)).toEqual(['user', 'model', 'user']);
    });

    it('merges consecutive turns that map to the same role', () => {
      const payload = build({
        messages: [
          { role: 'user', content: 'first' },
          { role: 'user', content: 'second' },
        ],
      });
      expect(payload.contents).toEqual([
        { role: 'user', parts: [{ text: 'first' }, { text: 'second' }] },
      ]);
    });

    it('resolves a tool result back to the function name that was called', () => {
      const payload = build({ messages: [...toolConversation], tools: [weatherTool] });

      expect(payload.contents[1]).toEqual({
        role: 'model',
        parts: [{ functionCall: { name: 'get_weather', args: { city: 'Lagos' } } }],
      });
      expect(payload.contents[2]).toEqual({
        role: 'user',
        parts: [{ functionResponse: { name: 'get_weather', response: { tempC: 31 } } }],
      });
    });

    it('wraps a non-JSON tool result so the model still receives the text', () => {
      const payload = build({
        messages: [
          ...toolConversation.slice(0, 2),
          { role: 'tool', tool_call_id: 'call_1', content: 'sunny, 31C' },
        ],
      });

      expect(payload.contents[2]?.parts[0]).toEqual({
        functionResponse: { name: 'get_weather', response: { content: 'sunny, 31C' } },
      });
    });

    it('groups generation parameters, including the topK no other provider takes', () => {
      const payload = build({
        max_tokens: 256,
        temperature: 0.7,
        top_p: 0.9,
        top_k: 40,
        frequency_penalty: 0.2,
        presence_penalty: 0.1,
        stop: ['END'],
        seed: 42,
      });

      expect(payload.generationConfig).toEqual({
        maxOutputTokens: 256,
        temperature: 0.7,
        topP: 0.9,
        topK: 40,
        frequencyPenalty: 0.2,
        presencePenalty: 0.1,
        stopSequences: ['END'],
        seed: 42,
      });
    });

    it('omits generationConfig entirely when no parameters were set', () => {
      expect(build().generationConfig).toBeUndefined();
    });

    it('asks for JSON output by media type', () => {
      expect(build({ response_format: 'json_object' }).generationConfig).toEqual({
        responseMimeType: 'application/json',
      });
    });

    it('passes a JSON schema through as responseSchema', () => {
      const payload = build({
        response_format: { type: 'json_schema', name: 'Invoice', schema: { type: 'object' } },
      });
      expect(payload.generationConfig).toEqual({
        responseMimeType: 'application/json',
        responseSchema: { type: 'object' },
      });
    });

    it('declares tools in a functionDeclarations block', () => {
      expect(build({ tools: [weatherTool] }).tools).toEqual([
        {
          functionDeclarations: [
            {
              name: 'get_weather',
              description: 'Look up the weather',
              parameters: { type: 'object', properties: { city: { type: 'string' } } },
            },
          ],
        },
      ]);
    });

    it.each([
      ['auto', { mode: 'AUTO' }],
      ['none', { mode: 'NONE' }],
      ['required', { mode: 'ANY' }],
    ])('maps toolChoice %s onto a function calling mode', (choice, expected) => {
      expect(build({ tools: [weatherTool], tool_choice: choice }).toolConfig).toEqual({
        functionCallingConfig: expected,
      });
    });

    it('restricts the allowed function when a tool is forced', () => {
      const payload = build({
        tools: [weatherTool],
        tool_choice: { type: 'tool', name: 'get_weather' },
      });
      expect(payload.toolConfig).toEqual({
        functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['get_weather'] },
      });
    });

    it('sends inline image bytes as inlineData', () => {
      const payload = build({
        messages: [
          { role: 'user', content: [{ type: 'image', data: PNG_BASE64, mediaType: 'image/png' }] },
        ],
      });
      expect(payload.contents[0]?.parts[0]).toEqual({
        inlineData: { mimeType: 'image/png', data: PNG_BASE64 },
      });
    });

    it('infers a media type for a URL image from its extension', () => {
      const payload = build({
        messages: [{ role: 'user', content: [{ type: 'image', url: 'gs://bucket/a.JPG' }] }],
      });
      expect(payload.contents[0]?.parts[0]).toEqual({
        fileData: { mimeType: 'image/jpeg', fileUri: 'gs://bucket/a.JPG' },
      });
    });

    it('rejects a URL image whose media type cannot be inferred', () => {
      expect(() =>
        build({
          messages: [{ role: 'user', content: [{ type: 'image', url: 'https://e.test/image' }] }],
        }),
      ).toThrowError(/no recognizable image extension/);
    });

    it('keeps project and location out of the request body', () => {
      const payload = build({
        providerOptions: {
          vertex: { project: 'p-1', location: 'us-central1', labels: { team: 'core' } },
        },
      });
      expect(payload['project']).toBeUndefined();
      expect(payload['location']).toBeUndefined();
      expect(payload['labels']).toEqual({ team: 'core' });
    });
  });

  describe('parseResponse', () => {
    const raw = {
      responseId: 'resp-1',
      modelVersion: 'gemini-2.0-flash-001',
      candidates: [{ content: { role: 'model', parts: [{ text: 'blue' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 },
    };

    it('normalizes a text completion', () => {
      expect(vertexAdapter.parseResponse(raw, vertex())).toMatchObject({
        id: 'resp-1',
        provider: 'vertex',
        model: 'gemini-2.0-flash-001',
        finishReason: 'stop',
        message: { role: 'assistant', content: [{ type: 'text', text: 'blue' }] },
        usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
      });
    });

    it('synthesizes positional ids for the calls Gemini leaves unidentified', () => {
      const response = vertexAdapter.parseResponse(
        {
          ...raw,
          candidates: [
            {
              content: {
                parts: [
                  { functionCall: { name: 'get_weather', args: { city: 'Lagos' } } },
                  { functionCall: { name: 'get_time', args: {} } },
                ],
              },
              finishReason: 'STOP',
            },
          ],
        },
        vertex(),
      );

      expect(response.message.toolCalls).toEqual([
        { id: 'call_0', name: 'get_weather', arguments: { city: 'Lagos' } },
        { id: 'call_1', name: 'get_time', arguments: {} },
      ]);
    });

    it('reports tool_calls even though Gemini says STOP', () => {
      const response = vertexAdapter.parseResponse(
        {
          ...raw,
          candidates: [
            {
              content: { parts: [{ functionCall: { name: 'ping', args: {} } }] },
              finishReason: 'STOP',
            },
          ],
        },
        vertex(),
      );
      expect(response.finishReason).toBe('tool_calls');
    });

    it.each([
      ['STOP', 'stop'],
      ['MAX_TOKENS', 'length'],
      ['SAFETY', 'content_filter'],
      ['RECITATION', 'content_filter'],
      ['PROHIBITED_CONTENT', 'content_filter'],
      ['MALFORMED_FUNCTION_CALL', 'unknown'],
    ])('maps finishReason %s to %s', (wire, canonical) => {
      const response = vertexAdapter.parseResponse(
        { ...raw, candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: wire }] },
        vertex(),
      );
      expect(response.finishReason).toBe(canonical);
    });

    it('falls back to the requested model when the response omits it', () => {
      const response = vertexAdapter.parseResponse({ ...raw, modelVersion: undefined }, vertex());
      expect(response.model).toBe('gemini-2.0-flash');
    });

    it('reports a blocked prompt as an invalid request, not a transient failure', () => {
      expect(() =>
        vertexAdapter.parseResponse({ promptFeedback: { blockReason: 'SAFETY' } }, vertex()),
      ).toThrowError(expect.objectContaining({ code: 'invalid_request', retryable: false }));
    });

    it('reports an empty candidate list as a retryable provider error', () => {
      expect(() => vertexAdapter.parseResponse({ candidates: [] }, vertex())).toThrowError(
        expect.objectContaining({ code: 'provider_error', retryable: true }),
      );
    });
  });

  describe('parseStreamChunk', () => {
    it('emits a text delta', () => {
      expect(
        vertexAdapter.parseStreamChunk({ candidates: [{ content: { parts: [{ text: 'Hel' }] } }] }),
      ).toEqual([{ type: 'text_delta', text: 'Hel' }]);
    });

    it('emits a whole function call in one delta', () => {
      expect(
        vertexAdapter.parseStreamChunk({
          candidates: [
            {
              content: {
                parts: [{ functionCall: { name: 'get_weather', args: { city: 'Lagos' } } }],
              },
            },
          ],
        }),
      ).toEqual([
        {
          type: 'tool_call_delta',
          index: 0,
          id: 'call_0',
          name: 'get_weather',
          argumentsDelta: '{"city":"Lagos"}',
        },
      ]);
    });

    it('emits a finish event, correcting STOP to tool_calls', () => {
      const events = vertexAdapter.parseStreamChunk({
        candidates: [
          {
            content: { parts: [{ functionCall: { name: 'ping', args: {} } }] },
            finishReason: 'STOP',
          },
        ],
      });
      expect(events.at(-1)).toEqual({ type: 'finish', finishReason: 'tool_calls' });
    });

    it('emits usage, which Gemini reports on the chunk itself', () => {
      expect(
        vertexAdapter.parseStreamChunk({
          candidates: [{ content: { parts: [{ text: 'a' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 },
        }),
      ).toEqual([
        { type: 'text_delta', text: 'a' },
        { type: 'finish', finishReason: 'stop' },
        { type: 'usage', usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 } },
      ]);
    });

    it('emits nothing for an empty chunk', () => {
      expect(vertexAdapter.parseStreamChunk({})).toEqual([]);
    });
  });
});
