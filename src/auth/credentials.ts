/**
 * Turning configuration into request headers.
 *
 * Each provider authenticates differently — a bearer key, a resource key, an
 * `x-api-key`, a SigV4 signature, a minted OAuth token — so this is where those
 * shapes collapse back into "headers to add to this request".
 *
 * A `Credentials` object never exposes its secrets; it only produces headers
 * for a request it has been shown.
 */

import { NimbleError } from '../errors.js';
import type {
  AnthropicConfig,
  AzureConfig,
  BedrockConfig,
  NimbleConfig,
  OpenAIConfig,
  VertexConfig,
} from '../config/config.js';
import type { ProviderId } from '../types.js';
import { ServiceAccountTokenSource, StaticTokenSource, type TokenSource } from './google.js';
import { signRequest } from './sigv4.js';

/** The request being authorized, as far as the credential needs to see it. */
export interface SigningContext {
  readonly method: string;
  readonly url: URL;
  /** Serialized request body, which SigV4 has to hash. */
  readonly body: string;
  /** Headers already set, which SigV4 has to include in the signature. */
  readonly headers: Readonly<Record<string, string>>;
}

export interface Credentials {
  readonly provider: ProviderId;
  /** Provider origin, with no trailing slash. */
  readonly baseUrl: string;
  /** Headers to merge into the outgoing request. */
  authorize(context: SigningContext): Promise<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

export class OpenAICredentials implements Credentials {
  readonly provider = 'openai' as const;
  readonly baseUrl: string;
  readonly #config: OpenAIConfig;

  constructor(config: OpenAIConfig) {
    this.#config = config;
    this.baseUrl = config.baseUrl;
  }

