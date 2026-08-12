import { describe, expect, it } from 'vitest';
import {
  assertToolChoiceResolvable,
  normalizeMetadata,
  normalizeProviderOptions,
  normalizeResponseFormat,
  normalizeScalar,
  normalizeStop,
  normalizeToolChoice,
  normalizeTools,
} from '../src/core/params.js';
import type { NimbleTool } from '../src/types.js';

describe('normalizeScalar', () => {
  it('passes through values inside the canonical range', () => {
    expect(normalizeScalar('temperature', 0.7)).toBe(0.7);
    expect(normalizeScalar('topP', 1)).toBe(1);
    expect(normalizeScalar('maxOutputTokens', 512)).toBe(512);
  });

  it('treats absent and null as unset', () => {
    expect(normalizeScalar('temperature', undefined)).toBeUndefined();
    expect(normalizeScalar('temperature', null)).toBeUndefined();
  });

  it.each([
    ['temperature', 2.5],
    ['temperature', -0.1],
    ['topP', 1.5],
    ['maxOutputTokens', 0],
    ['maxOutputTokens', 1.5],
    ['topK', -1],
    ['frequencyPenalty', 3],
    ['presencePenalty', -3],
    ['seed', 1.5],
    ['stream', 'yes'],
  ] as const)('rejects %s = %p', (name, value) => {
    expect(() => normalizeScalar(name, value)).toThrowError(
      expect.objectContaining({ code: 'invalid_request' }),
    );
  });

  it('reports the offending field in the issue path', () => {
    try {
      normalizeScalar('temperature', 9);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as { issues: { path: string }[] }).issues[0]?.path).toBe('temperature');
    }
  });
});

