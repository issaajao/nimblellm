/**
 * The smallest useful call.
 *
 *   export OPENAI_API_KEY=sk-...
 *   node examples/01-basic-completion.ts
 */

import { createClient } from 'nimblellm';

const client = createClient();

const response = await client.complete({
  model: process.env['MODEL'] ?? 'openai/gpt-4o-mini',
  messages: [
    { role: 'system', content: 'You are a concise assistant. Answer in one sentence.' },
    { role: 'user', content: 'Why is the sky blue?' },
  ],
  maxOutputTokens: 100,
  temperature: 0.2,
});

// `content` is always an array of parts, even for a plain text reply — that is
// what makes the same shape work for images and tool calls.
const text = response.message.content
  .filter((part) => part.type === 'text')
  .map((part) => part.text)
  .join('');

console.log(text);

console.log('\n---');
console.log('provider:     ', response.provider);
console.log('model:        ', response.model);
console.log('finish reason:', response.finishReason);
console.log(
  'tokens:        %d in + %d out = %d',
  response.usage.inputTokens,
  response.usage.outputTokens,
  response.usage.totalTokens,
);
