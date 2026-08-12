/**
 * Recursively freeze a value.
 *
 * Normalized requests are handed to adapters, retry wrappers and user
 * middleware; freezing makes accidental mutation fail loudly in strict mode
 * instead of corrupting a retry.
 *
 * Already-frozen objects are still traversed — parts of a request are frozen
 * as they are built, and their children may not be — but a `seen` set keeps
 * cyclic structures (possible inside a user-supplied JSON Schema) from
 * recursing forever.
 */
export function deepFreeze<T>(value: T): T {
  freeze(value, new WeakSet<object>());
  return value;
}

function freeze(value: unknown, seen: WeakSet<object>): void {
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);

  Object.freeze(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    freeze((value as Record<string, unknown>)[key], seen);
  }
}
