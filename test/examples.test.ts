/**
 * Every example is executed here against a stub that impersonates all four
 * providers. Documentation that has never been run is documentation that is
 * quietly wrong, so "working code examples" is asserted rather than claimed.
 *
 * No real provider is contacted: each base URL is pointed at a local server.
 */

import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { startServer, type StartedServer } from '../src/server/server.js';
import { NimbleClient } from '../src/client.js';
import { loadServerConfig } from '../src/server/config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Examples are TypeScript run directly by `node`, which needs unflagged type
 * stripping (Node 22.18+). The package supports Node 20.19+, so on older
 * runtimes these are skipped rather than failing — the examples themselves are
 * unaffected, they just need `npx tsx` there.
 */
const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
const stripsTypes = major > 22 || (major === 22 && minor >= 18);

/** One server that answers in whichever dialect the path implies. */
function stubProvider(): Server {
  return createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      const path = request.url ?? '';
      const sent = JSON.parse(body || '{}') as Record<string, unknown>;
      const streaming = sent['stream'] === true || path.includes('streamGenerateContent');

      const reply = (payload: unknown) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(payload));
      };

      const sse = (...events: unknown[]) => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
        response.write('data: [DONE]\n\n');
        response.end();
      };

      // --- Vertex ---------------------------------------------------------
      if (path.includes(':generateContent') || path.includes(':streamGenerateContent')) {
        const candidate = {
          content: { role: 'model', parts: [{ text: 'Pacific' }] },
          finishReason: 'STOP',
        };
        const usageMetadata = {
          promptTokenCount: 5,
          candidatesTokenCount: 2,
          totalTokenCount: 7,
        };
        return streaming
          ? sse({ candidates: [candidate], usageMetadata })
          : reply({ candidates: [candidate], usageMetadata, modelVersion: 'gemini-2.0-flash-001' });
      }

      // --- Bedrock --------------------------------------------------------
      if (path.includes('/converse')) {
        // The binary event-stream format is covered by its own unit tests; the
        // examples only need the non-streaming path here.
        return reply({
          output: { message: { role: 'assistant', content: [{ text: 'Pacific' }] } },
          stopReason: 'end_turn',
          usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
        });
      }

      // --- OpenAI and Azure (Chat Completions) -----------------------------
      const tools = sent['tools'] as { function?: { name?: string } }[] | undefined;
      const messages = (sent['messages'] ?? []) as { role: string }[];
      const answeringTool = messages.some((message) => message.role === 'tool');

      if (streaming) {
        return sse(
          { choices: [{ delta: { content: 'one ' } }] },
          { choices: [{ delta: { content: 'two ' } }] },
          { choices: [{ delta: { content: 'three' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
          { choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } },
        );
      }

      // A tools request gets a tool call first, then a normal answer once the
      // result has been handed back.
      if (tools !== undefined && tools.length > 0 && !answeringTool) {
        return reply({
          id: 'chatcmpl-tool',
          created: 1_700_000_000,
          model: 'gpt-4o-mini',
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: {
                      name: tools[0]?.function?.name ?? 'get_weather',
                      arguments: '{"city":"Lagos"}',
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });
      }

      const structured = sent['response_format'] !== undefined;
      const content = structured
        ? JSON.stringify({ name: 'Saturn', diameterKm: 116_460, hasRings: true })
        : 'Pacific';

      return reply({
        id: 'chatcmpl-1',
        created: 1_700_000_000,
        model: 'gpt-4o-mini',
        choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      });
    });
  });
}

let provider: Server;
let providerUrl: string;
let gateway: StartedServer;
let gatewayUrl: string;

beforeAll(async () => {
  provider = stubProvider();
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address();
  providerUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  // A real gateway, in front of the stub, for the HTTP example.
  const client = new NimbleClient({
    env: { OPENAI_API_KEY: 'sk-stub', OPENAI_BASE_URL: providerUrl },
  });
  gateway = await startServer({
    client,
    config: {
      ...loadServerConfig({ NIMBLE_SERVER_API_KEYS: 'dev-key', NIMBLE_HOST: '127.0.0.1' }),
      port: 0,
      logLevel: 'silent',
    },
  });
  gatewayUrl = `http://127.0.0.1:${gateway.port}`;
});

afterAll(async () => {
  await gateway?.close();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
});

/** Credentials that route every provider at the stub. */
function stubEnv(): Record<string, string> {
  return {
    OPENAI_API_KEY: 'sk-stub',
    OPENAI_BASE_URL: providerUrl,
    AZURE_OPENAI_API_KEY: 'az-stub',
    AZURE_OPENAI_ENDPOINT: providerUrl,
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE',
    AWS_SECRET_ACCESS_KEY: 'stub-secret',
    BEDROCK_BASE_URL: providerUrl,
    GOOGLE_ACCESS_TOKEN: 'ya29.stub',
    GOOGLE_CLOUD_PROJECT: 'stub-project',
    VERTEX_BASE_URL: providerUrl,
  };
}

