/**
 * Per-instance configuration.
 *
 * v1 is single-tenant by design: one deployment holds one set of credentials.
 * There is no per-caller credential routing and no credential store — that is
 * a deliberate boundary, not an omission, and it keeps the blast radius of this
 * module to a single process's environment.
 *
 * Every provider block is optional. Configuring OpenAI does not oblige you to
 * configure Azure; routing to a provider you never configured fails at call
 * time with `authentication_error`, naming the variables that were missing.
 */

import { readFileSync } from 'node:fs';
import { NimbleError } from '../errors.js';
import { PROVIDER_IDS, type ProviderId } from '../types.js';
import { Secret } from './secret.js';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface OpenAIConfig {
  readonly apiKey: Secret;
  /** Override for a proxy or a compatible gateway. */
  readonly baseUrl: string;
  readonly organization?: string;
  readonly project?: string;
}

export interface AzureConfig {
  /** Resource endpoint, e.g. `https://my-resource.openai.azure.com`. */
  readonly baseUrl: string;
  readonly apiVersion: string;
  /** Resource key. Mutually exclusive with `accessToken`. */
  readonly apiKey?: Secret;
  /** Microsoft Entra ID bearer token, for keyless deployments. */
  readonly accessToken?: Secret;
}

export interface BedrockConfig {
  readonly region: string;
  readonly baseUrl: string;
  /** Bedrock API key, sent as a bearer token. Takes precedence over SigV4. */
  readonly apiKey?: Secret;
  readonly accessKeyId?: Secret;
  readonly secretAccessKey?: Secret;
  /** Session token, required when using temporary STS credentials. */
  readonly sessionToken?: Secret;
}

export interface VertexServiceAccount {
  readonly clientEmail: string;
  readonly privateKey: Secret;
}

export interface VertexConfig {
  readonly project: string;
  readonly location: string;
  readonly baseUrl: string;
  /** A pre-obtained OAuth access token, refreshed by the caller. */
  readonly accessToken?: Secret;
  /** A service account key, from which access tokens are minted and cached. */
  readonly serviceAccount?: VertexServiceAccount;
}

export interface NimbleConfig {
  readonly openai?: OpenAIConfig;
  readonly azure?: AzureConfig;
  readonly bedrock?: BedrockConfig;
  readonly vertex?: VertexConfig;

  /** Provider assumed for model references with no `provider/` prefix. */
  readonly defaultProvider?: ProviderId;
  /** Per-request deadline, including retries. */
  readonly timeoutMs: number;
  /** Retries after the first attempt, for retryable failures only. */
  readonly maxRetries: number;
}

/**
 * Partial configuration, where an explicitly-`undefined` field means "leave the
 * base value alone" — the shape you get from spreading optional call options.
 */
export type ConfigOverrides = { [K in keyof NimbleConfig]?: NimbleConfig[K] | undefined };

export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com';
export const DEFAULT_VERTEX_LOCATION = 'us-central1';
/** Matches the default pinned by the Azure adapter in `describeRoute`. */
export const DEFAULT_AZURE_API_VERSION = '2024-10-21';

/** A record of environment variables, i.e. the shape of `process.env`. */
export type Env = Readonly<Record<string, string | undefined>>;

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Build configuration from environment variables.
 *
 * Reads only what is present: a provider block appears in the result if and
 * only if its credentials were supplied. Nothing is validated against a live
 * service here — that happens on the first call.
 *
 * @param env - variables to read, defaulting to `process.env`
 * @throws NimbleError - `invalid_request` when a variable is present but
 *   malformed (an unparseable service account, a non-numeric timeout)
 *
 * @example
 * ```bash
 * export OPENAI_API_KEY=sk-...
 * export AWS_REGION=us-east-1
 * ```
 * ```ts
 * const config = loadConfig();
 * config.openai?.baseUrl;  // 'https://api.openai.com'
 * config.bedrock?.region;  // 'us-east-1'
 * ```
 */
export function loadConfig(env: Env = process.env): NimbleConfig {
  const openai = loadOpenAI(env);
  const azure = loadAzure(env);
  const bedrock = loadBedrock(env);
  const vertex = loadVertex(env);
  const defaultProvider = readProvider(env['NIMBLE_DEFAULT_PROVIDER']);

  return {
    ...(openai === undefined ? {} : { openai }),
    ...(azure === undefined ? {} : { azure }),
    ...(bedrock === undefined ? {} : { bedrock }),
    ...(vertex === undefined ? {} : { vertex }),
    ...(defaultProvider === undefined ? {} : { defaultProvider }),
    timeoutMs: readPositiveInt(env['NIMBLE_TIMEOUT_MS'], 'NIMBLE_TIMEOUT_MS') ?? DEFAULT_TIMEOUT_MS,
    maxRetries:
      readNonNegativeInt(env['NIMBLE_MAX_RETRIES'], 'NIMBLE_MAX_RETRIES') ?? DEFAULT_MAX_RETRIES,
  };
}

