# NimbleLLM documentation

One request shape for OpenAI, AWS Bedrock, Azure OpenAI and Google Vertex AI.

## Start here

- **[Quick start](./quickstart.md)** — installed and calling a model in a few minutes.
- **[Configuration](./configuration.md)** — every environment variable, and how secrets are handled.
- **[Examples](../examples)** — nine runnable programs, each executed by the test suite.

## Provider setup

Each page covers getting credentials, the model reference format, what that
provider supports, and the mistakes that cost the most time.

- [OpenAI](./providers/openai.md)
- [Azure OpenAI](./providers/azure.md)
- [AWS Bedrock](./providers/bedrock.md) — SigV4 signing is verified against a
  live endpoint; the streaming frame decoder is not yet
  ([§6](../KNOWN_LIMITATIONS.md#6-streaming-caveats))
- [Google Vertex AI](./providers/vertex.md)

## Guides

- [Streaming](./streaming.md)
- [Tools and structured output](./tools.md)
- [Errors and retries](./errors.md)
- [Running as a gateway](./gateway.md)

## Reference

- [API reference](./api-reference.md) — types, client, router, adapters.
- [Known limitations](../KNOWN_LIMITATIONS.md) — what is not yet verified.

## How it fits together

```
your code
    ↓  any accepted request shape
normalizeRequest()          resolve aliases, hoist system, validate
    ↓  NimbleRequest (canonical, frozen)
Router.route()              pick adapter, check capabilities and ranges
    ↓  provider-native path + payload
CredentialRegistry          bearer token, resource key, SigV4, or OAuth
    ↓  authenticated request
transport                   deadlines, retries, error classification
    ↓  raw provider response
adapter.parseResponse()     back to the canonical shape
    ↓
NimbleResponse
```

Every layer is usable on its own. `normalizeRequest` and `Router` are pure —
they perform no I/O, which is why routing decisions can be tested without a
network and inspected before a call is made.
