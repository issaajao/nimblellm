/**
 * Google Vertex AI adapter — the Gemini `generateContent` API.
 *
 * Two Gemini quirks shape this adapter. The assistant role is called `model`,
 * and function results are matched to calls by function *name* rather than by
 * a call id — Gemini issues no ids at all. Canonical tool calls do have ids,
 * so results are resolved back to a name by looking at the assistant turn that
 * made the call, and ids are synthesized on the way out.
 *
 * @see https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/inference
 */

import { NimbleError } from '../errors.js';
import type {
  AssistantMessage,
  ContentPart,
  FinishReason,
  ImageSource,
  NimbleRequest,
  NimbleResponse,
  NimbleStreamEvent,
  ToolCall,
} from '../types.js';
import type { Capability, ProviderAdapter, ProviderLimits, ProviderRoute } from './adapter.js';
import {
  applyProviderOptions,
  dig,
  NO_USAGE,
  omitKeys,
  pick,
  stringOf,
  textOf,
  toolNamesByCallId,
  usageOf,
} from './shared.js';

// ---------------------------------------------------------------------------
// Payload types
// ---------------------------------------------------------------------------

export type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { fileData: { mimeType: string; fileUri: string } }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

export interface GeminiPayload {
  contents: GeminiContent[];
  systemInstruction?: { parts: { text: string }[] };
  generationConfig?: Record<string, unknown>;
  tools?: { functionDeclarations: Record<string, unknown>[] }[];
  toolConfig?: { functionCallingConfig: Record<string, unknown> };
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/** Request tagging (`labels`) is reachable through `providerOptions.vertex`. */
const SUPPORTED = new Set<Capability>([
  'streaming',
  'tools',
  'tool_choice_required',
  'json_mode',
  'json_schema',
  'image_url',
  'image_base64',
  'seed',
  'stop_sequences',
  'frequency_penalty',
  'presence_penalty',
  'top_k',
]);

const LIMITS: ProviderLimits = {
  temperature: { min: 0, max: 2 },
  topP: { min: 0, max: 1 },
  maxStopSequences: 5,
};

/** Keys consumed by routing, which must not reach the request body. */
const ROUTING_KEYS = ['project', 'location'];

const FINISH_REASONS: Readonly<Record<string, FinishReason>> = {
  STOP: 'stop',
  MAX_TOKENS: 'length',
  SAFETY: 'content_filter',
  RECITATION: 'content_filter',
  BLOCKLIST: 'content_filter',
  PROHIBITED_CONTENT: 'content_filter',
  SPII: 'content_filter',
};

export class VertexAdapter implements ProviderAdapter<GeminiPayload> {
  readonly id = 'vertex' as const;
  readonly limits = LIMITS;

  supports(capability: Capability): boolean {
    return SUPPORTED.has(capability);
  }

  /**
   * Vertex addresses a model by project and location. Supply them as
   * `providerOptions.vertex.project` / `.location` to get an absolute path;
   * otherwise the path is relative and the client prefixes it from config.
   */
  describeRoute(request: NimbleRequest): ProviderRoute {
    const operation = request.stream === true ? 'streamGenerateContent' : 'generateContent';
    const model = request.model.model;
    // An already-qualified model id (`publishers/…`, `projects/…`) is used as-is.
    const resource = model.includes('/') ? model : `publishers/google/models/${model}`;

    const project = stringOf(request.providerOptions?.vertex?.['project']);
    const location = stringOf(request.providerOptions?.vertex?.['location']);
    const prefix =
      project !== undefined && location !== undefined
        ? `v1/projects/${project}/locations/${location}/`
        : '';

    return {
      method: 'POST',
      path: `${prefix}${resource}:${operation}`,
      // Without alt=sse the streaming endpoint returns a JSON array, not SSE.
      ...(request.stream === true ? { query: { alt: 'sse' } } : {}),
      headers: { 'content-type': 'application/json' },
    };
  }

  buildPayload(request: NimbleRequest): GeminiPayload {
    const payload: GeminiPayload = {
      contents: toContents(request),
      ...(request.system === undefined
        ? {}
        : { systemInstruction: { parts: [{ text: request.system }] } }),
    };

    const generationConfig: Record<string, unknown> = {
      ...(request.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: request.maxOutputTokens }),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.topP === undefined ? {} : { topP: request.topP }),
      ...(request.topK === undefined ? {} : { topK: request.topK }),
      ...(request.frequencyPenalty === undefined
        ? {}
        : { frequencyPenalty: request.frequencyPenalty }),
      ...(request.presencePenalty === undefined
        ? {}
        : { presencePenalty: request.presencePenalty }),
      ...(request.stop === undefined ? {} : { stopSequences: [...request.stop] }),
      ...(request.seed === undefined ? {} : { seed: request.seed }),
      ...toGenerationFormat(request.responseFormat),
    };
    if (Object.keys(generationConfig).length > 0) payload.generationConfig = generationConfig;

