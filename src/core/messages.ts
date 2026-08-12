/**
 * Conversation normalization.
 *
 * Turns a loosely-typed message array into canonical {@link NimbleMessage}
 * values, and hoists `system` turns into a single top-level instruction block
 * (Bedrock, Vertex and Anthropic-on-Bedrock all carry system text outside the
 * conversation, so hoisting here keeps every adapter simple).
 */

import { NimbleError } from '../errors.js';
import type {
  AssistantMessage,
  ContentPart,
  ImageSource,
  NimbleMessage,
  ToolCall,
  ToolMessage,
  UserMessage,
} from '../types.js';
import { canonicalizeKeys, joinPath } from './keys.js';

const MESSAGE_ALIASES: Readonly<Record<string, string>> = {
  role: 'role',
  content: 'content',
  name: 'name',
  toolcalls: 'toolCalls',
  toolcallid: 'toolCallId',
  tooluseid: 'toolCallId',
  iserror: 'isError',
};

const TOOL_CALL_ALIASES: Readonly<Record<string, string>> = {
  id: 'id',
  toolcallid: 'id',
  type: 'type',
  name: 'name',
  arguments: 'arguments',
  args: 'arguments',
  input: 'arguments',
  function: 'function',
};

const TEXT_PART_ALIASES: Readonly<Record<string, string>> = {
  type: 'type',
  text: 'text',
};

const IMAGE_PART_ALIASES: Readonly<Record<string, string>> = {
  type: 'type',
  source: 'source',
  url: 'url',
  data: 'data',
  mediatype: 'mediaType',
  mimetype: 'mediaType',
};

export interface NormalizedConversation {
  /** Concatenated system instructions, or `undefined` if there were none. */
  readonly system: string | undefined;
  readonly messages: readonly NimbleMessage[];
}

/**
 * Validate and canonicalize a message array.
 *
 * @param raw - the caller-supplied `messages` value
 * @param path - path prefix for error reporting
 * @throws NimbleError - `invalid_request` on any structural problem
 */
