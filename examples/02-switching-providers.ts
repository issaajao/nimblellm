/**
 * One request, every provider that has credentials.
 *
 * The point of the library in eight lines: the request body never changes, only
 * the model prefix does. Configure whichever providers you have keys for.
 *
 *   node examples/02-switching-providers.ts
 */

import { createClient } from 'nimblellm';

const client = createClient();

// Models to try, per provider. Azure names a *deployment*, so it has no default.
const MODELS: Record<string, string | undefined> = {
  openai: process.env['OPENAI_MODEL'] ?? 'gpt-4o-mini',
  azure: process.env['AZURE_DEPLOYMENT'],
  bedrock: process.env['BEDROCK_MODEL'] ?? 'anthropic.claude-haiku-4-5-20251001-v1:0',
  vertex: process.env['VERTEX_MODEL'] ?? 'gemini-2.0-flash',
  anthropic: process.env['ANTHROPIC_MODEL'] ?? 'claude-haiku-4-5-20251001',
};

/** Identical for every provider — only `model` is filled in per call. */
const request = {
  messages: [{ role: 'user', content: 'Name one planet. Reply with the name only.' }],
  maxOutputTokens: 20,
  // 0–1 keeps this inside Bedrock's range as well as everyone else's.
  temperature: 0,
};

const configured = client.configuredProviders();
if (configured.length === 0) {
  console.error('No providers configured. See .env.example.');
  process.exit(1);
}

for (const provider of configured) {
  const model = MODELS[provider];
  if (model === undefined) {
    console.log(`${provider.padEnd(8)} skipped — set ${provider.toUpperCase()}_DEPLOYMENT`);
    continue;
  }

  try {
    const response = await client.complete({ ...request, model: `${provider}/${model}` });
    const text = response.message.content
      .map((part) => (part.type === 'text' ? part.text : '[image]'))
      .join('')
      .trim();

    console.log(`${provider.padEnd(8)} ${text}  (${response.usage.totalTokens} tokens)`);
  } catch (error) {
    console.log(`${provider.padEnd(8)} failed: ${(error as Error).message}`);
  }
}
