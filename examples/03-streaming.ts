/**
 * Streaming.
 *
 * Every provider frames streamed responses differently — OpenAI and Vertex use
 * server-sent events, Bedrock uses a binary format of its own. All of them
 * arrive here as the same four canonical events.
 *
 *   node examples/03-streaming.ts
 */

import { createClient, type TokenUsage } from 'nimblellm';

const client = createClient();

let usage: TokenUsage | undefined;
let finishReason: string | undefined;

for await (const event of client.stream({
  model: process.env['MODEL'] ?? 'openai/gpt-4o-mini',
  messages: [{ role: 'user', content: 'Count from one to five, in words.' }],
  maxOutputTokens: 100,
})) {
  switch (event.type) {
    case 'text_delta':
      process.stdout.write(event.text);
      break;

    case 'tool_call_delta':
      // Arguments arrive as JSON fragments; accumulate per `index` before parsing.
      process.stdout.write(`\n[tool ${event.index}: ${event.name ?? '…'}]`);
      break;

    // Usage is a separate event because providers report it on their own
    // schedule — OpenAI in a trailing chunk, Bedrock in a metadata frame.
    case 'usage':
      usage = event.usage;
      break;

    case 'finish':
      finishReason = event.finishReason;
      usage ??= event.usage;
      break;

    case 'error':
      console.error('\nstream failed:', event.error);
      break;
  }
}

console.log('\n---');
console.log('finish reason:', finishReason ?? '(none reported)');
console.log('tokens:       ', usage?.totalTokens ?? '(not reported)');
