/**
 * The provider seam.
 *
 * An adapter owns exactly three things: which HTTP route a request goes to,
 * how the canonical request becomes that provider's wire format, and how the
 * response comes back. It does not own transport or credentials — those are
 * supplied by the client layer, so adapters stay pure and trivially testable.
 */

import type { NimbleRequest, NimbleResponse, NimbleStreamEvent, ProviderId } from '../types.js';

/**
 * Optional behaviours a provider may or may not implement.
 *
 * Adapters declare what they support so the router can fail fast with
 * `unsupported_feature` and a remediation hint, instead of letting the
 * provider return an opaque 400 several layers down.
 */
export type Capability =
  | 'streaming'
  | 'tools'
  | 'tool_choice_required'
  | 'json_mode'
  | 'json_schema'
  /** Images referenced by URI rather than uploaded inline. */
  | 'image_url'
  /** Images supplied as inline base64 bytes. */
  | 'image_base64'
  | 'seed'
  | 'stop_sequences'
  | 'frequency_penalty'
  | 'presence_penalty'
  | 'top_k'
  | 'metadata';

/**
 * Where a request goes, relative to the provider's base URL.
 *
 * Paths are relative because the host is configuration: an Azure resource
 * endpoint, a Bedrock regional endpoint, or a Vertex location endpoint are all
 * supplied alongside credentials rather than derived from the request.
 */
export interface ProviderRoute {
  readonly method: 'POST';
  /** Path relative to the provider base URL, with no leading slash. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  /** Non-auth headers the provider requires. Credentials are added later. */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Numeric ranges a provider enforces on canonical parameters.
 *
 * Values are passed through, never rescaled — temperature is the same softmax
 * temperature everywhere, so a request outside a provider's range is rejected
 * rather than quietly reinterpreted.
 */
export interface ProviderLimits {
  readonly temperature: { readonly min: number; readonly max: number };
  readonly topP: { readonly min: number; readonly max: number };
  /** Maximum number of stop sequences, when the provider caps them. */
  readonly maxStopSequences?: number;
}

/**
 * Translates between the canonical request/response shapes and one provider's
 * wire format.
 *
 * @typeParam TPayload - the provider's request body type
 * @typeParam TRaw - the provider's response body type
 */
export interface ProviderAdapter<TPayload = unknown, TRaw = unknown> {
  readonly id: ProviderId;
  readonly limits: ProviderLimits;

  /** Features this adapter can express. */
  supports(capability: Capability): boolean;

  /**
   * Resolve the HTTP route for a request. Streaming and non-streaming
   * requests may go to different paths.
   */
  describeRoute(request: NimbleRequest): ProviderRoute;

  /**
   * Build the provider-native request body.
   *
   * @throws NimbleError - `unsupported_feature` when the request uses a
   *   capability this provider lacks, or `invalid_request` when a value is
   *   outside what the provider accepts.
   */
  buildPayload(request: NimbleRequest): TPayload;

  /** Convert a provider response body into the canonical response shape. */
  parseResponse(raw: TRaw, request: NimbleRequest): NimbleResponse;

  /**
   * Convert one decoded chunk of a streaming response into zero or more
   * canonical events. Present whenever `supports('streaming')` is true.
   */
  parseStreamChunk?(chunk: unknown, request: NimbleRequest): readonly NimbleStreamEvent[];
}
