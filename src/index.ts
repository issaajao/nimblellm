/**
 * NimbleLLM — know which providers can serve a request before you send it.
 *
 * A portability layer over OpenAI, Anthropic, AWS Bedrock, Azure OpenAI and
 * Google Vertex AI: one canonical request shape, and a router that reports
 * which providers can express a given request rather than letting them
 * discover it by returning a 400.
 *
 * @packageDocumentation
 */

export { normalizeRequest, type NormalizeOptions } from './core/normalize.js';
export {
  parseModelRef,
  formatModelRef,
  isProviderId,
  type ParseModelOptions,
} from './core/model.js';
export { normalizeMessages, type NormalizedConversation } from './core/messages.js';

export {
  NimbleError,
  type NimbleErrorCode,
  type NimbleErrorOptions,
  type NimbleIssue,
} from './errors.js';

export {
  PROVIDER_IDS,
  type AssistantMessage,
  type ContentPart,
  type FinishReason,
  type ImageSource,
  type MessageRole,
  type ModelRef,
  type NimbleMessage,
  type NimbleRequest,
  type NimbleResponse,
  type NimbleStreamEvent,
  type NimbleTool,
  type ProviderId,
  type ResponseFormat,
  type TokenUsage,
  type ToolCall,
  type ToolChoice,
  type ToolMessage,
  type UserMessage,
} from './types.js';

export { Router, createRouter, type RoutedRequest, type RouterOptions } from './router.js';

export {
  adaptersById,
  builtInAdapters,
  assertCapabilities,
  assertWithinLimits,
  requiredCapabilities,
  AnthropicAdapter,
  anthropicAdapter,
  AzureOpenAIAdapter,
  azureAdapter,
  BedrockAdapter,
  bedrockAdapter,
  OpenAIAdapter,
  openaiAdapter,
  VertexAdapter,
  vertexAdapter,
  DEFAULT_AZURE_API_VERSION,
  DEFAULT_MAX_OUTPUT_TOKENS,
  type Capability,
  type ProviderAdapter,
  type ProviderLimits,
  type ProviderRoute,
} from './providers/index.js';

export type { ChatCompletionsPayload } from './providers/openai-compatible.js';
export type { ConversePayload } from './providers/bedrock.js';
export type { GeminiPayload } from './providers/vertex.js';
export type { MessagesPayload } from './providers/anthropic.js';

export {
  NimbleClient,
  createClient,
  buildUrl,
  withProviderDefaults,
  type CallOptions,
  type ClientOptions,
} from './client.js';

export { Secret, redact } from './config/secret.js';
export {
  loadConfig,
  withOverrides,
  configuredProviders,
  secretsIn,
  DEFAULT_MAX_RETRIES,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_VERTEX_LOCATION,
  DEFAULT_ANTHROPIC_BASE_URL,
  DEFAULT_ANTHROPIC_VERSION,
  type AnthropicConfig,
  type AzureConfig,
  type ConfigOverrides,
  type BedrockConfig,
  type Env,
  type NimbleConfig,
  type OpenAIConfig,
  type VertexConfig,
  type VertexServiceAccount,
} from './config/config.js';

export {
  CredentialRegistry,
  AnthropicCredentials,
  AzureCredentials,
  BedrockCredentials,
  OpenAICredentials,
  VertexCredentials,
  type Credentials,
  type SigningContext,
} from './auth/credentials.js';
export { signRequest, type SignedRequest, type SignRequestInput } from './auth/sigv4.js';
export { ServiceAccountTokenSource, StaticTokenSource, type TokenSource } from './auth/google.js';

export {
  createGatewayServer,
  startServer,
  readBody,
  type ServerOptions,
  type StartedServer,
} from './server/server.js';
export {
  loadServerConfig,
  isAuthorized,
  DEFAULT_HOST,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_PORT,
  DEFAULT_SHUTDOWN_GRACE_MS,
  type LogLevel,
  type ServerConfig,
} from './server/config.js';

export { send, codeForStatus, type HttpRequest, type SendOptions } from './transport/http.js';
export { readEventStream, readJsonEventStream } from './transport/sse.js';
export { EventStreamDecoder, readBedrockStream } from './transport/aws-event-stream.js';
export { readAnthropicStream } from './transport/anthropic-stream.js';
export { VERSION } from './version.js';
