/**
 * Error handling.
 *
 * Everything throws one type. `code` is stable across versions and safe to
 * switch on; `retryable` tells you whether sending the identical request again
 * could plausibly work.
 *
 *   node examples/08-error-handling.ts
 */

import { createClient, NimbleError } from 'nimblellm';

const client = createClient();
const model = process.env['MODEL'] ?? 'openai/gpt-4o-mini';

/** Run something and report how the failure was classified. */
async function attempt(label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
    console.log(`${label.padEnd(28)} succeeded`);
  } catch (error) {
    if (!(error instanceof NimbleError)) {
      console.log(`${label.padEnd(28)} non-Nimble error: ${String(error)}`);
      return;
    }

    console.log(`${label.padEnd(28)} ${error.code}${error.retryable ? ' (retryable)' : ''}`);
    for (const issue of error.issues) {
      console.log(`${' '.repeat(30)}${issue.path}: ${issue.message}`);
    }
  }
}

// Caught before anything leaves the process.
await attempt('temperature out of range', () =>
  client.complete({ model, messages: [{ role: 'user', content: 'hi' }], temperature: 9 }),
);

await attempt('typo in a field name', () =>
  client.complete({ model, messages: [{ role: 'user', content: 'hi' }], max_tokns: 10 }),
);

await attempt('no messages', () => client.complete({ model, messages: [] }));

await attempt('unroutable model', () =>
  client.complete({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
);

await attempt('feature the provider lacks', () =>
  client.complete({
    model: 'bedrock/anthropic.claude-haiku-4-5-20251001-v1:0',
    messages: [{ role: 'user', content: 'hi' }],
    seed: 42,
  }),
);

// A client with no credentials at all, so this case does not depend on what
// happens to be set in your environment. `env` also makes tests deterministic.
const unconfigured = createClient({ env: {} });

await attempt('provider not configured', () =>
  unconfigured.complete({
    model: 'vertex/gemini-2.0-flash',
    messages: [{ role: 'user', content: 'hi' }],
  }),
);

console.log(`
Codes you may see:
  invalid_request       the request is malformed — fix it, do not retry
  unknown_provider      the model reference could not be routed
  unsupported_feature   valid request, wrong provider for it
  authentication_error  credentials missing, malformed, or rejected
  rate_limited          retryable; Retry-After is honoured automatically
  timeout               retryable
  provider_error        upstream failure; retryable when it is a 5xx
  internal_error        a defect in NimbleLLM

Retries for rate_limited, timeout and 5xx happen automatically
(NIMBLE_MAX_RETRIES, default 2) with exponential backoff and jitter.`);
