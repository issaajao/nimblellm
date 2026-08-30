# Quick start

## Install

```bash
npm install nimblellm
```

Node 20.19 or newer. The package has one runtime dependency (`zod`).

## Set a credential

Whichever provider you already have a key for. This page uses OpenAI; the
[provider pages](./README.md#provider-setup) cover the other three.

```bash
export OPENAI_API_KEY=sk-...
```

## Make a call

```ts
import { createClient } from 'nimblellm';

const client = createClient(); // reads credentials from the environment

const response = await client.complete({
  model: 'openai/gpt-4o-mini',
  messages: [
    { role: 'system', content: 'You are a concise assistant.' },
    { role: 'user', content: 'Why is the sky blue?' },
  ],
  maxOutputTokens: 100,
});

console.log(response.message.content);
// [{ type: 'text', text: 'Sunlight scatters off air molecules…' }]

console.log(response.usage.totalTokens); // 87
```

That is [example 01](../examples/01-basic-completion.ts), which you can run
directly:

```bash
node examples/01-basic-completion.ts
```

> Running `.ts` files directly needs Node 22.6+ (type stripping). On Node 20,
> use `npx tsx examples/01-basic-completion.ts`.

## Two things that will surprise you

**Content is always an array of parts**, even for a plain text reply:

```ts
const text = response.message.content
  .filter((part) => part.type === 'text')
  .map((part) => part.text)
  .join('');
```

That is what lets the same shape carry images and tool calls without a second
code path. It costs one line here and saves a rewrite later.

**System messages are hoisted.** They come out of the message list into a
top-level `system` field, because every provider but OpenAI carries them
separately:

```ts
const request = normalizeRequest({
  model: 'openai/gpt-4o',
  messages: [
    { role: 'system', content: 'Be concise.' },
    { role: 'user', content: 'Hello' },
  ],
});

request.system; // 'Be concise.'
request.messages; // just the user turn
```

## Change providers

Change the prefix, supply that provider's credentials, and nothing else moves:

```ts
model: 'openai/gpt-4o-mini';
model: 'azure/my-deployment'; // the deployment name, not the model name
model: 'bedrock/anthropic.claude-haiku-4-5-20251001-v1:0';
model: 'vertex/gemini-2.0-flash';
```

Without a prefix, set a default:

```ts
createClient({ config: { defaultProvider: 'openai' } });
// or NIMBLE_DEFAULT_PROVIDER=openai
```

An unprefixed model with no default is an error rather than a guess.

## Write the request however you like

These are all the same request. Aliases are resolved for you, so pasting code
from an OpenAI example works:

```ts
{
  max_tokens: 256;
} // OpenAI
{
  maxTokens: 256;
} // camelCase
{
  maxOutputTokens: 256;
} // canonical
{
  max_completion_tokens: 256;
}
```

Two spellings of the same field in one request is an error, not a coin flip.
So is a field that does not exist:

```ts
client.complete({ model, messages, max_tokns: 10 });
// NimbleError: max_tokns: unknown field. Accepted fields: frequencyPenalty, …
```

A silently ignored typo is far more expensive to find than an error at the call
site.

## Stream

```ts
for await (const event of client.stream({ model, messages })) {
  if (event.type === 'text_delta') process.stdout.write(event.text);
}
```

See [Streaming](./streaming.md) for the full event set.

## Handle failures

Everything throws `NimbleError` with a `code` that is stable across versions:

```ts
import { NimbleError } from 'nimblellm';

try {
  await client.complete({ model, messages });
} catch (error) {
  if (error instanceof NimbleError) {
    if (error.code === 'rate_limited') {
      // Already retried automatically; this is after retries were exhausted.
    }
    console.error(error.code, error.issues);
  }
}
```

See [Errors and retries](./errors.md).

## Next

- [Configuration](./configuration.md) — every variable and how secrets are held.
- [Tools and structured output](./tools.md)
- [Running as a gateway](./gateway.md) — one container in front of every provider.
- [Known limitations](../KNOWN_LIMITATIONS.md) — read before production.
