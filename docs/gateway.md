# Running as a gateway

The same code ships as a container: one service in front of every provider, so
credentials live in one place instead of in every application that needs a
model.

## Run it

```bash
cp .env.example .env      # fill in the providers you use
docker compose up --build
```

Without compose:

```bash
docker build -t nimblellm:local .
docker run -p 8080:8080 --env-file .env nimblellm:local
```

From source:

```bash
NIMBLE_SERVER_API_KEYS=dev-key OPENAI_API_KEY=sk-... npm run dev
```

> Published images live at `ghcr.io/issaajao/nimblellm`. For whether one is
> available yet, see
> [Verification status](../KNOWN_LIMITATIONS.md#verification-status).

## Endpoints

| Endpoint                    | Auth | Purpose                                       |
| --------------------------- | :--: | --------------------------------------------- |
| `POST /v1/chat/completions` | yes  | Completion; `stream: true` returns SSE        |
| `POST /v1/completions`      | yes  | The same handler, shorter name                |
| `GET /v1/providers`         | yes  | Configured providers, limits and capabilities |
| `GET /health`               |  no  | Liveness                                      |
| `GET /ready`                |  no  | Readiness; 503 until a provider is configured |

```bash
curl localhost:8080/v1/chat/completions \
  -H 'authorization: Bearer dev-key' \
  -H 'content-type: application/json' \
  -d '{"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"Hello"}]}'
```

Client code: [example 09](../examples/09-gateway-client.ts).

## It is not an OpenAI-compatible endpoint

Request bodies may use OpenAI spellings — that comes free from
`normalizeRequest`. But **responses are `NimbleResponse`, not an OpenAI
envelope**, so pointing an existing OpenAI SDK at this URL will not work; the
SDK cannot parse the reply.

```jsonc
// what you get back
{
  "id": "chatcmpl-1",
  "provider": "openai",
  "model": "gpt-4o-mini-2024-07-18",
  "finishReason": "stop",
  "message": { "role": "assistant", "content": [{ "type": "text", "text": "…" }] },
  "usage": { "inputTokens": 10, "outputTokens": 4, "totalTokens": 14 },
}
```

Use `fetch`, or the library directly.

## Authentication

Callers present `Authorization: Bearer <key>`, checked against
`NIMBLE_SERVER_API_KEYS`. Comma-separated, so keys rotate without downtime: add
the new key, migrate callers, drop the old one.

**The server refuses to start without a key.** A gateway with nothing in front
of it is an open proxy onto your paid provider credentials. If that is genuinely
what you want:

```bash
NIMBLE_ALLOW_ANONYMOUS=true
```

It will start, and say so loudly at startup.

Gateway keys authenticate _callers_. They do not select which provider
credentials get used — one instance holds one set. See
[KNOWN_LIMITATIONS §5](../KNOWN_LIMITATIONS.md#5-single-instance-credentials-by-design).

## Kubernetes

[`deploy/kubernetes.yaml`](../deploy/kubernetes.yaml) has a Deployment, Service,
ConfigMap, Secret template and HPA, with probes, resource limits and a hardened
`securityContext`.

```bash
kubectl apply -f deploy/kubernetes.yaml
```

Replace the image reference and every credential. Prefer an external secret
manager over committing that Secret with values filled in.

### Shutdown

SIGTERM stops new connections and waits up to `NIMBLE_SHUTDOWN_GRACE_MS`
(default 10s) for in-flight completions.

**Keep that below your orchestrator's termination grace period.** If
`terminationGracePeriodSeconds` is 30 and the drain window is 25s, a long
completion finishes. Reverse them and Kubernetes SIGKILLs the pod mid-token.

### Probes

`/health` asks whether the process is up. `/ready` additionally requires a
configured provider, so a pod with a broken secret is kept out of the Service
rather than restarted forever. Using `/ready` as a liveness probe would produce
exactly that crash loop.

## Operating it

**Logs** are one JSON object per line on stdout: `requestId`, `method`, `path`,
`status`, `durationMs`, and for failures `code` and `provider`.

Request and response bodies are **never** logged, at any level — prompts
routinely carry sensitive data. `NIMBLE_LOG_LEVEL=debug` raises verbosity but
still logs no bodies.

**Not included:** metrics, rate limiting, quota enforcement, request
authentication beyond a shared key. Put a reverse proxy or API gateway in front
if it is exposed beyond a trusted network —
[KNOWN_LIMITATIONS §7](../KNOWN_LIMITATIONS.md#7-operational-gaps).

**Body limit** is 4 MiB (`NIMBLE_MAX_BODY_BYTES`). Inline images add up; raise
it deliberately, since it bounds per-request memory.

## Embedding the server

```ts
import { createClient, startServer, loadServerConfig } from 'nimblellm';

const { port, close } = await startServer({
  client: createClient(),
  config: loadServerConfig(),
  log: (line) => logger.info(line),
});

process.on('SIGTERM', () => void close().then(() => process.exit(0)));
```

`createGatewayServer` returns a plain `node:http` server if you would rather
manage the lifecycle yourself.
