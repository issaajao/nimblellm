/**
 * AWS Bedrock adapter — the Converse API.
 *
 * Converse is the model-agnostic surface, so one adapter covers Anthropic,
 * Meta, Mistral and Amazon models alike. Three of its constraints drive most
 * of the code here: only `user` and `assistant` roles exist, those roles must
 * alternate, and tool results are carried inside a *user* turn.
 *
 * @see https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html
 */

import { NimbleError } from '../errors.js';
import type {
  AssistantMessage,
  ContentPart,
  FinishReason,
  NimbleRequest,
  NimbleResponse,
  NimbleStreamEvent,
  ToolCall,
} from '../types.js';
import type { Capability, ProviderAdapter, ProviderLimits, ProviderRoute } from './adapter.js';
import {
  applyProviderOptions,
  dig,
  imageFormatOf,
  NO_USAGE,
  pick,
  stringOf,
  textOf,
  usageOf,
} from './shared.js';

// ---------------------------------------------------------------------------
// Payload types
// ---------------------------------------------------------------------------

export type ConverseBlock =
  | { text: string }
  | { image: { format: string; source: { bytes: string } } }
  | { toolUse: { toolUseId: string; name: string; input: Record<string, unknown> } }
  | {
      toolResult: {
        toolUseId: string;
        content: { text: string }[];
        status?: 'success' | 'error';
      };
    };

export interface ConverseMessage {
  role: 'user' | 'assistant';
  content: ConverseBlock[];
}

export interface ConversePayload {
  messages: ConverseMessage[];
  system?: { text: string }[];
  inferenceConfig?: {
    maxTokens?: number;
    temperature?: number;
    topP?: number;
    stopSequences?: string[];
  };
  toolConfig?: {
    tools: { toolSpec: { name: string; description?: string; inputSchema: { json: unknown } } }[];
    toolChoice?: Record<string, unknown>;
  };
  additionalModelRequestFields?: Record<string, unknown>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Converse has no JSON mode, no seed, no penalties, and no URL images.
 * `topK` and request tagging are reachable through `providerOptions.bedrock`
 * but are not canonical here, because the field name varies by model family.
 */
const SUPPORTED = new Set<Capability>([
  'streaming',
  'tools',
  'tool_choice_required',
  'image_base64',
  'stop_sequences',
]);

const LIMITS: ProviderLimits = {
  temperature: { min: 0, max: 1 },
  topP: { min: 0, max: 1 },
};

const FINISH_REASONS: Readonly<Record<string, FinishReason>> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  content_filtered: 'content_filter',
  guardrail_intervened: 'content_filter',
};

export class BedrockAdapter implements ProviderAdapter<ConversePayload> {
  readonly id = 'bedrock' as const;
  readonly limits = LIMITS;

  supports(capability: Capability): boolean {
    return SUPPORTED.has(capability);
  }

  describeRoute(request: NimbleRequest): ProviderRoute {
    const operation = request.stream === true ? 'converse-stream' : 'converse';
    return {
      method: 'POST',
      path: `model/${encodeURIComponent(request.model.model)}/${operation}`,
      headers: { 'content-type': 'application/json' },
    };
  }

  buildPayload(request: NimbleRequest): ConversePayload {
    const payload: ConversePayload = {
      messages: toConverseMessages(request),
      ...(request.system === undefined ? {} : { system: [{ text: request.system }] }),
    };

    const inferenceConfig = {
      ...(request.maxOutputTokens === undefined ? {} : { maxTokens: request.maxOutputTokens }),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.topP === undefined ? {} : { topP: request.topP }),
      ...(request.stop === undefined ? {} : { stopSequences: [...request.stop] }),
    };
    if (Object.keys(inferenceConfig).length > 0) payload.inferenceConfig = inferenceConfig;

    const toolConfig = toToolConfig(request);
    if (toolConfig !== undefined) payload.toolConfig = toolConfig;

