/**
 * Secret values.
 *
 * Credentials leak through the boring paths: a config object in a log line, an
 * error serialized to JSON, a stack trace with an interpolated URL. `Secret`
 * closes those by making the *default* rendering of a credential harmless —
 * `toString`, `toJSON` and Node's inspector all yield `[redacted]`, and the
 * real value comes out only when something asks for it explicitly.
 */

const REDACTED = '[redacted]';

/** Node's `util.inspect` hook, used without importing `node:util`. */
const INSPECT = Symbol.for('nodejs.util.inspect.custom');

export class Secret {
  /** Held in a private field so it is invisible to spreads and enumeration. */
  readonly #value: string;

  /** Human-readable origin, e.g. `OPENAI_API_KEY`. Never secret itself. */
  readonly label: string;

  constructor(value: string, label = 'secret') {
    if (typeof value !== 'string' || value === '') {
      throw new TypeError(`${label}: a secret must be a non-empty string`);
    }
    this.#value = value;
    this.label = label;
  }

  /**
   * The actual value. Every call site is a place a credential can escape, so
   * keep them few and close to the wire.
   */
  reveal(): string {
    return this.#value;
  }

  /** Length of the underlying value, safe to log for diagnostics. */
  get length(): number {
    return this.#value.length;
  }

  /**
   * Last four characters, for confirming *which* key is loaded without
   * disclosing it. Short secrets are withheld entirely.
   */
  hint(): string {
    return this.#value.length >= 12 ? `…${this.#value.slice(-4)}` : REDACTED;
  }

  /** Constant-time-ish equality, to avoid leaking via comparison timing. */
  equals(other: Secret): boolean {
    const a = this.#value;
    const b = other.#value;
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [INSPECT](): string {
    return `Secret(${this.label}) ${REDACTED}`;
  }

  /** Wrap a value, passing `Secret` and `undefined` through unchanged. */
  static from(value: string | Secret | undefined, label?: string): Secret | undefined {
    if (value === undefined) return undefined;
    if (value instanceof Secret) return value;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : new Secret(trimmed, label);
  }
}

/**
 * Remove known secret values from text before it is logged or thrown.
 *
 * A backstop, not the primary defence: it can only scrub values it is told
 * about, and a provider that echoes a truncated key defeats it. The primary
 * defence is never putting a secret into a string in the first place.
 *
 * @param text - the text to scrub
 * @param secrets - values to remove, typically every configured credential
 */
export function redact(text: string, secrets: Iterable<Secret | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret === undefined) continue;
    const value = secret.reveal();
    // Skip values short enough that removing them would mangle unrelated text.
    if (value.length < 8) continue;
    out = out.split(value).join(REDACTED);
  }
  return out;
}
