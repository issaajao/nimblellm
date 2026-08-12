/**
 * Key canonicalization.
 *
 * Callers arrive with keys in whichever casing their previous SDK used —
 * `max_tokens`, `maxTokens`, `max-tokens`. Rather than accepting each spelling
 * separately in every schema, we fold keys down to a comparison form and map
 * them onto one canonical name before validation runs.
 */

import { NimbleError } from '../errors.js';

/** Fold a key to its comparison form: lowercase, delimiters removed. */
export function normalizeKey(key: string): string {
  return key.replace(/[_-]/g, '').toLowerCase();
}

/** Join a path prefix and a key into the dotted form used by `NimbleIssue`. */
export function joinPath(prefix: string, key: string | number): string {
  if (typeof key === 'number') return `${prefix}[${key}]`;
  return prefix === '' ? key : `${prefix}.${key}`;
}

export interface CanonicalizeOptions {
  /** Map of {@link normalizeKey} output to the canonical property name. */
  readonly aliases: Readonly<Record<string, string>>;
  /** Path prefix used when reporting problems. Pass `''` for the root object. */
  readonly path: string;
  /** Also treat an explicit `null` as "field absent". */
  readonly dropNull?: boolean;
}

/**
 * Rewrite an object's keys to their canonical names.
 *
 * @throws NimbleError - `invalid_request` if a key is unrecognized, or if two
 *   different spellings of the same field are both present.
 */
export function canonicalizeKeys(
  input: Readonly<Record<string, unknown>>,
  options: CanonicalizeOptions,
): Record<string, unknown> {
  const { aliases, path, dropNull = false } = options;
  const out: Record<string, unknown> = {};
  const sourceOf = new Map<string, string>();

  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (dropNull && value === null) continue;

    const canonical = aliases[normalizeKey(key)];
    if (canonical === undefined) {
      throw NimbleError.atPath(
        joinPath(path, key),
        `unknown field. Accepted fields: ${accepted(aliases)}`,
      );
    }

    const previous = sourceOf.get(canonical);
    if (previous !== undefined) {
      throw NimbleError.atPath(
        joinPath(path, key),
        `duplicate field: "${previous}" and "${key}" both set "${canonical}". Supply only one.`,
      );
    }

    sourceOf.set(canonical, key);
    out[canonical] = value;
  }

  return out;
}

function accepted(aliases: Readonly<Record<string, string>>): string {
  return [...new Set(Object.values(aliases))].sort().join(', ');
}
