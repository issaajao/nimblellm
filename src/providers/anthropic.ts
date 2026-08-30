/**
 * Anthropic adapter — the Messages API.
 *
 * The closest sibling to the Bedrock adapter, which is unsurprising: Converse
 * generalizes this shape. Three constraints carry over — only `user` and
 * `assistant` roles exist, those roles must alternate, and tool results are
 * carried inside a *user* turn. Two things differ in this adapter's favour:
 * the system prompt has a native top-level field, so nothing is hoisted, and
 * `topK` is a first-class parameter rather than a model-specific escape hatch.
 *
 * One constraint has no equivalent anywhere else: `max_tokens` is **required**
 * and has no server-side default. See {@link DEFAULT_MAX_OUTPUT_TOKENS}.
 *
 * @see https://docs.anthropic.com/en/api/messages
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

export type AnthropicBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string };
    }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: { type: 'text'; text: string }[];
      is_error?: true;
    };

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  /** JSON Schema. Anthropic names this `input_schema`, not `parameters`. */
  input_schema: Record<string, unknown>;
}

export interface MessagesPayload {
  model: string;
  messages: AnthropicMessage[];
  /** Required by the API, with no server-side default. */
  max_tokens: number;
  system?: string;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: AnthropicTool[];
  tool_choice?: { type: 'auto' | 'any' | 'none' | 'tool'; name?: string };
  metadata?: { user_id: string };
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * No JSON mode, no JSON schema output, no seed, no penalties.
 *
 * The two absences worth explaining are the output-shaping ones. Anthropic has
 * no `response_format` equivalent, and the well-known workaround — force a
 * single tool call and read the arguments as the result — is deliberately
 * *not* applied here. Emulating it would mean rewriting the response: a
 * `tool_calls` finish reason reported as `stop`, tool arguments presented as
 * message content, and a fabricated tool colliding with any the caller
 * declared. That is exactly the kind of silent reinterpretation this codebase
 * rejects elsewhere, so `json_mode` and `json_schema` fail fast with a hint
 * pointing at the tool definition instead. Bedrock reaches the same conclusion
 * for the same reason.
 */
const SUPPORTED = new Set<Capability>([
  'streaming',
  'tools',
  'tool_choice_required',
  'image_url',
  'image_base64',
  'stop_sequences',
  'top_k',
  'metadata',
]);

/** Temperature is 0–1 here, as on Bedrock — not the 0–2 OpenAI uses. */
const LIMITS: ProviderLimits = {
  temperature: { min: 0, max: 1 },
  topP: { min: 0, max: 1 },
};

/**
 * Applied when a request sets no `maxOutputTokens`.
 *
 * Anthropic requires `max_tokens` and supplies no default, so an adapter has
 * exactly two options: reject a request that omits it, or fill one in.
 * Rejecting would mean the simplest possible canonical request — a model and
 * one message — works on four providers and fails on the fifth, which breaks
 * the one promise this library makes. Absorbing a provider-specific required
 * field is precisely the job, so a default is filled in, in the same spirit as
 * the Azure API version and the Vertex location.
 *
 * 4096 is chosen to be unremarkable: large enough that ordinary answers are
 * not truncated, small enough to bound the cost of a runaway generation. It is
 * a ceiling, not a target — you are billed for tokens produced, not for this
 * number.
 *
 * Note that a request which *does* set `maxOutputTokens` is passed through
 * untouched, and a truncated response reports `finishReason: 'length'`, so a
 * budget that turns out to be too small is visible rather than silent.
 * Override per request with `maxOutputTokens`, or globally through
 * `providerOptions.anthropic.max_tokens`.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

const FINISH_REASONS: Readonly<Record<string, FinishReason>> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  refusal: 'content_filter',
};

export class AnthropicAdapter implements ProviderAdapter<MessagesPayload> {
  readonly id = 'anthropic' as const;
  readonly limits = LIMITS;

  supports(capability: Capability): boolean {
    return SUPPORTED.has(capability);
  }

  describeRoute(_request: NimbleRequest): ProviderRoute {
    // Streaming uses the same endpoint; only the body's `stream` flag differs.
    // The `anthropic-version` header is added by the credentials layer, which
    // is where the configured version lives.
    return {
      method: 'POST',
      path: 'v1/messages',
      headers: { 'content-type': 'application/json' },
    };
  }

  buildPayload(request: NimbleRequest): MessagesPayload {
    const payload: MessagesPayload = {
      model: request.model.model,
      messages: toAnthropicMessages(request),
      max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      ...(request.system === undefined ? {} : { system: request.system }),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.topP === undefined ? {} : { top_p: request.topP }),
      ...(request.topK === undefined ? {} : { top_k: request.topK }),
      ...(request.stop === undefined ? {} : { stop_sequences: [...request.stop] }),
      ...(request.stream === undefined ? {} : { stream: request.stream }),
      ...(request.metadata === undefined ? {} : { metadata: toMetadata(request.metadata) }),
    };

    const tools = toTools(request);
    if (tools !== undefined) Object.assign(payload, tools);

    return applyProviderOptions(payload, request.providerOptions?.anthropic);
  }

  parseResponse(raw: unknown, request: NimbleRequest): NimbleResponse {
    const blocks = pick(raw, 'content');
    if (!Array.isArray(blocks)) {
      throw new NimbleError('anthropic returned no content blocks', {
        code: 'provider_error',
        provider: this.id,
        retryable: true,
      });
    }

    const content: ContentPart[] = [];
    const toolCalls: ToolCall[] = [];

    for (const block of blocks) {
      switch (pick(block, 'type')) {
        case 'text': {
          const text = pick(block, 'text');
          if (typeof text === 'string' && text !== '') content.push({ type: 'text', text });
          break;
        }

        case 'tool_use': {
          const input = pick(block, 'input');
          toolCalls.push({
            id: stringOf(pick(block, 'id')) ?? '',
            name: stringOf(pick(block, 'name')) ?? '',
            // Unlike OpenAI, arguments arrive already decoded, so there is no
            // JSON string to parse and nothing that can be malformed here.
            arguments:
              typeof input === 'object' && input !== null && !Array.isArray(input)
                ? (input as Record<string, unknown>)
                : {},
          });
          break;
        }

        // `thinking` and `redacted_thinking` blocks have no canonical
        // equivalent and are not model output in the ordinary sense. They stay
        // reachable on `raw` rather than being flattened into the message.
        default:
          break;
      }
    }

    const message: AssistantMessage = {
      role: 'assistant',
      content,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };

    const usage = pick(raw, 'usage');

    return {
      id: stringOf(pick(raw, 'id')) ?? `anthropic-${Date.now()}`,
      provider: this.id,
      model: stringOf(pick(raw, 'model')) ?? request.model.model,
      // The Messages API reports no timestamp, so this is the receive time.
      createdAt: new Date().toISOString(),
      finishReason: FINISH_REASONS[String(pick(raw, 'stop_reason'))] ?? 'unknown',
      message,
      // Anthropic reports no total; `usageOf` sums the two it does report.
      usage:
        usage === undefined
          ? NO_USAGE
          : usageOf(pick(usage, 'input_tokens'), pick(usage, 'output_tokens')),
      raw,
    };
  }

  /**
   * Anthropic streams a typed event sequence rather than repeated snapshots of
   * one object, so each event maps to at most a couple of canonical events.
   *
   * The one piece of cross-event state — input tokens, reported at
   * `message_start` but needed at `message_delta` — is stitched together by
   * `readAnthropicStream` before chunks reach here. This stays a pure function
   * of one chunk, because the adapter is a shared singleton and per-request
   * state on it would leak between concurrent streams.
   */
  parseStreamChunk(chunk: unknown): readonly NimbleStreamEvent[] {
    const events: NimbleStreamEvent[] = [];
    const index = indexOf(chunk);

    switch (pick(chunk, 'type')) {
      case 'content_block_start': {
        const block = pick(chunk, 'content_block');
        if (pick(block, 'type') === 'tool_use') {
          const id = stringOf(pick(block, 'id'));
          const name = stringOf(pick(block, 'name'));
          events.push({
            type: 'tool_call_delta',
            index,
            ...(id === undefined ? {} : { id }),
            ...(name === undefined ? {} : { name }),
          });
        }
        break;
      }

      case 'content_block_delta': {
        const delta = pick(chunk, 'delta');
        const text = pick(delta, 'text');
        if (pick(delta, 'type') === 'text_delta' && typeof text === 'string' && text !== '') {
          events.push({ type: 'text_delta', text });
        }

        // Tool arguments stream as partial JSON, the same as everywhere else.
        const partial = pick(delta, 'partial_json');
        if (typeof partial === 'string') {
          events.push({ type: 'tool_call_delta', index, argumentsDelta: partial });
        }
        break;
      }

      case 'message_delta': {
        // Usage and the stop reason arrive together in this one event. They are
        // still emitted as two canonical events, so that a consumer watching
        // only for `usage` sees it — as it would from every other provider.
        const usage = pick(chunk, 'usage');
        if (usage !== undefined) {
          events.push({
            type: 'usage',
            usage: usageOf(pick(usage, 'input_tokens'), pick(usage, 'output_tokens')),
          });
        }

        const reason = dig(chunk, 'delta', 'stop_reason');
        if (reason !== null && reason !== undefined) {
          events.push({
            type: 'finish',
            finishReason: FINISH_REASONS[String(reason)] ?? 'unknown',
          });
        }
        break;
      }

      // An error can arrive mid-stream, after a 200 has already been sent.
      case 'error':
        events.push({ type: 'error', error: pick(chunk, 'error') });
        break;

      // `message_start`, `content_block_stop`, `message_stop` and `ping` carry
      // nothing canonical.
      default:
        break;
    }

    return events;
  }
}

