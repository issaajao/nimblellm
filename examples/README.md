# Examples

Nine runnable programs. Every one of them is **executed by the test suite**
against a stub that impersonates every provider — see
[`test/examples.test.ts`](../test/examples.test.ts). Documentation that has
never been run is documentation that is quietly wrong, so this is asserted
rather than claimed.

## Running them

```bash
export OPENAI_API_KEY=sk-...
node examples/01-basic-completion.ts
```

> Running `.ts` directly needs Node 22.6+ (type stripping). On Node 20:
> `npx tsx examples/01-basic-completion.ts`.

Most examples default to `openai/gpt-4o-mini` and accept a `MODEL` override:

```bash
MODEL=bedrock/anthropic.claude-haiku-4-5-20251001-v1:0 node examples/03-streaming.ts
```

They make real, billable calls.

| #                                                 | What it shows                                                    |
| ------------------------------------------------- | ---------------------------------------------------------------- |
| [01](./01-basic-completion.ts) basic completion   | The smallest useful call; reading content parts and usage        |
| [02](./02-switching-providers.ts) switching       | One request body, every configured provider                      |
| [03](./03-streaming.ts) streaming                 | The four canonical events; why `usage` is separate from `finish` |
| [04](./04-tool-calling.ts) tool calling           | A full round trip: call → run → result → answer                  |
| [05](./05-structured-output.ts) structured output | JSON schema, and failing loudly on Bedrock which lacks it        |
| [06](./06-vision.ts) vision                       | Inline vs URL images, and where URL images are refused           |
| [07](./07-fallback.ts) fallback                   | `candidatesFor` to build a chain without wasted round trips      |
| [08](./08-error-handling.ts) error handling       | Every error code, and which are worth retrying                   |
| [09](./09-gateway-client.ts) gateway client       | Talking to the container over HTTP with plain `fetch`            |

Example 09 needs a running gateway:

```bash
NIMBLE_SERVER_API_KEYS=dev-key OPENAI_API_KEY=sk-... npm run dev
node examples/09-gateway-client.ts
```

## Reading order

Start at 01, then 03 and 04 — those three cover most real usage. Read 08 before
you deploy anything: knowing which failures are worth retrying is the difference
between a resilient service and one that hammers a rate limit.

Examples 02 and 07 are the case for the library existing at all.

## Further reading

- [Quick start](../docs/quickstart.md)
- [Provider setup](../docs/README.md#provider-setup)
- [Known limitations](../KNOWN_LIMITATIONS.md)
