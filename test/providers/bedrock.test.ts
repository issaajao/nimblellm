import { describe, expect, it } from 'vitest';
import { bedrockAdapter } from '../../src/providers/bedrock.js';
import type { ConversePayload } from '../../src/providers/bedrock.js';
import { PNG_BASE64, req, toolConversation, weatherTool } from '../helpers.js';

const MODEL = 'bedrock/anthropic.claude-sonnet-4-20250514-v1:0';

const bedrock = (input: Record<string, unknown> = {}) => req({ model: MODEL, ...input });
const build = (input: Record<string, unknown> = {}): ConversePayload =>
  bedrockAdapter.buildPayload(bedrock(input));

describe('BedrockAdapter', () => {
  it('declares its id and the narrower temperature range', () => {
    expect(bedrockAdapter.id).toBe('bedrock');
    expect(bedrockAdapter.limits.temperature).toEqual({ min: 0, max: 1 });
  });

  it('does not claim capabilities Converse lacks', () => {
    expect(bedrockAdapter.supports('tools')).toBe(true);
    expect(bedrockAdapter.supports('image_base64')).toBe(true);
    expect(bedrockAdapter.supports('image_url')).toBe(false);
    expect(bedrockAdapter.supports('json_schema')).toBe(false);
    expect(bedrockAdapter.supports('json_mode')).toBe(false);
    expect(bedrockAdapter.supports('seed')).toBe(false);
    expect(bedrockAdapter.supports('frequency_penalty')).toBe(false);
    expect(bedrockAdapter.supports('top_k')).toBe(false);
  });

  describe('describeRoute', () => {
    it('addresses the model in the path', () => {
      expect(bedrockAdapter.describeRoute(bedrock()).path).toBe(
        'model/anthropic.claude-sonnet-4-20250514-v1%3A0/converse',
      );
    });

    it('switches to converse-stream when streaming', () => {
      expect(bedrockAdapter.describeRoute(bedrock({ stream: true })).path).toMatch(
        /\/converse-stream$/,
      );
    });
  });

  describe('buildPayload', () => {
    it('carries the system prompt outside the conversation', () => {
      expect(build({ system: 'Be concise.' }).system).toEqual([{ text: 'Be concise.' }]);
    });

    it('wraps text in content blocks', () => {
      expect(build().messages).toEqual([{ role: 'user', content: [{ text: 'hello' }] }]);
    });

    it('groups sampling parameters into inferenceConfig', () => {
      expect(
        build({ max_tokens: 256, temperature: 0.5, top_p: 0.9, stop: ['END'] }).inferenceConfig,
      ).toEqual({
        maxTokens: 256,
        temperature: 0.5,
        topP: 0.9,
        stopSequences: ['END'],
      });
    });

    it('omits inferenceConfig entirely when no parameters were set', () => {
      expect(build().inferenceConfig).toBeUndefined();
    });

    it('turns a tool result into a user turn and merges it with its neighbour', () => {
      const payload = build({ messages: [...toolConversation], tools: [weatherTool] });

      expect(payload.messages).toEqual([
        { role: 'user', content: [{ text: 'weather in Lagos?' }] },
        {
          role: 'assistant',
          content: [
            { toolUse: { toolUseId: 'call_1', name: 'get_weather', input: { city: 'Lagos' } } },
          ],
        },
        {
          role: 'user',
          content: [{ toolResult: { toolUseId: 'call_1', content: [{ text: '{"tempC":31}' }] } }],
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
        { role: 'user', content: [{ text: 'first' }, { text: 'second' }] },
      ]);
    });

    it('flags a failed tool result', () => {
      const payload = build({
        messages: [
          ...toolConversation.slice(0, 2),
          { role: 'tool', tool_call_id: 'call_1', content: 'upstream 503', is_error: true },
        ],
      });

      expect(payload.messages[2]?.content[0]).toMatchObject({
        toolResult: { status: 'error' },
      });
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

    it('names the image format alongside the bytes', () => {
      const payload = build({
        messages: [
          { role: 'user', content: [{ type: 'image', data: PNG_BASE64, mediaType: 'image/png' }] },
        ],
      });

      expect(payload.messages[0]?.content[0]).toEqual({
        image: { format: 'png', source: { bytes: PNG_BASE64 } },
      });
    });

    it('normalizes image/jpg to the jpeg format token', () => {
      const payload = build({
        messages: [
          { role: 'user', content: [{ type: 'image', data: 'x', mediaType: 'image/jpg' }] },
        ],
      });
      expect(payload.messages[0]?.content[0]).toMatchObject({ image: { format: 'jpeg' } });
    });

    it('rejects an image media type no Bedrock vision model accepts', () => {
      expect(() =>
        build({
          messages: [
            { role: 'user', content: [{ type: 'image', data: 'x', mediaType: 'image/tiff' }] },
          ],
        }),
      ).toThrowError(/received "image\/tiff"/);
    });

    it('rejects a URL image, which Converse cannot fetch', () => {
      expect(() =>
        build({
          messages: [{ role: 'user', content: [{ type: 'image', url: 'https://e.test/a.png' }] }],
        }),
      ).toThrowError(expect.objectContaining({ code: 'unsupported_feature' }));
    });

    it('describes tools with an inputSchema envelope', () => {
      expect(build({ tools: [weatherTool] }).toolConfig?.tools).toEqual([
        {
          toolSpec: {
            name: 'get_weather',
            description: 'Look up the weather',
            inputSchema: { json: { type: 'object', properties: { city: { type: 'string' } } } },
          },
        },
      ]);
    });

    it.each([
      ['auto', { auto: {} }],
      ['required', { any: {} }],
    ])('maps toolChoice %s onto Converse', (choice, expected) => {
      expect(build({ tools: [weatherTool], tool_choice: choice }).toolConfig?.toolChoice).toEqual(
        expected,
      );
    });

    it('names a forced tool', () => {
      const payload = build({
        tools: [weatherTool],
        tool_choice: { type: 'tool', name: 'get_weather' },
      });
      expect(payload.toolConfig?.toolChoice).toEqual({ tool: { name: 'get_weather' } });
    });

    it('withholds the tools entirely for toolChoice "none", which Converse cannot express', () => {
      expect(build({ tools: [weatherTool], tool_choice: 'none' }).toolConfig).toBeUndefined();
    });

    it('omits toolConfig when no tools were declared', () => {
      expect(build().toolConfig).toBeUndefined();
    });

    it('merges providerOptions, which is how topK reaches the model', () => {
      const payload = build({
        providerOptions: { bedrock: { additionalModelRequestFields: { top_k: 40 } } },
      });
      expect(payload.additionalModelRequestFields).toEqual({ top_k: 40 });
    });
  });

  describe('parseResponse', () => {
    const raw = {
      output: { message: { role: 'assistant', content: [{ text: 'blue' }] } },
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
    };

    it('normalizes a text completion', () => {
      const response = bedrockAdapter.parseResponse(raw, bedrock());

      expect(response).toMatchObject({
        provider: 'bedrock',
        model: 'anthropic.claude-sonnet-4-20250514-v1:0',
        finishReason: 'stop',
        message: { role: 'assistant', content: [{ type: 'text', text: 'blue' }] },
        usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
      });
    });

    it('uses the AWS SDK request id when the response carries one', () => {
      const response = bedrockAdapter.parseResponse(
        { ...raw, $metadata: { requestId: 'req-abc' } },
        bedrock(),
      );
      expect(response.id).toBe('req-abc');
    });

    it('generates an id when Converse supplies none', () => {
      expect(bedrockAdapter.parseResponse(raw, bedrock()).id).toMatch(/^bedrock-\d+$/);
    });

    it('reads tool use blocks', () => {
      const response = bedrockAdapter.parseResponse(
        {
          ...raw,
          output: {
            message: {
              content: [
                { text: 'checking' },
                { toolUse: { toolUseId: 'tu_1', name: 'get_weather', input: { city: 'Lagos' } } },
              ],
            },
          },
          stopReason: 'tool_use',
        },
        bedrock(),
      );

      expect(response.finishReason).toBe('tool_calls');
      expect(response.message.content).toEqual([{ type: 'text', text: 'checking' }]);
      expect(response.message.toolCalls).toEqual([
        { id: 'tu_1', name: 'get_weather', arguments: { city: 'Lagos' } },
      ]);
    });

    it.each([
      ['end_turn', 'stop'],
      ['stop_sequence', 'stop'],
      ['max_tokens', 'length'],
      ['tool_use', 'tool_calls'],
      ['content_filtered', 'content_filter'],
      ['guardrail_intervened', 'content_filter'],
      ['something_new', 'unknown'],
    ])('maps stopReason %s to %s', (wire, canonical) => {
      expect(
        bedrockAdapter.parseResponse({ ...raw, stopReason: wire }, bedrock()).finishReason,
      ).toBe(canonical);
    });

    it('reports a missing output message as a retryable provider error', () => {
      expect(() =>
        bedrockAdapter.parseResponse({ stopReason: 'end_turn' }, bedrock()),
      ).toThrowError(expect.objectContaining({ code: 'provider_error', retryable: true }));
    });
  });

  describe('parseStreamChunk', () => {
    it('emits a text delta', () => {
      expect(
        bedrockAdapter.parseStreamChunk({
          contentBlockDelta: { delta: { text: 'Hel' }, contentBlockIndex: 0 },
        }),
      ).toEqual([{ type: 'text_delta', text: 'Hel' }]);
    });

    it('emits the tool call header from contentBlockStart', () => {
      expect(
        bedrockAdapter.parseStreamChunk({
          contentBlockStart: {
            start: { toolUse: { toolUseId: 'tu_1', name: 'get_weather' } },
            contentBlockIndex: 1,
          },
        }),
      ).toEqual([{ type: 'tool_call_delta', index: 1, id: 'tu_1', name: 'get_weather' }]);
    });

    it('emits partial tool arguments from contentBlockDelta', () => {
      expect(
        bedrockAdapter.parseStreamChunk({
          contentBlockDelta: { delta: { toolUse: { input: '{"ci' } }, contentBlockIndex: 1 },
        }),
      ).toEqual([{ type: 'tool_call_delta', index: 1, argumentsDelta: '{"ci' }]);
    });

    it('emits a finish event from messageStop', () => {
      expect(
        bedrockAdapter.parseStreamChunk({ messageStop: { stopReason: 'max_tokens' } }),
      ).toEqual([{ type: 'finish', finishReason: 'length' }]);
    });

    it('emits usage from the metadata event', () => {
      expect(
        bedrockAdapter.parseStreamChunk({
          metadata: {
            usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
            metrics: { latencyMs: 42 },
          },
        }),
      ).toEqual([{ type: 'usage', usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 } }]);
    });

    it('ignores events it has no canonical equivalent for', () => {
      expect(bedrockAdapter.parseStreamChunk({ messageStart: { role: 'assistant' } })).toEqual([]);
      expect(
        bedrockAdapter.parseStreamChunk({ contentBlockStop: { contentBlockIndex: 0 } }),
      ).toEqual([]);
    });
  });
});
