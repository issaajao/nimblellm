/**
 * Helpers shared by more than one adapter.
 */

import { NimbleError } from '../errors.js';
import type { ContentPart, ImageSource, NimbleMessage, ProviderId, TokenUsage } from '../types.js';

/** Concatenate the text parts of a content array, ignoring everything else. */
export function textOf(parts: readonly ContentPart[], separator = '\n'): string {
  return parts
    .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join(separator);
}

/** Render an image source as a `data:` URL, which OpenAI-style APIs accept. */
export function toDataUrl(source: ImageSource): string {
  return source.kind === 'url' ? source.url : `data:${source.mediaType};base64,${source.data}`;
}

/**
 * Derive an image format token (`png`, `jpeg`, `gif`, `webp`) from a media
 * type. Bedrock names the format separately from the bytes.
 *
 * @throws NimbleError - `invalid_request` when the media type is not one of
 *   the formats every supported vision model accepts
 */
export function imageFormatOf(mediaType: string, provider: ProviderId): string {
  const format = mediaType
    .toLowerCase()
    .replace(/^image\//, '')
    .replace(/^jpg$/, 'jpeg');
  if (['png', 'jpeg', 'gif', 'webp'].includes(format)) return format;

  throw new NimbleError(
    `messages: ${provider} accepts image/png, image/jpeg, image/gif or image/webp; received "${mediaType}"`,
    {
      code: 'invalid_request',
      provider,
      issues: [{ path: 'messages', message: `unsupported image media type "${mediaType}"` }],
    },
  );
}

/**
 * Build a lookup from tool-call id to tool name.
 *
 * Gemini identifies tool results by function *name* rather than by call id, so
 * the Vertex adapter has to resolve one from the other by looking back at the
 * assistant turn that made the call.
 */
export function toolNamesByCallId(messages: readonly NimbleMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'assistant' || message.toolCalls === undefined) continue;
    for (const call of message.toolCalls) names.set(call.id, call.name);
  }
  return names;
}

/** Zeroed usage, for providers that omit token counts on some responses. */
export const NO_USAGE: TokenUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
});

/** Coerce a possibly-missing number to a non-negative integer. */
export function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Normalize token counts, filling in `totalTokens` when the provider does not
 * report it (Bedrock and Vertex both sometimes omit it).
 */
export function usageOf(input: unknown, output: unknown, total?: unknown): TokenUsage {
  const inputTokens = countOf(input);
  const outputTokens = countOf(output);
  const reported = countOf(total);
  return Object.freeze({
    inputTokens,
    outputTokens,
    totalTokens: reported > 0 ? reported : inputTokens + outputTokens,
  });
}

/** Read a property from an unknown value without throwing. */
export function pick(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

/** Walk a dotted path through an unknown value without throwing. */
export function dig(value: unknown, ...keys: readonly string[]): unknown {
  let current = value;
  for (const key of keys) current = pick(current, key);
  return current;
}

/** Read a string property, or `undefined` if it is missing or not a string. */
export function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Parse tool-call arguments returned as a JSON string.
 *
 * A model occasionally emits malformed JSON here. Surfacing it as a retryable
 * `provider_error` is better than silently handing the caller empty arguments.
 *
 * @throws NimbleError - `provider_error`, marked retryable
 */
export function parseToolArguments(
  raw: unknown,
  provider: ProviderId,
  toolName: string,
): Record<string, unknown> {
  if (raw === undefined || raw === null || raw === '') return {};

  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }

  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch (cause) {
      throw new NimbleError(`${provider} returned unparseable arguments for tool "${toolName}"`, {
        code: 'provider_error',
        provider,
        retryable: true,
        cause,
      });
    }
  }

  throw new NimbleError(`${provider} returned non-object arguments for tool "${toolName}"`, {
    code: 'provider_error',
    provider,
    retryable: true,
  });
}

/** Merge a `providerOptions` block over a payload, letting the caller win. */
export function applyProviderOptions<T extends object>(
  payload: T,
  options: Readonly<Record<string, unknown>> | undefined,
): T {
  return options === undefined ? payload : Object.assign(payload, options);
}

/**
 * Copy an options block without the keys that configure routing rather than
 * the request body — Azure's `apiVersion`, Vertex's `project` and `location`.
 * Without this they would leak into the payload the provider receives.
 */
export function omitKeys(
  source: Readonly<Record<string, unknown>> | undefined,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  if (source === undefined) return undefined;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!keys.includes(key)) out[key] = value;
  }

  return Object.keys(out).length === 0 ? undefined : out;
}
