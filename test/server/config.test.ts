import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_PORT,
  isAuthorized,
  loadServerConfig,
  type ServerConfig,
} from '../../src/server/config.js';
import { Secret } from '../../src/config/secret.js';

const withKey = { NIMBLE_SERVER_API_KEYS: 'gw-key-one' };

describe('loadServerConfig', () => {
  it('applies defaults once a gateway key is present', () => {
    const config = loadServerConfig(withKey);
    expect(config).toMatchObject({
      port: DEFAULT_PORT,
      host: '0.0.0.0',
      maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
      logLevel: 'info',
      allowAnonymous: false,
    });
    expect(config.apiKeys).toHaveLength(1);
  });

  it('refuses to start unauthenticated by accident', () => {
    expect(() => loadServerConfig({})).toThrowError(/no gateway key is configured/);
    expect(() => loadServerConfig({})).toThrowError(/fronts your provider credentials/);
  });

  it('allows an open gateway only when asked outright', () => {
    const config = loadServerConfig({ NIMBLE_ALLOW_ANONYMOUS: 'true' });
    expect(config.allowAnonymous).toBe(true);
    expect(config.apiKeys).toEqual([]);
  });

  it('accepts the singular variable name too', () => {
    expect(loadServerConfig({ NIMBLE_SERVER_API_KEY: 'one' }).apiKeys).toHaveLength(1);
  });

  it('splits comma-separated keys, which is how rotation works', () => {
    const config = loadServerConfig({ NIMBLE_SERVER_API_KEYS: 'old-key, new-key ,' });
    expect(config.apiKeys.map((key) => key.reveal())).toEqual(['old-key', 'new-key']);
  });

  it('reads port, host and body limit', () => {
    const config = loadServerConfig({
      ...withKey,
      NIMBLE_PORT: '9000',
      NIMBLE_HOST: '127.0.0.1',
      NIMBLE_MAX_BODY_BYTES: '1024',
    });
    expect(config).toMatchObject({ port: 9000, host: '127.0.0.1', maxBodyBytes: 1024 });
  });

  it('reads the CORS origin only when set', () => {
    expect(loadServerConfig(withKey).corsOrigin).toBeUndefined();
    expect(
      loadServerConfig({ ...withKey, NIMBLE_CORS_ORIGIN: 'https://app.test' }).corsOrigin,
    ).toBe('https://app.test');
  });

  it.each(['debug', 'info', 'error', 'silent'] as const)('accepts log level %s', (level) => {
    expect(loadServerConfig({ ...withKey, NIMBLE_LOG_LEVEL: level }).logLevel).toBe(level);
  });

  it.each([
    ['NIMBLE_PORT', '0', /positive integer/],
    ['NIMBLE_PORT', '70000', /valid port/],
    ['NIMBLE_MAX_BODY_BYTES', 'big', /positive integer/],
    ['NIMBLE_LOG_LEVEL', 'chatty', /must be one of/],
    ['NIMBLE_ALLOW_ANONYMOUS', 'perhaps', /must be true or false/],
  ])('rejects %s=%s', (name, value, pattern) => {
    expect(() => loadServerConfig({ ...withKey, [name]: value })).toThrowError(pattern);
  });
});

describe('isAuthorized', () => {
  const config = loadServerConfig({ NIMBLE_SERVER_API_KEYS: 'old-key,new-key' });

  it.each(['old-key', 'new-key'])('accepts the configured key %s', (key) => {
    expect(isAuthorized(config, `Bearer ${key}`)).toBe(true);
  });

  it('accepts the scheme case-insensitively, with extra whitespace', () => {
    expect(isAuthorized(config, '  bearer   old-key  ')).toBe(true);
  });

  it.each([
    ['a wrong key', 'Bearer nope'],
    ['no scheme', 'old-key'],
    ['the wrong scheme', 'Basic old-key'],
    ['an empty token', 'Bearer '],
  ])('rejects %s', (_label, header) => {
    expect(isAuthorized(config, header)).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(isAuthorized(config, undefined)).toBe(false);
  });

  it('does not accept a prefix of a valid key', () => {
    expect(isAuthorized(config, 'Bearer old')).toBe(false);
  });

  it('accepts anything when anonymous access is enabled', () => {
    const open: ServerConfig = { ...config, allowAnonymous: true, apiKeys: [] };
    expect(isAuthorized(open, undefined)).toBe(true);
  });

  it('rejects everything when keys are configured but none match', () => {
    const single: ServerConfig = { ...config, apiKeys: [new Secret('only')] };
    expect(isAuthorized(single, 'Bearer other')).toBe(false);
    expect(isAuthorized(single, 'Bearer only')).toBe(true);
  });
});
