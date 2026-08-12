import { describe, expect, it } from 'vitest';
import { NimbleError } from '../src/errors.js';
import { normalizeMessages } from '../src/core/messages.js';

const user = (content: unknown) => ({ role: 'user', content });

describe('normalizeMessages', () => {
  it('wraps string content in a text part', () => {
    const { messages } = normalizeMessages([user('hello')]);
    expect(messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]);
  });

  it('hoists system turns out of the conversation', () => {
    const { system, messages } = normalizeMessages([
      { role: 'system', content: 'Be concise.' },
      user('hi'),
    ]);
    expect(system).toBe('Be concise.');
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('user');
  });

  it('joins multiple system turns in order', () => {
    const { system } = normalizeMessages([
      { role: 'system', content: 'First.' },
      user('hi'),
      { role: 'system', content: 'Second.' },
    ]);
    expect(system).toBe('First.\n\nSecond.');
  });

  it('reports no system instructions when there are none', () => {
    expect(normalizeMessages([user('hi')]).system).toBeUndefined();
  });

  it('rejects non-text system content', () => {
    expect(() =>
      normalizeMessages([
        { role: 'system', content: [{ type: 'image', url: 'https://e.test/a.png' }] },
        user('hi'),
      ]),
    ).toThrowError(/system instructions must be text only/);
  });

  it('rejects a conversation that is only system turns', () => {
    expect(() => normalizeMessages([{ role: 'system', content: 'Be concise.' }])).toThrowError(
      /at least one user, assistant, or tool message/,
    );
  });

  describe('content parts', () => {
    it('accepts bare strings inside a content array', () => {
      const { messages } = normalizeMessages([user(['a', { type: 'text', text: 'b' }])]);
      expect(messages[0]?.content).toEqual([
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ]);
    });

    it('drops empty text parts', () => {
      const { messages } = normalizeMessages([user(['', { type: 'text', text: 'kept' }])]);
      expect(messages[0]?.content).toEqual([{ type: 'text', text: 'kept' }]);
    });

    it('normalizes a flat image url into a source', () => {
      const { messages } = normalizeMessages([
        user([{ type: 'image', url: 'https://e.test/a.png' }]),
      ]);
      expect(messages[0]?.content[0]).toEqual({
        type: 'image',
        source: { kind: 'url', url: 'https://e.test/a.png' },
      });
    });

    it('normalizes inline base64 image data', () => {
      const { messages } = normalizeMessages([
        user([{ type: 'image', data: 'aGk=', media_type: 'image/png' }]),
      ]);
      expect(messages[0]?.content[0]).toEqual({
        type: 'image',
        source: { kind: 'base64', mediaType: 'image/png', data: 'aGk=' },
      });
    });

    it('accepts the canonical source form, so output can be fed back in', () => {
      const first = normalizeMessages([user([{ type: 'image', url: 'https://e.test/a.png' }])]);
      const second = normalizeMessages([{ role: 'user', content: first.messages[0]?.content }]);
      expect(second.messages).toEqual(first.messages);
    });

    it('requires a mediaType alongside inline data', () => {
      expect(() => normalizeMessages([user([{ type: 'image', data: 'aGk=' }])])).toThrowError(
        /requires a mediaType/,
      );
    });

    it('rejects an image with neither url nor data', () => {
      expect(() => normalizeMessages([user([{ type: 'image' }])])).toThrowError(
        /require either a "url" or base64 "data"/,
      );
    });

    it('rejects unknown part types', () => {
      expect(() => normalizeMessages([user([{ type: 'audio', data: 'x' }])])).toThrowError(
        /unsupported content part type "audio"/,
      );
    });

    it('rejects an empty user message', () => {
      expect(() => normalizeMessages([user('')])).toThrowError(/must not be empty/);
    });
  });

  describe('tool calls', () => {
    const conversation = (toolCalls: unknown, toolMessage: Record<string, unknown>) => [
      user('what is the weather?'),
      { role: 'assistant', content: null, toolCalls },
      toolMessage,
    ];

    it('accepts an assistant turn with tool calls and no text', () => {
      const { messages } = normalizeMessages([
        user('hi'),
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', name: 'lookup', arguments: { city: 'Lagos' } }],
        },
      ]);
      expect(messages[1]).toEqual({
        role: 'assistant',
        content: [],
        toolCalls: [{ id: 'call_1', name: 'lookup', arguments: { city: 'Lagos' } }],
      });
    });

    it("parses OpenAI's nested function form with stringified arguments", () => {
      const { messages } = normalizeMessages([
        user('hi'),
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'lookup', arguments: '{"city":"Lagos"}' },
            },
          ],
        },
      ]);
      expect(messages[1]).toMatchObject({
        toolCalls: [{ id: 'call_1', name: 'lookup', arguments: { city: 'Lagos' } }],
      });
    });

    it('defaults missing arguments to an empty object', () => {
      const { messages } = normalizeMessages([
        user('hi'),
        { role: 'assistant', toolCalls: [{ id: 'call_1', name: 'ping' }] },
      ]);
      expect(messages[1]).toMatchObject({ toolCalls: [{ arguments: {} }] });
    });

    it('rejects unparseable argument JSON', () => {
      expect(() =>
        normalizeMessages([
          user('hi'),
          { role: 'assistant', toolCalls: [{ id: 'c', name: 'ping', arguments: '{oops' }] },
        ]),
      ).toThrowError(/not valid JSON/);
    });

    it('links a tool result to its call', () => {
      const { messages } = normalizeMessages(
        conversation([{ id: 'call_1', name: 'lookup' }], {
          role: 'tool',
          tool_call_id: 'call_1',
          content: 'sunny',
        }),
      );
      expect(messages[2]).toEqual({
        role: 'tool',
        toolCallId: 'call_1',
        content: [{ type: 'text', text: 'sunny' }],
      });
    });

    it('preserves the error flag on a failed tool result', () => {
      const { messages } = normalizeMessages(
        conversation([{ id: 'call_1', name: 'lookup' }], {
          role: 'tool',
          toolCallId: 'call_1',
          content: 'upstream 503',
          is_error: true,
        }),
      );
      expect(messages[2]).toMatchObject({ isError: true });
    });

    it('rejects a tool result with no matching call', () => {
      expect(() =>
        normalizeMessages(
          conversation([{ id: 'call_1', name: 'lookup' }], {
            role: 'tool',
            toolCallId: 'call_9',
            content: 'sunny',
          }),
        ),
      ).toThrowError(/does not match any tool call made earlier/);
    });

    it('rejects a tool result with no toolCallId', () => {
      expect(() =>
        normalizeMessages([user('hi'), { role: 'tool', content: 'sunny' }]),
      ).toThrowError(/must reference the id of the tool call/);
    });

    it('rejects an empty tool result', () => {
      expect(() =>
        normalizeMessages(
          conversation([{ id: 'call_1', name: 'lookup' }], {
            role: 'tool',
            toolCallId: 'call_1',
            content: '',
          }),
        ),
      ).toThrowError(/must carry a result/);
    });

    it('rejects a tool call without an id', () => {
      expect(() =>
        normalizeMessages([user('hi'), { role: 'assistant', toolCalls: [{ name: 'ping' }] }]),
      ).toThrowError(/require a non-empty id/);
    });
  });

  describe('structural validation', () => {
    it('rejects a non-array', () => {
      expect(() => normalizeMessages('hello')).toThrowError(/expected an array, received a string/);
    });

    it('rejects an empty array', () => {
      expect(() => normalizeMessages([])).toThrowError(/at least one message/);
    });

    it('rejects an unknown role', () => {
      expect(() => normalizeMessages([{ role: 'agent', content: 'hi' }])).toThrowError(
        /expected one of "system", "user", "assistant", "tool"/,
      );
    });

    it('rejects an unknown field with a usable path', () => {
      try {
        normalizeMessages([{ role: 'user', content: 'hi', temperature: 1 }]);
        expect.unreachable('should have thrown');
      } catch (error) {
        expect((error as NimbleError).issues[0]?.path).toBe('messages[0].temperature');
      }
    });

    it('rejects a field that is valid on another role', () => {
      expect(() =>
        normalizeMessages([user('hi'), { role: 'user', content: 'x', toolCallId: 'c' }]),
      ).toThrowError(/not valid on a "user" message/);
    });

    it('rejects an assistant turn with neither content nor tool calls', () => {
      expect(() =>
        normalizeMessages([user('hi'), { role: 'assistant', content: '' }]),
      ).toThrowError(/must have content, tool calls, or both/);
    });

    it('freezes the messages it returns', () => {
      const { messages } = normalizeMessages([user('hi')]);
      expect(Object.isFrozen(messages)).toBe(true);
      expect(Object.isFrozen(messages[0])).toBe(true);
    });
  });
});