  async authorize(): Promise<Record<string, string>> {
    return {
      authorization: `Bearer ${this.#config.apiKey.reveal()}`,
      ...(this.#config.organization === undefined
        ? {}
        : { 'openai-organization': this.#config.organization }),
      ...(this.#config.project === undefined ? {} : { 'openai-project': this.#config.project }),
    };
  }
}

// ---------------------------------------------------------------------------
// Azure OpenAI
// ---------------------------------------------------------------------------

export class AzureCredentials implements Credentials {
  readonly provider = 'azure' as const;
  readonly baseUrl: string;
  readonly #config: AzureConfig;

  constructor(config: AzureConfig) {
    if (config.apiKey === undefined && config.accessToken === undefined) {
      throw missingCredentials('azure', [
        'AZURE_OPENAI_API_KEY (resource key)',
        'AZURE_OPENAI_ACCESS_TOKEN (Entra ID token)',
      ]);
    }
    this.#config = config;
    this.baseUrl = config.baseUrl;
  }

  async authorize(): Promise<Record<string, string>> {
    // An Entra token wins when both are present: it is the narrower credential.
    if (this.#config.accessToken !== undefined) {
      return { authorization: `Bearer ${this.#config.accessToken.reveal()}` };
    }
    return { 'api-key': this.#config.apiKey?.reveal() ?? '' };
  }
}

// ---------------------------------------------------------------------------
// AWS Bedrock
// ---------------------------------------------------------------------------

export class BedrockCredentials implements Credentials {
  readonly provider = 'bedrock' as const;
  readonly baseUrl: string;
  readonly #config: BedrockConfig;

  constructor(config: BedrockConfig) {
    if (config.apiKey === undefined && config.accessKeyId === undefined) {
      throw missingCredentials('bedrock', [
        'AWS_BEARER_TOKEN_BEDROCK (Bedrock API key)',
        'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (IAM credentials)',
      ]);
    }
    if (config.apiKey === undefined && config.secretAccessKey === undefined) {
      throw missingCredentials('bedrock', ['AWS_SECRET_ACCESS_KEY']);
    }
    this.#config = config;
    this.baseUrl = config.baseUrl;
  }

  async authorize(context: SigningContext): Promise<Record<string, string>> {
    // A Bedrock API key is a plain bearer token and needs no signing.
    if (this.#config.apiKey !== undefined) {
      return { authorization: `Bearer ${this.#config.apiKey.reveal()}` };
    }

    const { accessKeyId, secretAccessKey, sessionToken } = this.#config;
    /* c8 ignore next 3 -- guarded by the constructor; here for type narrowing */
    if (accessKeyId === undefined || secretAccessKey === undefined) {
      throw missingCredentials('bedrock', ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']);
    }

    const { headers } = signRequest({
      method: context.method,
      url: context.url,
      headers: context.headers,
      body: context.body,
      region: this.#config.region,
      service: 'bedrock',
      credentials: { accessKeyId, secretAccessKey, sessionToken },
    });

    return headers;
  }
}

// ---------------------------------------------------------------------------
// Google Vertex AI
// ---------------------------------------------------------------------------

export interface VertexCredentialsOptions {
  /** Injectable for tests; forwarded to the token source. */
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
}

export class VertexCredentials implements Credentials {
  readonly provider = 'vertex' as const;
  readonly baseUrl: string;
  readonly #tokens: TokenSource;

  constructor(config: VertexConfig, options: VertexCredentialsOptions = {}) {
    this.baseUrl = config.baseUrl;

    if (config.serviceAccount !== undefined) {
      this.#tokens = new ServiceAccountTokenSource(config.serviceAccount, {
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.now === undefined ? {} : { now: options.now }),
      });
    } else if (config.accessToken !== undefined) {
      this.#tokens = new StaticTokenSource(config.accessToken);
    } else {
      throw missingCredentials('vertex', [
        'GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_SERVICE_ACCOUNT_JSON (service account key)',
        'GOOGLE_ACCESS_TOKEN (pre-obtained OAuth token)',
      ]);
    }
  }

  async authorize(): Promise<Record<string, string>> {
    const token = await this.#tokens.token();
    return { authorization: `Bearer ${token.reveal()}` };
  }
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

/**
 * Anthropic is the one provider that authenticates with neither a bearer token
 * nor a signature: the key goes in `x-api-key`, unprefixed.
 *
 * `anthropic-version` rides along here despite not being a credential. It is
 * configuration rather than anything derived from the request, and this is the
 * layer that holds configuration — the alternative, routing it through
 * `providerOptions` the way Azure's API version travels, would put it in the
 * request *body*, where Anthropic would reject it as an unknown field.
 */
export class AnthropicCredentials implements Credentials {
  readonly provider = 'anthropic' as const;
  readonly baseUrl: string;
  readonly #config: AnthropicConfig;

  constructor(config: AnthropicConfig) {
    this.#config = config;
    this.baseUrl = config.baseUrl;
  }

  async authorize(): Promise<Record<string, string>> {
    return {
      'x-api-key': this.#config.apiKey.reveal(),
      'anthropic-version': this.#config.version,
    };
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface CredentialRegistryOptions extends VertexCredentialsOptions {}

/**
 * Credentials for every provider that has configuration, built once and reused.
 *
 * Construction is lazy per provider so that a malformed Azure block does not
 * stop an OpenAI-only deployment from starting.
 */
export class CredentialRegistry {
  readonly #config: NimbleConfig;
  readonly #options: CredentialRegistryOptions;
  readonly #cache = new Map<ProviderId, Credentials>();

  constructor(config: NimbleConfig, options: CredentialRegistryOptions = {}) {
    this.#config = config;
    this.#options = options;
  }

  /**
   * Credentials for a provider.
   *
   * @throws NimbleError - `authentication_error` when the provider has no
   *   configuration, naming the variables that would supply it
   */
  for(provider: ProviderId): Credentials {
    const cached = this.#cache.get(provider);
    if (cached !== undefined) return cached;

    const credentials = this.#build(provider);
    this.#cache.set(provider, credentials);
    return credentials;
  }

  /** Whether a provider has usable configuration, without constructing it. */
  has(provider: ProviderId): boolean {
    return this.#config[provider] !== undefined;
  }

  #build(provider: ProviderId): Credentials {
    switch (provider) {
      case 'openai': {
        const config = this.#config.openai;
        if (config === undefined) throw notConfigured('openai', ['OPENAI_API_KEY']);
        return new OpenAICredentials(config);
      }
      case 'azure': {
        const config = this.#config.azure;
        if (config === undefined) {
          throw notConfigured('azure', ['AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_API_KEY']);
        }
        return new AzureCredentials(config);
      }
      case 'bedrock': {
        const config = this.#config.bedrock;
        if (config === undefined) {
          throw notConfigured('bedrock', [
            'AWS_REGION',
            'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or AWS_BEARER_TOKEN_BEDROCK',
          ]);
        }
        return new BedrockCredentials(config);
      }
      case 'vertex': {
        const config = this.#config.vertex;
        if (config === undefined) {
          throw notConfigured('vertex', [
            'GOOGLE_CLOUD_PROJECT',
            'GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_ACCESS_TOKEN',
          ]);
        }
        return new VertexCredentials(config, this.#options);
      }
      case 'anthropic': {
        const config = this.#config.anthropic;
        if (config === undefined) throw notConfigured('anthropic', ['ANTHROPIC_API_KEY']);
        return new AnthropicCredentials(config);
      }
    }
  }
}

function notConfigured(provider: ProviderId, variables: readonly string[]): NimbleError {
  return new NimbleError(`${provider} is not configured. Set ${variables.join(', ')}.`, {
    code: 'authentication_error',
    provider,
  });
}

function missingCredentials(provider: ProviderId, alternatives: readonly string[]): NimbleError {
  return new NimbleError(
    `${provider} credentials are incomplete. Supply one of: ${alternatives.join('; ')}.`,
    { code: 'authentication_error', provider },
  );
}
