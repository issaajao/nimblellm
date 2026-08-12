import { normalizeRequest } from '../src/core/normalize.js';
import type { NimbleRequest } from '../src/types.js';

/** Build a normalized request from a partial input, filling in the required bits. */
export function req(input: Record<string, unknown>): NimbleRequest {
  return normalizeRequest({
    model: 'openai/gpt-4o',
    messages: [{ role: 'user', content: 'hello' }],
    ...input,
  });
}

/** A user → assistant(tool call) → tool result conversation. */
export const toolConversation = [
  { role: 'user', content: 'weather in Lagos?' },
  {
    role: 'assistant',
    tool_calls: [{ id: 'call_1', name: 'get_weather', arguments: { city: 'Lagos' } }],
  },
  { role: 'tool', tool_call_id: 'call_1', content: '{"tempC":31}' },
] as const;

export const weatherTool = {
  name: 'get_weather',
  description: 'Look up the weather',
  parameters: { type: 'object', properties: { city: { type: 'string' } } },
} as const;

/** A 1x1 transparent PNG, small enough to inline in assertions. */
export const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGMAAQAABQAB';
