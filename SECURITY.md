# Security Policy

NimbleLLM handles provider credentials, so security reports are taken seriously.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private vulnerability reporting on
this repository (Security → Report a vulnerability), which keeps the report
between you and the maintainers until a fix is available.

Please include:

- What the issue is and why it matters
- Steps to reproduce, or a proof of concept
- The version or commit you tested
- Any suggested fix

**Never include real credentials in a report.** If a key was exposed while
finding the issue, rotate it before writing anything up.

You can expect an acknowledgement within a few days and an assessment shortly
after. Since this project is pre-1.0 and maintained on a best-effort basis,
please ask before assuming a timeline.

## Scope

In scope — anything that could disclose a credential or let an attacker use one:

- A credential appearing in a log line, error message, stack trace, or
  serialized object
- `Secret` failing to redact through any standard path (`toString`, `toJSON`,
  `console.log`, spreading, enumeration)
- A signing flaw that permits request forgery or replay
- The gateway serving a request without a valid key, or a timing side channel in
  key comparison
- Injection through request normalization — a crafted request causing NimbleLLM
  to send something it should not, to a host it should not

Out of scope:

- Vulnerabilities in a provider's own API
- Prompt injection against a model. NimbleLLM transports messages; it does not
  interpret them
- Anything requiring an attacker to already hold the credentials
- Missing rate limiting or quota enforcement in the gateway — documented as
  absent in [KNOWN_LIMITATIONS.md](./KNOWN_LIMITATIONS.md#7-operational-gaps)

## What the design already protects

Worth knowing before reporting, and worth preserving in any contribution:

- **Credentials are wrapped in `Secret`.** `toString`, `toJSON` and Node's
  inspector all yield `[redacted]`; the value lives in a `#private` field, so it
  survives neither spreading nor enumeration. `reveal()` is the only way out and
  is called in one place per provider, next to the wire.
- **Provider error text is scrubbed** of every configured secret before becoming
  a `NimbleError`. This is a backstop, not the primary defence — it can only
  remove values it knows about.
- **The gateway refuses to start without a key** unless
  `NIMBLE_ALLOW_ANONYMOUS=true` is set explicitly. Key comparison checks every
  configured key rather than stopping at the first match.
- **Request and response bodies are never logged**, at any log level. Prompts
  routinely carry sensitive data.
- **CI never sees a credential.** The entire test suite runs against mocked
  transports, and a workflow that references provider credentials or the live
  verification script fails the build.

## What is deliberately not protected

- **Anything you put in a prompt.** Message content is transmitted verbatim.
- **`providerOptions`.** Passed through as given; do not put credentials there.
- **Single-instance credentials.** One deployment holds one credential set;
  gateway keys authenticate callers but do not select provider credentials.
  Running one instance per tenant is the supported multi-tenant story.
