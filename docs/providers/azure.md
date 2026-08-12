# Azure OpenAI

The request body is Chat Completions, identical to OpenAI's. Everything that
differs is addressing: the **deployment** goes in the URL rather than the body,
and every call carries an `api-version`.

## Setup

1. Create an Azure OpenAI resource in the portal.
2. **Deploy a model.** In Azure a _deployment_ is a named instance of a model,
   and the name is whatever you chose — it need not match the model.
3. Collect the endpoint and a key from **Keys and Endpoint**.

```bash
export AZURE_OPENAI_ENDPOINT=https://my-resource.openai.azure.com
export AZURE_OPENAI_API_KEY=...
```

```ts
await createClient().complete({
  model: 'azure/my-gpt4o-deployment', // deployment name, not 'gpt-4o'
  messages: [{ role: 'user', content: 'Why is the sky blue?' }],
});
```

## Model references

`azure/<deployment-name>`.

This is the single most common Azure mistake: `azure/gpt-4o` works only if you
happened to name your deployment `gpt-4o`. The request goes to
`{endpoint}/openai/deployments/{deployment}/chat/completions`, and Azure returns
404 `DeploymentNotFound` when the name is wrong.

## Authentication

Either a resource key:

```bash
export AZURE_OPENAI_API_KEY=...
```

or a Microsoft Entra ID token, for keyless deployments:

```bash
export AZURE_OPENAI_ACCESS_TOKEN=$(az account get-access-token \
  --resource https://cognitiveservices.azure.com \
  --query accessToken -o tsv)
```

When both are set the Entra token wins, being the narrower credential.

> Entra tokens expire, typically within an hour. NimbleLLM does **not** refresh
> them — it sends what it was given. For long-running processes, either refresh
> the variable and rebuild the client, or use a resource key. (Vertex tokens
> _are_ refreshed automatically, because a service account key is supplied
> rather than a token.)

## API version

Defaults to `2024-10-21` (GA). Override globally:

```bash
export AZURE_OPENAI_API_VERSION=2025-01-01-preview
```

or per request:

```ts
providerOptions: {
  azure: {
    apiVersion: '2025-01-01-preview';
  }
}
```

Newer features — structured outputs, some tool behaviour — need a recent
version. If a feature that works on OpenAI fails on Azure, the API version is
the first thing to check.

`apiVersion` is consumed by routing and never appears in the request body.

## What is supported

Identical to [OpenAI](./openai.md): everything except `topK`, temperature 0–2,
up to 4 stop sequences.

The caveat is that Azure's support depends on your API version and region. The
capability table describes the API; an older `api-version` may reject
`response_format` or `tools` that NimbleLLM will happily send.

## Common problems

**`404 DeploymentNotFound`** — the model reference is a deployment name. Check
the exact name under **Deployments** in Azure AI Studio.

**`401 Access denied due to invalid subscription key`** — the key belongs to a
different resource than `AZURE_OPENAI_ENDPOINT`.

**`400 Unsupported parameter`** — the `api-version` predates the feature.

**Token expired mid-run** — see the Entra note above.

**Endpoint with a path** — `AZURE_OPENAI_ENDPOINT` must be the origin only
(`https://my-resource.openai.azure.com`), not a full deployment URL. Trailing
slashes are trimmed for you.
