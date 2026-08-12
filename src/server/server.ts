/**
 * The gateway server.
 *
 * Built on `node:http` rather than a framework, so the container ships with
 * exactly one runtime dependency (zod). The surface is small enough that a
 * router abstraction would cost more than it saves.
 *
 * The server speaks the **canonical** NimbleLLM shape. Request bodies may use
 * OpenAI spellings — `max_tokens`, nested `tool_calls`, and so on — because
 * `normalizeRequest` already accepts them; responses are always
 * {@link NimbleResponse}, not an OpenAI envelope.
 */

import { randomUUID } from 'node:crypto';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { NimbleClient } from '../client.js';
import { NimbleError, type NimbleErrorCode } from '../errors.js';
import { isAuthorized, type LogLevel, type ServerConfig } from './config.js';
import { VERSION } from '../version.js';

export interface ServerOptions {
  readonly client: NimbleClient;
  readonly config: ServerConfig;
  /** Injectable sink, so tests can assert on logs without touching stdout. */
  readonly log?: (line: Record<string, unknown>) => void;
}

/** HTTP status for each canonical error code. */
const STATUS: Readonly<Record<NimbleErrorCode, number>> = {
  invalid_request: 400,
  unknown_provider: 400,
  unsupported_feature: 400,
  // The gateway's *own* provider credentials are wrong: a server-side fault,
  // not something the caller can fix. Gateway auth is rejected separately, 401.
  authentication_error: 502,
  rate_limited: 429,
  timeout: 504,
  provider_error: 502,
  internal_error: 500,
};

const LEVELS: Readonly<Record<LogLevel, number>> = { debug: 0, info: 1, error: 2, silent: 3 };

/**
 * Build the gateway server. Call `.listen()` yourself, or use
 * {@link startServer} to get listening plus signal handling.
 */
export function createGatewayServer(options: ServerOptions): Server {
  const { client, config } = options;
  const log = logger(config.logLevel, options.log);

  return createHttpServer((request, response) => {
    void handle(request, response, client, config, log).catch((error: unknown) => {
      // Anything reaching here escaped the per-route handling; never leak it raw.
      log('error', { message: 'unhandled request failure', error: String(error) });
      if (!response.headersSent) {
        send(response, 500, { error: { code: 'internal_error', message: 'internal error' } });
      } else {
        response.end();
      }
    });
  });
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  client: NimbleClient,
  config: ServerConfig,
  log: Log,
): Promise<void> {
  const requestId = randomUUID();
  const started = Date.now();
  const path = new URL(request.url ?? '/', 'http://localhost').pathname;
  const method = request.method ?? 'GET';

  response.setHeader('x-request-id', requestId);
  if (config.corsOrigin !== undefined) {
    response.setHeader('access-control-allow-origin', config.corsOrigin);
    response.setHeader('access-control-allow-headers', 'authorization, content-type');
    response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  }

  const done = (status: number) => {
    log('info', { requestId, method, path, status, durationMs: Date.now() - started });
  };

  if (method === 'OPTIONS') {
    response.writeHead(204).end();
    return done(204);
  }

  // Liveness and readiness are unauthenticated: an orchestrator probing them
  // has no gateway key, and neither reveals anything about credentials.
  if (method === 'GET' && path === '/health') {
    send(response, 200, { status: 'ok', version: VERSION });
    return done(200);
  }

  if (method === 'GET' && path === '/ready') {
    const providers = client.configuredProviders();
    const status = providers.length > 0 ? 200 : 503;
    send(response, status, {
      status: status === 200 ? 'ready' : 'no providers configured',
      providers,
    });
    return done(status);
  }

  if (!isAuthorized(config, request.headers.authorization)) {
    log('info', { requestId, method, path, status: 401, reason: 'gateway key rejected' });
    send(response, 401, {
      error: { code: 'unauthorized', message: 'a valid gateway key is required' },
    });
    return done(401);
  }

  if (method === 'GET' && path === '/v1/providers') {
    send(response, 200, { providers: describeProviders(client) });
    return done(200);
  }

  if (method === 'POST' && (path === '/v1/chat/completions' || path === '/v1/completions')) {
    return completions(request, response, client, config, requestId, log, done);
  }

  send(response, 404, {
    error: { code: 'not_found', message: `no route for ${method} ${path}` },
  });
  return done(404);
}

