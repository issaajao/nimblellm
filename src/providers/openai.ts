/**
 * OpenAI adapter — the Chat Completions API.
 *
 * @see https://platform.openai.com/docs/api-reference/chat
 */

import type { NimbleRequest, NimbleResponse, NimbleStreamEvent } from '../types.js';
import type { Capability, ProviderAdapter, ProviderLimits, ProviderRoute } from './adapter.js';
import {
  buildChatCompletionsPayload,
  parseChatCompletionsChunk,
  parseChatCompletionsResponse,
  type ChatCompletionsPayload,
} from './openai-compatible.js';

/** Everything except `topK`, which Chat Completions does not expose. */
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
  'metadata',
]);

const LIMITS: ProviderLimits = {
  temperature: { min: 0, max: 2 },
  topP: { min: 0, max: 1 },
  maxStopSequences: 4,
};

export class OpenAIAdapter implements ProviderAdapter<ChatCompletionsPayload> {
  readonly id = 'openai' as const;
  readonly limits = LIMITS;

  supports(capability: Capability): boolean {
    return SUPPORTED.has(capability);
  }

  describeRoute(_request: NimbleRequest): ProviderRoute {
    // Streaming uses the same endpoint; only the body's `stream` flag differs.
    return {
      method: 'POST',
      path: 'v1/chat/completions',
      headers: { 'content-type': 'application/json' },
    };
  }

  buildPayload(request: NimbleRequest): ChatCompletionsPayload {
    return buildChatCompletionsPayload(request, {
      includeModel: true,
      extraOptions: request.providerOptions?.openai,
    });
  }

  parseResponse(raw: unknown, request: NimbleRequest): NimbleResponse {
    return parseChatCompletionsResponse(raw, request, this.id);
  }

  parseStreamChunk(chunk: unknown): readonly NimbleStreamEvent[] {
    return parseChatCompletionsChunk(chunk);
  }
}

export const openaiAdapter = new OpenAIAdapter();
