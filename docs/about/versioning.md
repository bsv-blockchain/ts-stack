---
id: about-versioning
title: 'Versioning Policy'
kind: meta
version: '2.0.0'
last_updated: '2026-07-27'
last_verified: '2026-07-27'
review_cadence_days: 30
status: stable
tags: [about, versioning, semver, releases]
---

# Versioning Policy

Each public package in ts-stack has its own Semantic Versioning version. A
source version and a published registry version are separate facts: merging a
version change does not publish it, and publication occurs only through the
protected npm OIDC workflow.

The exact source versions, runtime profiles, and release routes are generated
on [Generated Stack Facts](../reference/stack-facts.md). Do not copy that table
into hand-maintained pages.

## Semantic Versioning

- **PATCH** fixes a defect without changing the supported public contract.
- **MINOR** adds backward-compatible behavior or public API.
- **MAJOR** removes, renames, or incompatibly changes supported behavior,
  types, entry points, wire formats, persistence, or runtime requirements.

For a package below 1.0, an incompatible public change may use a minor bump,
but it still requires explicit migration notes and cannot be hidden in a patch.
Changing an internal implementation without changing its packed or runtime
contract does not automatically require bumping unrelated packages.

## Affected-package decisions

Version every public package whose published bytes or manifest will change.
Then inspect its first-party dependents:

1. A dependent package needs a bump when its packed manifest range changes, its
   generated declarations or bundles change, or consumers must receive the new
   dependency to obtain correct behavior.
2. A dependent package does not need a bump merely because a compatible
   workspace implementation changed while its own packed bytes and declared
   contract remain identical.
3. Breaking first-party changes require one coordinated migration across all
   affected dependents before publication.
4. Infrastructure manifests and locks are reconciled after a successful
   cascade release; they are deployed separately as immutable images.

Workspace runtime and development references use `workspace:^`; public peer
dependencies use reviewed public ranges. `scripts/check-versions.mjs` rejects
incoherent first-party references before release.

## Support policy

The latest published release of each package is the supported default. Older
versions remain available from npm but do not receive a blanket maintenance or
security-backport promise. When a serious vulnerability affects a previous
major, maintainers decide whether a safe backport is practical based on
exploitability, dependency constraints, and deployment exposure, and record
that decision in the private advisory.

Browser, React Native, Node consumer, contributor, and infrastructure support
are different profiles. The generated facts page and package manifests are
authoritative; contributor CI currently uses the stricter root toolchain.

## Breaking changes and deprecation

A breaking release must include:

- an explicit compatibility and deployment-impact review;
- migration instructions with before/after examples;
- updates to package READMEs, API docs, examples, and conformance contracts;
- a rollback or forward-fix plan for persisted or remotely deployed behavior;
  and
- coordinated versions for affected first-party dependents.

Prefer a deprecation period when it can be implemented without creating a
security or correctness hazard. There is no universal 60-day window. Do not
unpublish or move an immutable version to simulate rollback; deprecate a bad
version and publish a corrected version.

## Documentation and release notes

Package documentation frontmatter versions describe the package version
verified by that page. Cross-stack version and support facts come from the
generated pages. The [Package API, Declarations, and Migration
Ledger](../reference/package-api-migrations.md) is the uniform release-note
authority for all 30 public packages, including packages that retain an
additional historical `CHANGELOG.md`.

A package change updates:

- its README and API/reference docs when the consumer contract changes;
- its exact entry in `governance/package-release-notes.json`, including the
  source-versus-published boundary, SemVer impact, summary, and migration
  decision;
- a migration note with before/after examples for incompatible behavior;
- a package-local changelog when that package already maintains one; and
- the pull request and release evidence needed to explain the change.

`pnpm docs:packages:check` rejects missing packages, version/release-type
disagreement, missing API pages, and stale generated output. After an authorized
publication, the release-sync change advances the recorded published baseline;
merging a candidate record never publishes it.

Do not promise a GitHub Release, npm dist-tag, changelog format, cadence, or
support window that the workflow does not actually enforce.

## Publication

Publication is an explicit operator action after reviewed source versions are
on `main`. The supported paths are:

- `packages/<path>/vX.Y.Z` for a single governed package;
- `release/vYYYY-MM-DD` for a cascade of every source version absent from npm;
- a legacy `vX.Y.Z` cascade; or
- a manual protected workflow dispatch from `main`.

The workflow packs once, produces and scans SBOMs, verifies licenses,
attestations, provenance, and registry integrity, then opens a reviewed
post-publication version-sync PR when a cascade changes first-party ranges.
Nothing should be published from a maintainer workstation.

See [Dependency and Release Policy](../reference/dependency-policy.md),
[npm Package Supply Chain](../reference/npm-package-supply-chain.md), and
[Release and Operations Guide](../reference/release-operations.md) for the
complete gates, failure handling, and rollback path.
