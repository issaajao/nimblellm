# Releasing

Releases are manual. Publishing is a decision, not a consequence of merging.

## Before you start

Read [KNOWN_LIMITATIONS.md](./KNOWN_LIMITATIONS.md) end to end. It is the
project's record of what has and has not been checked against reality, and it is
the thing most likely to be out of date.

**The release workflow fails if that file contains the string `RELEASE BLOCKER`.**
Add that marker to any limitation that must be resolved before shipping; remove
it when resolved. It is a mechanical gate precisely because "we'll remember" is
not one.

## Checklist

1. **Limitations are current.** Anything fixed since the last release is removed
   from `KNOWN_LIMITATIONS.md`; anything newly discovered is added. Update the
   "Last reviewed" date.
2. **Version bumped** in `package.json` **and** `src/version.ts` — they are
   separate strings and both are user-visible (`src/version.ts` is the
   `user-agent`).
3. **CI green on all three Node versions.** The Node 20.19 row keeps the
   `engines` field honest.
4. **`npm pack --dry-run`** lists what you expect: `dist/`, `README.md`,
   `LICENSE`, `KNOWN_LIMITATIONS.md`. No sources, no tests, no `.env`.
5. **Run the dry run.** Actions → Release → Run workflow with `dry_run: true`.
   It runs the full gate and uploads the tarball without publishing.
6. **Publish.** Same workflow with `dry_run: false` — or by hand for a first
   release, which trusted publishing cannot do. See below.
7. **Tag** the released commit (`git tag v0.1.0 && git push --tags`) and write
   release notes.

## Recommended before a first public release

Not mechanically enforced, but worth doing:

- **Clear whatever is still open** in
  [Verification status](./KNOWN_LIMITATIONS.md#verification-status). That table
  is the single source of truth for what has been checked against real
  providers; read it rather than relying on this list, which cannot be kept in
  step with it.
- **Run `npm run verify:live`** with credentials for as many providers as you
  have. It is the only check that contacts a real provider. Record the outcome
  in `KNOWN_LIMITATIONS.md` — that file's value comes from being kept accurate.
- **Build and run the container**, if the table still shows it unbuilt. The
  Dockerfile is otherwise validated only by its parts.
- **Publish the container image.** Actions → Publish image → Run workflow.
  Leave `dry_run: true` first: it builds and smoke-tests without pushing.
  Re-run with `dry_run: false` to push multi-arch images and a provenance
  attestation to `ghcr.io/issaajao/nimblellm`. A published GitHub release
  triggers the same workflow automatically.

## Publishing to npm

The Release workflow uses **trusted publishing** (OIDC): the job authenticates
with a short-lived token minted by GitHub for that run. There is no npm token in
this repository to leak, rotate, or scope wrongly, and provenance — a signed
link between the tarball and the commit and workflow that produced it — is
generated automatically.

Configure it once, on npmjs.com → the package → Settings → Trusted publisher:

| Field       | Value          |
| ----------- | -------------- |
| Publisher   | GitHub Actions |
| Owner       | `issaajao`     |
| Repository  | `nimblellm`    |
| Workflow    | `release.yml`  |
| Environment | `release`      |

The environment field must match the `environment:` in the workflow, or be left
blank. The workflow declares `release`, so enter that or nothing — a mismatch
fails the publish with an unhelpful authentication error.

### The first version cannot use it

A trusted publisher is configured on a package's settings page, and that page
does not exist until the package does. **The initial publish has to happen
another way**, after which every subsequent release goes through the workflow.

For a first release, publish by hand:

```bash
npm login          # 2FA prompt
npm publish        # runs prepublishOnly: clean, format, types, build, tests
```

Then configure the trusted publisher as above, and use the workflow from the
next version onwards. The cost of this is that the first version carries no
provenance while later ones do; the alternative — publishing a throwaway
placeholder version purely to create the settings page — buys a signed 0.1.0 at
the price of a junk version in the public history, which is a bad trade.

Before publishing by hand, check the version is free:

```bash
npm view nimblellm@$(node -p "require('./package.json').version") version
```

A 404 means it is available.

## Versioning

Pre-1.0, so minor versions may break. Error `code` values are the most stable
part of the surface and are intended to be safe to switch on; changing one is a
breaking change even before 1.0.
