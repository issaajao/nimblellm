# Command line

The `nimblellm` binary has two modes. With no arguments it starts the
[gateway](./gateway.md). With `check` it answers one question offline:

**Which providers could serve this request?**

```bash
npx nimblellm check request.json
```

```
nimblellm check · support-bot.json

                      openai  azure  bedrock  vertex  anthropic
  streaming             ✓       ✓       ✓       ✓         ✓
  tools                 ✓       ✓       ✓       ✓         ✓
  JSON schema output    ✓       ✓       ✗       ✓         ✗
  seed                  ✓       ✓       ✗       ✓         ✗
  temperature (0.7)     ✓       ✓       ✓       ✓         ✓

  Portable across: 3/5 providers (openai, azure, vertex)

  Blocked on bedrock    JSON schema output, seed
  Blocked on anthropic  JSON schema output, seed

  Your request names openai, which can serve it.
```

No credentials are read, no network call is made, and nothing is sent anywhere.
It is worth being precise about why that is true rather than merely intended:
`check` never constructs a client. It calls `normalizeRequest`, then
`router.supports()`, `assertWithinLimits()` and `router.candidatesFor()`, all of
which are pure functions over the request and the capability table.

## Why it cannot go stale

Every judgement in that table comes from the same functions the router calls
when it dispatches a real request. There is no second capability table, no
copied list of what each provider supports, and no parallel validation path —
`check` is a presentation layer over
[`providers/capabilities.ts`](../src/providers/capabilities.ts) and nothing
else.

That is the point of it. A portability report maintained separately from the
routing logic would be wrong within one release, and wrong in the worst
direction: confidently telling you a request is portable when it is not.

## Inline flags

For a quick answer without writing a file:

```bash
npx nimblellm check --model claude-sonnet --tools --json-schema
```

```
nimblellm check · inline flags

                      openai  azure  bedrock  vertex  anthropic
  tools                 ✓       ✓       ✓       ✓         ✓
  JSON schema output    ✓       ✓       ✗       ✓         ✗

  Portable across: 3/5 providers (openai, azure, vertex)

  Blocked on bedrock    JSON schema output
  Blocked on anthropic  JSON schema output
```

Flags describe the _shape_ of a request, not its content: `--tools` stands in a
placeholder tool, because capability analysis only cares that tools are present.

| Flag                      | Sets                                     |
| ------------------------- | ---------------------------------------- |
| `--model <ref>`           | The model reference — see below          |
| `--stream`                | Streaming                                |
| `--tools`                 | Tool calling                             |
| `--forced-tool`           | Tool calling with `toolChoice: required` |
| `--json-mode`             | JSON mode                                |
| `--json-schema`           | JSON schema output                       |
| `--image-url`             | An image referenced by URL               |
| `--image-base64`          | An inline base64 image                   |
| `--seed`                  | Reproducible sampling                    |
| `--metadata`              | Request tagging                          |
| `--stop <a,b>`            | Stop sequences                           |
| `--temperature <n>`       | Sampling temperature                     |
| `--top-p <n>`             | Nucleus sampling                         |
| `--top-k <n>`             | Top-k sampling                           |
| `--frequency-penalty <n>` | Frequency penalty                        |
| `--presence-penalty <n>`  | Presence penalty                         |

A file and inline flags are mutually exclusive. `--help` lists the same set.

## What the rows mean

Only the capabilities a request actually uses appear. A request that asks for
nothing optional gets no table at all, because there is nothing to be blocked
on:

```
  This request uses no optional capabilities, so every provider can
  express it as written.

  Portable across: 5/5 providers (openai, azure, bedrock, vertex, anthropic)
```

Numeric limits appear as their own rows, with the value in the label, because a
provider can reject a request on a range as easily as on a missing feature:

```
  temperature (1.5)    ✓       ✓       ✗       ✓         ✗
  stop count (5)       ✗       ✗       ✓       ✓         ✓
```

`temperature (1.5)` is out of range on Bedrock and Anthropic, which cap at 1
rather than 2. `stop count (5)` exceeds the four sequences OpenAI and Azure
accept. Neither is rescaled or truncated at runtime — the request is rejected —
so both belong in a portability report.

## The model prefix

`check` reports on every registered provider, so the routing prefix does not
change the analysis and an unprefixed `--model claude-sonnet` is accepted.

When a prefix _is_ given, the provider you named is called out at the end:

```
  Your request names bedrock, which cannot serve it as written.
```

That line is usually what you came for: not "is this portable" in the abstract,
but "does this still work where I am sending it".

## Exit codes

| Code | Meaning                                                            |
| ---- | ------------------------------------------------------------------ |
| `0`  | At least one provider can serve the request                        |
| `1`  | Bad usage, an unreadable file, or a request that failed validation |
| `2`  | Valid request, but no registered provider can express it           |

Note that `0` means _some_ provider can serve it. A request that names a
provider which cannot serve it still exits `0` if another one could — the line
above tells you, but the exit code is about portability, not about your choice.

Useful in CI as a guard against a request drifting into a corner only one
provider can reach:

```bash
npx nimblellm check request.json || exit 1
```

## Validation errors

A request that fails validation is reported exactly as the library reports it —
the same error code, the same message, the same field paths — because it _is_
the library reporting it. `check` calls `normalizeRequest` and prints what comes
back:

```
$ npx nimblellm check broken.json
NimbleError [invalid_request]: max_tokns: unknown field. Accepted fields: frequencyPenalty, maxOutputTokens, …
```

Errors go to stderr, the report to stdout, so `check request.json > report.txt`
keeps the two apart.

## Formatting

There is no colour, deliberately. The output is plain text with `✓` and `✗`, so
it reads the same in a terminal, a pipe, a CI log, or a pasted comment, and
there is no second code path to keep correct.

## What it will not do

`check` is static analysis and stays that way. It will not ping providers for
health, compare prices or latency, or recommend a provider. Those need live
data, and NimbleLLM's stated non-goal is to normalize requests and get out of
the way rather than grow into an observability layer.