/**
 * Merge explicit overrides onto a base configuration.
 *
 * Provider blocks are replaced wholesale rather than deep-merged, so a partial
 * override cannot leave a block half-configured from two sources.
 */
export function withOverrides(base: NimbleConfig, overrides: ConfigOverrides = {}): NimbleConfig {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged as unknown as NimbleConfig;
}

/** Provider ids that have credentials configured. */
export function configuredProviders(config: NimbleConfig): readonly ProviderId[] {
  return PROVIDER_IDS.filter((id) => config[id] !== undefined);
}

/** Every secret held in a configuration, for redaction. */
export function secretsIn(config: NimbleConfig): readonly Secret[] {
  const secrets = [
    config.openai?.apiKey,
    config.azure?.apiKey,
    config.azure?.accessToken,
    config.bedrock?.apiKey,
    config.bedrock?.accessKeyId,
    config.bedrock?.secretAccessKey,
    config.bedrock?.sessionToken,
    config.vertex?.accessToken,
    config.vertex?.serviceAccount?.privateKey,
  ];
  return secrets.filter((secret): secret is Secret => secret !== undefined);
}

// ---------------------------------------------------------------------------
// Per-provider loaders
// ---------------------------------------------------------------------------

function loadOpenAI(env: Env): OpenAIConfig | undefined {
  const apiKey = Secret.from(env['OPENAI_API_KEY'], 'OPENAI_API_KEY');
  if (apiKey === undefined) return undefined;

  const organization = readString(env['OPENAI_ORG_ID']);
  const project = readString(env['OPENAI_PROJECT_ID']);

  return {
    apiKey,
    baseUrl: trimSlash(readString(env['OPENAI_BASE_URL']) ?? DEFAULT_OPENAI_BASE_URL),
    ...(organization === undefined ? {} : { organization }),
    ...(project === undefined ? {} : { project }),
  };
}

function loadAzure(env: Env): AzureConfig | undefined {
  const baseUrl = readString(env['AZURE_OPENAI_ENDPOINT']);
  const apiKey = Secret.from(env['AZURE_OPENAI_API_KEY'], 'AZURE_OPENAI_API_KEY');
  const accessToken = Secret.from(env['AZURE_OPENAI_ACCESS_TOKEN'], 'AZURE_OPENAI_ACCESS_TOKEN');

  if (baseUrl === undefined && apiKey === undefined && accessToken === undefined) return undefined;

  if (baseUrl === undefined) {
    throw configError(
      'AZURE_OPENAI_ENDPOINT is required alongside Azure credentials (e.g. https://my-resource.openai.azure.com)',
      'AZURE_OPENAI_ENDPOINT',
    );
  }

  return {
    baseUrl: trimSlash(baseUrl),
    apiVersion: readString(env['AZURE_OPENAI_API_VERSION']) ?? DEFAULT_AZURE_API_VERSION,
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(accessToken === undefined ? {} : { accessToken }),
  };
}

function loadBedrock(env: Env): BedrockConfig | undefined {
  const apiKey = Secret.from(env['AWS_BEARER_TOKEN_BEDROCK'], 'AWS_BEARER_TOKEN_BEDROCK');
  const accessKeyId = Secret.from(env['AWS_ACCESS_KEY_ID'], 'AWS_ACCESS_KEY_ID');
  const secretAccessKey = Secret.from(env['AWS_SECRET_ACCESS_KEY'], 'AWS_SECRET_ACCESS_KEY');
  const sessionToken = Secret.from(env['AWS_SESSION_TOKEN'], 'AWS_SESSION_TOKEN');

  if (apiKey === undefined && accessKeyId === undefined) return undefined;

  const region = readString(env['AWS_REGION']) ?? readString(env['AWS_DEFAULT_REGION']);
  if (region === undefined) {
    throw configError('AWS_REGION is required to reach Bedrock', 'AWS_REGION');
  }

  return {
    region,
    baseUrl: trimSlash(
      readString(env['BEDROCK_BASE_URL']) ?? `https://bedrock-runtime.${region}.amazonaws.com`,
    ),
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(accessKeyId === undefined ? {} : { accessKeyId }),
    ...(secretAccessKey === undefined ? {} : { secretAccessKey }),
    ...(sessionToken === undefined ? {} : { sessionToken }),
  };
}

