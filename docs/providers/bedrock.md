# AWS Bedrock

Uses the [Converse API](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html),
which is model-agnostic — one adapter covers Anthropic, Meta, Mistral and Amazon
models alike.

> **Signing is verified.** Bedrock is the one provider whose authentication this
> codebase _computes_ rather than copies — AWS Signature Version 4. Live
> verification found a real defect there (single-encoded canonical URIs where
> SigV4 requires double encoding), and the fix is confirmed accepted by a live
> AWS endpoint.
>
> One residual gap: the **binary event-stream decoder** used for streaming has
> never seen bytes AWS actually sent, because live runs were blocked at model
> entitlement before a response body was returned. Low risk — it is pure byte
> parsing, and `npm run verify:live` fails its `stream` leg loudly if frames
> decode to nothing — but open. See
> [KNOWN_LIMITATIONS §6](../../KNOWN_LIMITATIONS.md#6-streaming-caveats).

## Setup

**1. Enable model access.** In the Bedrock console → **Model access**, request
access to the models you want. This is per-account _and_ per-region, and it is
the most common reason a correct request fails.

**2. Choose credentials.** Either a Bedrock API key:

```bash
export AWS_REGION=us-east-1
export AWS_BEARER_TOKEN_BEDROCK=...
```

or IAM credentials, which are signed with SigV4:

```bash
export AWS_REGION=us-east-1
export AWS_ACCESS_KEY_ID=AKIA...
export AWS_SECRET_ACCESS_KEY=...
export AWS_SESSION_TOKEN=...   # only for temporary credentials
```

The API key path is simpler and skips signing entirely. When both are present,
the API key wins.

**3. Grant `bedrock:InvokeModel`** (and `bedrock:InvokeModelWithResponseStream`
for streaming) to the IAM principal.

```ts
await createClient().complete({
  model: 'bedrock/anthropic.claude-haiku-4-5-20251001-v1:0',
  messages: [{ role: 'user', content: 'Why is the sky blue?' }],
  temperature: 0.5, // 0–1 on Bedrock
});
```

## Model references

`bedrock/<modelId>` — the id exactly as the Bedrock console lists it under
**Programmatic Access**.

Two id shapes are in circulation. Current models use a short, unversioned form;
older ones keep a dated, version-suffixed form:

```
bedrock/anthropic.claude-opus-5                        # current convention
bedrock/anthropic.claude-sonnet-4-20250514-v1:0        # older, dated + versioned
```

### Geo prefixes — usually required

Most regions have **no in-region endpoint** for current models, so the bare id
returns 404 there. Prefix it with an inference-profile geo, which also sets data
residency:

| Prefix    | Routes within            |
| --------- | ------------------------ |
| `us.`     | US and Canada            |
| `eu.`     | EU                       |
| `au.`     | Australia                |
| `global.` | Worldwide, no constraint |

```
bedrock/us.anthropic.claude-opus-5
```

**Check the model's console page before choosing.** For Claude Opus 5, only
`us-east-1`, `eu-north-1`, `eu-west-1` and `ap-southeast-4` have an in-region
endpoint — `us-east-2` does not, so a bare `anthropic.claude-opus-5` fails there
while `us.anthropic.claude-opus-5` works.

An id containing a colon is URL-encoded into the path, so seeing `:` become
`%3A` in logs is expected. (The SigV4 canonical request encodes it a second
time, to `%253A` — see [KNOWN_LIMITATIONS §1](../../KNOWN_LIMITATIONS.md).)

### Sampling parameters on current models

Current Claude models **reject `temperature`, `topP` and `topK` outright**.
NimbleLLM passes them through when set, so a request carrying them fails at the
provider. Omit them and steer with prompting.

Adaptive thinking is also on by default, and `maxOutputTokens` caps thinking
_plus_ response — a budget sized for the answer alone can be spent reasoning and
truncate before any text appears. Give it room.

## Credentials NimbleLLM does not read

Only environment variables are read. **`~/.aws/credentials`, `AWS_PROFILE`, EC2
and ECS instance metadata, and IRSA are not consulted.** On EKS or EC2, export
the variables yourself, or fetch credentials with the AWS SDK and pass them in:

```ts
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';

const aws = await fromNodeProviderChain()();

createClient({
  config: {
    bedrock: {
      region: 'us-east-1',
      baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
      accessKeyId: new Secret(aws.accessKeyId),
      secretAccessKey: new Secret(aws.secretAccessKey),
      ...(aws.sessionToken ? { sessionToken: new Secret(aws.sessionToken) } : {}),
    },
  },
});
```

Temporary credentials expire; rebuild the client before they do.

## What is supported

| Feature                      | Supported                              |
| ---------------------------- | -------------------------------------- |
| Streaming                    | ✅ binary event stream                 |
| Tools / forced tool use      | ✅                                     |
| Images — inline base64       | ✅ png, jpeg, gif, webp                |
| Images — by URL              | ❌ Converse cannot fetch               |
| `stop`                       | ✅ limit not enforced (model-specific) |
| JSON mode / JSON schema      | ❌ use a tool instead                  |
| `seed`                       | ❌                                     |
| Frequency / presence penalty | ❌                                     |
| `topK`                       | ❌ canonically — see below             |
| `metadata`                   | ❌ canonically — see below             |
| Temperature range            | **0–1**                                |

**Temperature is 0–1, not 0–2.** A request with `temperature: 1.5` is rejected
with `invalid_request` rather than rescaled — the same number must mean the same
thing wherever a request is routed. Keep to 0–1 for portability.

**No JSON schema output.** Define a tool with the shape you want and read the
arguments off the tool call; the model is constrained the same way.

**`topK` and request tagging** go through `providerOptions`, because the field
name varies by model family and guessing would silently do nothing:

```ts
providerOptions: {
  bedrock: {
    additionalModelRequestFields: { top_k: 40 },   // Anthropic spelling
    guardrailConfig: { guardrailIdentifier: 'gr-1', guardrailVersion: '1' },
  },
}
```

## Mapping details

Three Converse constraints shape the adapter:

- **Only `user` and `assistant` roles exist.** System text goes in a top-level
  `system` block; canonical `tool` messages become `user` turns carrying a
  `toolResult`.
- **Roles must alternate.** Neighbouring turns that map to the same role are
  merged, so `user → assistant → tool → tool` collapses correctly.
- **The conversation must start with `user`.** One that starts with an assistant
  turn is rejected with a clear message rather than a Converse validation error.

## Common problems

**`AccessDeniedException` / `You don't have access to the model`** — most often
IAM: the principal lacks `bedrock:InvokeModel`, or an SCP blocks it. For an
Anthropic model on an account that has never used one, the message may instead
be asking for use-case details to be submitted. Note this is _not_ a signing
failure, even though both surface as a 4xx.

**`ValidationException: Invocation of model ID … with on-demand throughput
isn't supported`** — use the inference profile id (`us.` prefix) instead.

**`SignatureDoesNotMatch`** — in order of likelihood: `AWS_REGION` does not
match the credentials' region; temporary credentials without `AWS_SESSION_TOKEN`;
clock skew over five minutes; or a defect in the signing implementation. Run
`npm run verify:live`, which prints the raw AWS response next to the exact
request that was signed.

**Streaming fails while non-streaming works** — that isolates the fault to the
event-stream decoder rather than signing, and needs
`bedrock:InvokeModelWithResponseStream` on the IAM principal. `verify:live`
makes this distinction for you.

**`ResourceNotFoundException`** — the model id is wrong, or right for a
different region.

**Temperature rejected** — Bedrock's ceiling is 1, not 2.
