import { describe, expect, it } from 'vitest';
import { CredentialRegistry } from '../../src/auth/credentials.js';
import { loadConfig, type NimbleConfig } from '../../src/config/config.js';

const context = {
  method: 'POST',
  url: new URL('https://bedrock-runtime.us-east-1.amazonaws.com/model/m/converse'),
  body: '{}',
  headers: { 'content-type': 'application/json' },
};

const registryFor = (env: Record<string, string>): CredentialRegistry =>
  new CredentialRegistry(loadConfig(env));

describe('CredentialRegistry', () => {
  it('reports which providers are configured', () => {
    const registry = registryFor({ OPENAI_API_KEY: 'sk' });
    expect(registry.has('openai')).toBe(true);
    expect(registry.has('bedrock')).toBe(false);
  });

  it('reuses the credentials it builds', () => {
    const registry = registryFor({ OPENAI_API_KEY: 'sk' });
    expect(registry.for('openai')).toBe(registry.for('openai'));
  });

  it.each([
    ['openai', /OPENAI_API_KEY/],
    ['azure', /AZURE_OPENAI_ENDPOINT/],
    ['bedrock', /AWS_REGION/],
    ['vertex', /GOOGLE_CLOUD_PROJECT/],
  ] as const)('names the variables missing for %s', (provider, pattern) => {
    const registry = registryFor({});
    expect(() => registry.for(provider)).toThrowError(pattern);
    expect(() => registry.for(provider)).toThrowError(
      expect.objectContaining({ code: 'authentication_error', provider }),
    );
  });

  it('does not let one unconfigured provider block another', () => {
    const registry = registryFor({ OPENAI_API_KEY: 'sk' });
    expect(() => registry.for('openai')).not.toThrow();
    expect(() => registry.for('azure')).toThrow();
  });
});

describe('OpenAICredentials', () => {
  it('sends the key as a bearer token', async () => {
    const credentials = registryFor({ OPENAI_API_KEY: 'sk-test' }).for('openai');
    expect(await credentials.authorize(context)).toEqual({ authorization: 'Bearer sk-test' });
  });

  it('adds organization and project headers when configured', async () => {
    const credentials = registryFor({
      OPENAI_API_KEY: 'sk',
      OPENAI_ORG_ID: 'org-1',
      OPENAI_PROJECT_ID: 'proj-1',
    }).for('openai');

    expect(await credentials.authorize(context)).toMatchObject({
      'openai-organization': 'org-1',
      'openai-project': 'proj-1',
    });
  });

  it('exposes the base URL for the client to build on', () => {
    expect(registryFor({ OPENAI_API_KEY: 'sk' }).for('openai').baseUrl).toBe(
      'https://api.openai.com',
    );
  });
});

describe('AzureCredentials', () => {
  const endpoint = { AZURE_OPENAI_ENDPOINT: 'https://r.openai.azure.com' };

  it('sends a resource key in the api-key header', async () => {
    const credentials = registryFor({ ...endpoint, AZURE_OPENAI_API_KEY: 'az' }).for('azure');
    expect(await credentials.authorize(context)).toEqual({ 'api-key': 'az' });
  });

  it('sends an Entra token as a bearer token', async () => {
    const credentials = registryFor({ ...endpoint, AZURE_OPENAI_ACCESS_TOKEN: 'ey' }).for('azure');
    expect(await credentials.authorize(context)).toEqual({ authorization: 'Bearer ey' });
  });

  it('prefers the Entra token when both are present', async () => {
    const credentials = registryFor({
      ...endpoint,
      AZURE_OPENAI_API_KEY: 'az',
      AZURE_OPENAI_ACCESS_TOKEN: 'ey',
    }).for('azure');

    expect(await credentials.authorize(context)).toEqual({ authorization: 'Bearer ey' });
  });

  it('rejects an endpoint with no credential at all', () => {
    // Reachable only through explicit config; the loader rejects it from env.
    const config: NimbleConfig = {
      azure: { baseUrl: 'https://r.openai.azure.com', apiVersion: '2024-10-21' },
      timeoutMs: 1000,
      maxRetries: 0,
    };
    expect(() => new CredentialRegistry(config).for('azure')).toThrowError(
      /credentials are incomplete/,
    );
  });
});

