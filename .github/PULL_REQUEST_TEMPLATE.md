## What this changes

<!-- What and why. If it fixes an issue, "Fixes #123". -->

## How it was verified

<!-- Which tests cover it. If behaviour changed, say what would have failed before. -->

## Checklist

- [ ] `npm run format && npm run typecheck && npm test && npm run build` passes
- [ ] Tests cover the change, and none of them touch the network
- [ ] Documentation updated in the same PR if behaviour changed
- [ ] No credentials, tokens, or `.env` contents in the diff or the description

<!-- Delete any section below that does not apply. -->

### Provider adapter changes

- [ ] `supports()` reflects what the provider genuinely does — an unsupported
      declaration is preferable to an optimistic one
- [ ] Any uncertainty about provider behaviour is recorded in `KNOWN_LIMITATIONS.md`
- [ ] Tests cover request mapping, response parsing, stream chunks, and failures

### Public API changes

- [ ] Exported from `src/index.ts`
- [ ] `docs/api-reference.md` updated
- [ ] Breaking? Say so here — the project is pre-1.0, but breakage should still
      be deliberate and explained
