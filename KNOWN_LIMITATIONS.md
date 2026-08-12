# Known limitations

Things that are true about NimbleLLM today and worth knowing before you rely on
it. Kept honest and current — if something here stops being true, the fix is to
edit this file, not to quietly leave it stale.

Last reviewed: **2026-08-12** (v0.1.0, phase 6 of 6).

One entry here has already earned its keep: §1 records a real signing defect that
live verification caught and unit tests could not — found, fixed, and confirmed
against a live AWS endpoint.

---

## 1. AWS Bedrock SigV4 — verified against live AWS

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

A completion that actually returns content, and the streaming path. Both were
blocked by account entitlement, not by anything in this codebase — see §6, where
that residual gap is tracked. It is a response-parsing gap, not a signing one.

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

## 2. No provider has been exercised against a live endpoint

The same is true of OpenAI, Azure and Vertex, and `verify-live` covers them
too — but the risk is materially lower. Their authentication is a token in a
header, and their request and response shapes are exercised against realistic
payloads in the unit tests. What a live run would additionally catch there is
narrower: a wrong default API version, a model id that no longer exists, a
response field that moved.

Everything in the repository today is tested against mocked transports.

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
  suite from the documented layout; live verification reached AWS successfully
  three times but was blocked at model entitlement before any response body was
  returned, so no real frames were ever decoded.

  Note what this is _not_: signing is verified (§1), and the decoder is a pure
  byte-parsing routine with no dependency on credentials or network state. The
  plausible failure is a field-layout misreading, which would present
  unmistakably — `npm run verify:live` fails its `stream` leg if the body
  arrives and decodes to zero events, and reports it as a decoding fault rather
  than a signing one. Closing it needs one run on an entitled account.

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
- **The container image is unsigned and unpublished.** No image exists at
  `ghcr.io/nimblellm/nimblellm` yet; the references in the README and
  Kubernetes manifest are what publishing will produce, not something you can
  pull today.

---

## 8. Pre-1.0 API stability

The public API may change without a major version bump until 1.0. Error `code`
values are the most stable part of the surface and are intended to be safe to
switch on.
