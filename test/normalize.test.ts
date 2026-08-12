import { describe, expect, it } from 'vitest';
import { NimbleError, normalizeRequest } from '../src/index.js';

const minimal = {
  model: 'openai/gpt-4o',
  messages: [{ role: 'user', content: 'hello' }],
};

describe('normalizeRequest', () => {
  it('produces a canonical request from the minimal input', () => {
    expect(normalizeRequest(minimal)).toEqual({
      model: { provider: 'openai', model: 'gpt-4o', raw: 'openai/gpt-4o' },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    });
  });

  it('omits optional fields rather than setting them to undefined', () => {
    expect(Object.keys(normalizeRequest(minimal))).toEqual(['model', 'messages']);
  });

  it('deeply freezes the result', () => {
    const request = normalizeRequest({
      ...minimal,
      tools: [{ name: 'ping', parameters: { type: 'object', properties: {} } }],
    });
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.tools?.[0]?.parameters)).toBe(true);
  });

  describe('field aliases', () => {
    it.each([
      ['max_tokens', 'maxOutputTokens', 256],
      ['maxTokens', 'maxOutputTokens', 256],
      ['max_completion_tokens', 'maxOutputTokens', 256],
      ['top_p', 'topP', 0.9],
      ['top_k', 'topK', 40],
      ['frequency_penalty', 'frequencyPenalty', 0.5],
      ['presence_penalty', 'presencePenalty', 0.5],
    ] as const)('maps %s onto %s', (alias, canonical, value) => {
      const request = normalizeRequest({ ...minimal, [alias]: value });
      expect(request[canonical]).toBe(value);
    });

    it('maps stop_sequences onto stop', () => {
      expect(normalizeRequest({ ...minimal, stop_sequences: 'END' }).stop).toEqual(['END']);
    });

    it('rejects two spellings of the same field', () => {
      expect(() => normalizeRequest({ ...minimal, max_tokens: 10, maxTokens: 10 })).toThrowError(
        /both set "maxOutputTokens"/,
      );
    });

    it('rejects an unknown field instead of dropping it', () => {
      try {
        normalizeRequest({ ...minimal, max_tokns: 10 });
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(NimbleError);
        expect((error as NimbleError).issues[0]?.path).toBe('max_tokns');
        expect((error as NimbleError).message).toMatch(/Accepted fields:/);
      }
    });

    it('treats an explicit null as unset', () => {
      expect(normalizeRequest({ ...minimal, temperature: null }).temperature).toBeUndefined();
    });
  });

  describe('system instructions', () => {
    it('accepts a top-level system field', () => {
      expect(normalizeRequest({ ...minimal, system: 'Be concise.' }).system).toBe('Be concise.');
    });

    it('hoists system messages', () => {
      const request = normalizeRequest({
        model: 'openai/gpt-4o',
        messages: [
          { role: 'system', content: 'Be concise.' },
          { role: 'user', content: 'hello' },
        ],
      });
      expect(request.system).toBe('Be concise.');
      expect(request.messages).toHaveLength(1);
    });

    it('puts the top-level field ahead of hoisted messages', () => {
      const request = normalizeRequest({
        model: 'openai/gpt-4o',
        system: 'Standing rule.',
        messages: [
          { role: 'system', content: 'Turn rule.' },
          { role: 'user', content: 'hello' },
        ],
      });
      expect(request.system).toBe('Standing rule.\n\nTurn rule.');
    });

    it('ignores a whitespace-only system field', () => {
      expect(normalizeRequest({ ...minimal, system: '   ' }).system).toBeUndefined();
    });

    it('rejects a non-string system field', () => {
      expect(() => normalizeRequest({ ...minimal, system: ['a'] })).toThrowError(
        /system: expected a string, received an array/,
      );
    });
  });

  describe('routing', () => {
    it('uses defaultProvider for unprefixed models', () => {
      const request = normalizeRequest(
        { ...minimal, model: 'gpt-4o' },
        { defaultProvider: 'azure' },
      );
      expect(request.model).toEqual({ provider: 'azure', model: 'gpt-4o', raw: 'gpt-4o' });
    });

    it('lets an explicit prefix win over defaultProvider', () => {
      const request = normalizeRequest(minimal, { defaultProvider: 'azure' });
      expect(request.model.provider).toBe('openai');
    });

    it('fails with unknown_provider when routing is ambiguous', () => {
      expect(() => normalizeRequest({ ...minimal, model: 'gpt-4o' })).toThrowError(
        expect.objectContaining({ code: 'unknown_provider' }),
      );
    });

    it('rejects a missing model', () => {
      expect(() => normalizeRequest({ messages: minimal.messages })).toThrowError(
        /model: expected a string/,
      );
    });
  });

  describe('cross-field validation', () => {
    it('rejects toolChoice without tools', () => {
      expect(() => normalizeRequest({ ...minimal, tool_choice: 'required' })).toThrowError(
        /no tools were supplied/,
      );
    });

    it('accepts a forced tool that is declared', () => {
      const request = normalizeRequest({
        ...minimal,
        tools: [{ name: 'ping', parameters: { type: 'object', properties: {} } }],
        tool_choice: { type: 'function', function: { name: 'ping' } },
      });
      expect(request.toolChoice).toEqual({ type: 'tool', name: 'ping' });
    });
  });

  describe('input shape', () => {
    it.each([[null], ['a string'], [[1, 2]], [42]])('rejects %p as a request', (input) => {
      expect(() => normalizeRequest(input)).toThrowError(/expected a request object/);
    });

    it('does not mutate the caller’s input', () => {
      const input = { ...minimal, messages: [{ role: 'user', content: 'hello' }] };
      const snapshot = structuredClone(input);
      normalizeRequest(input);
      expect(input).toEqual(snapshot);
    });
  });

  it('is idempotent: a normalized request re-normalizes to itself', () => {
    const first = normalizeRequest({
      model: 'bedrock/anthropic.claude-sonnet-4-20250514-v1:0',
      system: 'Be concise.',
      messages: [
        { role: 'user', content: [{ type: 'image', url: 'https://e.test/a.png' }, 'describe it'] },
        { role: 'assistant', tool_calls: [{ id: 'c1', name: 'ping', arguments: '{"n":1}' }] },
        { role: 'tool', tool_call_id: 'c1', content: 'pong' },
      ],
      max_tokens: 128,
      temperature: 0.2,
      stop: 'END',
      tools: [{ name: 'ping', parameters: { type: 'object', properties: {} } }],
      tool_choice: 'auto',
      metadata: { tenant: 'acme' },
      providerOptions: { bedrock: { guardrailIdentifier: 'gr-1' } },
    });

    const second = normalizeRequest({ ...first, model: first.model.raw });
    expect(second).toEqual(first);
  });
});
