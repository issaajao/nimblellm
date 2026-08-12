import { describe, expect, it } from 'vitest';
import { openaiAdapter } from '../../src/providers/openai.js';
import type { ChatCompletionsPayload } from '../../src/providers/openai-compatible.js';
import { PNG_BASE64, req, toolConversation, weatherTool } from '../helpers.js';

const build = (input: Record<string, unknown>): ChatCompletionsPayload =>
  openaiAdapter.buildPayload(req(input));

describe('OpenAIAdapter', () => {
  it('declares its id and ranges', () => {
    expect(openaiAdapter.id).toBe('openai');
    expect(openaiAdapter.limits.temperature).toEqual({ min: 0, max: 2 });
  });

  it('supports everything except topK', () => {
    expect(openaiAdapter.supports('json_schema')).toBe(true);
    expect(openaiAdapter.supports('seed')).toBe(true);
    expect(openaiAdapter.supports('top_k')).toBe(false);
  });

  describe('describeRoute', () => {
    it('posts to chat completions', () => {
      expect(openaiAdapter.describeRoute(req({}))).toEqual({
        method: 'POST',
        path: 'v1/chat/completions',
        headers: { 'content-type': 'application/json' },
      });
    });

    it('uses the same path when streaming', () => {
      expect(openaiAdapter.describeRoute(req({ stream: true })).path).toBe('v1/chat/completions');
    });
  });

  describe('buildPayload', () => {
    it('names the model in the body', () => {
      expect(build({}).model).toBe('gpt-4o');
    });

    it('reinstates the system prompt as the first message', () => {
      expect(build({ system: 'Be concise.' }).messages[0]).toEqual({
        role: 'system',
        content: 'Be concise.',
      });
    });

    it('sends a lone text part as a plain string', () => {
      expect(build({}).messages[0]).toEqual({ role: 'user', content: 'hello' });
    });

    it('sends mixed content as a part array', () => {
      const payload = build({
        messages: [
          {
            role: 'user',
            content: ['describe this', { type: 'image', data: PNG_BASE64, mediaType: 'image/png' }],
          },
        ],
      });

      expect(payload.messages[0]).toEqual({
        role: 'user',
        content: [
          { type: 'text', text: 'describe this' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_BASE64}` } },
        ],
      });
    });

    it('passes an image URL through untouched', () => {
      const payload = build({
        messages: [{ role: 'user', content: [{ type: 'image', url: 'https://e.test/a.png' }] }],
      });
      expect(payload.messages[0]).toMatchObject({
        content: [{ type: 'image_url', image_url: { url: 'https://e.test/a.png' } }],
      });
    });

    it('stringifies tool call arguments and echoes tool results', () => {
      const payload = build({ messages: [...toolConversation], tools: [weatherTool] });

      expect(payload.messages[1]).toEqual({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Lagos"}' },
          },
        ],
      });
      expect(payload.messages[2]).toEqual({
        role: 'tool',
        tool_call_id: 'call_1',
        content: '{"tempC":31}',
      });
    });

    it('maps sampling parameters onto their wire names', () => {
      const payload = build({
        max_tokens: 256,
        temperature: 0.7,
        top_p: 0.9,
        frequency_penalty: 0.2,
        presence_penalty: -0.2,
        stop: ['END'],
        seed: 42,
      });

      expect(payload).toMatchObject({
        max_completion_tokens: 256,
        temperature: 0.7,
        top_p: 0.9,
        frequency_penalty: 0.2,
        presence_penalty: -0.2,
        stop: ['END'],
        seed: 42,
      });
    });

    it('asks for usage when streaming', () => {
      expect(build({ stream: true })).toMatchObject({
        stream: true,
        stream_options: { include_usage: true },
      });
    });

    it('omits stream_options when streaming is explicitly off', () => {
      const payload = build({ stream: false });
      expect(payload.stream).toBe(false);
      expect(payload.stream_options).toBeUndefined();
    });

    it('nests a json_schema response format', () => {
      const payload = build({
        response_format: {
          type: 'json_schema',
          name: 'Invoice',
          schema: { type: 'object' },
          strict: true,
        },
      });
      expect(payload.response_format).toEqual({
        type: 'json_schema',
        json_schema: { name: 'Invoice', schema: { type: 'object' }, strict: true },
      });
    });

    it('wraps tools in the function envelope', () => {
      expect(build({ tools: [weatherTool] }).tools).toEqual([
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Look up the weather',
            parameters: { type: 'object', properties: { city: { type: 'string' } } },
          },
        },
      ]);
    });

    it.each([
      ['auto', 'auto'],
      ['none', 'none'],
      ['required', 'required'],
    ])('passes tool_choice %s through', (input, expected) => {
      expect(build({ tools: [weatherTool], tool_choice: input }).tool_choice).toBe(expected);
    });

    it('names a forced tool in the function envelope', () => {
      const payload = build({
        tools: [weatherTool],
        tool_choice: { type: 'tool', name: 'get_weather' },
      });
      expect(payload.tool_choice).toEqual({ type: 'function', function: { name: 'get_weather' } });
    });

    it('merges providerOptions over the payload', () => {
      const payload = build({
        temperature: 0.5,
        providerOptions: { openai: { temperature: 0.1, logit_bias: { '123': -100 } } },
      });
      expect(payload.temperature).toBe(0.1);
      expect(payload['logit_bias']).toEqual({ '123': -100 });
    });

    it('ignores another provider’s options block', () => {
      const payload = build({ providerOptions: { bedrock: { guardrailIdentifier: 'gr-1' } } });
      expect(payload['guardrailIdentifier']).toBeUndefined();
    });
  });

  describe('parseResponse', () => {
    const raw = {
      id: 'chatcmpl-1',
      created: 1_700_000_000,
      model: 'gpt-4o-2024-08-06',
      choices: [
        { index: 0, message: { role: 'assistant', content: 'blue' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
    };

    it('normalizes a text completion', () => {
      const response = openaiAdapter.parseResponse(raw, req({}));

      expect(response).toMatchObject({
        id: 'chatcmpl-1',
        provider: 'openai',
        model: 'gpt-4o-2024-08-06',
        createdAt: '2023-11-14T22:13:20.000Z',
        finishReason: 'stop',
        message: { role: 'assistant', content: [{ type: 'text', text: 'blue' }] },
        usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
      });
      expect(response.raw).toBe(raw);
    });

    it('parses tool calls and their JSON arguments', () => {
      const response = openaiAdapter.parseResponse(
        {
          ...raw,
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_9',
                    type: 'function',
                    function: { name: 'get_weather', arguments: '{"city":"Lagos"}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        },
        req({}),
      );

      expect(response.finishReason).toBe('tool_calls');
      expect(response.message.content).toEqual([]);
      expect(response.message.toolCalls).toEqual([
        { id: 'call_9', name: 'get_weather', arguments: { city: 'Lagos' } },
      ]);
    });

    it.each([
      ['stop', 'stop'],
      ['length', 'length'],
      ['tool_calls', 'tool_calls'],
      ['function_call', 'tool_calls'],
      ['content_filter', 'content_filter'],
      ['something_new', 'unknown'],
    ])('maps finish_reason %s to %s', (wire, canonical) => {
      const response = openaiAdapter.parseResponse(
        { ...raw, choices: [{ message: { content: 'x' }, finish_reason: wire }] },
        req({}),
      );
      expect(response.finishReason).toBe(canonical);
    });

    it('falls back to zeroed usage when the provider omits it', () => {
      const response = openaiAdapter.parseResponse({ ...raw, usage: undefined }, req({}));
      expect(response.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    });

    it('derives totalTokens when the provider omits it', () => {
      const response = openaiAdapter.parseResponse(
        { ...raw, usage: { prompt_tokens: 10, completion_tokens: 3 } },
        req({}),
      );
      expect(response.usage.totalTokens).toBe(13);
    });

    it('falls back to the requested model when the response omits it', () => {
      const response = openaiAdapter.parseResponse({ ...raw, model: undefined }, req({}));
      expect(response.model).toBe('gpt-4o');
    });

    it('reports an empty choices array as a retryable provider error', () => {
      expect(() => openaiAdapter.parseResponse({ choices: [] }, req({}))).toThrowError(
        expect.objectContaining({ code: 'provider_error', retryable: true }),
      );
    });

    it('reports malformed tool arguments rather than dropping them', () => {
      expect(() =>
        openaiAdapter.parseResponse(
          {
            ...raw,
            choices: [
              {
                message: {
                  tool_calls: [{ id: 'c', function: { name: 'ping', arguments: '{oops' } }],
                },
                finish_reason: 'tool_calls',
              },
            ],
          },
          req({}),
        ),
      ).toThrowError(/unparseable arguments for tool "ping"/);
    });
  });

  describe('parseStreamChunk', () => {
    it('emits a text delta', () => {
      expect(openaiAdapter.parseStreamChunk({ choices: [{ delta: { content: 'Hel' } }] })).toEqual([
        { type: 'text_delta', text: 'Hel' },
      ]);
    });

    it('emits nothing for an empty delta', () => {
      expect(openaiAdapter.parseStreamChunk({ choices: [{ delta: {} }] })).toEqual([]);
    });

    it('emits tool call deltas with their index', () => {
      const events = openaiAdapter.parseStreamChunk({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '{"ci' } },
              ],
            },
          },
        ],
      });

      expect(events).toEqual([
        {
          type: 'tool_call_delta',
          index: 0,
          id: 'call_1',
          name: 'get_weather',
          argumentsDelta: '{"ci',
        },
      ]);
    });

    it('emits a finish event when the reason arrives', () => {
      expect(
        openaiAdapter.parseStreamChunk({ choices: [{ delta: {}, finish_reason: 'length' }] }),
      ).toEqual([{ type: 'finish', finishReason: 'length' }]);
    });

    it('emits usage from the trailing chunk', () => {
      expect(
        openaiAdapter.parseStreamChunk({
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
        }),
      ).toEqual([{ type: 'usage', usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 } }]);
    });

    it('ignores a null usage field on intermediate chunks', () => {
      expect(
        openaiAdapter.parseStreamChunk({ choices: [{ delta: { content: 'a' } }], usage: null }),
      ).toEqual([{ type: 'text_delta', text: 'a' }]);
    });
  });
});
