import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { formatPath, fromZodError, NimbleError } from '../src/errors.js';
import { deepFreeze } from '../src/util/freeze.js';

describe('NimbleError', () => {
  it('defaults retryable from the error code', () => {
    expect(new NimbleError('slow down', { code: 'rate_limited' }).retryable).toBe(true);
    expect(new NimbleError('bad input', { code: 'invalid_request' }).retryable).toBe(false);
  });

  it('lets an explicit retryable flag win', () => {
    expect(
      new NimbleError('upstream 503', { code: 'provider_error', retryable: true }).retryable,
    ).toBe(true);
  });

  it('preserves the underlying cause', () => {
    const cause = new Error('socket hang up');
    expect(new NimbleError('failed', { code: 'provider_error', cause }).cause).toBe(cause);
  });

  it('serializes to a loggable object without empty fields', () => {
    const json = new NimbleError('slow down', {
      code: 'rate_limited',
      provider: 'openai',
      status: 429,
    }).toJSON();

    expect(json).toEqual({
      name: 'NimbleError',
      code: 'rate_limited',
      message: 'slow down',
      provider: 'openai',
      status: 429,
      retryable: true,
    });
  });

  it('builds a single-field error with atPath', () => {
    const error = NimbleError.atPath('messages[0].role', 'is required');
    expect(error.message).toBe('messages[0].role: is required');
    expect(error.issues).toEqual([{ path: 'messages[0].role', message: 'is required' }]);
  });
});

describe('formatPath', () => {
  it.each([
    [[], '(root)'],
    [['model'], 'model'],
    [['messages', 0, 'content', 1, 'text'], 'messages[0].content[1].text'],
  ])('renders %j as %s', (path, expected) => {
    expect(formatPath(path)).toBe(expected);
  });
});

describe('fromZodError', () => {
  const schema = z.object({ temperature: z.number().max(2), topP: z.number() });

  it('summarizes a single issue inline', () => {
    const result = schema.safeParse({ temperature: 5, topP: 1 });
    const error = fromZodError(result.error!);
    expect(error.code).toBe('invalid_request');
    expect(error.issues).toHaveLength(1);
    expect(error.message).toMatch(/^temperature: /);
  });

  it('counts multiple issues in the summary', () => {
    const result = schema.safeParse({ temperature: 5, topP: 'x' });
    const error = fromZodError(result.error!);
    expect(error.issues).toHaveLength(2);
    expect(error.message).toBe('Request failed validation with 2 issues');
  });

  it('prefixes paths when validating a subtree', () => {
    const result = z.number().safeParse('x');
    expect(fromZodError(result.error!, ['params', 'temperature']).issues[0]?.path).toBe(
      'params.temperature',
    );
  });
});

describe('deepFreeze', () => {
  it('freezes nested objects and arrays', () => {
    const value = deepFreeze({ a: { b: [{ c: 1 }] } });
    expect(Object.isFrozen(value.a.b[0])).toBe(true);
  });

  it('traverses into an already-frozen container', () => {
    const inner = { mutable: true };
    const value = deepFreeze({ frozen: Object.freeze({ inner }) });
    expect(Object.isFrozen(value.frozen.inner)).toBe(true);
  });

  it('survives cycles', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => deepFreeze(cyclic)).not.toThrow();
  });
});