describe('BedrockCredentials', () => {
  const iam = {
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE',
    AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG',
  };

  it('signs the request with SigV4', async () => {
    const headers = await registryFor(iam).for('bedrock').authorize(context);

    expect(headers['authorization']).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/bedrock\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/,
    );
    expect(headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/);
    expect(headers['host']).toBe('bedrock-runtime.us-east-1.amazonaws.com');
  });

  it('signs over the body, so a different request signs differently', async () => {
    const credentials = registryFor(iam).for('bedrock');
    const a = await credentials.authorize({ ...context, body: '{"a":1}' });
    const b = await credentials.authorize({ ...context, body: '{"a":2}' });
    expect(a['authorization']).not.toBe(b['authorization']);
  });

  it('sends a Bedrock API key as a bearer token, skipping signing', async () => {
    const credentials = registryFor({
      AWS_REGION: 'us-east-1',
      AWS_BEARER_TOKEN_BEDROCK: 'bedrock-key',
    }).for('bedrock');

    expect(await credentials.authorize(context)).toEqual({
      authorization: 'Bearer bedrock-key',
    });
  });

  it('prefers the API key over IAM credentials when both are present', async () => {
    const credentials = registryFor({ ...iam, AWS_BEARER_TOKEN_BEDROCK: 'bedrock-key' }).for(
      'bedrock',
    );
    expect(await credentials.authorize(context)).toEqual({ authorization: 'Bearer bedrock-key' });
  });

  it('rejects an access key with no secret', () => {
    const config: NimbleConfig = {
      ...loadConfig({ AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'AKIA' }),
    };
    expect(() => new CredentialRegistry(config).for('bedrock')).toThrowError(
      /AWS_SECRET_ACCESS_KEY/,
    );
  });
});

describe('AnthropicCredentials', () => {
  it('sends the key in x-api-key, not as a bearer token', async () => {
    const credentials = registryFor({ ANTHROPIC_API_KEY: 'sk-ant-test' }).for('anthropic');
    const headers = await credentials.authorize(context);

    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers['authorization']).toBeUndefined();
  });

  it('pins the api version, which the endpoint requires on every request', async () => {
    const credentials = registryFor({ ANTHROPIC_API_KEY: 'sk-ant' }).for('anthropic');
    expect(await credentials.authorize(context)).toMatchObject({
      'anthropic-version': '2023-06-01',
    });
  });

  it('exposes the base URL for the client to build on', () => {
    expect(registryFor({ ANTHROPIC_API_KEY: 'sk-ant' }).for('anthropic').baseUrl).toBe(
      'https://api.anthropic.com',
    );
  });

  it('reports an unconfigured provider by naming the variable that would fix it', () => {
    expect(() => registryFor({}).for('anthropic')).toThrowError(/ANTHROPIC_API_KEY/);
  });
});

describe('VertexCredentials', () => {
  it('sends a pre-obtained access token as a bearer token', async () => {
    const credentials = registryFor({
      GOOGLE_ACCESS_TOKEN: 'ya29.static',
      VERTEX_PROJECT: 'p',
    }).for('vertex');

    expect(await credentials.authorize(context)).toEqual({
      authorization: 'Bearer ya29.static',
    });
  });

  it('exposes the regional endpoint', () => {
    const credentials = registryFor({
      GOOGLE_ACCESS_TOKEN: 'ya29',
      VERTEX_PROJECT: 'p',
      VERTEX_LOCATION: 'europe-west4',
    }).for('vertex');

    expect(credentials.baseUrl).toBe('https://europe-west4-aiplatform.googleapis.com');
  });

  it('rejects a project with no way to authenticate', () => {
    const config: NimbleConfig = {
      vertex: {
        project: 'p',
        location: 'us-central1',
        baseUrl: 'https://us-central1-aiplatform.googleapis.com',
      },
      timeoutMs: 1000,
      maxRetries: 0,
    };
    expect(() => new CredentialRegistry(config).for('vertex')).toThrowError(
      /credentials are incomplete/,
    );
  });
});
