import { describe, expect, it } from 'vitest';
import { NimbleError } from '../src/errors.js';
import { formatModelRef, isProviderId, parseModelRef } from '../src/core/model.js';

describe('parseModelRef', () => {
  it('splits a prefixed reference into provider and model', () => {
    expect(parseModelRef('openai/gpt-4o')).toEqual({
      provider: 'openai',
      model: 'gpt-4o',
      raw: 'openai/gpt-4o',
    });
  });

  it('splits on the first slash only, so nested model ids survive', () => {
    const ref = parseModelRef('vertex/publishers/google/models/gemini-2.0-flash');
    expect(ref.provider).toBe('vertex');
    expect(ref.model).toBe('publishers/google/models/gemini-2.0-flash');
  });

  it('keeps colons and dots in Bedrock model ids intact', () => {
    const ref = parseModelRef('bedrock/anthropic.claude-sonnet-4-20250514-v1:0');
    expect(ref.provider).toBe('bedrock');
    expect(ref.model).toBe('anthropic.claude-sonnet-4-20250514-v1:0');
  });

  it.each([
    ['aws/mistral.mistral-large-2407-v1:0', 'bedrock'],
    ['azure-openai/my-deployment', 'azure'],
    ['Google/gemini-2.0-flash', 'vertex'],
    ['OpenAI/gpt-4o-mini', 'openai'],
  ])('resolves the provider alias in %s', (input, expected) => {
    expect(parseModelRef(input).provider).toBe(expected);
  });

  it('falls back to defaultProvider when there is no prefix', () => {
    const ref = parseModelRef('gpt-4o', { defaultProvider: 'azure' });
    expect(ref).toEqual({ provider: 'azure', model: 'gpt-4o', raw: 'gpt-4o' });
  });

  it('treats an unrecognized prefix as part of the model name', () => {
    const ref = parseModelRef('anthropic/claude-sonnet-4', { defaultProvider: 'bedrock' });
    expect(ref.provider).toBe('bedrock');
    expect(ref.model).toBe('anthropic/claude-sonnet-4');
  });

  it('rejects an unprefixed reference when no default is configured', () => {
    expect(() => parseModelRef('gpt-4o')).toThrowError(
      expect.objectContaining({ code: 'unknown_provider' }),
    );
  });

  it.each([
    ['', 'must not be empty'],
    ['openai/', 'missing model id'],
  ])('rejects %j', (input, fragment) => {
    expect(() => parseModelRef(input)).toThrowError(new RegExp(fragment));
  });

  it('rejects a non-string reference with a field-level issue', () => {
    try {
      parseModelRef(42);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(NimbleError);
      expect((error as NimbleError).issues).toEqual([
        { path: 'model', message: 'expected a string, received a number' },
      ]);
    }
  });

  it('trims surrounding whitespace', () => {
    expect(parseModelRef('  openai/gpt-4o  ').model).toBe('gpt-4o');
  });

  it('returns a frozen reference', () => {
    expect(Object.isFrozen(parseModelRef('openai/gpt-4o'))).toBe(true);
  });
});

describe('formatModelRef', () => {
  it('round-trips a prefixed reference', () => {
    expect(formatModelRef(parseModelRef('openai/gpt-4o'))).toBe('openai/gpt-4o');
  });

  it('adds the resolved prefix to an unprefixed reference', () => {
    expect(formatModelRef(parseModelRef('gpt-4o', { defaultProvider: 'openai' }))).toBe(
      'openai/gpt-4o',
    );
  });
});

describe('isProviderId', () => {
  it('accepts known ids and rejects aliases', () => {
    expect(isProviderId('bedrock')).toBe(true);
    expect(isProviderId('aws')).toBe(false);
  });
});
