import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  configuredProviders,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  loadConfig,
  secretsIn,
  withOverrides,
  type Env,
} from '../../src/config/config.js';
import { Secret } from '../../src/config/secret.js';

const SERVICE_ACCOUNT = {
  type: 'service_account',
  project_id: 'from-key',
  client_email: 'bot@from-key.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n',
};

function writeKeyFile(contents: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'nimblellm-')), 'key.json');
  writeFileSync(path, contents);
  return path;
}

describe('loadConfig', () => {
  it('returns only defaults when nothing is set', () => {
    const config = loadConfig({});
    expect(configuredProviders(config)).toEqual([]);
    expect(config.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(config.maxRetries).toBe(DEFAULT_MAX_RETRIES);
  });

  it('does not read the ambient environment when given one', () => {
    expect(loadConfig({} satisfies Env).openai).toBeUndefined();
  });

  describe('openai', () => {
    it('loads a key and defaults the base URL', () => {
      const config = loadConfig({ OPENAI_API_KEY: 'sk-test' });
      expect(config.openai?.apiKey.reveal()).toBe('sk-test');
      expect(config.openai?.baseUrl).toBe('https://api.openai.com');
    });

    it('accepts an overridden base URL and strips the trailing slash', () => {
      const config = loadConfig({ OPENAI_API_KEY: 'sk', OPENAI_BASE_URL: 'https://proxy.test/' });
      expect(config.openai?.baseUrl).toBe('https://proxy.test');
    });

    it('carries organization and project when present', () => {
      const config = loadConfig({
        OPENAI_API_KEY: 'sk',
        OPENAI_ORG_ID: 'org-1',
        OPENAI_PROJECT_ID: 'proj-1',
      });
      expect(config.openai).toMatchObject({ organization: 'org-1', project: 'proj-1' });
    });
  });

  describe('azure', () => {
    it('loads an endpoint, key and default api version', () => {
      const config = loadConfig({
        AZURE_OPENAI_API_KEY: 'az-key',
        AZURE_OPENAI_ENDPOINT: 'https://r.openai.azure.com',
      });
      expect(config.azure).toMatchObject({
        baseUrl: 'https://r.openai.azure.com',
        apiVersion: '2024-10-21',
      });
    });

    it('accepts an Entra access token instead of a key', () => {
      const config = loadConfig({
        AZURE_OPENAI_ACCESS_TOKEN: 'ey-token',
        AZURE_OPENAI_ENDPOINT: 'https://r.openai.azure.com',
      });
      expect(config.azure?.accessToken?.reveal()).toBe('ey-token');
      expect(config.azure?.apiKey).toBeUndefined();
    });

    it('rejects credentials with no endpoint', () => {
      expect(() => loadConfig({ AZURE_OPENAI_API_KEY: 'az-key' })).toThrowError(
        /AZURE_OPENAI_ENDPOINT is required/,
      );
    });
  });

  describe('bedrock', () => {
    it('derives the regional endpoint from the region', () => {
      const config = loadConfig({
        AWS_ACCESS_KEY_ID: 'AKIA',
        AWS_SECRET_ACCESS_KEY: 'secret',
        AWS_REGION: 'eu-west-1',
      });
      expect(config.bedrock).toMatchObject({
        region: 'eu-west-1',
        baseUrl: 'https://bedrock-runtime.eu-west-1.amazonaws.com',
      });
    });

    it('accepts AWS_DEFAULT_REGION as a fallback', () => {
      const config = loadConfig({ AWS_ACCESS_KEY_ID: 'AKIA', AWS_DEFAULT_REGION: 'us-west-2' });
      expect(config.bedrock?.region).toBe('us-west-2');
    });

    it('loads a Bedrock API key without IAM credentials', () => {
      const config = loadConfig({
        AWS_BEARER_TOKEN_BEDROCK: 'bedrock-key',
        AWS_REGION: 'us-east-1',
      });
      expect(config.bedrock?.apiKey?.reveal()).toBe('bedrock-key');
      expect(config.bedrock?.accessKeyId).toBeUndefined();
    });

    it('carries a session token for temporary credentials', () => {
      const config = loadConfig({
        AWS_ACCESS_KEY_ID: 'ASIA',
        AWS_SECRET_ACCESS_KEY: 'secret',
        AWS_SESSION_TOKEN: 'token',
        AWS_REGION: 'us-east-1',
      });
      expect(config.bedrock?.sessionToken?.reveal()).toBe('token');
    });

    it('rejects credentials with no region', () => {
      expect(() => loadConfig({ AWS_ACCESS_KEY_ID: 'AKIA' })).toThrowError(
        /AWS_REGION is required/,
      );
    });

    it('ignores an environment that has AWS variables but no credentials', () => {
      expect(loadConfig({ AWS_REGION: 'us-east-1' }).bedrock).toBeUndefined();
    });
  });

  describe('vertex', () => {
    it('loads an inline service account and defaults the location', () => {
      const config = loadConfig({
        GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(SERVICE_ACCOUNT),
        GOOGLE_CLOUD_PROJECT: 'my-project',
      });

      expect(config.vertex).toMatchObject({
        project: 'my-project',
        location: 'us-central1',
        baseUrl: 'https://us-central1-aiplatform.googleapis.com',
      });
      expect(config.vertex?.serviceAccount?.clientEmail).toBe(SERVICE_ACCOUNT.client_email);
    });

    it('takes the project from the key when no variable sets one', () => {
      const config = loadConfig({ GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(SERVICE_ACCOUNT) });
      expect(config.vertex?.project).toBe('from-key');
    });

    it('reads a key file named by GOOGLE_APPLICATION_CREDENTIALS', () => {
      const path = writeKeyFile(JSON.stringify(SERVICE_ACCOUNT));
      const config = loadConfig({ GOOGLE_APPLICATION_CREDENTIALS: path });
      expect(config.vertex?.serviceAccount?.privateKey.reveal()).toContain('BEGIN PRIVATE KEY');
    });

    it('derives the endpoint from a non-default location', () => {
      const config = loadConfig({
        GOOGLE_ACCESS_TOKEN: 'ya29.token',
        GOOGLE_CLOUD_PROJECT: 'p',
        VERTEX_LOCATION: 'europe-west4',
      });
      expect(config.vertex?.baseUrl).toBe('https://europe-west4-aiplatform.googleapis.com');
    });

    it('accepts a pre-obtained access token', () => {
      const config = loadConfig({ GOOGLE_ACCESS_TOKEN: 'ya29.token', VERTEX_PROJECT: 'p' });
      expect(config.vertex?.accessToken?.reveal()).toBe('ya29.token');
      expect(config.vertex?.serviceAccount).toBeUndefined();
    });

    it('rejects a key file that does not exist', () => {
      expect(() =>
        loadConfig({ GOOGLE_APPLICATION_CREDENTIALS: '/nonexistent/key.json' }),
      ).toThrowError(/could not read the service account key/);
    });

    it('rejects a key that is not JSON', () => {
      expect(() => loadConfig({ GOOGLE_SERVICE_ACCOUNT_JSON: 'not json' })).toThrowError(
        /not valid JSON/,
      );
    });

    it('rejects a key missing its email or private key', () => {
      expect(() =>
        loadConfig({ GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ project_id: 'p' }) }),
      ).toThrowError(/must contain "client_email" and "private_key"/);
    });

    it('rejects credentials with no project anywhere', () => {
      const { project_id: _dropped, ...withoutProject } = SERVICE_ACCOUNT;
      expect(() =>
        loadConfig({ GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(withoutProject) }),
      ).toThrowError(/GOOGLE_CLOUD_PROJECT.*is required/);
    });
  });

  describe('anthropic', () => {
    it('loads a key and defaults the base URL and version', () => {
      const config = loadConfig({ ANTHROPIC_API_KEY: 'sk-ant-test' });
      expect(config.anthropic?.apiKey.reveal()).toBe('sk-ant-test');
      expect(config.anthropic?.baseUrl).toBe('https://api.anthropic.com');
      expect(config.anthropic?.version).toBe('2023-06-01');
    });

    it('accepts an overridden base URL and strips the trailing slash', () => {
      const config = loadConfig({
        ANTHROPIC_API_KEY: 'sk-ant',
        ANTHROPIC_BASE_URL: 'https://proxy.test/',
      });
      expect(config.anthropic?.baseUrl).toBe('https://proxy.test');
    });

    it('lets the api version be pinned elsewhere', () => {
      const config = loadConfig({ ANTHROPIC_API_KEY: 'sk-ant', ANTHROPIC_VERSION: '2024-01-01' });
      expect(config.anthropic?.version).toBe('2024-01-01');
    });

    it('is absent without a key, whatever else is set', () => {
      expect(loadConfig({ ANTHROPIC_BASE_URL: 'https://proxy.test' }).anthropic).toBeUndefined();
    });
  });

  describe('client-wide settings', () => {
    it('reads the default provider', () => {
      expect(loadConfig({ NIMBLE_DEFAULT_PROVIDER: 'bedrock' }).defaultProvider).toBe('bedrock');
    });

    it('rejects an unknown default provider', () => {
      expect(() => loadConfig({ NIMBLE_DEFAULT_PROVIDER: 'cohere' })).toThrowError(
        /not a known provider/,
      );
    });

    it('reads timeout and retry settings', () => {
      const config = loadConfig({ NIMBLE_TIMEOUT_MS: '5000', NIMBLE_MAX_RETRIES: '0' });
      expect(config.timeoutMs).toBe(5000);
      expect(config.maxRetries).toBe(0);
    });

    it.each([
      ['NIMBLE_TIMEOUT_MS', 'abc', /must be an integer/],
      ['NIMBLE_TIMEOUT_MS', '0', /must be a positive integer/],
      ['NIMBLE_MAX_RETRIES', '-1', /must be zero or a positive integer/],
    ])('rejects %s=%s', (name, value, pattern) => {
      expect(() => loadConfig({ [name]: value })).toThrowError(pattern);
    });
  });
});

