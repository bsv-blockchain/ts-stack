# Pending release changes

Each pull request that changes what a public npm package publishes adds **one
new file** in this directory. The file records the SemVer impact, a
consumer-visible summary, and the migration decision. Every file has a unique
name, so pull requests that each add one never conflict with each other.

Do not edit any of these files in a feature pull request:

- a public package `version` field;
- `governance/package-release-notes.json`;
- a package `CHANGELOG.md`;
- `publicPackageVersions` in `governance/repository-health/baselines.json`; or
- the generated ledgers in `docs/reference/`.

The `Version packages` workflow writes them. After each merge to `main`, it
applies every pending file here in one generated `chore: version packages`
pull request and deletes the files that it applied.

## Add a change file

```bash
pnpm change @bsv/sdk:minor --summary "Adds X so that Y." --migration "No consumer migration is required."
```

Name more than one package to record one change that affects several packages:

```bash
pnpm change @bsv/sdk:patch @bsv/wallet-toolbox:patch --summary "…" --migration "…"
```

You can also write the file by hand. Name it `YYYYMMDD-<lowercase-slug>.md`:

```markdown
---
release:
  "@bsv/sdk": minor
---
Adds X so that Y. Use complete sentences; this text goes into the release
notes and the package changelog.

## Migration

No consumer migration is required.
```

## Choose the impact

- `patch`: a fix with no change to the public contract.
- `minor`: a backward-compatible addition.
- `major`: an incompatible change. For a `0.y.z` package, use `minor` for an
  incompatible change; `major` moves the package to `1.0.0`.

The strongest pending impact for a package wins. Nested packages, such as the
wallet-toolbox client and mobile builds, move in lockstep with their enclosing
package. A package whose source version is already an unpublished candidate is
not bumped again when that candidate already satisfies the impact.

## Commands

- `pnpm changes:status` shows the versions that the pending files produce.
- `pnpm changes:check` validates every pending file.
- `pnpm changes:version` applies the pending files. Only the `Version packages`
  workflow runs it.
