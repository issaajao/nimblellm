# Contributing to NimbleLLM

Thanks for considering it. This document covers what the project is trying to
be, how to get set up, and the few conventions that are load-bearing.

## What this project is

NimbleLLM normalizes requests and responses across OpenAI, Anthropic, AWS Bedrock, Azure
OpenAI and Google Vertex AI, and gets out of the way. It is **not** a prompt
framework, an agent runtime, or a vector store. Contributions that pull it
toward those are likely to be declined, however good the code — say what you
have in mind in an issue first and we can find the right home for it.

## Getting set up

```bash
git clone <your fork>
cd nimblellm
npm install
npm test
```

Node 20.19 or newer. No provider credentials are needed: the entire test suite
runs against mocked transports and local stub servers.

```bash
npm test           # vitest, including every example
npm run test:watch
npm run typecheck  # tsc --noEmit
npm run format     # prettier --write
npm run build      # emits dist/
```

## Before opening a pull request

```bash
npm run format && npm run typecheck && npm test && npm run build
```

CI runs exactly this on Node 20.19, 22 and 24. The Node 20 row exists to keep
the `engines` field honest — if it fails there, either fix the code or change
`engines`, but do not leave them disagreeing.

## Conventions that matter

**Tests do not touch the network.** Every suite runs against injected `fetch`
stubs or a local server. If a change needs a real provider, it belongs behind
`npm run verify:live` — see below.

**Unknown request fields are rejected, not dropped.** A silently ignored
`max_tokns` costs far more to debug than an error at the call site. Keep it that
way.

**Values are passed through, never rescaled.** Temperature is the same softmax
temperature everywhere; a value outside a provider's range is an error, not
something to reinterpret. See the README for the reasoning.

**Under-claim rather than over-claim.** Where a provider's behaviour is
ambiguous, declare the capability unsupported and leave `providerOptions` as the
escape hatch. A request that could have worked being rejected is a much smaller
problem than a request that quietly does the wrong thing.

**Comments explain why, not what.** Match the density and idiom of the
surrounding code.

## Adding or changing a provider adapter

Adapters implement [`ProviderAdapter`](./src/providers/adapter.ts). A new one
needs:

- `describeRoute`, `buildPayload`, `parseResponse`, and `parseStreamChunk`
- an honest `supports()` — declare a capability only if you are confident, and
  document any uncertainty in [KNOWN_LIMITATIONS.md](./KNOWN_LIMITATIONS.md)
- `limits` reflecting the provider's real accepted ranges
- a test suite mirroring the existing ones in `test/providers/`, covering
  request mapping, response parsing, stream chunks, and the failure modes
- a page under `docs/providers/` following the existing shape, including a
  "common problems" section

Adapters are registered, not hard-coded — a third-party adapter can be passed to
`createRouter({ adapters })` without forking, so an adapter for a niche provider
may be better maintained outside this repo. Ask in an issue if unsure.

## The live verification script

[`npm run verify:live`](./src/scripts/verify-live.ts) is the only thing here
that contacts a real provider. It is **manual and on-demand by design**:

- It must never be added to CI. A workflow that references it fails the build,
  deliberately — see `.github/workflows/ci.yml`.
- It costs real money and needs real credentials.
- It fails for reasons unrelated to the code (model entitlement, region
  availability, quota), so it is unsuitable as a gate.

If you have credentials and run it, record the outcome in
[KNOWN_LIMITATIONS.md](./KNOWN_LIMITATIONS.md) — that file is the project's
memory of what has and has not been verified against reality.

## Documentation

Documentation that has never been run is documentation that is quietly wrong.
Examples in `examples/` are executed by the test suite against a stub provider;
if you add one, add its assertions to `test/examples.test.ts` too.

If you change behaviour that a doc describes, change the doc in the same pull
request.

## Reporting bugs

Use the issue templates. For anything involving a provider, the single most
useful thing you can include is the `NimbleError` — its `code`, `provider`,
`status`, and `issues`. It is scrubbed of credentials by design, so it is safe
to paste.

**Never paste API keys, tokens, or `.env` contents into an issue.** For security
problems, see [SECURITY.md](./SECURITY.md) rather than opening a public issue.

## Commit messages and pull requests

No enforced format. A short imperative subject and a body explaining _why_ is
plenty. Keep unrelated changes in separate pull requests — a formatting sweep
mixed into a behaviour change is hard to review and harder to revert.

## Code of conduct

Participation is governed by the [Code of Conduct](./CODE_OF_CONDUCT.md).
