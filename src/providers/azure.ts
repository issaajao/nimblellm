/**
 * Azure OpenAI adapter.
 *
 * The body is Chat Completions, identical to OpenAI's. The differences are all
 * in addressing: the *deployment* name goes in the URL rather than the body,
 * and every call carries an `api-version` query parameter.
 *
 * @see https://learn.microsoft.com/azure/ai-services/openai/reference
 */

import type { NimbleRequest, NimbleResponse, NimbleStreamEvent } from '../types.js';
import type { Capability, ProviderAdapter, ProviderLimits, ProviderRoute } from './adapter.js';
import {
  buildChatCompletionsPayload,
  parseChatCompletionsChunk,
  parseChatCompletionsResponse,
  type ChatCompletionsPayload,
} from './openai-compatible.js';
import { omitKeys, stringOf } from './shared.js';

/**
 * Default `api-version`. Override per request with
 * `providerOptions.azure.apiVersion`, or globally in client config (phase 3).
 */
export const DEFAULT_AZURE_API_VERSION = '2024-10-21';

/** Keys consumed by routing, which must not reach the request body. */
const ROUTING_KEYS = ['apiVersion'];

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

export class AzureOpenAIAdapter implements ProviderAdapter<ChatCompletionsPayload> {
  readonly id = 'azure' as const;
  readonly limits = LIMITS;

  supports(capability: Capability): boolean {
    return SUPPORTED.has(capability);
  }

  /**
   * `model.model` is the **deployment name**, not the base model name — on
   * Azure those are chosen independently when the deployment is created.
   */
  describeRoute(request: NimbleRequest): ProviderRoute {
    const deployment = request.model.model;
    const apiVersion =
      stringOf(request.providerOptions?.azure?.['apiVersion']) ?? DEFAULT_AZURE_API_VERSION;

    return {
      method: 'POST',
      path: `openai/deployments/${encodeURIComponent(deployment)}/chat/completions`,
      query: { 'api-version': apiVersion },
      headers: { 'content-type': 'application/json' },
    };
  }

  buildPayload(request: NimbleRequest): ChatCompletionsPayload {
    return buildChatCompletionsPayload(request, {
      includeModel: false,
      extraOptions: omitKeys(request.providerOptions?.azure, ROUTING_KEYS),
    });
  }

  parseResponse(raw: unknown, request: NimbleRequest): NimbleResponse {
    return parseChatCompletionsResponse(raw, request, this.id);
  }

  parseStreamChunk(chunk: unknown): readonly NimbleStreamEvent[] {
    return parseChatCompletionsChunk(chunk);
  }
}

export const azureAdapter = new AzureOpenAIAdapter();
