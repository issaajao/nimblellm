/**
 * `nimblellm check` — static portability analysis for one request.
 *
 * Answers "which providers could serve this?" without credentials, without a
 * network call, and without running anything. It is a presentation layer and
 * nothing more: every judgement on the grid comes from `router.supports()`,
 * `assertWithinLimits()` and `router.candidatesFor()` — the same functions the
 * library calls on the real path. Nothing here can drift out of step with
 * routing, because there is no second opinion to drift.
 *
 * The model's routing prefix is deliberately ignored. The report covers every
 * registered provider, so an unprefixed `--model claude-sonnet` is accepted;
 * when a prefix *is* given, the requested provider is called out in the summary.
 */

import { readFileSync } from 'node:fs';
import { NimbleError } from '../errors.js';
import { normalizeRequest } from '../core/normalize.js';
import { Router } from '../router.js';
import {
  assertCapabilities,
  assertWithinLimits,
  requiredCapabilities,
} from '../providers/capabilities.js';
import type { Capability } from '../providers/adapter.js';
import type { NimbleRequest, ProviderId } from '../types.js';

/** Exit codes, which are the CLI's machine-readable surface. */
export const EXIT = {
  /** At least one provider can serve the request. */
  portable: 0,
  /** Usage error, unreadable input, or a request that failed validation. */
  invalid: 1,
  /** The request is valid, but no registered provider can express it. */
  unroutable: 2,
} as const;

export interface CheckResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** Row labels, matching the capability table in the README. */
const LABELS: Readonly<Record<Capability, string>> = {
  streaming: 'streaming',
  tools: 'tools',
  tool_choice_required: 'forced tool use',
  json_mode: 'JSON mode',
  json_schema: 'JSON schema output',
  image_url: 'images by URL',
  image_base64: 'inline images',
  seed: 'seed',
  stop_sequences: 'stop',
  frequency_penalty: 'frequency penalty',
  presence_penalty: 'presence penalty',
  top_k: 'topK',
  metadata: 'metadata',
};

/** README order, so the report reads the same way the docs do. */
const ORDER: readonly Capability[] = [
  'streaming',
  'tools',
  'tool_choice_required',
  'json_mode',
  'json_schema',
  'image_url',
  'image_base64',
  'seed',
  'stop_sequences',
  'frequency_penalty',
  'presence_penalty',
  'top_k',
  'metadata',
];

interface Row {
  readonly label: string;
  /** Provider id → whether this provider can express this one thing. */
  readonly byProvider: ReadonlyMap<ProviderId, boolean>;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Run the check and return what to print, rather than printing it.
 *
 * Returning the output keeps this testable in-process; the binary is a thin
 * wrapper that writes the strings and exits with the code.
 *
 * @param argv - arguments after `nimblellm check`
 */
export function runCheck(argv: readonly string[], router: Router = new Router()): CheckResult {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { stdout: HELP, stderr: '', exitCode: EXIT.portable };
  }

  let input: unknown;
  let source: string;

  try {
    ({ input, source } = readInput(argv));
  } catch (error) {
    return usageError(error);
  }

  let request: NimbleRequest;
  try {
    // The same entry point the library uses. A CLI that validated requests its
    // own way would eventually disagree with the library about what is valid.
    request = normalizeRequest(input, { defaultProvider: 'openai' });
  } catch (error) {
    return { stdout: '', stderr: renderNimbleError(error), exitCode: EXIT.invalid };
  }

