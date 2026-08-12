import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { redact, Secret } from '../../src/config/secret.js';

describe('Secret', () => {
  const secret = new Secret('sk-super-secret-value', 'OPENAI_API_KEY');

  it('returns the value only when asked explicitly', () => {
    expect(secret.reveal()).toBe('sk-super-secret-value');
  });

  it('renders as [redacted] when interpolated', () => {
    expect(`key=${secret}`).toBe('key=[redacted]');
    expect(String(secret)).toBe('[redacted]');
  });

  it('renders as [redacted] when serialized', () => {
    expect(JSON.stringify({ apiKey: secret })).toBe('{"apiKey":"[redacted]"}');
  });

  it('renders as [redacted] under console.log', () => {
    expect(inspect(secret)).toBe('Secret(OPENAI_API_KEY) [redacted]');
    expect(inspect({ apiKey: secret })).toContain('[redacted]');
  });

  it('does not expose the value through spread or enumeration', () => {
    expect(Object.keys({ ...secret })).toEqual(['label']);
    expect(JSON.stringify(Object.values({ ...secret }))).not.toContain('super-secret');
  });

  it('reports its length without disclosing the value', () => {
    expect(secret.length).toBe('sk-super-secret-value'.length);
  });

  it('hints at the tail of a long value', () => {
    expect(secret.hint()).toBe('…alue');
  });

  it('withholds a hint for a value short enough to guess', () => {
    expect(new Secret('short').hint()).toBe('[redacted]');
  });

  it('compares without early exit on content', () => {
    expect(secret.equals(new Secret('sk-super-secret-value'))).toBe(true);
    expect(secret.equals(new Secret('sk-super-secret-valuf'))).toBe(false);
    expect(secret.equals(new Secret('different-length'))).toBe(false);
  });

  it('rejects an empty value', () => {
    expect(() => new Secret('')).toThrowError(/non-empty string/);
  });

  describe('from', () => {
    it('wraps a string', () => {
      expect(Secret.from('abc')?.reveal()).toBe('abc');
    });

    it('trims surrounding whitespace, which env files often carry', () => {
      expect(Secret.from('  abc\n')?.reveal()).toBe('abc');
    });

    it('treats absent and blank as unset', () => {
      expect(Secret.from(undefined)).toBeUndefined();
      expect(Secret.from('   ')).toBeUndefined();
    });

    it('passes an existing Secret through', () => {
      expect(Secret.from(secret)).toBe(secret);
    });
  });
});

describe('redact', () => {
  const key = new Secret('sk-abcdefghijklmnop');

  it('removes a secret from text', () => {
    expect(redact('failed with key sk-abcdefghijklmnop', [key])).toBe('failed with key [redacted]');
  });

  it('removes every occurrence', () => {
    expect(redact('sk-abcdefghijklmnop and sk-abcdefghijklmnop', [key])).toBe(
      '[redacted] and [redacted]',
    );
  });

  it('ignores absent entries', () => {
    expect(redact('nothing to do', [undefined])).toBe('nothing to do');
  });

  it('leaves short secrets alone, to avoid mangling unrelated text', () => {
    expect(redact('the region is us-east-1', [new Secret('east')])).toBe('the region is us-east-1');
  });
});
