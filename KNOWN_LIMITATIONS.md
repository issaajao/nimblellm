# Known limitations

Things that are true about NimbleLLM today and worth knowing before you rely on
it. Kept honest and current — if something here stops being true, the fix is to
edit this file, not to quietly leave it stale.

Last reviewed: **2026-08-15** (v0.1.0, phase 6 of 6).

One entry here has already earned its keep: §1 records a real signing defect that
live verification caught and unit tests could not — found, fixed, and confirmed
against a live AWS endpoint.

---

## Verification status

**This section is the single source of truth for what has been checked against
real providers.** Everything else in the repository — the README, the docs, the
verification script's own output — links here rather than restating it, so there
is exactly one place to update when this changes.

| Area                                      | Checked against a real provider?                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Bedrock SigV4 signing                     | ✅ Yes — found and fixed a real defect ([§1](#1-aws-bedrock-sigv4-signing))                            |
| Bedrock non-streaming round trip          | ✅ Yes — a real completion, correctly normalized ([§2](#2-live-coverage-by-provider-and-path))         |
| Bedrock streaming / event-stream decoding | ❌ Not yet — has never decoded real AWS bytes ([§6](#6-streaming-caveats))                             |
| OpenAI, Azure, Vertex — any path          | ❌ Not yet — no live call has been made ([§2](#2-live-coverage-by-provider-and-path))                  |
| Container image                           | ✅ Yes — published, pulled anonymously, and smoke-tested from the registry ([§7](#7-operational-gaps)) |
| Everything else                           | Tested against mocked transports and local stub servers                                                |

Re-check any of it with `npm run verify:live`, which contacts real providers and
is manual by design. Record what you find here.

---

## 1. AWS Bedrock SigV4 signing

**Status: verified. Signing is confirmed working against a real AWS endpoint.**

Bedrock is the only provider whose authentication is _computed_ by this codebase
rather than copied from configuration — AWS Signature Version 4, implemented in
[`src/auth/sigv4.ts`](./src/auth/sigv4.ts). That made it the one place where a
plausible-looking implementation could be wrong in a way no unit test would
catch, which is why it was checked against a live endpoint.

### A real defect, found live

The first live call failed with `SignatureDoesNotMatch` (403). `canonicalUri`
was percent-encoding each path segment **once**, where SigV4 requires it
**twice** for every service except S3. A Bedrock model id containing a colon
travels on the wire as `…v1%3A0` and must appear in the string-to-sign as
`…v1%253A0`; it was appearing as `…v1%3A0`, so AWS computed a different
signature.

**Unit tests could not have caught this.** The signing code was internally
consistent and every assertion passed — the canonical request was assembled in
the right order, with the right headers, over the right key. It was simply
encoding to a different convention than AWS. The bug is also invisible unless a
path contains a character needing encoding, and the original tests used clean
example paths (`/model/my-model/converse`) that encode to themselves.

Fixed, with regression tests covering a colon-bearing model id, equivalence
between raw and pre-encoded input, and confirmation that the wire path stays
single-encoded while only the canonical representation is double-encoded.

### How the fix was confirmed

Three subsequent live runs each got past authentication and were rejected on
**model** grounds instead:

| Date       | Region    | Model                                       | Result                                           |
| ---------- | --------- | ------------------------------------------- | ------------------------------------------------ |
| 2026-08-12 | us-east-2 | us.anthropic.claude-3-5-haiku-20241022-v1:0 | ❌ `SignatureDoesNotMatch` — defect found, fixed |
| 2026-08-12 | us-east-2 | us.anthropic.claude-3-5-haiku-20241022-v1:0 | ⚠️ 404 model retired — **signature accepted**    |
| 2026-08-12 | us-east-2 | us.anthropic.claude-opus-5                  | ⚠️ 403 not entitled — **signature accepted**     |

AWS validates SigV4 at the front door, before it resolves the model. A
lifecycle or entitlement rejection is therefore only reachable _after_
authentication succeeds — the 403 even names the resolved base model
(`anthropic.claude-opus-5`), proving the geo inference profile was expanded
server-side. **Signing is verified.**

### What this does not cover

Only the streaming path. A non-streaming completion has since returned real
content through the container, exercising response parsing end to end
([§2](#2-live-coverage-by-provider-and-path)) — so the entitlement wall that
blocked these three runs has been cleared with a different model.

The remaining gap is the binary event-stream decoder ([§6](#6-streaming-caveats)),
which is a response-parsing gap and not a signing one.

To re-verify at any time, with an account entitled to invoke a Bedrock model:

```bash
export AWS_REGION=us-east-2
export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...
export VERIFY_BEDROCK_MODEL=<an id this account can invoke>
npm run verify:live
```

[`verify-live`](./src/scripts/verify-live.ts) checks each configured provider
twice — a non-streaming call and a streaming one — because the two paths fail
independently. It distinguishes a signing rejection from a lifecycle or
entitlement one and says so explicitly. It is manual and on-demand by design: it
is **not** part of `npm test` and must not be added to CI.

---

## 2. Live coverage, by provider and path

Only AWS Bedrock has been exercised against a live endpoint, and only on the
non-streaming path. Everything else in the repository is tested against mocked
transports and local stub servers.

### Verified: Bedrock, non-streaming, through the container

|          |                                                                                                                 |
| -------- | --------------------------------------------------------------------------------------------------------------- |
| Date     | 13 August 2026                                                                                                  |
| Provider | AWS Bedrock                                                                                                     |
| Region   | us-east-2                                                                                                       |
| Model    | `us.anthropic.claude-sonnet-4-5-20250929-v1:0`                                                                  |
| Path     | `docker build` → `docker run -p 8080:8080 --env-file .env` → `curl POST /v1/chat/completions` with a Bearer key |
| Result   | 200 OK, correctly normalized — `finishReason: "stop"`, content and usage tokens all present and correct         |

The same container also served `GET /health` (200) and `GET /ready` (200,
listing the configured providers).

This exercised the whole chain end to end: request normalization, routing,
SigV4 signing, transport, Converse response parsing, and the gateway's own HTTP
surface — inside the built image rather than against the library directly. It is
the strongest single piece of evidence in this file.

Note the path: this was **not** run through `verify-live`. That script covers
the same ground plus streaming, but the round trip above was performed with
`curl` against a running container, which additionally proves the image works.

### Not verified

- **Bedrock streaming.** The `stream: true` path, the SSE surface, and the
  binary event-stream decoder were not exercised. See
  [§6](#6-streaming-caveats).
- **OpenAI, Azure and Vertex — any path.** No live call has been made to any of
  them. The risk is materially lower than it was for Bedrock: their
  authentication is a token in a header rather than a signature this codebase
  computes, and their request and response shapes are exercised against
  realistic payloads in the unit tests. What a live run would additionally catch
  is narrower — a wrong default API version, a model id that no longer exists, a
  response field that moved.

---

## 3. Provider behaviour is modelled from documentation, not observation

Capability declarations, parameter ranges and error mappings come from each
provider's published API reference. Where the documentation was ambiguous, the
conservative choice was made:

- **`metadata` is declared unsupported on Bedrock and Vertex.** Both likely
  have an equivalent (Converse `requestMetadata`, Vertex `labels`), but the
  field names were not confirmed, and emitting a wrong field breaks live
  requests. Both remain reachable through `providerOptions`.
- **`topK` on Bedrock is not canonical.** Converse carries it in
  `additionalModelRequestFields`, where the key differs by model family
  (`top_k` for Anthropic, `topK` elsewhere). Guessing would silently do nothing.
- **Bedrock stop-sequence limits are not enforced**, being model-specific.

These are deliberate under-claims: a request that could have worked is rejected,
rather than a request that quietly does the wrong thing.

---

## 4. The gateway speaks the canonical shape, not the OpenAI wire format

`POST /v1/chat/completions` _accepts_ OpenAI-shaped request bodies — that comes
free from `normalizeRequest`, which resolves aliases and nested forms. But
responses are `NimbleResponse`, not an OpenAI envelope. **Pointing an existing
OpenAI SDK at this gateway will not work**; the SDK will fail to parse the
reply.

An OpenAI-compatible response mode is a plausible future addition. It is not
implemented, and translating back would partly undo the normalization the
library exists to provide.

---

## 5. Single-instance credentials, by design

One deployment holds one set of provider credentials. There is no per-caller
credential routing, no credential store, and no tenant isolation. Gateway keys
(`NIMBLE_SERVER_API_KEYS`) authenticate _callers_; they do not select which
provider credentials get used.

This is a deliberate v1 boundary, not an oversight. Running one instance per
tenant is the supported multi-tenant story.

---

## 6. Streaming caveats

- **Streamed responses are not retried.** Once the first byte is sent the status
  is already 200, so a mid-stream failure surfaces as a terminal `error` event
  rather than a retry. Non-streaming calls retry normally.
- **AWS event-stream CRCs are not verified.** The frame decoder reads the
  prelude and message CRC fields but does not check them. They guard against
  corruption on the wire, which TLS already covers.
- **Bedrock's binary event-stream decoder has not seen real AWS bytes.** This is
  the one residual gap from the §1 verification effort, and it is **low risk but
  open**. The frame decoder is tested against frames constructed in the test
  suite from the documented layout. The live Bedrock call that has succeeded
  ([§2](#2-live-coverage-by-provider-and-path)) went through the non-streaming
  path, so `converse-stream` has still never been called and no real frame has
  ever been decoded.

  Note what this is _not_: signing is verified (§1), and so now is non-streaming
  request and response handling (§2) — the decoder is the only Bedrock component
  still unexercised. It is a pure byte-parsing routine with no dependency on
  credentials or network state, and the plausible failure is a field-layout
  misreading, which would present unmistakably: `npm run verify:live` fails its
  `stream` leg if the body arrives and decodes to zero events, and reports it as
  a decoding fault rather than a signing one.

  Closing it needs one request with `stream: true` against the same account and
  model that already work — either `npm run verify:live`, or a `curl` to the
  gateway with `"stream": true` in the body.

  The same caveat applies more weakly to `parseResponse` on Bedrock: no live
  Converse response body has been parsed. Its shape is exercised against
  realistic fixtures in the unit tests.

---

## 7. Operational gaps

- **No metrics endpoint.** Logs are structured JSON on stdout; there is no
  Prometheus endpoint or OpenTelemetry integration.
- **No rate limiting or quota enforcement** in the gateway. Put one in front of
  it if it is exposed beyond a trusted network.
- **No request/response body logging**, deliberately — prompts frequently carry
  sensitive data. `NIMBLE_LOG_LEVEL=debug` raises verbosity but still never
  logs bodies.
- **The container image is published and independently verified.**
  `ghcr.io/issaajao/nimblellm:0.1.0` (and `:latest`) is public, builds for
  linux/amd64 and linux/arm64, and carries a signed provenance attestation
  tracing it to `publish-image.yml` at commit `a99ed55`. It has been pulled
  anonymously — logged out of ghcr, so as any stranger would — and passed the
  smoke test from the registry rather than from a local build. CI additionally
  builds and smoke-tests the image on every change. Verify it yourself with
  `gh attestation verify oci://ghcr.io/issaajao/nimblellm:0.1.0 --owner issaajao`.

---

## 8. Pre-1.0 API stability

The public API may change without a major version bump until 1.0. Error `code`
values are the most stable part of the surface and are intended to be safe to
switch on.