  const report = analyze(request, router);
  return {
    stdout: render(request, report, source, router),
    stderr: '',
    exitCode: report.candidates.length > 0 ? EXIT.portable : EXIT.unroutable,
  };
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

interface Report {
  readonly rows: readonly Row[];
  readonly candidates: readonly ProviderId[];
  /** Provider → the row labels that exclude it, in row order. */
  readonly blockedBy: ReadonlyMap<ProviderId, readonly string[]>;
}

function analyze(request: NimbleRequest, router: Router): Report {
  const providers = router.providers();
  const needed = new Set(requiredCapabilities(request));
  const rows: Row[] = [];

  for (const capability of ORDER) {
    if (!needed.has(capability)) continue;
    rows.push({
      label: LABELS[capability],
      byProvider: new Map(
        providers.map((provider) => [provider, router.supports(provider, capability)]),
      ),
    });
  }

  rows.push(...rangeRows(request, router, providers));

  const candidates = router.candidatesFor(request);
  const blockedBy = new Map<ProviderId, readonly string[]>();

  for (const provider of providers) {
    if (candidates.includes(provider)) continue;

    const reasons = rows
      .filter((row) => row.byProvider.get(provider) === false)
      .map((row) => row.label);

    // The grid is built from the same checks `candidatesFor` runs, so this
    // should never be empty. If it ever is, the report and the router have
    // diverged, and saying so is far better than printing a blank reason.
    blockedBy.set(
      provider,
      reasons.length > 0 ? reasons : [unexplained(request, router, provider)],
    );
  }

  return { rows, candidates, blockedBy };
}

/**
 * Rows for the numeric limits, which exclude providers just as capabilities do.
 *
 * Which field failed is read off the `NimbleError` that `assertWithinLimits`
 * throws rather than recomputed here — the library says what it rejected, so
 * there is no second comparison to get wrong.
 */
function rangeRows(
  request: NimbleRequest,
  router: Router,
  providers: readonly ProviderId[],
): Row[] {
  const fields: { path: string; label: string }[] = [];
  if (request.temperature !== undefined) {
    fields.push({ path: 'temperature', label: `temperature (${request.temperature})` });
  }
  if (request.topP !== undefined) {
    fields.push({ path: 'topP', label: `topP (${request.topP})` });
  }
  if (request.stop !== undefined) {
    fields.push({ path: 'stop', label: `stop count (${request.stop.length})` });
  }
  if (fields.length === 0) return [];

  const failedPaths = new Map<ProviderId, Set<string>>();
  for (const provider of providers) {
    const paths = new Set<string>();
    try {
      assertWithinLimits(request, router.adapterFor(provider));
    } catch (error) {
      if (error instanceof NimbleError) {
        for (const issue of error.issues) paths.add(issue.path);
      }
    }
    failedPaths.set(provider, paths);
  }

  return fields.map((field) => ({
    label: field.label,
    byProvider: new Map(
      providers.map((provider) => [
        provider,
        !(failedPaths.get(provider)?.has(field.path) ?? false),
      ]),
    ),
  }));
}

/**
 * The router excluded a provider for a reason the grid does not show.
 *
 * Re-runs the same two checks against that provider's adapter and reports what
 * they said, so a divergence surfaces as the router's own words rather than a
 * blank line.
 */
/* c8 ignore start -- only reachable if the grid and candidatesFor disagree */
function unexplained(request: NimbleRequest, router: Router, provider: ProviderId): string {
  const adapter = router.adapterFor(provider);
  try {
    assertCapabilities(request, adapter);
    assertWithinLimits(request, adapter);
    return 'excluded for an unreported reason (please report this as a bug)';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `${message} (not shown above — please report this as a bug)`;
  }
}
/* c8 ignore stop */

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const YES = '✓';
const NO = '✗';

/**
 * No ANSI colour anywhere, on purpose. The report has to be equally readable
 * piped into a file or a CI log, and a second, colourless code path would be a
 * second thing to keep correct for no gain.
 */
function render(request: NimbleRequest, report: Report, source: string, router: Router): string {
  const providers = router.providers();
  const lines: string[] = ['', `nimblellm check · ${source}`, ''];

  if (report.rows.length === 0) {
    lines.push(
      '  This request uses no optional capabilities, so every provider can',
      '  express it as written.',
      '',
    );
  } else {
    const labelWidth = Math.max(...report.rows.map((row) => row.label.length));
    const widths = providers.map((provider) => Math.max(provider.length, 3));

    lines.push(
      `  ${''.padEnd(labelWidth)}  ${providers.map((p, i) => p.padEnd(widths[i] ?? 0)).join('  ')}`,
    );
    for (const row of report.rows) {
      const cells = providers.map((provider, index) =>
        centre(row.byProvider.get(provider) === true ? YES : NO, widths[index] ?? 0),
      );
      lines.push(`  ${row.label.padEnd(labelWidth)}  ${cells.join('  ')}`);
    }
    lines.push('');
  }

  lines.push(
    `  Portable across: ${report.candidates.length}/${providers.length} providers` +
      (report.candidates.length > 0 ? ` (${report.candidates.join(', ')})` : ''),
  );

  if (report.blockedBy.size > 0) {
    lines.push('');
    const width = Math.max(...[...report.blockedBy.keys()].map((p) => p.length));
    for (const [provider, reasons] of report.blockedBy) {
      lines.push(`  Blocked on ${provider.padEnd(width)}  ${reasons.join(', ')}`);
    }
  }

  // Only when the caller actually named a provider. `parseModelRef` keeps the
  // original string, so a stripped prefix is what distinguishes an explicit
  // choice from the placeholder used when `--model` is omitted.
  const requested = request.model.raw === request.model.model ? undefined : request.model.provider;
  if (requested !== undefined) {
    lines.push(
      '',
      report.candidates.includes(requested)
        ? `  Your request names ${requested}, which can serve it.`
        : `  Your request names ${requested}, which cannot serve it as written.`,
    );
  }

  lines.push('');
  // Trailing spaces from the padded last column would show up as noise in a
  // diff or a CI log, where this output often ends up.
  return lines.map((line) => line.replace(/\s+$/, '')).join('\n');
}

function centre(value: string, width: number): string {
  const left = Math.max(0, Math.floor((width - value.length) / 2));
  return `${' '.repeat(left)}${value}`.padEnd(width);
}

/**
 * Print a validation failure the way the library reports it — the same summary
 * line and the same per-field issues a caller sees from `normalizeRequest`, so
 * what the CLI says and what the code throws are the same text.
 */
function renderNimbleError(error: unknown): string {
  if (!(error instanceof NimbleError)) return `${String(error)}\n`;

  const lines = [`NimbleError [${error.code}]: ${error.message}`];

  for (const issue of error.issues) {
    const rendered = `${issue.path}: ${issue.message}`;
    // For a single issue the library's own summary line is already
    // `path: message`, so listing it again prints the same sentence twice.
    if (error.message.endsWith(rendered)) continue;
    lines.push(`  ${rendered}`);
  }

  return `${lines.join('\n')}\n`;
}

function usageError(error: unknown): CheckResult {
  const message = error instanceof Error ? error.message : String(error);
  return { stdout: '', stderr: `${message}\n\n${HELP}`, exitCode: EXIT.invalid };
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/**
 * Build the request to analyse, from a JSON file or from inline flags.
 *
 * Flags describe the *shape* of a request rather than its content: `--tools`
 * stands in a placeholder tool, because capability analysis only cares that
 * tools are present, not what they do.
 */
function readInput(argv: readonly string[]): { input: unknown; source: string } {
  const first = argv[0];
  if (first === undefined) {
    throw new Error('check needs a request file or at least one flag.');
  }

  // The first argument decides the mode. Splitting on "starts with a dash"
  // instead would misread a flag's value — `--model claude-sonnet` would count
  // `claude-sonnet` as a filename.
  if (first.startsWith('-')) {
    return { input: fromFlags(argv), source: 'inline flags' };
  }

  if (argv.length > 1) {
    throw new Error('check accepts either one request file or inline flags, not both.');
  }

  let text: string;
  try {
    text = readFileSync(first, 'utf8');
  } catch {
    throw new Error(`could not read "${first}".`);
  }

  try {
    return { input: JSON.parse(text), source: first };
  } catch (cause) {
    throw new Error(`"${first}" is not valid JSON: ${(cause as Error).message}`);
  }
}

const PLACEHOLDER_TOOL = {
  name: 'example_tool',
  description: 'Placeholder; capability analysis does not read tool bodies.',
  parameters: { type: 'object', properties: {} },
};

function fromFlags(argv: readonly string[]): Record<string, unknown> {
  const request: Record<string, unknown> = {
    // Unused by the analysis — every registered provider is reported on — but
    // `normalizeRequest` needs something routable.
    model: 'unspecified',
    messages: [{ role: 'user', content: 'placeholder' }],
  };

  const content: Record<string, unknown>[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    /* c8 ignore next -- the loop bound guarantees this */
    if (flag === undefined) continue;

    const value = (): string => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('-')) {
        throw new Error(`${flag} needs a value.`);
      }
      index += 1;
      return next;
    };

    switch (flag) {
      case '--model':
        request['model'] = value();
        break;
      case '--stream':
        request['stream'] = true;
        break;
      case '--tools':
        request['tools'] = [PLACEHOLDER_TOOL];
        break;
      case '--forced-tool':
        request['tools'] = [PLACEHOLDER_TOOL];
        request['toolChoice'] = 'required';
        break;
      case '--json-mode':
        request['responseFormat'] = { type: 'json_object' };
        break;
      case '--json-schema':
        request['responseFormat'] = {
          type: 'json_schema',
          name: 'Example',
          schema: { type: 'object', properties: {} },
        };
        break;
      case '--image-url':
        content.push({ type: 'image', url: 'https://example.test/image.png' });
        break;
      case '--image-base64':
        content.push({ type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' });
        break;
      case '--seed':
        request['seed'] = 1;
        break;
      case '--metadata':
        request['metadata'] = { user_id: 'placeholder' };
        break;
      case '--stop':
        request['stop'] = value().split(',');
        break;
      case '--temperature':
        request['temperature'] = number(value(), flag);
        break;
      case '--top-p':
        request['topP'] = number(value(), flag);
        break;
      case '--top-k':
        request['topK'] = number(value(), flag);
        break;
      case '--frequency-penalty':
        request['frequencyPenalty'] = number(value(), flag);
        break;
      case '--presence-penalty':
        request['presencePenalty'] = number(value(), flag);
        break;
      default:
        throw new Error(`unknown flag "${flag}".`);
    }
  }

  if (content.length > 0) {
    request['messages'] = [{ role: 'user', content: [{ type: 'text', text: '.' }, ...content] }];
  }

  return request;
}

function number(raw: string, flag: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${flag} expects a number, received "${raw}".`);
  return parsed;
}

const HELP = `nimblellm check — which providers can serve this request?

Static analysis only: no credentials are read, no network call is made, and
nothing is sent anywhere. The answer comes from the same capability checks the
router runs when it dispatches a real request.

USAGE
  nimblellm check <request.json>
  nimblellm check [flags]

FLAGS
  --model <ref>            Model reference. The routing prefix is not used —
                           every registered provider is reported on either way.
  --stream                 Streaming
  --tools                  Tool calling
  --forced-tool            Tool calling with toolChoice: required
  --json-mode              JSON mode
  --json-schema            JSON schema output
  --image-url              An image referenced by URL
  --image-base64           An inline base64 image
  --seed                   Reproducible sampling
  --metadata               Request tagging
  --stop <a,b>             Stop sequences
  --temperature <n>        Sampling temperature
  --top-p <n>              Nucleus sampling
  --top-k <n>              Top-k sampling
  --frequency-penalty <n>  Frequency penalty
  --presence-penalty <n>   Presence penalty
  -h, --help               This text

EXIT CODES
  0  at least one provider can serve the request
  1  bad usage, or a request that failed validation
  2  valid request, but no provider can express it

EXAMPLES
  nimblellm check request.json
  nimblellm check --model claude-sonnet --tools --json-schema
`;