describe('normalizeStop', () => {
  it('wraps a single string', () => {
    expect(normalizeStop('END')).toEqual(['END']);
  });

  it('passes an array through', () => {
    expect(normalizeStop(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('treats an empty array as unset', () => {
    expect(normalizeStop([])).toBeUndefined();
  });

  it('rejects empty and non-string entries', () => {
    expect(() => normalizeStop([''])).toThrowError(/non-empty strings/);
    expect(() => normalizeStop([1])).toThrowError(/non-empty strings/);
  });
});

describe('normalizeMetadata', () => {
  it('accepts string values', () => {
    expect(normalizeMetadata({ tenant: 'acme' })).toEqual({ tenant: 'acme' });
  });

  it('treats an empty object as unset', () => {
    expect(normalizeMetadata({})).toBeUndefined();
  });

  it('rejects non-string values, naming the key', () => {
    expect(() => normalizeMetadata({ retries: 3 })).toThrowError(
      /metadata\.retries: expected a string/,
    );
  });
});

describe('normalizeTools', () => {
  const weather = {
    type: 'function',
    name: 'get_weather',
    description: 'Look up the weather',
    parameters: { type: 'object', properties: { city: { type: 'string' } } },
  };

  it('accepts the canonical flat form', () => {
    expect(normalizeTools([weather])).toEqual([weather]);
  });

  it("accepts OpenAI's nested function form", () => {
    const tools = normalizeTools([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Look up the weather',
          parameters: { type: 'object', properties: {} },
        },
      },
    ]);
    expect(tools?.[0]).toMatchObject({ type: 'function', name: 'get_weather' });
  });

  it('accepts input_schema as an alias for parameters', () => {
    const tools = normalizeTools([
      { name: 'ping', input_schema: { type: 'object', properties: {} } },
    ]);
    expect(tools?.[0]?.parameters).toEqual({ type: 'object', properties: {} });
  });

  it('defaults missing parameters to an empty object schema', () => {
    expect(normalizeTools([{ name: 'ping' }])?.[0]?.parameters).toEqual({
      type: 'object',
      properties: {},
    });
  });

  it('treats an empty array as unset', () => {
    expect(normalizeTools([])).toBeUndefined();
  });

  it('rejects duplicate tool names', () => {
    expect(() => normalizeTools([{ name: 'ping' }, { name: 'ping' }])).toThrowError(
      /duplicate tool name "ping"/,
    );
  });

  it('rejects names the providers will not accept', () => {
    expect(() => normalizeTools([{ name: 'get weather' }])).toThrowError(/tool names must be/);
    expect(() => normalizeTools([{ name: '' }])).toThrowError(/tool names must be/);
  });

  it('rejects a non-object parameter schema', () => {
    expect(() => normalizeTools([{ name: 'ping', parameters: { type: 'string' } }])).toThrowError(
      /JSON Schema of type "object"/,
    );
  });
});

describe('normalizeToolChoice', () => {
  it.each(['auto', 'none', 'required'] as const)('accepts the %s shorthand', (value) => {
    expect(normalizeToolChoice(value)).toEqual({ type: value });
  });

  it('accepts the canonical forced-tool form', () => {
    expect(normalizeToolChoice({ type: 'tool', name: 'ping' })).toEqual({
      type: 'tool',
      name: 'ping',
    });
  });

  it("accepts OpenAI's forced-function form", () => {
    expect(normalizeToolChoice({ type: 'function', function: { name: 'ping' } })).toEqual({
      type: 'tool',
      name: 'ping',
    });
  });

  it('rejects an unknown shorthand', () => {
    expect(() => normalizeToolChoice('maybe')).toThrowError(
      /expected "auto", "none" or "required"/,
    );
  });

  it('rejects a forced tool with no name', () => {
    expect(() => normalizeToolChoice({ type: 'tool' })).toThrowError(/requires its name/);
  });
});

describe('assertToolChoiceResolvable', () => {
  const tools: NimbleTool[] = [{ type: 'function', name: 'ping', parameters: { type: 'object' } }];

  it('allows "none" without tools', () => {
    expect(() => assertToolChoiceResolvable({ type: 'none' }, undefined)).not.toThrow();
  });

  it('rejects "auto" without tools', () => {
    expect(() => assertToolChoiceResolvable({ type: 'auto' }, undefined)).toThrowError(
      /no tools were supplied/,
    );
  });

  it('rejects forcing a tool that was not declared', () => {
    expect(() => assertToolChoiceResolvable({ type: 'tool', name: 'other' }, tools)).toThrowError(
      /is not among the declared tools/,
    );
  });

  it('allows forcing a declared tool', () => {
    expect(() => assertToolChoiceResolvable({ type: 'tool', name: 'ping' }, tools)).not.toThrow();
  });
});

describe('normalizeResponseFormat', () => {
  it('accepts a bare type string', () => {
    expect(normalizeResponseFormat('json_object')).toEqual({ type: 'json_object' });
  });

  it('accepts the canonical flat json_schema form', () => {
    expect(
      normalizeResponseFormat({
        type: 'json_schema',
        name: 'Invoice',
        schema: { type: 'object' },
        strict: true,
      }),
    ).toEqual({ type: 'json_schema', name: 'Invoice', schema: { type: 'object' }, strict: true });
  });

  it("accepts OpenAI's nested json_schema form", () => {
    expect(
      normalizeResponseFormat({
        type: 'json_schema',
        json_schema: { name: 'Invoice', schema: { type: 'object' } },
      }),
    ).toEqual({ type: 'json_schema', name: 'Invoice', schema: { type: 'object' } });
  });

  it('requires a name and schema for json_schema output', () => {
    expect(() => normalizeResponseFormat({ type: 'json_schema' })).toThrowError(
      /requires a schema name/,
    );
    expect(() => normalizeResponseFormat({ type: 'json_schema', name: 'X' })).toThrowError(
      /expected an object/,
    );
  });

  it('rejects an unknown format', () => {
    expect(() => normalizeResponseFormat({ type: 'yaml' })).toThrowError(
      /expected "text", "json_object" or "json_schema"/,
    );
  });
});

describe('normalizeProviderOptions', () => {
  it('keeps per-provider blocks opaque', () => {
    expect(normalizeProviderOptions({ bedrock: { guardrailIdentifier: 'gr-1' } })).toEqual({
      bedrock: { guardrailIdentifier: 'gr-1' },
    });
  });

  it('treats an empty object as unset', () => {
    expect(normalizeProviderOptions({})).toBeUndefined();
  });

  it('rejects a block keyed by an unknown provider', () => {
    expect(() => normalizeProviderOptions({ cohere: {} })).toThrowError(/unknown provider/);
  });
});
