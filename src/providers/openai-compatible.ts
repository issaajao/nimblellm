/**
 * The OpenAI Chat Completions wire format.
 *
 * Shared by the OpenAI and Azure OpenAI adapters, which differ only in how the
 * model is addressed: OpenAI names it in the body, Azure puts the deployment
 * in the URL.
 */

import { NimbleError } from '../errors.js';
import type {
  AssistantMessage,
  ContentPart,
  FinishReason,
  NimbleRequest,
  NimbleResponse,
  NimbleStreamEvent,
  ProviderId,
  ToolCall,
} from '../types.js';
import {
  applyProviderOptions,
  dig,
  NO_USAGE,
  parseToolArguments,
  pick,
  stringOf,
  textOf,
  toDataUrl,
  usageOf,
} from './shared.js';

// ---------------------------------------------------------------------------
// Payload types
// ---------------------------------------------------------------------------

export type ChatPart =
  { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ChatPart[]; name?: string }
  | {
      role: 'assistant';
      content: string | null;
      name?: string;
      tool_calls?: {
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }[];
    }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ChatCompletionsPayload {
  model?: string;
  messages: ChatMessage[];
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string[];
  seed?: number;
  stream?: boolean;
  stream_options?: { include_usage: true };
  response_format?: Record<string, unknown>;
  tools?: { type: 'function'; function: Record<string, unknown> }[];
  tool_choice?: unknown;
  metadata?: Record<string, string>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export interface BuildChatPayloadOptions {
  /** Azure addresses the deployment in the URL, so it omits `model`. */
  readonly includeModel: boolean;
  /**
   * Caller-supplied `providerOptions` to merge over the payload, with
   * routing-only keys (such as Azure's `apiVersion`) already removed.
   */
  readonly extraOptions?: Readonly<Record<string, unknown>> | undefined;
}

export function buildChatCompletionsPayload(
  request: NimbleRequest,
  options: BuildChatPayloadOptions,
): ChatCompletionsPayload {
  const messages: ChatMessage[] = [];

  if (request.system !== undefined) {
    messages.push({ role: 'system', content: request.system });
  }

  for (const message of request.messages) {
    switch (message.role) {
      case 'user':
        messages.push({
          role: 'user',
          content: toChatContent(message.content),
          ...(message.name === undefined ? {} : { name: message.name }),
        });
        break;

      case 'assistant': {
        const text = textOf(message.content);
        messages.push({
          role: 'assistant',
          // Chat Completions requires `content` to be present, and null is how
          // it expresses "this turn was nothing but tool calls".
          content: text === '' ? null : text,
          ...(message.name === undefined ? {} : { name: message.name }),
          ...(message.toolCalls === undefined
            ? {}
            : {
                tool_calls: message.toolCalls.map((call) => ({
                  id: call.id,
                  type: 'function' as const,
                  function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                })),
              }),
        });
        break;
      }

      case 'tool':
        messages.push({
          role: 'tool',
          tool_call_id: message.toolCallId,
          content: textOf(message.content),
        });
        break;
    }
  }

  const payload: ChatCompletionsPayload = {
    ...(options.includeModel ? { model: request.model.model } : {}),
    messages,
    ...(request.maxOutputTokens === undefined
      ? {}
      : { max_completion_tokens: request.maxOutputTokens }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.topP === undefined ? {} : { top_p: request.topP }),
    ...(request.frequencyPenalty === undefined
      ? {}
      : { frequency_penalty: request.frequencyPenalty }),
    ...(request.presencePenalty === undefined ? {} : { presence_penalty: request.presencePenalty }),
    ...(request.stop === undefined ? {} : { stop: [...request.stop] }),
    ...(request.seed === undefined ? {} : { seed: request.seed }),
    // `include_usage` is opt-in; without it a streamed response reports no tokens.
    ...(request.stream === undefined
      ? {}
      : {
          stream: request.stream,
          ...(request.stream ? { stream_options: { include_usage: true as const } } : {}),
        }),
    ...(request.responseFormat === undefined
      ? {}
      : { response_format: toResponseFormat(request.responseFormat) }),
    ...(request.tools === undefined
      ? {}
      : {
          tools: request.tools.map((tool) => ({
            type: 'function' as const,
            function: {
              name: tool.name,
              ...(tool.description === undefined ? {} : { description: tool.description }),
              parameters: tool.parameters,
            },
          })),
        }),
    ...(request.toolChoice === undefined ? {} : { tool_choice: toToolChoice(request.toolChoice) }),
    ...(request.metadata === undefined ? {} : { metadata: { ...request.metadata } }),
  };

  return applyProviderOptions(payload, options.extraOptions);
}

/** A lone text part becomes a plain string; anything richer becomes a part array. */
function toChatContent(parts: readonly ContentPart[]): string | ChatPart[] {
  const first = parts[0];
  if (parts.length === 1 && first?.type === 'text') return first.text;

  return parts.map((part) =>
    part.type === 'text'
      ? { type: 'text' as const, text: part.text }
      : { type: 'image_url' as const, image_url: { url: toDataUrl(part.source) } },
  );
}

function toResponseFormat(
  format: NonNullable<NimbleRequest['responseFormat']>,
): Record<string, unknown> {
  if (format.type !== 'json_schema') return { type: format.type };
  return {
    type: 'json_schema',
    json_schema: {
      name: format.name,
      schema: format.schema,
      ...(format.strict === undefined ? {} : { strict: format.strict }),
    },
  };
}

function toToolChoice(choice: NonNullable<NimbleRequest['toolChoice']>): unknown {
  return choice.type === 'tool'
    ? { type: 'function', function: { name: choice.name } }
    : choice.type;
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

const FINISH_REASONS: Readonly<Record<string, FinishReason>> = {
  stop: 'stop',
  length: 'length',
  tool_calls: 'tool_calls',
  function_call: 'tool_calls',
  content_filter: 'content_filter',
};

export function parseChatCompletionsResponse(
  raw: unknown,
  request: NimbleRequest,
  provider: ProviderId,
): NimbleResponse {
  const choices = pick(raw, 'choices');
  const choice = Array.isArray(choices) ? choices[0] : undefined;
  if (choice === undefined) {
    throw new NimbleError(`${provider} returned no choices`, {
      code: 'provider_error',
      provider,
      retryable: true,
    });
  }

  const message = pick(choice, 'message');
  const content: ContentPart[] = [];
  const text = pick(message, 'content');
  if (typeof text === 'string' && text !== '') content.push({ type: 'text', text });

  const rawCalls = pick(message, 'tool_calls');
  const toolCalls: ToolCall[] = Array.isArray(rawCalls)
    ? rawCalls.map((call) => {
        const name = stringOf(dig(call, 'function', 'name')) ?? '';
        return {
          id: stringOf(pick(call, 'id')) ?? `call_${name}`,
          name,
          arguments: parseToolArguments(dig(call, 'function', 'arguments'), provider, name),
        };
      })
    : [];

  const assistant: AssistantMessage = {
    role: 'assistant',
    content,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };

  const created = pick(raw, 'created');
  const usage = pick(raw, 'usage');

  return {
    id: stringOf(pick(raw, 'id')) ?? `${provider}-${Date.now()}`,
    provider,
    model: stringOf(pick(raw, 'model')) ?? request.model.model,
    createdAt:
      typeof created === 'number'
        ? new Date(created * 1000).toISOString()
        : new Date().toISOString(),
    finishReason: FINISH_REASONS[String(pick(choice, 'finish_reason'))] ?? 'unknown',
    message: assistant,
    usage:
      usage === undefined
        ? NO_USAGE
        : usageOf(
            pick(usage, 'prompt_tokens'),
            pick(usage, 'completion_tokens'),
            pick(usage, 'total_tokens'),
          ),
    raw,
  };
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

export function parseChatCompletionsChunk(chunk: unknown): readonly NimbleStreamEvent[] {
  const events: NimbleStreamEvent[] = [];

  const choices = pick(chunk, 'choices');
  const choice = Array.isArray(choices) ? choices[0] : undefined;

  if (choice !== undefined) {
    const delta = pick(choice, 'delta');

    const text = pick(delta, 'content');
    if (typeof text === 'string' && text !== '') {
      events.push({ type: 'text_delta', text });
    }

    const calls = pick(delta, 'tool_calls');
    if (Array.isArray(calls)) {
      calls.forEach((call, position) => {
        const index = pick(call, 'index');
        const id = stringOf(pick(call, 'id'));
        const name = stringOf(dig(call, 'function', 'name'));
        const argumentsDelta = dig(call, 'function', 'arguments');
        events.push({
          type: 'tool_call_delta',
          index: typeof index === 'number' ? index : position,
          ...(id === undefined ? {} : { id }),
          ...(name === undefined ? {} : { name }),
          ...(typeof argumentsDelta === 'string' ? { argumentsDelta } : {}),
        });
      });
    }

    const reason = pick(choice, 'finish_reason');
    if (typeof reason === 'string') {
      events.push({ type: 'finish', finishReason: FINISH_REASONS[reason] ?? 'unknown' });
    }
  }

  // Sent as a trailing chunk with no choices when `stream_options.include_usage` is set.
  const usage = pick(chunk, 'usage');
  if (usage !== null && usage !== undefined) {
    events.push({
      type: 'usage',
      usage: usageOf(
        pick(usage, 'prompt_tokens'),
        pick(usage, 'completion_tokens'),
        pick(usage, 'total_tokens'),
      ),
    });
  }

  return events;
}