    return applyProviderOptions(payload, request.providerOptions?.bedrock);
  }

  parseResponse(raw: unknown, request: NimbleRequest): NimbleResponse {
    const blocks = dig(raw, 'output', 'message', 'content');
    if (!Array.isArray(blocks)) {
      throw new NimbleError('bedrock returned no output message', {
        code: 'provider_error',
        provider: this.id,
        retryable: true,
      });
    }

    const content: ContentPart[] = [];
    const toolCalls: ToolCall[] = [];

    for (const block of blocks) {
      const text = pick(block, 'text');
      if (typeof text === 'string' && text !== '') {
        content.push({ type: 'text', text });
        continue;
      }

      const toolUse = pick(block, 'toolUse');
      if (toolUse !== undefined) {
        const input = pick(toolUse, 'input');
        toolCalls.push({
          id: stringOf(pick(toolUse, 'toolUseId')) ?? '',
          name: stringOf(pick(toolUse, 'name')) ?? '',
          arguments:
            typeof input === 'object' && input !== null && !Array.isArray(input)
              ? (input as Record<string, unknown>)
              : {},
        });
      }
    }

    const message: AssistantMessage = {
      role: 'assistant',
      content,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };

    const usage = pick(raw, 'usage');

    return {
      // Converse carries no id in the body; the AWS SDK exposes the request id
      // on `$metadata`, so use it when the caller passed the SDK response through.
      id: stringOf(dig(raw, '$metadata', 'requestId')) ?? `bedrock-${Date.now()}`,
      provider: this.id,
      model: request.model.model,
      createdAt: new Date().toISOString(),
      finishReason: FINISH_REASONS[String(pick(raw, 'stopReason'))] ?? 'unknown',
      message,
      usage:
        usage === undefined
          ? NO_USAGE
          : usageOf(
              pick(usage, 'inputTokens'),
              pick(usage, 'outputTokens'),
              pick(usage, 'totalTokens'),
            ),
      raw,
    };
  }

  parseStreamChunk(chunk: unknown): readonly NimbleStreamEvent[] {
    const events: NimbleStreamEvent[] = [];

    const start = pick(chunk, 'contentBlockStart');
    if (start !== undefined) {
      const toolUse = dig(start, 'start', 'toolUse');
      if (toolUse !== undefined) {
        const id = stringOf(pick(toolUse, 'toolUseId'));
        const name = stringOf(pick(toolUse, 'name'));
        events.push({
          type: 'tool_call_delta',
          index: indexOf(start),
          ...(id === undefined ? {} : { id }),
          ...(name === undefined ? {} : { name }),
        });
      }
    }

    const delta = pick(chunk, 'contentBlockDelta');
    if (delta !== undefined) {
      const text = dig(delta, 'delta', 'text');
      if (typeof text === 'string' && text !== '') {
        events.push({ type: 'text_delta', text });
      }

      // Tool arguments stream as a partial JSON string, same as OpenAI's.
      const input = dig(delta, 'delta', 'toolUse', 'input');
      if (typeof input === 'string') {
        events.push({ type: 'tool_call_delta', index: indexOf(delta), argumentsDelta: input });
      }
    }

    const stop = pick(chunk, 'messageStop');
    if (stop !== undefined) {
      events.push({
        type: 'finish',
        finishReason: FINISH_REASONS[String(pick(stop, 'stopReason'))] ?? 'unknown',
      });
    }

    const usage = dig(chunk, 'metadata', 'usage');
    if (usage !== undefined) {
      events.push({
        type: 'usage',
        usage: usageOf(
          pick(usage, 'inputTokens'),
          pick(usage, 'outputTokens'),
          pick(usage, 'totalTokens'),
        ),
      });
    }

    return events;
  }
}

export const bedrockAdapter = new BedrockAdapter();

// ---------------------------------------------------------------------------
// Request mapping
// ---------------------------------------------------------------------------

/**
 * Map canonical messages onto Converse's two roles, then merge neighbours that
 * ended up sharing a role — a tool result becomes a `user` turn, so a
 * user → assistant → tool → tool sequence collapses to alternating turns.
 */
function toConverseMessages(request: NimbleRequest): ConverseMessage[] {
  const messages: ConverseMessage[] = [];

  for (const message of request.messages) {
    const role: 'user' | 'assistant' = message.role === 'assistant' ? 'assistant' : 'user';
    const blocks: ConverseBlock[] = [];

    if (message.role === 'tool') {
      blocks.push({
        toolResult: {
          toolUseId: message.toolCallId,
          content: [{ text: textOf(message.content) }],
          ...(message.isError === true ? { status: 'error' as const } : {}),
        },
      });
    } else {
      blocks.push(...toBlocks(message.content));
      if (message.role === 'assistant' && message.toolCalls !== undefined) {
        for (const call of message.toolCalls) {
          blocks.push({
            toolUse: { toolUseId: call.id, name: call.name, input: call.arguments },
          });
        }
      }
    }

    const previous = messages[messages.length - 1];
    if (previous !== undefined && previous.role === role) {
      previous.content.push(...blocks);
    } else {
      messages.push({ role, content: blocks });
    }
  }

  if (messages[0]?.role !== 'user') {
    throw new NimbleError('messages: bedrock requires the conversation to start with a user turn', {
      code: 'invalid_request',
      provider: 'bedrock',
      issues: [
        { path: 'messages[0].role', message: 'bedrock conversations must start with "user"' },
      ],
    });
  }

  return messages;
}

function toBlocks(parts: readonly ContentPart[]): ConverseBlock[] {
  return parts.map((part) => {
    if (part.type === 'text') return { text: part.text };

    // Capability checking rejects URL images before this point.
    const source = part.source;
    if (source.kind === 'url') {
      throw new NimbleError('messages: bedrock cannot fetch images by URL', {
        code: 'unsupported_feature',
        provider: 'bedrock',
        issues: [{ path: 'messages', message: 'send images as inline base64 data' }],
      });
    }

    return {
      image: {
        format: imageFormatOf(source.mediaType, 'bedrock'),
        source: { bytes: source.data },
      },
    };
  });
}

/**
 * `toolChoice: 'none'` has no Converse equivalent, so the tools are simply not
 * offered on this turn — which is what "the model must not call a tool" means.
 */
function toToolConfig(request: NimbleRequest): ConversePayload['toolConfig'] {
  if (request.tools === undefined || request.tools.length === 0) return undefined;
  if (request.toolChoice?.type === 'none') return undefined;

  const tools = request.tools.map((tool) => ({
    toolSpec: {
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      inputSchema: { json: tool.parameters },
    },
  }));

  const choice = request.toolChoice;
  if (choice === undefined) return { tools };

  const toolChoice =
    choice.type === 'tool'
      ? { tool: { name: choice.name } }
      : choice.type === 'required'
        ? { any: {} }
        : { auto: {} };

  return { tools, toolChoice };
}

function indexOf(value: unknown): number {
  const index = pick(value, 'contentBlockIndex');
  return typeof index === 'number' ? index : 0;
}
