# Google Vertex AI

Uses the Gemini
[`generateContent`](https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/inference)
API.

## Setup

**1. Enable the Vertex AI API** for your project:

```bash
gcloud services enable aiplatform.googleapis.com --project=my-project
```

**2. Create a service account** with the **Vertex AI User**
(`roles/aiplatform.user`) role, and download a JSON key:

```bash
gcloud iam service-accounts create nimblellm
gcloud projects add-iam-policy-binding my-project \
  --member="serviceAccount:nimblellm@my-project.iam.gserviceaccount.com" \
  --role="roles/aiplatform.user"
gcloud iam service-accounts keys create key.json \
  --iam-account=nimblellm@my-project.iam.gserviceaccount.com
```

**3. Point at it:**

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json
export GOOGLE_CLOUD_PROJECT=my-project
export GOOGLE_CLOUD_LOCATION=us-central1   # optional, this is the default
```

```ts
await createClient().complete({
  model: 'vertex/gemini-2.0-flash',
  messages: [{ role: 'user', content: 'Why is the sky blue?' }],
});
```

`GOOGLE_CLOUD_PROJECT` may be omitted if the key file carries `project_id`.

## Model references

`vertex/<model>` for Google's own models:

```
vertex/gemini-2.0-flash
vertex/gemini-1.5-pro
```

Fully-qualified resource paths are passed through unchanged, which is how you
reach partner models:

```
vertex/publishers/meta/models/llama-3.3-70b-instruct-maas
```

The request goes to
`v1/projects/{project}/locations/{location}/publishers/google/models/{model}:generateContent`,
with project and location filled in from configuration.

## Authentication

Three ways in, in order of preference:

**A service account key**, either as a file path
(`GOOGLE_APPLICATION_CREDENTIALS`) or inline
(`GOOGLE_SERVICE_ACCOUNT_JSON`). NimbleLLM signs a JWT with the key, exchanges
it for an OAuth access token, and **caches that token until a minute before it
expires**, sharing one exchange between concurrent callers. Nothing to refresh.

**A pre-obtained token**, if you would rather manage it yourself:

```bash
export GOOGLE_ACCESS_TOKEN=$(gcloud auth print-access-token)
export GOOGLE_CLOUD_PROJECT=my-project
```

This is used as-is and **never refreshed** — `gcloud` tokens last about an hour,
which makes this fine for a script and wrong for a server.

**Not supported:** Application Default Credentials discovery, the GCE/GKE
metadata server, and Workload Identity Federation. A key or a token must be
supplied explicitly. On GKE, mount the key as a secret, or fetch a token with
`google-auth-library` and pass it in.

The inline form suits containers where mounting a file is awkward, at the cost
of a private key in an environment variable. The file path is the safer default.

## What is supported

Vertex is the most capable adapter — it is the only one that takes `topK`.

| Feature                      | Supported                              |
| ---------------------------- | -------------------------------------- |
| Streaming                    | ✅ SSE                                 |
| Tools / forced tool use      | ✅                                     |
| JSON mode and JSON schema    | ✅ via `responseSchema`                |
| Images — inline base64       | ✅                                     |
| Images — by URI              | ✅ with caveats, below                 |
| `seed`                       | ✅                                     |
| `stop`                       | ✅ up to 5                             |
| Frequency / presence penalty | ✅                                     |
| `topK`                       | ✅ only provider that supports it      |
| `metadata`                   | ❌ use `providerOptions.vertex.labels` |
| Temperature range            | 0–2                                    |

### Images by URI

Gemini requires an explicit media type, which a bare URL does not carry, so it
is inferred from the file extension. A URL with no recognizable extension is
rejected with a clear message — send the image inline instead.

Vertex generally wants a `gs://` Cloud Storage URI rather than an arbitrary
public URL, and the service account needs read access to that object.

## Mapping details

Two Gemini quirks drive most of the adapter:

- **The assistant role is called `model`.**
- **Function results are matched by function _name_, not by call id — Gemini
  issues no ids at all.** Canonical tool calls do have ids, so a `toolCallId` is
  resolved back to a name by looking at the assistant turn that made the call,
  and positional ids (`call_0`, `call_1`) are synthesized on the way out. A tool
  result whose call is missing from the history is rejected, because there would
  be no name to send.

Also worth knowing:

- Gemini reports `finishReason: STOP` even when the turn is a function call, so
  the presence of tool calls is treated as the more reliable signal and the
  canonical reason becomes `tool_calls`.
- `functionResponse.response` must be a JSON object. A tool result that parses
  as one is passed through; anything else is wrapped as `{ content: "…" }`.
- Streaming adds `?alt=sse`, without which the endpoint returns a JSON array.

## Common problems

**`403 Permission denied on resource project`** — the service account lacks
`roles/aiplatform.user`, or `GOOGLE_CLOUD_PROJECT` names a different project
than the key.

**`404` on a model that exists** — models are regional. `gemini-2.0-flash` is
not in every location; try `us-central1`.

**`could not sign with the service account private key`** — the PEM was
mangled. In an environment variable, newlines must survive; prefer
`GOOGLE_APPLICATION_CREDENTIALS` with a file, or ensure `\n` sequences are real
newlines.

**`invalid_grant: Invalid JWT Signature`** — the key was revoked or edited.

**`401` an hour into a long run** — a `GOOGLE_ACCESS_TOKEN` expired. Use a
service account key, which is refreshed automatically.