export const anthropicAdapter = new AnthropicAdapter();

// ---------------------------------------------------------------------------
// Request mapping
// ---------------------------------------------------------------------------

/**
 * Map canonical messages onto Anthropic's two roles, merging neighbours that
 * ended up sharing one — a tool result becomes a `user` turn, so a
 * user → assistant → tool → tool sequence collapses to alternating turns.
 */
function toAnthropicMessages(request: NimbleRequest): AnthropicMessage[] {
  const messages: AnthropicMessage[] = [];

  for (const message of request.messages) {
    const role: 'user' | 'assistant' = message.role === 'assistant' ? 'assistant' : 'user';
    const blocks: AnthropicBlock[] = [];

    if (message.role === 'tool') {
      blocks.push({
        type: 'tool_result',
        tool_use_id: message.toolCallId,
        content: [{ type: 'text', text: textOf(message.content) }],
        ...(message.isError === true ? { is_error: true as const } : {}),
      });
    } else {
      blocks.push(...toBlocks(message.content));
      if (message.role === 'assistant' && message.toolCalls !== undefined) {
        blocks.push(...toToolUseBlocks(message.toolCalls));
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
    throw new NimbleError(
      'messages: anthropic requires the conversation to start with a user turn',
      {
        code: 'invalid_request',
        provider: 'anthropic',
        issues: [
          { path: 'messages[0].role', message: 'anthropic conversations must start with "user"' },
        ],
      },
    );
  }

  return messages;
}

function toBlocks(parts: readonly ContentPart[]): AnthropicBlock[] {
  return parts.map((part) => {
    if (part.type === 'text') return { type: 'text' as const, text: part.text };

    const source = part.source;
    if (source.kind === 'url') {
      return { type: 'image' as const, source: { type: 'url' as const, url: source.url } };
    }

    return {
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        // Anthropic wants the full media type rather than Bedrock's bare format
        // token, but the same four formats and the same jpg → jpeg fold apply,
        // so the validation is shared and the prefix put back on.
        media_type: `image/${imageFormatOf(source.mediaType, 'anthropic')}`,
        data: source.data,
      },
    };
  });
}

/**
 * Canonical tool calls become `tool_use` content blocks.
 *
 * Deliberately not shared with the OpenAI mapping: there, a call is an entry in
 * a sibling `tool_calls` array whose arguments are a JSON *string*. Here it is
 * a content block, inline with the text, whose `input` is a JSON *object*.
 * Those are different enough that one function serving both would be a
 * conditional pretending to be an abstraction.
 */
function toToolUseBlocks(calls: readonly ToolCall[]): AnthropicBlock[] {
  return calls.map((call) => ({
    type: 'tool_use' as const,
    id: call.id,
    name: call.name,
    input: call.arguments,
  }));
}

/** Tool declarations and the choice, which are set or omitted together. */
function toTools(
  request: NimbleRequest,
): Pick<MessagesPayload, 'tools' | 'tool_choice'> | undefined {
  if (request.tools === undefined || request.tools.length === 0) return undefined;

  const tools: AnthropicTool[] = request.tools.map((tool) => ({
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    input_schema: tool.parameters,
  }));

  const choice = request.toolChoice;
  if (choice === undefined) return { tools };

  // Every canonical choice has a native spelling here, including `none` —
  // which Converse cannot express and has to fake by withholding the tools.
  const tool_choice =
    choice.type === 'tool'
      ? { type: 'tool' as const, name: choice.name }
      : choice.type === 'required'
        ? { type: 'any' as const }
        : { type: choice.type };

  return { tools, tool_choice };
}

/**
 * Anthropic's `metadata` is not a free-form bag: `user_id` is the only key it
 * accepts, and it must not carry identifying information.
 *
 * Anything else is rejected here rather than dropped, so a caller who tags
 * requests for another provider finds out at the call site instead of losing
 * the tags silently — or collecting an opaque 400.
 */
function toMetadata(metadata: Readonly<Record<string, string>>): { user_id: string } {
  const unknown = Object.keys(metadata).filter((key) => key !== 'user_id');
  if (unknown.length > 0) {
    throw new NimbleError(
      `metadata: anthropic accepts only "user_id"; received ${unknown.map((key) => `"${key}"`).join(', ')}. ` +
        'Move the rest into the prompt, or drop them for this provider.',
      {
        code: 'invalid_request',
        provider: 'anthropic',
        issues: unknown.map((key) => ({
          path: `metadata.${key}`,
          message: 'anthropic accepts only "user_id"',
        })),
      },
    );
  }

  return { user_id: metadata['user_id'] ?? '' };
}

/** The content-block index an event refers to, defaulting to the first. */
function indexOf(chunk: unknown): number {
  const index = pick(chunk, 'index');
  return typeof index === 'number' ? index : 0;
}
