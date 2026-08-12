/**
 * Structured output.
 *
 * `responseFormat` constrains the reply to a JSON Schema. OpenAI, Azure and
 * Vertex support it; **Bedrock does not**, and routing this request there fails
 * fast with `unsupported_feature` rather than returning prose you then fail to
 * parse. On Bedrock, use a tool definition instead (see example 04).
 *
 *   node examples/05-structured-output.ts
 */

import { createClient, NimbleError } from 'nimblellm';

const client = createClient();

const schema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    diameterKm: { type: 'number' },
    hasRings: { type: 'boolean' },
  },
  required: ['name', 'diameterKm', 'hasRings'],
  additionalProperties: false,
};

try {
  const response = await client.complete({
    model: process.env['MODEL'] ?? 'openai/gpt-4o-mini',
    messages: [{ role: 'user', content: 'Describe the planet Saturn.' }],
    responseFormat: {
      type: 'json_schema',
      name: 'planet',
      schema,
      // Ask the provider to guarantee conformance where it can.
      strict: true,
    },
    maxOutputTokens: 200,
  });

  const json = response.message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');

  const planet = JSON.parse(json) as { name: string; diameterKm: number; hasRings: boolean };

  console.log('parsed object:', planet);
  console.log('rings?', planet.hasRings ? 'yes' : 'no');
} catch (error) {
  if (error instanceof NimbleError && error.code === 'unsupported_feature') {
    console.error(`${error.message}\n`);
    console.error('Ask which providers can serve a request before sending it:');
    console.error("  router.candidatesFor(request) → ['openai', 'azure', 'vertex']");
    process.exit(1);
  }
  throw error;
}
