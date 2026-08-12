/**
 * A full tool-calling round trip.
 *
 * Ask → model requests a tool → run it → hand back the result → final answer.
 * The conversation you build is the canonical one; each adapter translates it
 * into its provider's very different tool format.
 *
 *   node examples/04-tool-calling.ts
 */

import { createClient, type NimbleMessage, type NimbleTool } from 'nimblellm';

const client = createClient();
const model = process.env['MODEL'] ?? 'openai/gpt-4o-mini';

const tools: NimbleTool[] = [
  {
    type: 'function',
    name: 'get_weather',
    description: 'Current weather for a city.',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City name, e.g. "Lagos"' },
      },
      required: ['city'],
    },
  },
];

/** Stand-in for whatever your tool actually does. */
function getWeather(args: Record<string, unknown>): string {
  return JSON.stringify({ city: args['city'], tempC: 31, conditions: 'sunny' });
}

const messages: NimbleMessage[] = [
  { role: 'user', content: [{ type: 'text', text: 'What is the weather in Lagos?' }] },
];

const first = await client.complete({ model, messages, tools, maxOutputTokens: 200 });

if (first.finishReason !== 'tool_calls' || first.message.toolCalls === undefined) {
  console.log('The model answered without calling a tool:');
  console.log(first.message.content.map((p) => (p.type === 'text' ? p.text : '')).join(''));
  process.exit(0);
}

// Keep the assistant turn verbatim — providers reject a tool result whose call
// is missing from the history, and `arguments` is already parsed JSON here.
messages.push(first.message);

for (const call of first.message.toolCalls) {
  console.log(`→ ${call.name}(${JSON.stringify(call.arguments)})`);
  const result = getWeather(call.arguments);
  console.log(`← ${result}`);

  messages.push({
    role: 'tool',
    // Matching the call by id is what lets Vertex resolve it back to a name,
    // since Gemini identifies results by function name rather than by id.
    toolCallId: call.id,
    content: [{ type: 'text', text: result }],
  });
}

const second = await client.complete({ model, messages, tools, maxOutputTokens: 200 });

console.log('\n' + second.message.content.map((p) => (p.type === 'text' ? p.text : '')).join(''));
console.log('\ntotal tokens:', first.usage.totalTokens + second.usage.totalTokens);
