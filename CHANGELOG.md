# Changelog

## 0.2.0 — 21 September 2026

The first release where the npm package and the container image are built
from the same commit. `nimblellm@0.1.0` on npm was published from `7b6e03f`
and already contains everything listed below; the `0.1.0` container image
was built earlier, from `a99ed55`, and contains none of it. 0.2.0 brings the
image level with the package. Between 0.1.0 and 0.2.0 on npm there are no
code changes.

### Added, relative to the 0.1.0 container image

- Native Anthropic provider adapter — the fifth provider, addressed as
  `anthropic/claude-*` and talking to the Messages API directly. Both the
  non-streaming and streaming paths were verified against the live Anthropic
  API on 30 August 2026.
- `nimblellm check` — offline portability analysis for a request: which
  providers can serve it, and what blocks the rest. No credentials, no
  network call.
- README now leads with portability and capability discovery, and says
  plainly how this differs from the Vercel AI SDK.

### Providers

- `openai` — OpenAI
- `azure` — Azure OpenAI
- `bedrock` — AWS Bedrock (Converse API)
- `vertex` — Google Vertex AI
- `anthropic` — Anthropic Messages API

## 0.1.0 — August 2026

Initial release. See the note above: the npm package and the container image
carrying this version do not contain the same code.

- Canonical request and response shapes across OpenAI, Azure OpenAI, AWS
  Bedrock and Google Vertex AI
- Gateway with a `POST /v1/chat/completions` endpoint — accepts OpenAI field
  spellings, returns the canonical `NimbleResponse`; not a drop-in for the
  OpenAI SDK
- `router.candidatesFor()` and `router.supports()` capability discovery
- AWS SigV4 signing, verified against a live Bedrock endpoint
