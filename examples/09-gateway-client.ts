/**
 * Calling the gateway over HTTP.
 *
 * When NimbleLLM runs as a container, applications talk to it with plain
 * `fetch` — no SDK, no provider credentials in the calling service. Start it
 * first:
 *
 *   NIMBLE_SERVER_API_KEYS=dev-key OPENAI_API_KEY=sk-... npm start
 *   node examples/09-gateway-client.ts
 *
 * Note the gateway answers in the **canonical** shape, not OpenAI's — an
 * OpenAI SDK pointed at this URL will not be able to parse the reply.
 */

const BASE = process.env['NIMBLE_GATEWAY_URL'] ?? 'http://localhost:8080';
const KEY = process.env['NIMBLE_SERVER_API_KEYS'] ?? 'dev-key';

const headers = {
  authorization: `Bearer ${KEY}`,
  'content-type': 'application/json',
};

// 1. Is it up, and does it have credentials?
const ready = await fetch(`${BASE}/ready`);
console.log(`/ready → ${ready.status}`, await ready.json());

// 2. What can it route to?
const providers = (await (await fetch(`${BASE}/v1/providers`, { headers })).json()) as {
  providers: { id: string; configured: boolean }[];
};
console.log(
  '\nconfigured providers:',
  providers.providers
    .filter((p) => p.configured)
    .map((p) => p.id)
    .join(', ') || '(none)',
);

// 3. A completion.
const response = await fetch(`${BASE}/v1/chat/completions`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    model: process.env['MODEL'] ?? 'openai/gpt-4o-mini',
    messages: [{ role: 'user', content: 'Name one colour. Reply with the name only.' }],
    // OpenAI spellings are accepted on the way in and normalized for you.
    max_tokens: 20,
  }),
});

if (!response.ok) {
  console.error(`\nfailed (${response.status}):`, await response.text());
  process.exit(1);
}

const completion = (await response.json()) as {
  provider: string;
  message: { content: { type: string; text?: string }[] };
  usage: { totalTokens: number };
};

console.log(
  '\nanswer:  ',
  completion.message.content
    .map((p) => p.text ?? '')
    .join('')
    .trim(),
);
console.log('provider:', completion.provider);
console.log('tokens:  ', completion.usage.totalTokens);

// 4. The same call, streamed as server-sent events.
process.stdout.write('\nstreamed: ');
const stream = await fetch(`${BASE}/v1/chat/completions`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    model: process.env['MODEL'] ?? 'openai/gpt-4o-mini',
    messages: [{ role: 'user', content: 'Count to three.' }],
    stream: true,
  }),
});

const decoder = new TextDecoder();
for await (const chunk of stream.body!) {
  for (const line of decoder.decode(chunk as Uint8Array).split('\n\n')) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6);
    if (data === '[DONE]') continue;

    const event = JSON.parse(data) as { type: string; text?: string };
    if (event.type === 'text_delta') process.stdout.write(event.text ?? '');
  }
}
console.log();
