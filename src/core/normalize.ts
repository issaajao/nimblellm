/**
 * The entry point of the normalization layer.
 *
 * `normalizeRequest` is deliberately strict: unknown fields are rejected
 * rather than passed through, because a silently-dropped `max_tokns` is far
 * more expensive to debug than an error at the call site. Provider-specific
 * knobs belong in `providerOptions`, which is the one place arbitrary keys are
 * allowed.
 */

import { NimbleError } from '../errors.js';
import type { NimbleRequest, ProviderId } from '../types.js';
import { deepFreeze } from '../util/freeze.js';
import { canonicalizeKeys } from './keys.js';
import { asObject, describe } from './messages.js';
import { normalizeMessages } from './messages.js';
import { parseModelRef } from './model.js';
import {
  assertToolChoiceResolvable,
  normalizeMetadata,
  normalizeProviderOptions,
  normalizeResponseFormat,
  normalizeScalar,
  normalizeStop,
  normalizeToolChoice,
  normalizeTools,
} from './params.js';

/** Folded key → canonical field name, for the top level of a request. */
const REQUEST_ALIASES: Readonly<Record<string, string>> = {
  model: 'model',
  modelid: 'model',
  system: 'system',
  systemprompt: 'system',
  systeminstruction: 'system',
  messages: 'messages',

  maxoutputtokens: 'maxOutputTokens',
  maxtokens: 'maxOutputTokens',
  maxcompletiontokens: 'maxOutputTokens',
  maxtokenstosample: 'maxOutputTokens',
  temperature: 'temperature',
  topp: 'topP',
  topk: 'topK',
  frequencypenalty: 'frequencyPenalty',
  presencepenalty: 'presencePenalty',
  stop: 'stop',
  stopsequences: 'stop',
  seed: 'seed',
  stream: 'stream',

  responseformat: 'responseFormat',
  tools: 'tools',
  toolchoice: 'toolChoice',

  metadata: 'metadata',
  provideroptions: 'providerOptions',
};

export interface NormalizeOptions {
  /**
   * Provider assumed when a model reference carries no `provider/` prefix.
   * Without it, unprefixed model names are rejected.
   */
  readonly defaultProvider?: ProviderId;
}

/**
 * Validate and canonicalize a request.
 *
 * Resolves field aliases, hoists system turns, coerces content into parts, and
 * checks cross-field invariants. The result is deeply frozen and is the only
 * shape provider adapters ever see.
 *
 * @example
 * ```ts
 * const request = normalizeRequest({
 *   model: 'bedrock/anthropic.claude-sonnet-4-20250514-v1:0',
 *   messages: [
 *     { role: 'system', content: 'Be concise.' },
 *     { role: 'user', content: 'Why is the sky blue?' },
 *   ],
 *   max_tokens: 256,
 * });
 *
 * request.model.provider; // 'bedrock'
 * request.system;         // 'Be concise.'
 * request.maxOutputTokens // 256
 * ```
 *
 * @throws NimbleError - `invalid_request` for schema problems, or
 *   `unknown_provider` when the model reference cannot be routed.
 */
export function normalizeRequest(input: unknown, options: NormalizeOptions = {}): NimbleRequest {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw NimbleError.atPath('(root)', `expected a request object, received ${describe(input)}`);
  }

  const fields = canonicalizeKeys(asObject(input, '(root)'), {
    aliases: REQUEST_ALIASES,
    path: '',
    dropNull: true,
  });

  const model = parseModelRef(
    fields['model'],
    options.defaultProvider === undefined ? {} : { defaultProvider: options.defaultProvider },
  );

  const conversation = normalizeMessages(fields['messages']);
  const system = mergeSystem(fields['system'], conversation.system);

  const tools = normalizeTools(fields['tools']);
  const toolChoice = normalizeToolChoice(fields['toolChoice']);
  assertToolChoiceResolvable(toolChoice, tools);

  const maxOutputTokens = normalizeScalar('maxOutputTokens', fields['maxOutputTokens']);
  const temperature = normalizeScalar('temperature', fields['temperature']);
  const topP = normalizeScalar('topP', fields['topP']);
  const topK = normalizeScalar('topK', fields['topK']);
  const frequencyPenalty = normalizeScalar('frequencyPenalty', fields['frequencyPenalty']);
  const presencePenalty = normalizeScalar('presencePenalty', fields['presencePenalty']);
  const seed = normalizeScalar('seed', fields['seed']);
  const stream = normalizeScalar('stream', fields['stream']);

  const stop = normalizeStop(fields['stop']);
  const responseFormat = normalizeResponseFormat(fields['responseFormat']);
  const metadata = normalizeMetadata(fields['metadata']);
  const providerOptions = normalizeProviderOptions(fields['providerOptions']);

  const request: NimbleRequest = {
    model,
    ...(system === undefined ? {} : { system }),
    messages: conversation.messages,
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(temperature === undefined ? {} : { temperature }),
    ...(topP === undefined ? {} : { topP }),
    ...(topK === undefined ? {} : { topK }),
    ...(frequencyPenalty === undefined ? {} : { frequencyPenalty }),
    ...(presencePenalty === undefined ? {} : { presencePenalty }),
    ...(stop === undefined ? {} : { stop }),
    ...(seed === undefined ? {} : { seed }),
    ...(stream === undefined ? {} : { stream }),
    ...(responseFormat === undefined ? {} : { responseFormat }),
    ...(tools === undefined ? {} : { tools }),
    ...(toolChoice === undefined ? {} : { toolChoice }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(providerOptions === undefined ? {} : { providerOptions }),
  };

  return deepFreeze(request);
}

/**
 * Combine a top-level `system` field with any hoisted `system` messages.
 * The explicit field goes first, on the assumption that it is the standing
 * instruction and message-level ones are turn-specific additions.
 */
function mergeSystem(explicit: unknown, hoisted: string | undefined): string | undefined {
  let head: string | undefined;

  if (explicit !== undefined) {
    if (typeof explicit !== 'string') {
      throw NimbleError.atPath('system', `expected a string, received ${describe(explicit)}`);
    }
    if (explicit.trim() !== '') head = explicit;
  }

  if (head === undefined) return hoisted;
  if (hoisted === undefined) return head;
  return `${head}\n\n${hoisted}`;
}