describe('withOverrides', () => {
  const base = loadConfig({ OPENAI_API_KEY: 'sk' });

  it('replaces scalar settings', () => {
    expect(withOverrides(base, { maxRetries: 5 }).maxRetries).toBe(5);
  });

  it('leaves untouched settings alone', () => {
    expect(withOverrides(base, { maxRetries: 5 }).openai?.apiKey.reveal()).toBe('sk');
  });

  it('ignores explicitly undefined overrides', () => {
    expect(withOverrides(base, { maxRetries: undefined }).maxRetries).toBe(DEFAULT_MAX_RETRIES);
  });

  it('replaces a provider block wholesale', () => {
    const replaced = withOverrides(base, {
      openai: { apiKey: new Secret('sk-other'), baseUrl: 'https://other.test' },
    });
    expect(replaced.openai?.baseUrl).toBe('https://other.test');
    expect(replaced.openai?.apiKey.reveal()).toBe('sk-other');
  });
});

describe('secretsIn', () => {
  it('collects every credential held in a configuration', () => {
    const config = loadConfig({
      OPENAI_API_KEY: 'sk',
      AWS_ACCESS_KEY_ID: 'AKIA',
      AWS_SECRET_ACCESS_KEY: 'secret',
      AWS_SESSION_TOKEN: 'token',
      AWS_REGION: 'us-east-1',
      GOOGLE_ACCESS_TOKEN: 'ya29',
      VERTEX_PROJECT: 'p',
    });

    expect(
      secretsIn(config)
        .map((s) => s.reveal())
        .sort(),
    ).toEqual(['AKIA', 'secret', 'sk', 'token', 'ya29']);
  });

  it('returns nothing for an empty configuration', () => {
    expect(secretsIn(loadConfig({}))).toEqual([]);
  });
});
