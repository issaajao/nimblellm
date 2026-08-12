#!/usr/bin/env node
/**
 * Live provider verification — MANUAL, ON-DEMAND.
 *
 * This is the only thing in the repository that makes a real, billable call to
 * a real provider. It is deliberately **not** wired into `npm test` or CI: it
 * needs credentials, it costs money, and it fails for reasons that have nothing
 * to do with the code (a model not enabled in a region, a quota, an expired
 * token). Run it by hand, once, before trusting a deployment.
 *
 * Each provider is checked twice, because the two paths can fail independently:
 *
 *   complete  the non-streaming call — proves authentication is accepted
 *   stream    the streaming call — proves the response framing decodes
 *
 * Bedrock is the reason both legs exist. Its SigV4 signature is *computed* by
 * this codebase rather than copied from configuration, and its streamed
 * responses arrive as binary event-stream frames rather than SSE. A signing bug
 * fails both legs; a frame-decoding bug fails only the second. Separating them
 * turns "Bedrock is broken" into a one-line diagnosis.
 *
 * @example
 * ```bash
 * export AWS_REGION=us-east-1
 * export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...
 * npm run verify:live
 * ```
 *
 * Set `VERIFY_SKIP_STREAM=true` to run only the non-streaming leg.
 */

import { createClient } from '../client.js';
import { configuredProviders, loadConfig, secretsIn } from '../config/config.js';
import { NimbleError } from '../errors.js';
import { redact, type Secret } from '../config/secret.js';
import type { ProviderId } from '../types.js';

/** Default models, overridable per provider. Chosen to be cheap and widely enabled. */
const DEFAULT_MODELS: Readonly<Record<ProviderId, string | undefined>> = {
  openai: 'gpt-4o-mini',
  // No sensible default: an Azure deployment name is whatever the operator called it.
  azure: undefined,
  // Geo inference profile: us-east-2 and most regions have no in-region
  // endpoint for current models, so the bare id 404s there. Swap the prefix
  // (eu./au./global.) to match your data-residency requirement.
  bedrock: 'us.anthropic.claude-opus-5',
  vertex: 'gemini-2.0-flash',
};

const MODEL_ENV: Readonly<Record<ProviderId, string>> = {
  openai: 'VERIFY_OPENAI_MODEL',
  azure: 'VERIFY_AZURE_DEPLOYMENT',
  bedrock: 'VERIFY_BEDROCK_MODEL',
  vertex: 'VERIFY_VERTEX_MODEL',
};

const PROMPT = 'Reply with the single word: ok';

/** What the wrapped fetch captured about one attempt. */
interface Attempt {
  url: string;
  headers: Record<string, string>;
  body: string;
  status?: number;
  responseBody?: string;
}

type Leg = 'complete' | 'stream';

interface Check {
  provider: ProviderId;
  model: string;
  leg: Leg;
  ok: boolean;
  durationMs: number;
  /** Short summary shown on the result line. */
  detail: string;
  error?: unknown;
  attempt: Attempt;
}

const GREEN = '\u001b[32m';
const RED = '\u001b[31m';
const YELLOW = '\u001b[33m';
const DIM = '\u001b[2m';
const RESET = '\u001b[0m';

async function main(): Promise<void> {
  const config = loadConfig();
  const configured = configuredProviders(config);
  const secrets = secretsIn(config);
  const skipStream = process.env['VERIFY_SKIP_STREAM'] === 'true';

  heading('NimbleLLM live verification');

  if (configured.length === 0) {
    console.log(
      `${YELLOW}No provider credentials found in the environment.${RESET}\n\n` +
        'Set at least one provider (see .env.example) and run this again.\n' +
        'Note that this script reads process.env and does NOT load a .env file:\n\n' +
        '  set -a; source .env; set +a && npm run verify:live\n\n' +
        'For the Bedrock signature check specifically:\n\n' +
        '  export AWS_REGION=us-east-1\n' +
        '  export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...\n',
    );
    process.exit(1);
  }

  console.log(`Configured providers: ${configured.join(', ')}`);
  console.log(
    `${DIM}Each provider runs ${skipStream ? 'one real completion' : 'two real completions (non-streaming, then streaming)'}, and will be billed.${RESET}\n`,
  );

  const checks: Check[] = [];
  for (const provider of configured) {
    checks.push(...(await verify(provider, skipStream)));
  }

  if (checks.length === 0) {
    console.log(`\n${YELLOW}Nothing was checked — every configured provider was skipped.${RESET}`);
    process.exit(1);
  }

  summarize(checks, secrets);
  process.exit(checks.every((check) => check.ok) ? 0 : 1);
}

