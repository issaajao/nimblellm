/**
 * The built-in adapter set.
 */

import type { ProviderId } from '../types.js';
import type { ProviderAdapter } from './adapter.js';
import { azureAdapter } from './azure.js';
import { bedrockAdapter } from './bedrock.js';
import { openaiAdapter } from './openai.js';
import { vertexAdapter } from './vertex.js';

export const builtInAdapters: readonly ProviderAdapter[] = Object.freeze([
  openaiAdapter,
  azureAdapter,
  bedrockAdapter,
  vertexAdapter,
]);

/** Adapters keyed by provider id, for direct lookup outside a router. */
export const adaptersById: Readonly<Record<ProviderId, ProviderAdapter>> = Object.freeze({
  openai: openaiAdapter,
  azure: azureAdapter,
  bedrock: bedrockAdapter,
  vertex: vertexAdapter,
});

export { AzureOpenAIAdapter, azureAdapter, DEFAULT_AZURE_API_VERSION } from './azure.js';
export { BedrockAdapter, bedrockAdapter } from './bedrock.js';
export { OpenAIAdapter, openaiAdapter } from './openai.js';
export { VertexAdapter, vertexAdapter } from './vertex.js';
export { assertCapabilities, assertWithinLimits, requiredCapabilities } from './capabilities.js';
export type { Capability, ProviderAdapter, ProviderLimits, ProviderRoute } from './adapter.js';
