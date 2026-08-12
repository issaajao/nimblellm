/**
 * Model reference parsing.
 *
 * A model reference is `"<provider>/<model>"`. The split is on the *first*
 * slash only, because some providers use slashes inside their own identifiers
 * (Vertex, for instance, accepts `publishers/google/models/gemini-2.0-flash`).
 */

import { NimbleError } from '../errors.js';
import { PROVIDER_IDS, type ModelRef, type ProviderId } from '../types.js';

/**
 * Accepted spellings for each provider prefix, keyed by the folded form
 * produced by `normalizeKey`-style comparison (lowercase, no delimiters).
 */
const PROVIDER_ALIASES: Readonly<Record<string, ProviderId>> = {
  openai: 'openai',
  oai: 'openai',
  azure: 'azure',
  azureopenai: 'azure',
  bedrock: 'bedrock',
  aws: 'bedrock',
  awsbedrock: 'bedrock',
  vertex: 'vertex',
  vertexai: 'vertex',
  google: 'vertex',
  googlevertex: 'vertex',
  gcp: 'vertex',
};

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

export interface ParseModelOptions {
  /** Provider to assume when the reference carries no prefix. */
  readonly defaultProvider?: ProviderId;
  /** Path used when reporting problems. Defaults to `model`. */
  readonly path?: string;
}

/**
 * Resolve a model reference into an explicit provider and model id.
 *
 * @example
 * ```ts
 * parseModelRef('openai/gpt-4o');
 * // { provider: 'openai', model: 'gpt-4o', raw: 'openai/gpt-4o' }
 *
 * parseModelRef('gpt-4o', { defaultProvider: 'azure' });
 * // { provider: 'azure', model: 'gpt-4o', raw: 'gpt-4o' }
 * ```
 *
 * @throws NimbleError - `invalid_request` when the reference is empty, or
 *   `unknown_provider` when no provider can be determined.
 */
export function parseModelRef(raw: unknown, options: ParseModelOptions = {}): ModelRef {
  const path = options.path ?? 'model';

  if (typeof raw !== 'string') {
    throw NimbleError.atPath(path, `expected a string, received ${describe(raw)}`);
  }

  const trimmed = raw.trim();
  if (trimmed === '') {
    throw NimbleError.atPath(path, 'must not be empty');
  }

  const slash = trimmed.indexOf('/');
  if (slash > 0) {
    const prefix = trimmed.slice(0, slash);
    const rest = trimmed.slice(slash + 1).trim();
    const provider = PROVIDER_ALIASES[prefix.replace(/[_-]/g, '').toLowerCase()];

    if (provider !== undefined) {
      if (rest === '') {
        throw NimbleError.atPath(path, `missing model id after "${prefix}/"`);
      }
      return Object.freeze({ provider, model: rest, raw: trimmed });
    }
  }

  // No recognizable prefix: fall back to the configured default provider.
  const fallback = options.defaultProvider;
  if (fallback === undefined) {
    throw new NimbleError(
      `${path}: cannot determine a provider for "${trimmed}". ` +
        `Prefix the model (e.g. "openai/${trimmed}") or set defaultProvider. ` +
        `Known providers: ${PROVIDER_IDS.join(', ')}.`,
      {
        code: 'unknown_provider',
        issues: [{ path, message: `no provider prefix and no defaultProvider configured` }],
      },
    );
  }

  if (!isProviderId(fallback)) {
    throw new NimbleError(`defaultProvider: "${String(fallback)}" is not a known provider`, {
      code: 'unknown_provider',
    });
  }

  return Object.freeze({ provider: fallback, model: trimmed, raw: trimmed });
}

/** Render `"provider/model"` from a parsed reference. */
export function formatModelRef(ref: ModelRef): string {
  return `${ref.provider}/${ref.model}`;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}
