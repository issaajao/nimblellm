/**
 * `nimblellm check`, from both ends.
 *
 * The spawned suite runs the built binary as a real process, which is the only
 * way to assert what a user actually gets: argv handling, exit codes, and which
 * stream each line lands on. The in-process suite calls `runCheck` directly,
 * where assertions can be precise and a failure points at a line rather than at
 * a subprocess.
 *
 * Nothing here touches the network — the command has no network to touch, which
 * is the point of it.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { EXIT, runCheck } from '../../src/cli/check.js';
import { Router } from '../../src/router.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BINARY = join(ROOT, 'dist', 'bin', 'nimblellm.js');

const fixtures = mkdtempSync(join(tmpdir(), 'nimblellm-check-'));

/** Write a fixture request and return its path. */
function fixture(name: string, body: unknown): string {
  const path = join(fixtures, name);
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
  return path;
}

const PLAIN = {
  model: 'openai/gpt-4o',
  messages: [{ role: 'user', content: 'Why is the sky blue?' }],
};

describe('nimblellm check (spawned)', () => {
  beforeAll(() => {
    if (!existsSync(BINARY)) {
      throw new Error(
        'dist/ is missing — the CLI suite runs the built binary. Run `npm run build`.',
      );
    }
  });

  const run = (...argv: string[]) =>
    spawnSync(process.execPath, [BINARY, 'check', ...argv], { encoding: 'utf8' });

  it('reports the grid for the documented one-liner', () => {
    const { status, stdout } = run('--model', 'claude-sonnet', '--tools', '--json-schema');

    expect(status).toBe(EXIT.portable);
    expect(stdout).toContain('tools');
    expect(stdout).toContain('JSON schema output');
    expect(stdout).toContain('Portable across: 3/5 providers');
    expect(stdout).toContain('Blocked on bedrock');
    expect(stdout).toContain('Blocked on anthropic');
  });

  it('reads a request from a file', () => {
    const { status, stdout } = run(fixture('plain.json', PLAIN));

    expect(status).toBe(EXIT.portable);
    expect(stdout).toContain('Portable across: 5/5 providers');
    expect(stdout).toContain('no optional capabilities');
  });

  it('exits 2 when no provider can serve the request', () => {
    // seed, topK and metadata have no provider in common.
    const { status, stdout } = run('--seed', '--top-k', '40', '--metadata');

    expect(status).toBe(EXIT.unroutable);
    expect(stdout).toContain('Portable across: 0/5 providers');
  });

  it('exits 1 and prints the library’s own error for an invalid request', () => {
    const path = fixture('typo.json', { ...PLAIN, max_tokns: 5 });
    const { status, stdout, stderr } = run(path);

    expect(status).toBe(EXIT.invalid);
    expect(stdout).toBe('');
    // The same sentence normalizeRequest throws, not a CLI-specific rewording.
    expect(stderr).toContain('NimbleError [invalid_request]');
    expect(stderr).toContain('max_tokns: unknown field');
  });

  it('exits 1 on a file it cannot read', () => {
    const { status, stderr } = run(join(fixtures, 'absent.json'));

    expect(status).toBe(EXIT.invalid);
    expect(stderr).toContain('could not read');
  });

  it('exits 1 on a file that is not JSON', () => {
    const { status, stderr } = run(fixture('broken.json', '{ not json'));

    expect(status).toBe(EXIT.invalid);
    expect(stderr).toContain('is not valid JSON');
  });

  it('prints help on request, without needing an input', () => {
    const { status, stdout } = run('--help');

    expect(status).toBe(EXIT.portable);
    expect(stdout).toContain('nimblellm check');
    expect(stdout).toContain('EXIT CODES');
  });

  it('rejects an unknown flag rather than ignoring it', () => {
    const { status, stderr } = run('--nonsense');

    expect(status).toBe(EXIT.invalid);
    expect(stderr).toContain('unknown flag "--nonsense"');
  });

  it('rejects an unknown subcommand without starting the gateway', () => {
    const { status, stderr } = spawnSync(process.execPath, [BINARY, 'frobnicate'], {
      encoding: 'utf8',
    });

    expect(status).toBe(1);
    expect(stderr).toContain('unknown command "frobnicate"');
  });

  it('makes no network call, so it runs with no credentials at all', () => {
    const { status } = spawnSync(process.execPath, [BINARY, 'check', '--tools'], {
      encoding: 'utf8',
      // A deliberately empty environment: no keys, no region, nothing.
      env: { PATH: process.env['PATH'] ?? '' },
    });

    expect(status).toBe(EXIT.portable);
  });
});