    if (request.tools !== undefined && request.tools.length > 0) {
      payload.tools = [
        {
          functionDeclarations: request.tools.map((tool) => ({
            name: tool.name,
            ...(tool.description === undefined ? {} : { description: tool.description }),
            parameters: tool.parameters,
          })),
        },
      ];
    }

    const toolConfig = toToolConfig(request);
    if (toolConfig !== undefined) payload.toolConfig = toolConfig;

    return applyProviderOptions(payload, omitKeys(request.providerOptions?.vertex, ROUTING_KEYS));
  }

  parseResponse(raw: unknown, request: NimbleRequest): NimbleResponse {
    const candidates = pick(raw, 'candidates');
    const candidate = Array.isArray(candidates) ? candidates[0] : undefined;
    if (candidate === undefined) {
      // A prompt blocked before generation comes back with no candidates.
      const blockReason = stringOf(dig(raw, 'promptFeedback', 'blockReason'));
      throw new NimbleError(
        blockReason === undefined
          ? 'vertex returned no candidates'
          : `vertex blocked the prompt: ${blockReason}`,
        {
          code: blockReason === undefined ? 'provider_error' : 'invalid_request',
          provider: this.id,
          retryable: blockReason === undefined,
        },
      );
    }

    const { content, toolCalls } = toCanonicalParts(dig(candidate, 'content', 'parts'));

    const message: AssistantMessage = {
      role: 'assistant',
      content,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };

    const usage = pick(raw, 'usageMetadata');
    const reason = String(pick(candidate, 'finishReason'));

    return {
      id: stringOf(pick(raw, 'responseId')) ?? `vertex-${Date.now()}`,
      provider: this.id,
      model: stringOf(pick(raw, 'modelVersion')) ?? request.model.model,
      createdAt: stringOf(pick(raw, 'createTime')) ?? new Date().toISOString(),
      // Gemini reports STOP even when the turn is a function call, so the
      // presence of tool calls is the more reliable signal.
      finishReason: toolCalls.length > 0 ? 'tool_calls' : (FINISH_REASONS[reason] ?? 'unknown'),
      message,
      usage:
        usage === undefined
          ? NO_USAGE
          : usageOf(
              pick(usage, 'promptTokenCount'),
              pick(usage, 'candidatesTokenCount'),
              pick(usage, 'totalTokenCount'),
            ),
      raw,
    };
  }

  parseStreamChunk(chunk: unknown): readonly NimbleStreamEvent[] {
    const events: NimbleStreamEvent[] = [];

    const candidates = pick(chunk, 'candidates');
    const candidate = Array.isArray(candidates) ? candidates[0] : undefined;

    if (candidate !== undefined) {
      const parts = dig(candidate, 'content', 'parts');
      let toolIndex = 0;

      if (Array.isArray(parts)) {
        for (const part of parts) {
          const text = pick(part, 'text');
          if (typeof text === 'string' && text !== '') {
            events.push({ type: 'text_delta', text });
          }

          const call = pick(part, 'functionCall');
          if (call !== undefined) {
            // Gemini emits each function call whole rather than in fragments.
            events.push({
              type: 'tool_call_delta',
              index: toolIndex,
              id: `call_${toolIndex}`,
              name: stringOf(pick(call, 'name')) ?? '',
              argumentsDelta: JSON.stringify(pick(call, 'args') ?? {}),
            });
            toolIndex += 1;
          }
        }
      }

      const reason = pick(candidate, 'finishReason');
      if (typeof reason === 'string') {
        events.push({
          type: 'finish',
          finishReason: toolIndex > 0 ? 'tool_calls' : (FINISH_REASONS[reason] ?? 'unknown'),
        });
      }
    }

    const usage = pick(chunk, 'usageMetadata');
    if (usage !== undefined) {
      events.push({
        type: 'usage',
        usage: usageOf(
          pick(usage, 'promptTokenCount'),
          pick(usage, 'candidatesTokenCount'),
          pick(usage, 'totalTokenCount'),
        ),
      });
    }

    return events;
  }
}

export const vertexAdapter = new VertexAdapter();

// ---------------------------------------------------------------------------
// Request mapping
// ---------------------------------------------------------------------------