export function normalizeMessages(raw: unknown, path = 'messages'): NormalizedConversation {
  if (!Array.isArray(raw)) {
    throw NimbleError.atPath(path, `expected an array, received ${describe(raw)}`);
  }
  if (raw.length === 0) {
    throw NimbleError.atPath(path, 'must contain at least one message');
  }

  const systemChunks: string[] = [];
  const messages: NimbleMessage[] = [];
  const declaredToolCallIds = new Set<string>();

  raw.forEach((entry, index) => {
    const at = joinPath(path, index);
    const fields = canonicalizeKeys(asObject(entry, at), { aliases: MESSAGE_ALIASES, path: at });
    const role = readRole(fields['role'], joinPath(at, 'role'));

    switch (role) {
      case 'system': {
        rejectUnexpected(fields, ['role', 'content', 'name'], at);
        const text = contentToText(
          normalizeContent(fields['content'], joinPath(at, 'content')),
          joinPath(at, 'content'),
        );
        if (text !== '') systemChunks.push(text);
        break;
      }

      case 'user': {
        rejectUnexpected(fields, ['role', 'content', 'name'], at);
        const content = normalizeContent(fields['content'], joinPath(at, 'content'));
        if (content.length === 0) {
          throw NimbleError.atPath(joinPath(at, 'content'), 'user messages must not be empty');
        }
        const name = readOptionalName(fields['name'], joinPath(at, 'name'));
        messages.push(
          Object.freeze<UserMessage>({
            role: 'user',
            content: Object.freeze(content),
            ...(name === undefined ? {} : { name }),
          }),
        );
        break;
      }

      case 'assistant': {
        rejectUnexpected(fields, ['role', 'content', 'name', 'toolCalls'], at);
        const content = normalizeContent(fields['content'], joinPath(at, 'content'));
        const toolCalls = normalizeToolCalls(fields['toolCalls'], joinPath(at, 'toolCalls'));
        if (content.length === 0 && toolCalls.length === 0) {
          throw NimbleError.atPath(at, 'assistant messages must have content, tool calls, or both');
        }
        for (const call of toolCalls) declaredToolCallIds.add(call.id);
        const name = readOptionalName(fields['name'], joinPath(at, 'name'));
        messages.push(
          Object.freeze<AssistantMessage>({
            role: 'assistant',
            content: Object.freeze(content),
            ...(toolCalls.length > 0 ? { toolCalls: Object.freeze(toolCalls) } : {}),
            ...(name === undefined ? {} : { name }),
          }),
        );
        break;
      }

      case 'tool': {
        rejectUnexpected(fields, ['role', 'content', 'toolCallId', 'isError'], at);
        const toolCallId = fields['toolCallId'];
        if (typeof toolCallId !== 'string' || toolCallId.trim() === '') {
          throw NimbleError.atPath(
            joinPath(at, 'toolCallId'),
            'tool messages must reference the id of the tool call they answer',
          );
        }
        if (!declaredToolCallIds.has(toolCallId)) {
          throw NimbleError.atPath(
            joinPath(at, 'toolCallId'),
            `"${toolCallId}" does not match any tool call made earlier in the conversation`,
          );
        }
        const content = normalizeContent(fields['content'], joinPath(at, 'content'));
        if (content.length === 0) {
          throw NimbleError.atPath(
            joinPath(at, 'content'),
            'tool messages must carry a result; use an explicit error string if the tool failed',
          );
        }
        const isError = fields['isError'];
        if (isError !== undefined && typeof isError !== 'boolean') {
          throw NimbleError.atPath(joinPath(at, 'isError'), 'expected a boolean');
        }
        messages.push(
          Object.freeze<ToolMessage>({
            role: 'tool',
            toolCallId,
            content: Object.freeze(content),
            ...(isError === true ? { isError: true } : {}),
          }),
        );
        break;
      }
    }
  });

  if (messages.length === 0) {
    throw NimbleError.atPath(
      path,
      'must contain at least one user, assistant, or tool message besides system instructions',
    );
  }

  return {
    system: systemChunks.length > 0 ? systemChunks.join('\n\n') : undefined,
    messages: Object.freeze(messages),
  };
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

/**
 * Accepts a plain string, an array of parts (strings allowed as shorthand for
 * text), or `null`/`undefined` for "no content". Empty text parts are dropped
 * rather than forwarded, since several providers reject them outright.
 */
export function normalizeContent(raw: unknown, path: string): ContentPart[] {
  if (raw === undefined || raw === null) return [];

  if (typeof raw === 'string') {
    return raw === '' ? [] : [Object.freeze<ContentPart>({ type: 'text', text: raw })];
  }

  if (!Array.isArray(raw)) {
    throw NimbleError.atPath(
      path,
      `expected a string or an array of parts, received ${describe(raw)}`,
    );
  }

  const parts: ContentPart[] = [];
  raw.forEach((entry, index) => {
    const part = normalizeContentPart(entry, joinPath(path, index));
    if (part !== undefined) parts.push(part);
  });
  return parts;
}

function normalizeContentPart(entry: unknown, at: string): ContentPart | undefined {
  if (typeof entry === 'string') {
    return entry === '' ? undefined : Object.freeze<ContentPart>({ type: 'text', text: entry });
  }

  const object = asObject(entry, at);
  const type = object['type'];

  if (type === 'text') {
    const fields = canonicalizeKeys(object, { aliases: TEXT_PART_ALIASES, path: at });
    const text = fields['text'];
    if (typeof text !== 'string') {
      throw NimbleError.atPath(
        joinPath(at, 'text'),
        `expected a string, received ${describe(text)}`,
      );
    }
    return text === '' ? undefined : Object.freeze<ContentPart>({ type: 'text', text });
  }

  if (type === 'image') {
    const fields = canonicalizeKeys(object, { aliases: IMAGE_PART_ALIASES, path: at });
    return Object.freeze<ContentPart>({ type: 'image', source: normalizeImageSource(fields, at) });
  }

  throw NimbleError.atPath(
    joinPath(at, 'type'),
    `unsupported content part type ${JSON.stringify(type)}. Supported types: text, image`,
  );
}

/** Accepts the canonical `{ source }` form as well as flat `{ url }` / `{ data, mediaType }`. */
function normalizeImageSource(fields: Record<string, unknown>, at: string): ImageSource {
  const source = fields['source'];
  if (source !== undefined) {
    const inner = asObject(source, joinPath(at, 'source'));
    if (inner['kind'] === 'url' || inner['kind'] === 'base64') {
      return normalizeImageSource({ ...inner }, joinPath(at, 'source'));
    }
    throw NimbleError.atPath(
      joinPath(at, 'source.kind'),
      `expected "url" or "base64", received ${JSON.stringify(inner['kind'])}`,
    );
  }

  const url = fields['url'];
  const data = fields['data'];

  if (typeof url === 'string' && url !== '') {
    if (data !== undefined) {
      throw NimbleError.atPath(at, 'image parts take either "url" or "data", not both');
    }
    return Object.freeze<ImageSource>({ kind: 'url', url });
  }

  if (typeof data === 'string' && data !== '') {
    const mediaType = fields['mediaType'];
    if (typeof mediaType !== 'string' || mediaType === '') {
      throw NimbleError.atPath(
        joinPath(at, 'mediaType'),
        'inline image data requires a mediaType such as "image/png"',
      );
    }
    return Object.freeze<ImageSource>({ kind: 'base64', mediaType, data });
  }

  throw NimbleError.atPath(at, 'image parts require either a "url" or base64 "data"');
}

/** Flatten a content array to plain text, rejecting non-text parts. */
function contentToText(parts: readonly ContentPart[], path: string): string {
  const text: string[] = [];
  for (const part of parts) {
    if (part.type !== 'text') {
      throw NimbleError.atPath(path, 'system instructions must be text only');
    }
    text.push(part.text);
  }
  return text.join('\n\n');
}

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

/** Accepts the canonical flat form as well as OpenAI's nested `function` form. */
export function normalizeToolCalls(raw: unknown, path: string): ToolCall[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw NimbleError.atPath(path, `expected an array, received ${describe(raw)}`);
  }

  return raw.map((entry, index) => {
    const at = joinPath(path, index);
    const fields = canonicalizeKeys(asObject(entry, at), { aliases: TOOL_CALL_ALIASES, path: at });

    const nested = fields['function'];
    if (nested !== undefined) {
      const inner = asObject(nested, joinPath(at, 'function'));
      fields['name'] ??= inner['name'];
      fields['arguments'] ??= inner['arguments'];
    }

    const id = fields['id'];
    if (typeof id !== 'string' || id.trim() === '') {
      throw NimbleError.atPath(joinPath(at, 'id'), 'tool calls require a non-empty id');
    }

    const name = fields['name'];
    if (typeof name !== 'string' || name.trim() === '') {
      throw NimbleError.atPath(joinPath(at, 'name'), 'tool calls require a tool name');
    }

    return Object.freeze<ToolCall>({
      id,
      name,
      arguments: Object.freeze(parseArguments(fields['arguments'], joinPath(at, 'arguments'))),
    });
  });
}