describe('runCheck', () => {
  const check = (...argv: string[]) => runCheck(argv);

  it('lists only the capabilities the request actually uses', () => {
    const { stdout } = check('--stream');

    expect(stdout).toContain('streaming');
    expect(stdout).not.toContain('JSON mode');
    expect(stdout).not.toContain('seed');
  });

  it('renders a ✓ or ✗ per provider, in router order', () => {
    const { stdout } = check('--top-k', '40');
    const header = stdout.split('\n').find((line) => line.includes('openai'));
    const row = stdout.split('\n').find((line) => line.trimStart().startsWith('topK'));

    expect(header).toContain('openai  azure  bedrock  vertex  anthropic');
    // Only Vertex and Anthropic take topK canonically.
    expect(row).toMatch(/topK\s+✗\s+✗\s+✗\s+✓\s+✓/);
  });

  it('treats a value that is out of range as its own row', () => {
    const { stdout } = check('--temperature', '1.5');

    expect(stdout).toContain('temperature (1.5)');
    // 0–2 on OpenAI, Azure and Vertex; 0–1 on Bedrock and Anthropic.
    expect(stdout).toContain('Portable across: 3/5 providers');
    expect(stdout).toContain('Blocked on bedrock    temperature (1.5)');
  });

  it('counts stop sequences against the provider limit', () => {
    const { stdout } = check('--stop', 'a,b,c,d,e');

    expect(stdout).toContain('stop count (5)');
    // OpenAI and Azure cap at 4, Vertex at 5, Bedrock and Anthropic do not cap.
    expect(stdout).toContain('Blocked on openai  stop count (5)');
  });

  it('names the requested provider when the model carries a prefix', () => {
    expect(check('--model', 'bedrock/claude', '--seed').stdout).toContain(
      'Your request names bedrock, which cannot serve it as written.',
    );
    expect(check('--model', 'openai/gpt-4o', '--seed').stdout).toContain(
      'Your request names openai, which can serve it.',
    );
  });

  it('says nothing about a requested provider when the model has no prefix', () => {
    expect(check('--tools').stdout).not.toContain('Your request names');
  });

  it('lists a blocked provider’s reasons in row order', () => {
    const { stdout } = check('--json-mode', '--seed', '--image-url');

    expect(stdout).toContain('Blocked on bedrock    JSON mode, images by URL, seed');
  });

  it('reports against whichever adapters the router has', () => {
    // A router with one adapter reports one column — the CLI reads the registry
    // rather than assuming the built-in five.
    const router = new Router();
    const only = new Router({ adapters: [router.adapterFor('bedrock')] });

    const { stdout, exitCode } = runCheck(['--seed'], only);
    expect(stdout).toContain('Portable across: 0/1 providers');
    expect(exitCode).toBe(EXIT.unroutable);
  });

  it('leaves no trailing whitespace on any line', () => {
    for (const line of check('--tools', '--seed').stdout.split('\n')) {
      expect(line).toBe(line.replace(/\s+$/, ''));
    }
  });

  it('needs an input', () => {
    const { exitCode, stderr } = check();

    expect(exitCode).toBe(EXIT.invalid);
    expect(stderr).toContain('needs a request file or at least one flag');
  });

  it('rejects a file and flags together', () => {
    expect(check('request.json', '--tools').stderr).toContain('not both');
  });

  it('rejects a flag that is missing its value', () => {
    expect(check('--temperature').stderr).toContain('--temperature needs a value');
    expect(check('--temperature', '--tools').stderr).toContain('--temperature needs a value');
  });

  it('rejects a non-numeric value where a number is required', () => {
    expect(check('--top-p', 'high').stderr).toContain('--top-p expects a number');
  });

  it('accepts every flag its own help text documents', () => {
    // The list is read out of the help output rather than restated here, so a
    // flag cannot drift into the documentation without an implementation, or
    // out of it while still working.
    const help = runCheck(['--help']).stdout;
    const documented = [...help.matchAll(/^ {2}(--[a-z0-9-]+)( <[^>]+>)?/gm)];
    expect(documented.length).toBeGreaterThan(10);

    for (const [, flag, takesValue] of documented) {
      const argv =
        takesValue === undefined
          ? [flag as string]
          : [flag as string, VALUES[flag as string] ?? '1'];
      const { exitCode, stderr } = runCheck(argv);

      expect(stderr, `${flag} was rejected`).not.toContain('unknown flag');
      expect(stderr, `${flag} needed a value the test did not supply`).not.toContain(
        'needs a value',
      );
      expect(exitCode, `${flag} failed: ${stderr}`).not.toBe(EXIT.invalid);
    }
  });
});

const VALUES: Readonly<Record<string, string>> = {
  '--model': 'openai/gpt-4o',
  '--stop': 'END',
  '--temperature': '0.5',
  '--top-p': '0.9',
  '--top-k': '40',
  '--frequency-penalty': '0.5',
  '--presence-penalty': '0.5',
};