function toContents(request: NimbleRequest): GeminiContent[] {
  const toolNames = toolNamesByCallId(request.messages);
  const contents: GeminiContent[] = [];

  for (const message of request.messages) {
    const role: 'user' | 'model' = message.role === 'assistant' ? 'model' : 'user';
    const parts: GeminiPart[] = [];

    if (message.role === 'tool') {
      const name = toolNames.get(message.toolCallId);
      if (name === undefined) {
        throw new NimbleError(
          `messages: vertex identifies tool results by function name, and no earlier tool call declares "${message.toolCallId}"`,
          {
            code: 'invalid_request',
            provider: 'vertex',
            issues: [
              { path: 'messages', message: `unresolvable toolCallId "${message.toolCallId}"` },
            ],
          },
        );
      }
      parts.push({ functionResponse: { name, response: toResponseStruct(message.content) } });
    } else {
      parts.push(...toParts(message.content));
      if (message.role === 'assistant' && message.toolCalls !== undefined) {
        for (const call of message.toolCalls) {
          parts.push({ functionCall: { name: call.name, args: call.arguments } });
        }
      }
    }

    const previous = contents[contents.length - 1];
    if (previous !== undefined && previous.role === role) {
      previous.parts.push(...parts);
    } else {
      contents.push({ role, parts });
    }
  }

  return contents;
}

function toParts(parts: readonly ContentPart[]): GeminiPart[] {
  return parts.map((part) => {
    if (part.type === 'text') return { text: part.text };
    return part.source.kind === 'base64'
      ? { inlineData: { mimeType: part.source.mediaType, data: part.source.data } }
      : { fileData: { mimeType: mimeTypeFromUrl(part.source), fileUri: part.source.url } };
  });
}

/**
 * Gemini's `fileData` requires an explicit media type, which a bare URL does
 * not carry, so it is inferred from the file extension.
 *
 * @throws NimbleError - `invalid_request` when the extension gives nothing to
 *   go on and the image should be sent inline instead
 */
function mimeTypeFromUrl(source: Extract<ImageSource, { kind: 'url' }>): string {
  const extension = /\.(png|jpe?g|gif|webp|heic|heif)(?:[?#]|$)/i.exec(source.url)?.[1];
  if (extension === undefined) {
    throw new NimbleError(
      `messages: vertex needs a media type for "${source.url}", which has no recognizable image extension. Send the image as inline base64 data instead.`,
      {
        code: 'invalid_request',
        provider: 'vertex',
        issues: [{ path: 'messages', message: 'cannot infer image media type from URL' }],
      },
    );
  }
  const normalized = extension.toLowerCase() === 'jpg' ? 'jpeg' : extension.toLowerCase();
  return `image/${normalized}`;
}

/**
 * `functionResponse.response` is a struct. A tool that returned JSON keeps its
 * shape; anything else is wrapped so the model still receives the text.
 */
function toResponseStruct(content: readonly ContentPart[]): Record<string, unknown> {
  const text = textOf(content);
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Not JSON — fall through to the wrapped form.
  }
  return { content: text };
}

function toGenerationFormat(format: NimbleRequest['responseFormat']): Record<string, unknown> {
  if (format === undefined || format.type === 'text') return {};
  if (format.type === 'json_object') return { responseMimeType: 'application/json' };
  return { responseMimeType: 'application/json', responseSchema: format.schema };
}

function toToolConfig(request: NimbleRequest): GeminiPayload['toolConfig'] {
  const choice = request.toolChoice;
  if (choice === undefined) return undefined;

  switch (choice.type) {
    case 'auto':
      return { functionCallingConfig: { mode: 'AUTO' } };
    case 'none':
      return { functionCallingConfig: { mode: 'NONE' } };
    case 'required':
      return { functionCallingConfig: { mode: 'ANY' } };
    case 'tool':
      return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [choice.name] } };
  }
}

// ---------------------------------------------------------------------------
// Response mapping
// ---------------------------------------------------------------------------

function toCanonicalParts(parts: unknown): {
  content: ContentPart[];
  toolCalls: ToolCall[];
} {
  const content: ContentPart[] = [];
  const toolCalls: ToolCall[] = [];

  if (!Array.isArray(parts)) return { content, toolCalls };

  for (const part of parts) {
    const text = pick(part, 'text');
    if (typeof text === 'string' && text !== '') {
      content.push({ type: 'text', text });
      continue;
    }

    const call = pick(part, 'functionCall');
    if (call !== undefined) {
      const args = pick(call, 'args');
      toolCalls.push({
        // Gemini issues no call ids, so synthesize stable positional ones.
        id: `call_${toolCalls.length}`,
        name: stringOf(pick(call, 'name')) ?? '',
        arguments:
          typeof args === 'object' && args !== null && !Array.isArray(args)
            ? (args as Record<string, unknown>)
            : {},
      });
    }
  }

  return { content, toolCalls };
}
