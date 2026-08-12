# Configuration

Configuration comes from the environment. [`.env.example`](../.env.example) is
the annotated template.

Every provider block is independent: configuring OpenAI does not oblige you to
configure Azure. Routing to a provider with no credentials fails at call time
with `authentication_error`, naming the variables it wanted.

## Providers

### OpenAI

| Variable            | Required | Default                  |
| ------------------- | -------- | ------------------------ |
| `OPENAI_API_KEY`    | yes      | —                        |
| `OPENAI_BASE_URL`   | no       | `https://api.openai.com` |
| `OPENAI_ORG_ID`     | no       | —                        |
| `OPENAI_PROJECT_ID` | no       | —                        |

### Azure OpenAI

| Variable                    | Required         | Default      |
| --------------------------- | ---------------- | ------------ |
| `AZURE_OPENAI_ENDPOINT`     | yes              | —            |
| `AZURE_OPENAI_API_KEY`      | one of these two | —            |
| `AZURE_OPENAI_ACCESS_TOKEN` | one of these two | —            |
| `AZURE_OPENAI_API_VERSION`  | no               | `2024-10-21` |

### AWS Bedrock

| Variable                   | Required                       | Default                                          |
| -------------------------- | ------------------------------ | ------------------------------------------------ |
| `AWS_REGION`               | yes (or `AWS_DEFAULT_REGION`)  | —                                                |
| `AWS_BEARER_TOKEN_BEDROCK` | either this…                   | —                                                |
| `AWS_ACCESS_KEY_ID`        | …or this pair                  | —                                                |
| `AWS_SECRET_ACCESS_KEY`    | with the above                 | —                                                |
| `AWS_SESSION_TOKEN`        | only for temporary credentials | —                                                |
| `BEDROCK_BASE_URL`         | no                             | `https://bedrock-runtime.{region}.amazonaws.com` |

### Google Vertex AI

| Variable                         | Required                  | Default                                        |
| -------------------------------- | ------------------------- | ---------------------------------------------- |
| `GOOGLE_CLOUD_PROJECT`           | yes (or `VERTEX_PROJECT`) | falls back to `project_id` in the key          |
| `GOOGLE_APPLICATION_CREDENTIALS` | either this…              | —                                              |
| `GOOGLE_SERVICE_ACCOUNT_JSON`    | …or this…                 | —                                              |
| `GOOGLE_ACCESS_TOKEN`            | …or this                  | —                                              |
| `GOOGLE_CLOUD_LOCATION`          | no (or `VERTEX_LOCATION`) | `us-central1`                                  |
| `VERTEX_BASE_URL`                | no                        | `https://{location}-aiplatform.googleapis.com` |

## Client behaviour

| Variable                  | Default  | Meaning                                        |
| ------------------------- | -------- | ---------------------------------------------- |
| `NIMBLE_DEFAULT_PROVIDER` | —        | Provider for models with no `provider/` prefix |
| `NIMBLE_TIMEOUT_MS`       | `120000` | Deadline **per attempt**, not per call         |
| `NIMBLE_MAX_RETRIES`      | `2`      | Extra attempts, retryable failures only        |

## Gateway server

Only read by the container entrypoint. See [Running as a gateway](./gateway.md).

| Variable                   | Default   | Meaning                                      |
| -------------------------- | --------- | -------------------------------------------- |
| `NIMBLE_SERVER_API_KEYS`   | —         | Comma-separated caller keys. **Required.**   |
| `NIMBLE_ALLOW_ANONYMOUS`   | `false`   | Serve without a key. Local development only. |
| `NIMBLE_PORT`              | `8080`    |                                              |
| `NIMBLE_HOST`              | `0.0.0.0` |                                              |
| `NIMBLE_MAX_BODY_BYTES`    | `4194304` | 4 MiB                                        |
| `NIMBLE_LOG_LEVEL`         | `info`    | `debug` · `info` · `error` · `silent`        |
| `NIMBLE_CORS_ORIGIN`       | —         | Sends no CORS headers when unset             |
| `NIMBLE_SHUTDOWN_GRACE_MS` | `10000`   | Drain time after SIGTERM                     |

## Overriding in code

Anything from the environment can be overridden:

```ts
import { createClient } from 'nimblellm';

const client = createClient({
  config: { maxRetries: 5, timeoutMs: 30_000, defaultProvider: 'openai' },
  onRetry: (attempt, delayMs, error) => {
    log.warn({ attempt, delayMs, code: error.code }, 'retrying');
  },
});
```

Provider blocks are replaced wholesale rather than deep-merged, so a partial
override cannot leave one half-configured from two sources.

Per-call overrides:

```ts
await client.complete(request, {
  timeoutMs: 5_000,
  maxRetries: 0,
  signal: controller.signal,
});
```

Reading configuration from somewhere other than `process.env` — a secrets
manager, a test fixture:

```ts
createClient({ env: { OPENAI_API_KEY: await vault.read('openai') } });
```

## Secrets

Every credential is wrapped in `Secret`. The default rendering of one is
harmless, so the usual accidents do not disclose anything:

```ts
const key = client.config.openai?.apiKey;

`${key}`; // '[redacted]'
JSON.stringify({ key }); // '{"key":"[redacted]"}'
console.log(key); // Secret(OPENAI_API_KEY) [redacted]
console.log(client.config); // no credential appears anywhere in it

key.hint(); // '…bcd1' — enough to tell which key is loaded
key.length; // safe to log
key.reveal(); // the actual value, only when asked outright
```

The value lives in a `#private` field, so it survives neither spreading nor
enumeration. `reveal()` is called in exactly one place per provider, next to
the wire.

Provider error text is scrubbed of every configured secret before becoming a
`NimbleError` message:

```
openai returned 401: Incorrect API key provided: [redacted]
```

That is a backstop, not the primary defence — it can only remove values it has
been told about. The primary defence is never putting a secret into a string.

### What is not protected

- **Anything you put in a prompt.** Message content is sent verbatim.
- **`providerOptions`.** Passed through as given; do not put credentials there.
- **Your own logging.** `client.config` is safe to log; a `reveal()` result is not.

## Precedence

1. Per-call options (`complete(request, { timeoutMs })`)
2. `createClient({ config })`
3. Environment variables
4. Built-in defaults

For `providerOptions`, an explicit value always beats a config-derived one —
that is how a per-request `apiVersion` overrides `AZURE_OPENAI_API_VERSION`.