async function verify(provider: ProviderId, skipStream: boolean): Promise<Check[]> {
  const model = process.env[MODEL_ENV[provider]] ?? DEFAULT_MODELS[provider];

  if (model === undefined) {
    console.log(
      `${YELLOW}SKIP${RESET}  ${provider.padEnd(8)} set ${MODEL_ENV[provider]} to check this provider`,
    );
    return [];
  }

  console.log(`      ${provider.padEnd(8)} ${DIM}${model}${RESET}`);

  const completion = await runLeg(provider, model, 'complete');
  report(completion);

  // A failed non-streaming call means authentication or model access is wrong;
  // the streaming leg would fail identically and teach nothing, so skip it and
  // do not spend a second request.
  if (!completion.ok || skipStream) return [completion];

  const streamed = await runLeg(provider, model, 'stream');
  report(streamed);

  return [completion, streamed];
}

async function runLeg(provider: ProviderId, model: string, leg: Leg): Promise<Check> {
  const attempt: Attempt = { url: '', headers: {}, body: '' };
  const client = createClient({
    fetch: capturingFetch(attempt),
    // One attempt only: a retry would overwrite the captured request, and a
    // signature failure is not going to fix itself.
    config: { maxRetries: 0 },
  });

  // No `temperature`: current Claude models reject sampling parameters
  // outright, and determinism buys nothing in a one-shot smoke test.
  //
  // maxOutputTokens is generous because it caps thinking *plus* response, and
  // adaptive thinking is on by default on current models — a tight budget gets
  // spent reasoning and truncates before any text is produced.
  const request = {
    model: `${provider}/${model}`,
    messages: [{ role: 'user', content: PROMPT }],
    maxOutputTokens: 1024,
  };

  const started = Date.now();
  try {
    const detail =
      leg === 'complete' ? await completeOnce(client, request) : await streamOnce(client, request);
    return { provider, model, leg, ok: true, durationMs: Date.now() - started, detail, attempt };
  } catch (error) {
    return {
      provider,
      model,
      leg,
      ok: false,
      durationMs: Date.now() - started,
      detail: '',
      error,
      attempt,
    };
  }
}

async function completeOnce(
  client: ReturnType<typeof createClient>,
  request: Record<string, unknown>,
): Promise<string> {
  const response = await client.complete(request);
  const text = textOf(response.message.content);
  return `${response.usage.totalTokens} tokens · "${clip(text, 40)}"`;
}

/**
 * Consume a streamed response and prove it actually decoded.
 *
 * A stream that yields nothing is the signature failure mode of a broken frame
 * decoder: the HTTP call succeeds, the body arrives, and not one event comes
 * out of it. That has to be a failure, not a silent pass.
 */
async function streamOnce(
  client: ReturnType<typeof createClient>,
  request: Record<string, unknown>,
): Promise<string> {
  let events = 0;
  let text = '';
  let finishReason: string | undefined;
  let totalTokens: number | undefined;

  for await (const event of client.stream(request)) {
    events += 1;
    if (event.type === 'text_delta') text += event.text;
    if (event.type === 'usage') totalTokens = event.usage.totalTokens;
    if (event.type === 'finish') {
      finishReason = event.finishReason;
      totalTokens ??= event.usage?.totalTokens;
    }
    if (event.type === 'error') throw event.error;
  }

  if (events === 0) {
    throw new NimbleError(
      'the stream completed without decoding a single event — the response body arrived but produced nothing',
      { code: 'provider_error', retryable: false },
    );
  }
  if (text === '') {
    throw new NimbleError(
      `decoded ${events} event(s) but no text — deltas are not being read correctly`,
      { code: 'provider_error', retryable: false },
    );
  }

  const tokens = totalTokens === undefined ? 'usage not reported' : `${totalTokens} tokens`;
  return `${events} events · ${tokens} · finish=${finishReason ?? 'none'} · "${clip(text, 30)}"`;
}

