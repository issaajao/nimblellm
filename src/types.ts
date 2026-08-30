/**
 * The canonical request and response shapes.
 *
 * Everything in NimbleLLM is expressed in terms of these types. Provider
 * adapters translate *to* the provider wire format on the way out and *from*
 * it on the way back, so application code never sees a vendor-specific field.
 */

/** Providers NimbleLLM knows how to route to. */
export const PROVIDER_IDS = ['openai', 'azure', 'bedrock', 'vertex', 'anthropic'] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

/** A model reference after the `provider/model` prefix has been resolved. */
export interface ModelRef {
  readonly provider: ProviderId;
  /**
   * The provider-native model identifier, with the routing prefix stripped.
   * For Azure this is the *deployment* name, not the base model name.
   */
  readonly model: string;
  /** The string the caller originally supplied, kept for logging. */
  readonly raw: string;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * Roles in a canonical conversation.
 *
 * Note that `system` is not listed: system instructions are hoisted out of the
 * message list into {@link NimbleRequest.system}, because every provider but
 * OpenAI carries them in a dedicated top-level field.
 */
export type MessageRole = 'user' | 'assistant' | 'tool';

/** An image supplied either by URL or as inline base64 bytes. */
export type ImageSource =
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'base64'; readonly mediaType: string; readonly data: string };

export type ContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly source: ImageSource };

/** A model-requested invocation of a tool. */
export interface ToolCall {
  /** Provider-assigned identifier, echoed back on the matching tool result. */
  readonly id: string;
  /** Name of the tool the model wants to run. */
  readonly name: string;
  /**
   * Arguments as decoded JSON. Adapters that receive arguments as a JSON
   * string parse them here so callers never have to.
   */
  readonly arguments: Record<string, unknown>;
}

export interface UserMessage {
  readonly role: 'user';
  readonly content: readonly ContentPart[];
  /** Optional participant name, for multi-speaker transcripts. */
  readonly name?: string;
}

export interface AssistantMessage {
  readonly role: 'assistant';
  readonly content: readonly ContentPart[];
  readonly toolCalls?: readonly ToolCall[];
  readonly name?: string;
}

/** The result of running a tool the assistant asked for. */
export interface ToolMessage {
  readonly role: 'tool';
  /** Must match the `id` of a `ToolCall` earlier in the conversation. */
  readonly toolCallId: string;
  readonly content: readonly ContentPart[];
  /** Set when the tool failed, so adapters can flag the result to the model. */
  readonly isError?: boolean;
}

export type NimbleMessage = UserMessage | AssistantMessage | ToolMessage;

// ---------------------------------------------------------------------------
// Tools and output shaping
// ---------------------------------------------------------------------------

/** A tool the model may call, described with JSON Schema. */
export interface NimbleTool {
  readonly type: 'function';
  readonly name: string;
  readonly description?: string;
  /** JSON Schema object describing the arguments. */
  readonly parameters: Record<string, unknown>;
}

export type ToolChoice =
  /** Model decides freely (default when tools are present). */
  | { readonly type: 'auto' }
  /** Model must not call a tool. */
  | { readonly type: 'none' }
  /** Model must call some tool, its choice which. */
  | { readonly type: 'required' }
  /** Model must call this specific tool. */
  | { readonly type: 'tool'; readonly name: string };

export type ResponseFormat =
  | { readonly type: 'text' }
  | { readonly type: 'json_object' }
  | {
      readonly type: 'json_schema';
      readonly name: string;
      readonly schema: Record<string, unknown>;
      /** Ask the provider to guarantee conformance, where it supports that. */
      readonly strict?: boolean;
    };

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/**
 * A fully normalized, validated request.
 *
 * Instances are deeply frozen. Build one with `normalizeRequest()` rather than
 * by hand, so that aliases are resolved and invariants are checked.
 */
export interface NimbleRequest {
  readonly model: ModelRef;
  /** System instructions, hoisted out of the message list. */
  readonly system?: string;
  /** At least one message; never contains a `system` role. */
  readonly messages: readonly NimbleMessage[];

  readonly maxOutputTokens?: number;
  /** Canonical range is 0–2, matching OpenAI. Adapters rescale as needed. */
  readonly temperature?: number;
  readonly topP?: number;
  readonly topK?: number;
  readonly frequencyPenalty?: number;
  readonly presencePenalty?: number;
  readonly stop?: readonly string[];
  readonly seed?: number;
  readonly stream?: boolean;

  readonly responseFormat?: ResponseFormat;
  readonly tools?: readonly NimbleTool[];
  readonly toolChoice?: ToolChoice;

  /** Free-form labels forwarded to providers that support request tagging. */
  readonly metadata?: Readonly<Record<string, string>>;
  /**
   * Escape hatch for provider-specific knobs that have no canonical
   * equivalent. Merged into the outgoing payload by the matching adapter and
   * ignored by every other one.
   */
  readonly providerOptions?: Readonly<Partial<Record<ProviderId, Record<string, unknown>>>>;
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

export type FinishReason =
  /** Model reached a natural stopping point or a stop sequence. */
  | 'stop'
  /** Output was cut off by the token budget. */
  | 'length'
  /** Model stopped in order to call one or more tools. */
  | 'tool_calls'
  /** Provider-side safety filtering truncated or blocked the output. */
  | 'content_filter'
  /** Provider reported a reason we have no canonical mapping for. */
  | 'unknown';

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

/** A non-streaming completion, normalized across providers. */
export interface NimbleResponse {
  /** Provider-assigned response id, or a generated one if absent upstream. */
  readonly id: string;
  readonly provider: ProviderId;
  /** Model the provider reports having served, which may differ from request. */
  readonly model: string;
  /** ISO-8601 timestamp of when the response was produced. */
  readonly createdAt: string;
  readonly finishReason: FinishReason;
  readonly message: AssistantMessage;
  readonly usage: TokenUsage;
  /** Untouched provider payload, for escape-hatch access. */
  readonly raw?: unknown;
}

/** Incremental events emitted while streaming a completion. */
export type NimbleStreamEvent =
  | { readonly type: 'text_delta'; readonly text: string }
  | {
      readonly type: 'tool_call_delta';
      readonly index: number;
      readonly id?: string;
      readonly name?: string;
      readonly argumentsDelta?: string;
    }
  /**
   * Token counts. Emitted separately from `finish` because every provider
   * reports usage on its own schedule — OpenAI in a trailing chunk after the
   * finish reason, Bedrock in a `metadata` event, Vertex on each chunk.
   */
  | { readonly type: 'usage'; readonly usage: TokenUsage }
  | { readonly type: 'finish'; readonly finishReason: FinishReason; readonly usage?: TokenUsage }
  | { readonly type: 'error'; readonly error: unknown };
