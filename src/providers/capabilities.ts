/**
 * Capability and range checking.
 *
 * Runs once, in the router, before an adapter builds anything. The goal is
 * that "Bedrock cannot do JSON schema output" is a clear error at the call
 * site rather than a 400 from a service several layers away.
 */

import { NimbleError } from '../errors.js';
import type { NimbleRequest } from '../types.js';
import type { Capability, ProviderAdapter } from './adapter.js';

/** Remediation hints, shown alongside `unsupported_feature` errors. */
const HINTS: Readonly<Record<Capability, string>> = {
  streaming: 'Send the request without `stream: true`.',
  tools: 'Remove `tools`, or route to a provider with tool support.',
  tool_choice_required: 'Use `toolChoice: { type: "auto" }`, or force a specific tool by name.',
  json_mode: 'Constrain the output with a tool definition instead.',
  json_schema: 'Constrain the output with a tool definition instead.',
  image_url: 'Fetch the image and send it as inline base64 `data` with a `mediaType`.',
  image_base64: 'Upload the image and reference it by URI instead.',
  seed: 'Remove `seed`; this provider does not offer reproducible sampling.',
  stop_sequences: 'Remove `stop` and trim the output yourself.',
  frequency_penalty: 'Remove `frequencyPenalty`.',
  presence_penalty: 'Remove `presencePenalty`.',
  top_k: 'Remove `topK`, or pass it through `providerOptions`.',
  metadata: 'Remove `metadata`; this provider does not accept request tags.',
};

/**
 * Determine which capabilities a request actually exercises.
 *
 * @returns the required capabilities, deduplicated, in a stable order
 */
export function requiredCapabilities(request: NimbleRequest): readonly Capability[] {
  const needed = new Set<Capability>();

  if (request.stream === true) needed.add('streaming');
  if (request.tools !== undefined && request.tools.length > 0) needed.add('tools');
  if (request.toolChoice?.type === 'required') needed.add('tool_choice_required');

  if (request.responseFormat?.type === 'json_object') needed.add('json_mode');
  if (request.responseFormat?.type === 'json_schema') needed.add('json_schema');

  if (request.seed !== undefined) needed.add('seed');
  if (request.stop !== undefined) needed.add('stop_sequences');
  if (request.frequencyPenalty !== undefined) needed.add('frequency_penalty');
  if (request.presencePenalty !== undefined) needed.add('presence_penalty');
  if (request.topK !== undefined) needed.add('top_k');
  if (request.metadata !== undefined) needed.add('metadata');

  for (const message of request.messages) {
    for (const part of message.content) {
      if (part.type !== 'image') continue;
      needed.add(part.source.kind === 'url' ? 'image_url' : 'image_base64');
    }
  }

  return [...needed];
}

/**
 * Reject a request the adapter cannot express.
 *
 * @throws NimbleError - `unsupported_feature`, listing every missing
 *   capability at once so a caller fixes them in one pass
 */
export function assertCapabilities(request: NimbleRequest, adapter: ProviderAdapter): void {
  const missing = requiredCapabilities(request).filter((c) => !adapter.supports(c));
  if (missing.length === 0) return;

  const details = missing.map((c) => `${c} (${HINTS[c]})`).join(' ');
  throw new NimbleError(`${adapter.id} does not support: ${missing.join(', ')}. ${details}`, {
    code: 'unsupported_feature',
    provider: adapter.id,
    issues: missing.map((capability) => ({
      path: pathFor(capability),
      message: `not supported by ${adapter.id}`,
    })),
  });
}

/**
 * Reject values outside the range the provider accepts.
 *
 * Deliberately an error rather than a clamp: silently sampling at a different
 * temperature than asked for is the kind of bug that takes a week to notice.
 *
 * @throws NimbleError - `invalid_request`
 */
export function assertWithinLimits(request: NimbleRequest, adapter: ProviderAdapter): void {
  const { temperature, topP, maxStopSequences } = adapter.limits;

  if (request.temperature !== undefined) {
    assertRange('temperature', request.temperature, temperature, adapter.id);
  }
  if (request.topP !== undefined) {
    assertRange('topP', request.topP, topP, adapter.id);
  }
  if (maxStopSequences !== undefined && request.stop !== undefined) {
    if (request.stop.length > maxStopSequences) {
      throw new NimbleError(
        `stop: ${adapter.id} accepts at most ${maxStopSequences} stop sequences, received ${request.stop.length}`,
        {
          code: 'invalid_request',
          provider: adapter.id,
          issues: [{ path: 'stop', message: `at most ${maxStopSequences} entries` }],
        },
      );
    }
  }
}

function assertRange(
  field: string,
  value: number,
  range: { readonly min: number; readonly max: number },
  provider: string,
): void {
  if (value >= range.min && value <= range.max) return;
  throw new NimbleError(
    `${field}: ${provider} accepts ${range.min}-${range.max}, received ${value}. ` +
      `Values are passed through rather than rescaled, so this request is rejected instead of being reinterpreted.`,
    {
      code: 'invalid_request',
      provider,
      issues: [{ path: field, message: `must be between ${range.min} and ${range.max}` }],
    },
  );
}

/** Map a capability back to the request field that triggered it. */
function pathFor(capability: Capability): string {
  switch (capability) {
    case 'streaming':
      return 'stream';
    case 'tools':
      return 'tools';
    case 'tool_choice_required':
      return 'toolChoice';
    case 'json_mode':
    case 'json_schema':
      return 'responseFormat';
    case 'image_url':
    case 'image_base64':
      return 'messages';
    case 'seed':
      return 'seed';
    case 'stop_sequences':
      return 'stop';
    case 'frequency_penalty':
      return 'frequencyPenalty';
    case 'presence_penalty':
      return 'presencePenalty';
    case 'top_k':
      return 'topK';
    case 'metadata':
      return 'metadata';
  }
}
