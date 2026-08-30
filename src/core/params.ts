/**
 * Sampling parameter, tool and output-format validation.
 *
 * Ranges here are the *canonical* ones — temperature is 0–2, matching OpenAI.
 * Providers with narrower ranges (Bedrock and Vertex both cap temperature at
 * 1) rescale in their adapter rather than at this layer, so that the same
 * request means the same thing everywhere.
 */

import { z } from 'zod';
import { fromZodError, NimbleError } from '../errors.js';
import type { NimbleTool, ResponseFormat, ToolChoice } from '../types.js';
import { canonicalizeKeys, joinPath } from './keys.js';
import { asObject, describe } from './messages.js';

const scalarSchemas = {
  maxOutputTokens: z.number().int().positive(),
  temperature: z.number().min(0).max(2),
  topP: z.number().min(0).max(1),
  topK: z.number().int().positive(),
  frequencyPenalty: z.number().min(-2).max(2),
  presencePenalty: z.number().min(-2).max(2),
  seed: z.number().int(),
  stream: z.boolean(),
} as const;

export type ScalarParamName = keyof typeof scalarSchemas;

/**
 * Validate one scalar parameter.
 *
 * @returns the value, or `undefined` if it was absent
 * @throws NimbleError - `invalid_request` if present but out of range
 */
export function normalizeScalar<K extends ScalarParamName>(
  name: K,
  raw: unknown,
  path = name as string,
): z.infer<(typeof scalarSchemas)[K]> | undefined {
  if (raw === undefined || raw === null) return undefined;
  const result = scalarSchemas[name].safeParse(raw);
  if (!result.success) throw fromZodError(result.error, [path]);
  return result.data as z.infer<(typeof scalarSchemas)[K]>;
}

/** Accepts a single stop string or an array of them; always yields an array. */
export function normalizeStop(raw: unknown, path = 'stop'): readonly string[] | undefined {
  if (raw === undefined || raw === null) return undefined;

  const values = typeof raw === 'string' ? [raw] : raw;
  if (!Array.isArray(values)) {
    throw NimbleError.atPath(
      path,
      `expected a string or an array of strings, received ${describe(raw)}`,
    );
  }

  const stop: string[] = [];
  values.forEach((value, index) => {
    if (typeof value !== 'string' || value === '') {
      throw NimbleError.atPath(joinPath(path, index), 'stop sequences must be non-empty strings');
    }
    stop.push(value);
  });

  return stop.length === 0 ? undefined : Object.freeze(stop);
}

/** Metadata is forwarded to providers as request tags, so values must be strings. */
export function normalizeMetadata(
  raw: unknown,
  path = 'metadata',
): Readonly<Record<string, string>> | undefined {
  if (raw === undefined || raw === null) return undefined;

  const entries = Object.entries(asObject(raw, path));
  const metadata: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (typeof value !== 'string') {
      throw NimbleError.atPath(
        joinPath(path, key),
        `expected a string, received ${describe(value)}`,
      );
    }
    metadata[key] = value;
  }

  return entries.length === 0 ? undefined : Object.freeze(metadata);
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const TOOL_ALIASES: Readonly<Record<string, string>> = {
  type: 'type',
  name: 'name',
  description: 'description',
  parameters: 'parameters',
  inputschema: 'parameters',
  function: 'function',
};

/** Accepts the canonical flat form as well as OpenAI's nested `function` form. */
export function normalizeTools(raw: unknown, path = 'tools'): readonly NimbleTool[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw NimbleError.atPath(path, `expected an array, received ${describe(raw)}`);
  }
  if (raw.length === 0) return undefined;

  const seen = new Set<string>();
  const tools = raw.map((entry, index) => {
    const at = joinPath(path, index);
    const fields = canonicalizeKeys(asObject(entry, at), { aliases: TOOL_ALIASES, path: at });

    const nested = fields['function'];
    if (nested !== undefined) {
      const inner = asObject(nested, joinPath(at, 'function'));
      fields['name'] ??= inner['name'];
      fields['description'] ??= inner['description'];
      fields['parameters'] ??= inner['parameters'];
    }

    const name = fields['name'];
    if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
      throw NimbleError.atPath(
        joinPath(at, 'name'),
        'tool names must be 1-64 characters of letters, digits, underscores or hyphens',
      );
    }
    if (seen.has(name)) {
      throw NimbleError.atPath(joinPath(at, 'name'), `duplicate tool name "${name}"`);
    }
    seen.add(name);

    const description = fields['description'];
    if (description !== undefined && typeof description !== 'string') {
      throw NimbleError.atPath(joinPath(at, 'description'), 'expected a string');
    }

    const parameters = fields['parameters'] ?? { type: 'object', properties: {} };
    const schema = asObject(parameters, joinPath(at, 'parameters'));
    if (schema['type'] !== 'object') {
      throw NimbleError.atPath(
        joinPath(at, 'parameters.type'),
        'tool parameters must be a JSON Schema of type "object"',
      );
    }

    return Object.freeze<NimbleTool>({
      type: 'function',
      name,
      ...(description === undefined ? {} : { description }),
      parameters: schema,
    });
  });

  return Object.freeze(tools);
}