/** Tool arguments arrive as a JSON string from OpenAI-style APIs and as an object elsewhere. */
function parseArguments(raw: unknown, path: string): Record<string, unknown> {
  if (raw === undefined || raw === null || raw === '') return {};

  if (typeof raw === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      throw new NimbleError(`${path}: tool call arguments are not valid JSON`, {
        code: 'invalid_request',
        issues: [{ path, message: 'expected a JSON object, received an unparseable string' }],
        cause,
      });
    }
    return asObject(parsed, path);
  }

  return { ...asObject(raw, path) };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function readRole(raw: unknown, path: string): 'system' | 'user' | 'assistant' | 'tool' {
  if (raw === 'system' || raw === 'user' || raw === 'assistant' || raw === 'tool') return raw;
  throw NimbleError.atPath(
    path,
    `expected one of "system", "user", "assistant", "tool"; received ${JSON.stringify(raw)}`,
  );
}

function readOptionalName(raw: unknown, path: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw NimbleError.atPath(path, 'expected a non-empty string');
  }
  return raw;
}

/** Reject fields that are legal on some roles but meaningless on this one. */
function rejectUnexpected(
  fields: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  at: string,
): void {
  for (const key of Object.keys(fields)) {
    if (!allowed.includes(key)) {
      throw NimbleError.atPath(
        joinPath(at, key),
        `not valid on a "${String(fields['role'])}" message`,
      );
    }
  }
}

export function asObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw NimbleError.atPath(path, `expected an object, received ${describe(value)}`);
  }
  return value as Record<string, unknown>;
}

export function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}