/**
 * Wrap `fetch` to keep the exact request that went out and the raw body that
 * came back. The response is cloned, so the caller still reads it normally.
 */
function capturingFetch(attempt: Attempt): typeof globalThis.fetch {
  return async (input, init) => {
    attempt.url = String(input);
    attempt.headers = { ...((init?.headers ?? {}) as Record<string, string>) };
    attempt.body = String(init?.body ?? '');

    const response = await globalThis.fetch(input, init);
    attempt.status = response.status;
    if (!response.ok) {
      attempt.responseBody = await response.clone().text();
    }
    return response;
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function report(check: Check): void {
  const mark = check.ok ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
  console.log(
    `        ${check.leg.padEnd(9)} ${mark} ${String(check.durationMs).padStart(5)}ms  ${DIM}${check.detail}${RESET}`,
  );
}

function summarize(checks: readonly Check[], secrets: readonly Secret[]): void {
  const failures = checks.filter((check) => !check.ok);

  heading('Result');
  for (const check of checks) {
    const mark = check.ok ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
    console.log(`  ${mark}  ${check.provider.padEnd(8)} ${check.leg.padEnd(9)} ${check.model}`);
  }

  if (failures.length === 0) {
    console.log(`\n${GREEN}Every configured provider answered on both paths.${RESET}`);

    const bedrock = checks.filter((check) => check.provider === 'bedrock');
    if (bedrock.length > 0) {
      console.log(
        `\n${GREEN}Bedrock accepted the SigV4 signature — the signing implementation is confirmed\n` +
          `against a live endpoint.${RESET}`,
      );
      if (bedrock.some((check) => check.leg === 'stream')) {
        console.log(
          `${GREEN}The binary event-stream decoder also handled real AWS frames.${RESET}`,
        );
      }
      console.log(
        `\n${DIM}Record this in KNOWN_LIMITATIONS.md — date, region, model — and update its\n` +
          `"Verification status" section, which is where the rest of the repository reads\n` +
          `this from.${RESET}`,
      );
    }
    return;
  }

  for (const failure of failures) diagnose(failure, secrets);

  console.log(`\n${RED}${failures.length} of ${checks.length} check(s) failed.${RESET}`);
}

function diagnose(check: Check, secrets: readonly Secret[]): void {
  const { provider, leg, error, attempt } = check;
  heading(`${provider} · ${leg} failed`);

  if (error instanceof NimbleError) {
    console.log(`  code:      ${error.code}`);
    console.log(`  status:    ${error.status ?? '(no response)'}`);
    console.log(`  retryable: ${error.retryable}`);
    console.log(`  message:   ${error.message}`);
  } else {
    console.log(`  ${String(error)}`);
  }

  const signatureRejected =
    provider === 'bedrock' && /signature|SignatureDoesNotMatch|not authorized/i.test(String(error));

  if (signatureRejected) {
    console.log(
      `\n${RED}  ↳ AWS rejected the request signature.${RESET}\n` +
        `${YELLOW}     This is the failure mode unit tests cannot catch: the SigV4 implementation\n` +
        `     produces a well-formed request that AWS computes differently. Compare the\n` +
        `     canonical request below against what AWS reports in its error body.\n` +
        `     The code to look at is src/auth/sigv4.ts.${RESET}`,
    );
  }

  // Both of these mean AWS authenticated the request and only then declined it
  // on model grounds — so the signature was accepted. They look like failures
  // and are worth calling out as the good news they are for signing.
  const modelRetired = /end of its life|has been retired|ResourceNotFound/i.test(String(error));
  const notEntitled = /not available for this account|not authorized to invoke|AccessDenied/i.test(
    String(error),
  );

  if (modelRetired || notEntitled) {
    console.log(
      `\n${GREEN}  ↳ The signature was ACCEPTED.${RESET}\n` +
        `${YELLOW}     AWS validates SigV4 before it resolves the model, so a model-level\n` +
        `     rejection means authentication succeeded. This is not a signing defect.${RESET}`,
    );
  }

  if (modelRetired) {
    console.log(
      `${YELLOW}\n     The model id is retired. Pick a current one from the Bedrock console\n` +
        `     (Model catalog, region set to the one you are using) and re-run with:\n` +
        `       export VERIFY_BEDROCK_MODEL=<id from the console>${RESET}`,
    );
  }

  if (notEntitled) {
    console.log(
      `${YELLOW}\n     The model exists and the id is right — this account cannot invoke it.\n` +
        `     Models served through AWS Marketplace must be subscribed once by a\n` +
        `     principal holding Marketplace permissions before any IAM user can call\n` +
        `     them; an invoke-only policy is not enough.\n\n` +
        `     Either subscribe to it in the Bedrock console with an admin identity, or\n` +
        `     point the check at a model this account already has:\n` +
        `       export VERIFY_BEDROCK_MODEL=<id from the console>\n\n` +
        `     To have this script list what is available, add bedrock:ListFoundationModels\n` +
        `     to the IAM policy — an invoke-only policy cannot enumerate models.${RESET}`,
    );
  }

  // A streaming-only failure isolates the fault to response decoding: the same
  // signing code already passed on the non-streaming leg.
  if (
    provider === 'bedrock' &&
    leg === 'stream' &&
    !signatureRejected &&
    !modelRetired &&
    !notEntitled
  ) {
    console.log(
      `\n${YELLOW}  ↳ The non-streaming call to bedrock passed, so authentication and model access\n` +
        `     are fine. This failure is in decoding the response, not in signing.\n` +
        `     The code to look at is src/transport/aws-event-stream.ts.${RESET}`,
    );
  }

  console.log(`\n  ${DIM}--- request sent ---${RESET}`);
  console.log(`  ${attempt.url}`);
  for (const [name, value] of Object.entries(attempt.headers).sort()) {
    console.log(`  ${name}: ${clip(redact(value, secrets), 200)}`);
  }
  console.log(`\n  ${DIM}--- request body ---${RESET}`);
  console.log(`  ${clip(redact(attempt.body, secrets), 800)}`);

  if (attempt.responseBody !== undefined) {
    console.log(`\n  ${DIM}--- raw response (${attempt.status}) ---${RESET}`);
    console.log(indent(redact(attempt.responseBody, secrets), '  '));
  }

  // Suppressed for a retired model: every cause below is already disproven by
  // AWS having authenticated the request far enough to check the model.
  if (provider === 'bedrock' && !modelRetired && !notEntitled) {
    // The stream leg only runs after the complete leg passed, so credentials,
    // region and model access are already proven. Listing them again would send
    // someone chasing causes that have been ruled out.
    const causes =
      leg === 'stream'
        ? [
            'the IAM principal lacks bedrock:InvokeModelWithResponseStream',
            'this model does not support streaming',
            'a genuine defect in src/transport/aws-event-stream.ts',
          ]
        : [
            'an Anthropic model needing first-time use-case details submitted for this account',
            'an IAM policy or SCP restricting bedrock:InvokeModel',
            'AWS_REGION does not match the region the credentials are scoped to',
            'temporary credentials without AWS_SESSION_TOKEN set',
            'the IAM principal lacks bedrock:InvokeModel',
            'a genuine defect in src/auth/sigv4.ts',
          ];

    console.log(
      `\n  ${DIM}Common causes, in rough order of likelihood:${RESET}\n` +
        causes.map((cause) => `    · ${cause}`).join('\n') +
        '\n',
    );
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function textOf(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('')
    .trim();
}

function heading(title: string): void {
  console.log(`\n${'─'.repeat(72)}\n${title}\n${'─'.repeat(72)}`);
}

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function indent(value: string, prefix: string): string {
  return value
    .split('\n')
    .map((line) => prefix + line)
    .join('\n');
}

main().catch((error: unknown) => {
  console.error(`\n${RED}verification could not run:${RESET} ${String(error)}`);
  process.exit(1);
});