function loadVertex(env: Env): VertexConfig | undefined {
  const accessToken = Secret.from(env['GOOGLE_ACCESS_TOKEN'], 'GOOGLE_ACCESS_TOKEN');
  const serviceAccount = loadServiceAccount(env);
  if (accessToken === undefined && serviceAccount === undefined) return undefined;

  const project =
    readString(env['VERTEX_PROJECT']) ??
    readString(env['GOOGLE_CLOUD_PROJECT']) ??
    serviceAccount?.projectId;
  if (project === undefined) {
    throw configError(
      'GOOGLE_CLOUD_PROJECT (or VERTEX_PROJECT) is required to reach Vertex AI',
      'GOOGLE_CLOUD_PROJECT',
    );
  }

  const location =
    readString(env['VERTEX_LOCATION']) ??
    readString(env['GOOGLE_CLOUD_LOCATION']) ??
    DEFAULT_VERTEX_LOCATION;

  return {
    project,
    location,
    baseUrl: trimSlash(
      readString(env['VERTEX_BASE_URL']) ?? `https://${location}-aiplatform.googleapis.com`,
    ),
    ...(accessToken === undefined ? {} : { accessToken }),
    ...(serviceAccount === undefined
      ? {}
      : {
          serviceAccount: {
            clientEmail: serviceAccount.clientEmail,
            privateKey: serviceAccount.privateKey,
          },
        }),
  };
}

interface LoadedServiceAccount extends VertexServiceAccount {
  readonly projectId?: string;
}

/**
 * Read a service account key from inline JSON or from the file named by
 * `GOOGLE_APPLICATION_CREDENTIALS`.
 */
function loadServiceAccount(env: Env): LoadedServiceAccount | undefined {
  const inline = readString(env['GOOGLE_SERVICE_ACCOUNT_JSON']);
  const path = readString(env['GOOGLE_APPLICATION_CREDENTIALS']);

  let json: string;
  let source: string;

  if (inline !== undefined) {
    json = inline;
    source = 'GOOGLE_SERVICE_ACCOUNT_JSON';
  } else if (path !== undefined) {
    source = 'GOOGLE_APPLICATION_CREDENTIALS';
    try {
      json = readFileSync(path, 'utf8');
    } catch (cause) {
      throw configError(`could not read the service account key at "${path}"`, source, cause);
    }
  } else {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    throw configError('the service account key is not valid JSON', source, cause);
  }

  const clientEmail = readString(field(parsed, 'client_email'));
  const privateKey = readString(field(parsed, 'private_key'));
  if (clientEmail === undefined || privateKey === undefined) {
    throw configError(
      'the service account key must contain "client_email" and "private_key"',
      source,
    );
  }

  const projectId = readString(field(parsed, 'project_id'));

  return {
    clientEmail,
    privateKey: new Secret(privateKey, `${source}#private_key`),
    ...(projectId === undefined ? {} : { projectId }),
  };
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function readProvider(value: string | undefined): ProviderId | undefined {
  const id = readString(value);
  if (id === undefined) return undefined;
  if (!(PROVIDER_IDS as readonly string[]).includes(id)) {
    throw configError(
      `"${id}" is not a known provider. Expected one of: ${PROVIDER_IDS.join(', ')}`,
      'NIMBLE_DEFAULT_PROVIDER',
    );
  }
  return id as ProviderId;
}

function readPositiveInt(value: string | undefined, name: string): number | undefined {
  const parsed = readInt(value, name);
  if (parsed !== undefined && parsed <= 0) {
    throw configError(`must be a positive integer, received "${value}"`, name);
  }
  return parsed;
}

function readNonNegativeInt(value: string | undefined, name: string): number | undefined {
  const parsed = readInt(value, name);
  if (parsed !== undefined && parsed < 0) {
    throw configError(`must be zero or a positive integer, received "${value}"`, name);
  }
  return parsed;
}

function readInt(value: string | undefined, name: string): number | undefined {
  const raw = readString(value);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw configError(`must be an integer, received "${raw}"`, name);
  }
  return parsed;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function configError(message: string, variable: string, cause?: unknown): NimbleError {
  return new NimbleError(`${variable}: ${message}`, {
    code: 'invalid_request',
    issues: [{ path: variable, message }],
    ...(cause === undefined ? {} : { cause }),
  });
}