async function completions(
  request: IncomingMessage,
  response: ServerResponse,
  client: NimbleClient,
  config: ServerConfig,
  requestId: string,
  log: Log,
  done: (status: number) => void,
): Promise<void> {
  let body: unknown;
  try {
    body = JSON.parse(await readBody(request, config.maxBodyBytes));
  } catch (error) {
    const tooLarge = error instanceof NimbleError;
    const status = tooLarge ? 413 : 400;
    send(response, status, {
      error: {
        code: 'invalid_request',
        message: tooLarge ? error.message : 'request body is not valid JSON',
      },
    });
    return done(status);
  }

  const wantsStream = (body as { stream?: unknown } | null)?.stream === true;

  // Abort the upstream call if the caller hangs up mid-stream, so a closed
  // browser tab does not keep burning provider tokens.
  const controller = new AbortController();
  request.on('close', () => {
    if (!response.writableEnded) controller.abort();
  });

  try {
    if (!wantsStream) {
      const result = await client.complete(body, { signal: controller.signal });
      send(response, 200, result);
      return done(200);
    }

    // Pull the first event *before* writing headers. `stream()` is a generator,
    // so the upstream call has not happened yet — committing to 200 here would
    // turn an authentication or routing failure into a successful empty stream.
    const events = client.stream(body, { signal: controller.signal });
    const first = await events.next();

    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-request-id': requestId,
    });

    if (first.done !== true) {
      response.write(`data: ${JSON.stringify(first.value)}\n\n`);
      for await (const event of events) {
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    }

    response.write('data: [DONE]\n\n');
    response.end();
    return done(200);
  } catch (error) {
    const failure = asNimbleError(error);
    log('error', {
      requestId,
      code: failure.code,
      provider: failure.provider,
      message: failure.message,
    });

    if (response.headersSent) {
      // Mid-stream: the status is already 200, so report the failure as a
      // final event rather than pretending the stream finished cleanly.
      response.write(`data: ${JSON.stringify({ type: 'error', error: failure.toJSON() })}\n\n`);
      response.end();
      return done(200);
    }

    const status = STATUS[failure.code];
    send(response, status, { error: failure.toJSON() });
    return done(status);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export interface StartedServer {
  readonly server: Server;
  readonly port: number;
  /** Stop accepting connections and wait for in-flight requests to finish. */
  close(): Promise<void>;
}

/**
 * Start the server and wire up graceful shutdown.
 *
 * @returns the listening server, its resolved port, and a `close()` that
 *   drains in-flight requests before resolving
 */
export async function startServer(options: ServerOptions): Promise<StartedServer> {
  const server = createGatewayServer(options);
  const { config } = options;
  const log = logger(config.logLevel, options.log);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : config.port;

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        log('error', { message: 'shutdown grace period elapsed; closing anyway' });
        server.closeAllConnections();
        resolve();
      }, config.shutdownGraceMs);
      timer.unref();

      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
      // Idle keep-alive sockets would otherwise hold the close open.
      server.closeIdleConnections();
    });
  };

  return { server, port, close };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read the request body, refusing anything over the limit.
 *
 * @throws NimbleError - `invalid_request` once the limit is exceeded, without
 *   waiting for the rest of the upload
 */
export function readBody(request: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;

    request.on('data', (chunk: Buffer) => {
      if (rejected) return;

      size += chunk.length;
      if (size > maxBytes) {
        rejected = true;
        chunks.length = 0;
        // Drain the rest into the void rather than destroying the socket: the
        // connection has to survive long enough to carry the 413 back.
        request.resume();
        reject(
          new NimbleError(`request body exceeds the ${maxBytes} byte limit`, {
            code: 'invalid_request',
          }),
        );
        return;
      }
      chunks.push(chunk);
    });

    request.on('end', () => {
      if (!rejected) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', reject);
  });
}

function describeProviders(client: NimbleClient): Record<string, unknown>[] {
  const configured = new Set(client.configuredProviders());

  return client.router.providers().map((id) => {
    const adapter = client.router.adapterFor(id);
    return {
      id,
      configured: configured.has(id),
      limits: adapter.limits,
      capabilities: CAPABILITIES.filter((capability) => adapter.supports(capability)),
    };
  });
}

/** Listed explicitly so the endpoint's output is stable across releases. */
const CAPABILITIES = [
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
] as const;

function asNimbleError(error: unknown): NimbleError {
  if (error instanceof NimbleError) return error;
  return new NimbleError(error instanceof Error ? error.message : 'internal error', {
    code: 'internal_error',
    cause: error,
  });
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

type Log = (level: Exclude<LogLevel, 'silent'>, line: Record<string, unknown>) => void;

/** Structured single-line JSON logs. Never given a credential to print. */
function logger(level: LogLevel, sink?: (line: Record<string, unknown>) => void): Log {
  const threshold = LEVELS[level];

  return (lineLevel, line) => {
    if (LEVELS[lineLevel] < threshold) return;
    const entry = { level: lineLevel, time: new Date().toISOString(), ...line };
    if (sink !== undefined) {
      sink(entry);
    } else {
      process.stdout.write(`${JSON.stringify(entry)}\n`);
    }
  };
}