/**
 * Accepts `"auto" | "none" | "required"`, the canonical `{ type: 'tool', name }`
 * object, or OpenAI's `{ type: 'function', function: { name } }`.
 */
export function normalizeToolChoice(raw: unknown, path = 'toolChoice'): ToolChoice | undefined {
  if (raw === undefined || raw === null) return undefined;

  if (typeof raw === 'string') {
    if (raw === 'auto' || raw === 'none' || raw === 'required') {
      return Object.freeze<ToolChoice>({ type: raw });
    }
    throw NimbleError.atPath(path, `expected "auto", "none" or "required"; received "${raw}"`);
  }

  const object = asObject(raw, path);
  const type = object['type'];

  if (type === 'auto' || type === 'none' || type === 'required') {
    return Object.freeze<ToolChoice>({ type });
  }

  if (type === 'tool' || type === 'function') {
    const nested = object['function'];
    const name =
      object['name'] ??
      (nested === undefined ? undefined : asObject(nested, joinPath(path, 'function'))['name']);
    if (typeof name !== 'string' || name === '') {
      throw NimbleError.atPath(joinPath(path, 'name'), 'forcing a tool requires its name');
    }
    return Object.freeze<ToolChoice>({ type: 'tool', name });
  }

  throw NimbleError.atPath(
    joinPath(path, 'type'),
    `expected "auto", "none", "required" or "tool"; received ${JSON.stringify(type)}`,
  );
}

/** Cross-field check: a forced tool must actually be declared. */
export function assertToolChoiceResolvable(
  toolChoice: ToolChoice | undefined,
  tools: readonly NimbleTool[] | undefined,
): void {
  if (toolChoice === undefined) return;

  if (toolChoice.type === 'none') return;

  if (tools === undefined || tools.length === 0) {
    throw NimbleError.atPath('toolChoice', 'set but no tools were supplied');
  }

  if (toolChoice.type === 'tool' && !tools.some((tool) => tool.name === toolChoice.name)) {
    throw NimbleError.atPath(
      'toolChoice.name',
      `"${toolChoice.name}" is not among the declared tools (${tools.map((t) => t.name).join(', ')})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Response format
// ---------------------------------------------------------------------------

/** Accepts the canonical flat form as well as OpenAI's nested `json_schema` form. */
export function normalizeResponseFormat(
  raw: unknown,
  path = 'responseFormat',
): ResponseFormat | undefined {
  if (raw === undefined || raw === null) return undefined;

  if (typeof raw === 'string') {
    return normalizeResponseFormat({ type: raw }, path);
  }

  const object = asObject(raw, path);
  const type = object['type'];

  if (type === 'text') return Object.freeze<ResponseFormat>({ type: 'text' });
  if (type === 'json_object') return Object.freeze<ResponseFormat>({ type: 'json_object' });

  if (type === 'json_schema') {
    const nested = object['json_schema'] ?? object['jsonSchema'];
    const source = nested === undefined ? object : asObject(nested, joinPath(path, 'json_schema'));

    const name = source['name'];
    if (typeof name !== 'string' || name === '') {
      throw NimbleError.atPath(joinPath(path, 'name'), 'json_schema output requires a schema name');
    }

    const schema = asObject(source['schema'], joinPath(path, 'schema'));
    const strict = source['strict'];
    if (strict !== undefined && typeof strict !== 'boolean') {
      throw NimbleError.atPath(joinPath(path, 'strict'), 'expected a boolean');
    }

    return Object.freeze<ResponseFormat>({
      type: 'json_schema',
      name,
      schema,
      ...(strict === undefined ? {} : { strict }),
    });
  }

  throw NimbleError.atPath(
    joinPath(path, 'type'),
    `expected "text", "json_object" or "json_schema"; received ${JSON.stringify(type)}`,
  );
}

// ---------------------------------------------------------------------------
// Provider options
// ---------------------------------------------------------------------------

const PROVIDER_OPTION_KEYS = ['openai', 'azure', 'bedrock', 'vertex', 'anthropic'] as const;

/**
 * Provider-specific escape hatch, keyed by provider id. Contents are opaque
 * here; each adapter validates its own slice when it builds the payload.
 */
export function normalizeProviderOptions(
  raw: unknown,
  path = 'providerOptions',
): Readonly<Record<string, Record<string, unknown>>> | undefined {
  if (raw === undefined || raw === null) return undefined;

  const object = asObject(raw, path);
  const out: Record<string, Record<string, unknown>> = {};

  for (const [key, value] of Object.entries(object)) {
    if (!(PROVIDER_OPTION_KEYS as readonly string[]).includes(key)) {
      throw NimbleError.atPath(
        joinPath(path, key),
        `unknown provider. Expected one of: ${PROVIDER_OPTION_KEYS.join(', ')}`,
      );
    }
    out[key] = { ...asObject(value, joinPath(path, key)) };
  }

  return Object.keys(out).length === 0 ? undefined : Object.freeze(out);
}