function run(
  file: string,
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, 'examples', file)], {
      cwd: ROOT,
      env: { ...process.env, ...stubEnv(), ...env },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

describe.skipIf(!stripsTypes)('examples', () => {
  it('01 completes and reports usage', async () => {
    const { code, stdout, stderr } = await run('01-basic-completion.ts');
    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(stdout).toContain('Pacific');
    expect(stdout).toContain('provider:');
    expect(stdout).toMatch(/tokens:\s+5 in \+ 2 out = 7/);
  });

  it('02 sends the same request to every configured provider', async () => {
    const { code, stdout } = await run('02-switching-providers.ts', {
      AZURE_DEPLOYMENT: 'my-deployment',
    });
    expect(code).toBe(0);
    for (const provider of ['openai', 'azure', 'bedrock', 'vertex']) {
      expect(stdout).toContain(provider);
    }
    expect(stdout).not.toContain('failed:');
  });

  it('03 streams text deltas and a finish reason', async () => {
    const { code, stdout } = await run('03-streaming.ts');
    expect(code).toBe(0);
    expect(stdout).toContain('one two three');
    expect(stdout).toContain('finish reason: stop');
    expect(stdout).toContain('tokens:        8');
  });

  it('04 completes a tool round trip', async () => {
    const { code, stdout } = await run('04-tool-calling.ts');
    expect(code).toBe(0);
    expect(stdout).toContain('→ get_weather({"city":"Lagos"})');
    expect(stdout).toContain('← {"city":"Lagos","tempC":31');
    expect(stdout).toContain('total tokens:');
  });

  it('05 parses a structured reply', async () => {
    const { code, stdout } = await run('05-structured-output.ts');
    expect(code).toBe(0);
    expect(stdout).toContain("name: 'Saturn'");
    expect(stdout).toContain('rings? yes');
  });

  it('05 fails loudly on a provider without JSON schema support', async () => {
    const { code, stderr } = await run('05-structured-output.ts', {
      MODEL: 'bedrock/anthropic.claude-haiku-4-5-20251001-v1:0',
    });
    expect(code).toBe(1);
    expect(stderr).toContain('bedrock does not support');
    expect(stderr).toContain('candidatesFor');
  });

  it('06 sends an inline image and reports the URL restriction', async () => {
    const { code, stdout } = await run('06-vision.ts', {
      MODEL: 'bedrock/anthropic.claude-haiku-4-5-20251001-v1:0',
    });
    expect(code).toBe(0);
    expect(stdout).toContain('Pacific');
    expect(stdout).toContain('URL images rejected here, as expected');
  });

  it('07 builds a fallback chain and serves from the first candidate', async () => {
    const { code, stdout } = await run('07-fallback.ts', { AZURE_DEPLOYMENT: 'my-deployment' });
    expect(code).toBe(0);
    expect(stdout).toContain('fallback chain:');
    expect(stdout).toContain('bedrock: succeeded');
    expect(stdout).toContain('served by: bedrock');
  });

  it('07 drops providers that cannot express the request', async () => {
    // `seed` is unsupported on Bedrock, so it must fall out of the chain.
    const { stdout } = await run('07-fallback.ts', { AZURE_DEPLOYMENT: 'my-deployment' });
    expect(stdout).toMatch(/capable of this request: .*openai/);
  });

  it('08 classifies each failure by code', async () => {
    const { code, stdout } = await run('08-error-handling.ts');
    expect(code).toBe(0);
    expect(stdout).toContain('temperature out of range     invalid_request');
    expect(stdout).toContain('typo in a field name         invalid_request');
    expect(stdout).toContain('unroutable model             unknown_provider');
    expect(stdout).toContain('feature the provider lacks   unsupported_feature');
    expect(stdout).toContain('provider not configured      authentication_error');
    // The field-level issue path is what makes a validation failure actionable.
    expect(stdout).toContain('temperature:');
  });

  it('09 talks to a running gateway over HTTP', async () => {
    const { code, stdout, stderr } = await run('09-gateway-client.ts', {
      NIMBLE_GATEWAY_URL: gatewayUrl,
      NIMBLE_SERVER_API_KEYS: 'dev-key',
    });
    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(stdout).toContain('/ready → 200');
    expect(stdout).toContain('configured providers: openai');
    expect(stdout).toContain('answer:   Pacific');
    expect(stdout).toContain('streamed: one two three');
  });
});
