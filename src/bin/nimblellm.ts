#!/usr/bin/env node
/**
 * The `nimblellm` binary.
 *
 * Two modes. With no arguments it is the container entrypoint: read
 * configuration from the environment, start the gateway, and shut down cleanly
 * on SIGTERM — which is what an orchestrator sends first, and what decides
 * whether in-flight completions finish or are cut off mid-token.
 *
 * With `check` it is an offline capability report and never opens a socket.
 * The gateway stays the no-argument default so that `CMD ["node",
 * "dist/bin/nimblellm.js"]` keeps meaning what it has always meant.
 */

import { runCheck } from '../cli/check.js';
import { createClient } from '../client.js';
import { configuredProviders } from '../config/config.js';
import { NimbleError } from '../errors.js';
import { loadServerConfig } from '../server/config.js';
import { startServer } from '../server/server.js';
import { VERSION } from '../version.js';

async function main(): Promise<void> {
  const [mode, ...rest] = process.argv.slice(2);

  if (mode === 'check') {
    const { stdout, stderr, exitCode } = runCheck(rest);
    if (stdout !== '') process.stdout.write(stdout);
    if (stderr !== '') process.stderr.write(stderr);
    process.exit(exitCode);
  }

  if (mode !== undefined) {
    process.stderr.write(
      `unknown command "${mode}". Run \`nimblellm check --help\`, or pass no arguments to start the gateway.\n`,
    );
    process.exit(1);
  }

  const serverConfig = loadServerConfig();
  const client = createClient();
  const providers = configuredProviders(client.config);

  const { port, close } = await startServer({ client, config: serverConfig });

  log({
    message: 'nimblellm listening',
    version: VERSION,
    port,
    host: serverConfig.host,
    providers,
    anonymous: serverConfig.allowAnonymous,
  });

  if (providers.length === 0) {
    log({
      level: 'error',
      message:
        'no provider credentials found; /ready will report 503 until at least one is configured',
    });
  }
  if (serverConfig.allowAnonymous) {
    log({
      level: 'error',
      message:
        'NIMBLE_ALLOW_ANONYMOUS is set: this gateway will serve anyone who can reach it, using your provider credentials',
    });
  }

  let shuttingDown = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      log({ message: 'shutting down', signal });

      void close().then(() => {
        log({ message: 'stopped' });
        process.exit(0);
      });
    });
  }
}

function log(line: Record<string, unknown>): void {
  process.stdout.write(
    `${JSON.stringify({ level: 'info', time: new Date().toISOString(), ...line })}\n`,
  );
}

main().catch((error: unknown) => {
  // Startup failures are almost always misconfiguration, so print the guidance
  // rather than a stack trace. Secrets never reach a NimbleError message.
  const message = error instanceof NimbleError ? error.message : String(error);
  process.stderr.write(
    `${JSON.stringify({ level: 'error', time: new Date().toISOString(), message: `failed to start: ${message}` })}\n`,
  );
  process.exit(1);
});
