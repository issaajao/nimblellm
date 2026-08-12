/**
 * Fallback across providers.
 *
 * `candidatesFor` answers "who could serve this request as written?" without
 * sending anything — capability and range checks are pure. That is the piece
 * you need to build a fallback chain that does not waste a round trip
 * discovering a provider was never going to accept the request.
 *
 *   node examples/07-fallback.ts
 */

import {
  createClient,
  NimbleError,
  normalizeRequest,
  type NimbleResponse,
  type ProviderId,
} from 'nimblellm';

const client = createClient();

/** Preference order. Earlier entries are tried first. */
const PREFERENCE: ProviderId[] = ['bedrock', 'openai', 'vertex', 'azure'];

const MODELS: Record<ProviderId, string> = {
  openai: 'gpt-4o-mini',
  azure: process.env['AZURE_DEPLOYMENT'] ?? 'gpt-4o-mini',
  bedrock: 'anthropic.claude-haiku-4-5-20251001-v1:0',
  vertex: 'gemini-2.0-flash',
};

const request = {
  messages: [{ role: 'user', content: 'Name one ocean. Reply with the name only.' }],
  maxOutputTokens: 20,
  temperature: 0,
  // Uncomment to watch Bedrock drop out of the candidate list:
  // seed: 42,
};

// Which providers *could* take this request, ignoring credentials. Normalizing
// against any provider is fine — capability checks do not depend on the model.
const capable = client.router.candidatesFor(
  normalizeRequest({ ...request, model: 'openai/placeholder' }),
);

// Intersect with the ones actually configured, in preference order.
const configured = new Set(client.configuredProviders());
const chain = PREFERENCE.filter((id) => capable.includes(id) && configured.has(id));

console.log('capable of this request:', capable.join(', ') || '(none)');
console.log('configured here:        ', [...configured].join(', ') || '(none)');
console.log('fallback chain:         ', chain.join(' → ') || '(empty)');
console.log();

let response: NimbleResponse | undefined;
const failures: string[] = [];

for (const provider of chain) {
  try {
    response = await client.complete({ ...request, model: `${provider}/${MODELS[provider]}` });
    console.log(`${provider}: succeeded`);
    break;
  } catch (error) {
    const failure = error as NimbleError;
    failures.push(`${provider}: ${failure.message}`);

    // A request that is wrong will be wrong everywhere — do not walk the chain
    // burning quota on a bad payload.
    if (
      failure instanceof NimbleError &&
      !failure.retryable &&
      failure.code === 'invalid_request'
    ) {
      console.error('request is invalid; not trying further providers');
      break;
    }
    console.log(`${provider}: failed, trying next`);
  }
}

if (response === undefined) {
  console.error('\nevery provider failed:');
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log(
  '\nanswer:',
  response.message.content
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('')
    .trim(),
);
console.log('served by:', response.provider);
