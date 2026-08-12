# Errors and retries

Everything throws one type. `code` is stable across versions and safe to switch
on.

```ts
import { NimbleError } from 'nimblellm';

try {
  await client.complete(request);
} catch (error) {
  if (error instanceof NimbleError) {
    error.code; // 'rate_limited'
    error.retryable; // true
    error.provider; // 'openai'
    error.status; // 429
    error.issues; // field-level problems, for invalid_request
    error.cause; // the underlying error, when there was one
  }
}
```

Full program: [example 08](../examples/08-error-handling.ts).

## Codes

| Code                   | Meaning                                      | Retryable |
| ---------------------- | -------------------------------------------- | :-------: |
| `invalid_request`      | Malformed request. Fix it.                   |    no     |
| `unknown_provider`     | The model reference could not be routed.     |    no     |
| `unsupported_feature`  | Valid request, wrong provider for it.        |    no     |
| `authentication_error` | Credentials missing, malformed, or rejected. |    no     |
| `rate_limited`         | Quota or rate limit.                         |    yes    |
| `timeout`              | Deadline passed.                             |    yes    |
| `provider_error`       | Upstream failure.                            | 5xx only  |
| `internal_error`       | A defect in NimbleLLM.                       |    no     |

`retryable` is what to branch on, not the code — a `provider_error` from a 500
is retryable while one from a malformed response body is not.

## Field-level issues

Validation failures carry a path per problem, so the caller learns everything
wrong in one pass:

```ts
client.complete({ model: 'openai/gpt-4o', messages: [], temperature: 9 });
// issues: [{ path: 'messages', message: 'must contain at least one message' }]
```

```ts
client.complete({ model, messages, max_tokns: 10 });
// issues: [{ path: 'max_tokns', message: 'unknown field. Accepted fields: …' }]
```

Unknown fields are rejected rather than dropped. A silently ignored `max_tokns`
costs far more to find than an error at the call site.

Paths use dotted-and-bracketed form: `messages[2].content[0].text`.

## When failures are detected

Most are caught before anything leaves the process:

```
normalizeRequest   invalid_request      shape, ranges, cross-field invariants
Router             unknown_provider     no adapter for the prefix
                   unsupported_feature  provider cannot express the request
                   invalid_request      value outside this provider's range
CredentialRegistry authentication_error provider not configured
transport          everything else      the call was actually made
```

Only the last line costs a network round trip or money.

## Retries

`rate_limited`, `timeout` and 5xx `provider_error` are retried automatically:
`NIMBLE_MAX_RETRIES` extra attempts (default 2), exponential backoff with full
jitter, `Retry-After` honoured when the provider sends it.

Everything in the 4xx range is final — the same body gets the same answer.

```ts
createClient({
  config: { maxRetries: 5 },
  onRetry: (attempt, delayMs, error) => {
    log.warn({ attempt, delayMs, code: error.code, provider: error.provider });
  },
});

await client.complete(request, { maxRetries: 0 }); // per call
```

`NIMBLE_TIMEOUT_MS` (default 120000) is the deadline **per attempt**, not for
the call as a whole. Three attempts at 120s can take six minutes. For a hard
ceiling, use a signal:

```ts
await client.complete(request, { signal: AbortSignal.timeout(30_000) });
```

**Streamed calls are not retried** once the first byte has been sent. See
[Streaming](./streaming.md#what-streaming-does-not-do).

## Secrets in error text

Provider error text is scrubbed of every configured secret before it becomes a
message:

```
openai returned 401: Incorrect API key provided: [redacted]
```

A backstop, not the primary defence — it can only remove values it knows about.

## Logging

`toJSON()` gives a structured form with no secrets:

```ts
log.error(error.toJSON());
// { name: 'NimbleError', code: 'rate_limited', message: '…',
//   provider: 'openai', status: 429, retryable: true }
```

## Through the gateway

| Code                   | HTTP |
| ---------------------- | ---- |
| `invalid_request`      | 400  |
| `unknown_provider`     | 400  |
| `unsupported_feature`  | 400  |
| `rate_limited`         | 429  |
| `timeout`              | 504  |
| `authentication_error` | 502  |
| `provider_error`       | 502  |
| `internal_error`       | 500  |

`authentication_error` becomes **502, not 401**: the gateway's own provider
credentials are wrong, which the caller cannot fix. A missing or wrong _gateway_
key is a separate 401 with `code: 'unauthorized'`, produced before routing.

An oversized body is 413.
