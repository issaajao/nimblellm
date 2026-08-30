import { describe, expect, it } from 'vitest';
import {
  anthropicAdapter,
  DEFAULT_MAX_OUTPUT_TOKENS,
  type MessagesPayload,
} from '../../src/providers/anthropic.js';
import { PNG_BASE64, req, toolConversation, weatherTool } from '../helpers.js';

const MODEL = 'anthropic/claude-sonnet-4-5-20250929';

const anthropic = (input: Record<string, unknown> = {}) => req({ model: MODEL, ...input });
const build = (input: Record<string, unknown> = {}): MessagesPayload =>
  anthropicAdapter.buildPayload(anthropic(input));

describe('AnthropicAdapter', () => {
  it('declares its id and the narrower temperature range', () => {
    expect(anthropicAdapter.id).toBe('anthropic');
    expect(anthropicAdapter.limits.temperature).toEqual({ min: 0, max: 1 });
  });

  it('does not claim capabilities the Messages API lacks', () => {
    expect(anthropicAdapter.supports('tools')).toBe(true);
    expect(anthropicAdapter.supports('tool_choice_required')).toBe(true);
    expect(anthropicAdapter.supports('image_base64')).toBe(true);
    expect(anthropicAdapter.supports('image_url')).toBe(true);
    expect(anthropicAdapter.supports('top_k')).toBe(true);
    expect(anthropicAdapter.supports('metadata')).toBe(true);

    expect(anthropicAdapter.supports('json_mode')).toBe(false);
    expect(anthropicAdapter.supports('json_schema')).toBe(false);
    expect(anthropicAdapter.supports('seed')).toBe(false);
    expect(anthropicAdapter.supports('frequency_penalty')).toBe(false);
    expect(anthropicAdapter.supports('presence_penalty')).toBe(false);
  });

  describe('describeRoute', () => {
    it('names the model in the body, not the path', () => {
      expect(anthropicAdapter.describeRoute(anthropic())).toEqual({
        method: 'POST',
        path: 'v1/messages',
        headers: { 'content-type': 'application/json' },
      });
    });

    it('uses the same path when streaming', () => {
      expect(anthropicAdapter.describeRoute(anthropic({ stream: true })).path).toBe('v1/messages');
    });
  });

  describe('buildPayload', () => {
    it('maps the system prompt straight onto the native field', () => {
      expect(build({ system: 'Be concise.' }).system).toBe('Be concise.');
    });

    it('wraps text in typed content blocks', () => {
      expect(build().messages).toEqual([
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      ]);
    });

    it('passes sampling parameters through at the top level, topK included', () => {
      const payload = build({
        max_tokens: 256,
        temperature: 0.5,
        top_p: 0.9,
        top_k: 40,
        stop: ['END'],
      });

      expect(payload).toMatchObject({
        max_tokens: 256,
        temperature: 0.5,
        top_p: 0.9,
        top_k: 40,
        stop_sequences: ['END'],
      });
    });

    describe('max_tokens, which the API requires and does not default', () => {
      it('fills in a documented default when the request omits it', () => {
        expect(build().max_tokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
      });

      it('never overrides an explicit budget', () => {
        expect(build({ max_tokens: 32 }).max_tokens).toBe(32);
      });

      it('lets providerOptions win over the default', () => {
        expect(build({ providerOptions: { anthropic: { max_tokens: 100 } } }).max_tokens).toBe(100);
      });
    });

    it('turns a tool result into a user turn and merges it with its neighbour', () => {
      const payload = build({ messages: [...toolConversation], tools: [weatherTool] });

      expect(payload.messages).toEqual([
        { role: 'user', content: [{ type: 'text', text: 'weather in Lagos?' }] },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Lagos' } },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_1',
              content: [{ type: 'text', text: '{"tempC":31}' }],
            },
          ],
        },
      ]);
    });

    it('merges consecutive turns that map to the same role', () => {
      const payload = build({
        messages: [
          { role: 'user', content: 'first' },
          { role: 'user', content: 'second' },
        ],
      });

      expect(payload.messages).toEqual([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'first' },
            { type: 'text', text: 'second' },
          ],
        },
      ]);
    });

    it('flags a failed tool result', () => {
      const payload = build({
        messages: [
          ...toolConversation.slice(0, 2),
          { role: 'tool', tool_call_id: 'call_1', content: 'upstream 503', is_error: true },
        ],
      });

      expect(payload.messages[2]?.content[0]).toMatchObject({ is_error: true });
    });

    it('rejects a conversation that does not start with a user turn', () => {
      expect(() =>
        build({
          messages: [
            { role: 'assistant', content: 'I already spoke' },
            { role: 'user', content: 'hi' },
          ],
        }),
      ).toThrowError(/requires the conversation to start with a user turn/);
    });

    it('sends an inline image as a base64 source with a full media type', () => {
      const payload = build({
        messages: [
          { role: 'user', content: [{ type: 'image', data: PNG_BASE64, mediaType: 'image/png' }] },
        ],
      });

      expect(payload.messages[0]?.content[0]).toEqual({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: PNG_BASE64 },
      });
    });

    it('normalizes image/jpg to the jpeg media type', () => {
      const payload = build({
        messages: [
          { role: 'user', content: [{ type: 'image', data: 'x', mediaType: 'image/jpg' }] },
        ],
      });

      expect(payload.messages[0]?.content[0]).toMatchObject({
        source: { media_type: 'image/jpeg' },
      });
    });

    it('rejects an image media type no Claude vision model accepts', () => {
      expect(() =>
        build({
          messages: [
            { role: 'user', content: [{ type: 'image', data: 'x', mediaType: 'image/tiff' }] },
          ],
        }),
      ).toThrowError(/received "image\/tiff"/);
    });

    it('passes a URL image through as a url source', () => {
      const payload = build({
        messages: [{ role: 'user', content: [{ type: 'image', url: 'https://e.test/a.png' }] }],
      });

      expect(payload.messages[0]?.content[0]).toEqual({
        type: 'image',
        source: { type: 'url', url: 'https://e.test/a.png' },
      });
    });

    it('describes tools with an input_schema, not OpenAI’s parameters envelope', () => {
      expect(build({ tools: [weatherTool] }).tools).toEqual([
        {
          name: 'get_weather',
          description: 'Look up the weather',
          input_schema: { type: 'object', properties: { city: { type: 'string' } } },
        },
      ]);
    });

    it.each([
      ['auto', { type: 'auto' }],
      ['required', { type: 'any' }],
      ['none', { type: 'none' }],
    ])('maps toolChoice %s onto the native spelling', (choice, expected) => {
      expect(build({ tools: [weatherTool], tool_choice: choice }).tool_choice).toEqual(expected);
    });

    it('keeps the tools on the request for toolChoice "none", which it can express natively', () => {
      expect(build({ tools: [weatherTool], tool_choice: 'none' }).tools).toHaveLength(1);
    });

    it('names a forced tool', () => {
      const payload = build({
        tools: [weatherTool],
        tool_choice: { type: 'tool', name: 'get_weather' },
      });
      expect(payload.tool_choice).toEqual({ type: 'tool', name: 'get_weather' });
    });

    it('omits tools entirely when none were declared', () => {
      expect(build().tools).toBeUndefined();
      expect(build().tool_choice).toBeUndefined();
    });

    it('forwards metadata.user_id', () => {
      expect(build({ metadata: { user_id: 'u_1' } }).metadata).toEqual({ user_id: 'u_1' });
    });

    it('rejects metadata keys other than user_id rather than dropping them', () => {
      expect(() => build({ metadata: { tenant: 'acme' } })).toThrowError(
        expect.objectContaining({ code: 'invalid_request' }),
      );
      expect(() => build({ metadata: { tenant: 'acme' } })).toThrowError(/only "user_id"/);
    });

    it('merges providerOptions over the payload', () => {
      const payload = build({ providerOptions: { anthropic: { thinking: { type: 'enabled' } } } });
      expect(payload['thinking']).toEqual({ type: 'enabled' });
    });
  });

  describe('parseResponse', () => {
    const raw = {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5-20250929',
      content: [{ type: 'text', text: 'blue' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 3 },
    };

    it('normalizes a text completion', () => {
      expect(anthropicAdapter.parseResponse(raw, anthropic())).toMatchObject({
        id: 'msg_1',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5-20250929',
        finishReason: 'stop',
        message: { role: 'assistant', content: [{ type: 'text', text: 'blue' }] },
      });
    });

    it('sums the token counts, which the API reports without a total', () => {
      expect(anthropicAdapter.parseResponse(raw, anthropic()).usage).toEqual({
        inputTokens: 10,
        outputTokens: 3,
        totalTokens: 13,
      });
    });

    it('generates an id when the response carries none', () => {
      const { id, ...rest } = raw;
      expect(anthropicAdapter.parseResponse(rest, anthropic()).id).toMatch(/^anthropic-\d+$/);
    });

    it('reads tool_use blocks, whose input needs no JSON parsing', () => {
      const response = anthropicAdapter.parseResponse(
        {
          ...raw,
          content: [
            { type: 'text', text: 'checking' },
            { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Lagos' } },
          ],
          stop_reason: 'tool_use',
        },
        anthropic(),
      );

      expect(response.finishReason).toBe('tool_calls');
      expect(response.message.content).toEqual([{ type: 'text', text: 'checking' }]);
      expect(response.message.toolCalls).toEqual([
        { id: 'toolu_1', name: 'get_weather', arguments: { city: 'Lagos' } },
      ]);
    });

    it('leaves thinking blocks out of the message, reachable only on raw', () => {
      const response = anthropicAdapter.parseResponse(
        {
          ...raw,
          content: [
            { type: 'thinking', thinking: 'hmm', signature: 'sig' },
            { type: 'text', text: 'blue' },
          ],
        },
        anthropic(),
      );

      expect(response.message.content).toEqual([{ type: 'text', text: 'blue' }]);
      expect(response.raw).toMatchObject({ content: expect.any(Array) });
    });

    it.each([
      ['end_turn', 'stop'],
      ['stop_sequence', 'stop'],
      ['max_tokens', 'length'],
      ['tool_use', 'tool_calls'],
      ['refusal', 'content_filter'],
      ['something_new', 'unknown'],
    ])('maps stop_reason %s to %s', (wire, canonical) => {
      expect(
        anthropicAdapter.parseResponse({ ...raw, stop_reason: wire }, anthropic()).finishReason,
      ).toBe(canonical);
    });

    it('reports a missing content array as a retryable provider error', () => {
      expect(() => anthropicAdapter.parseResponse({ id: 'msg_1' }, anthropic())).toThrowError(
        expect.objectContaining({ code: 'provider_error', retryable: true }),
      );
    });
  });

  describe('parseStreamChunk', () => {
    it('emits a text delta', () => {
      expect(
        anthropicAdapter.parseStreamChunk({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hel' },
        }),
      ).toEqual([{ type: 'text_delta', text: 'Hel' }]);
    });

    it('emits the tool call header from content_block_start', () => {
      expect(
        anthropicAdapter.parseStreamChunk({
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} },
        }),
      ).toEqual([{ type: 'tool_call_delta', index: 1, id: 'toolu_1', name: 'get_weather' }]);
    });

    it('emits nothing for a text block starting', () => {
      expect(
        anthropicAdapter.parseStreamChunk({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }),
      ).toEqual([]);
    });

    it('emits partial tool arguments from input_json_delta', () => {
      expect(
        anthropicAdapter.parseStreamChunk({
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"ci' },
        }),
      ).toEqual([{ type: 'tool_call_delta', index: 1, argumentsDelta: '{"ci' }]);
    });

    it('emits usage and finish separately from one message_delta', () => {
      expect(
        anthropicAdapter.parseStreamChunk({
          type: 'message_delta',
          delta: { stop_reason: 'max_tokens', stop_sequence: null },
          usage: { input_tokens: 10, output_tokens: 3 },
        }),
      ).toEqual([
        { type: 'usage', usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 } },
        { type: 'finish', finishReason: 'length' },
      ]);
    });

    it('surfaces a mid-stream error event', () => {
      expect(
        anthropicAdapter.parseStreamChunk({
          type: 'error',
          error: { type: 'overloaded_error', message: 'Overloaded' },
        }),
      ).toEqual([{ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]);
    });

    it('ignores events it has no canonical equivalent for', () => {
      for (const type of ['message_start', 'content_block_stop', 'message_stop', 'ping']) {
        expect(anthropicAdapter.parseStreamChunk({ type, index: 0 })).toEqual([]);
      }
    });
  });
});
