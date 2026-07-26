---
id: dependency-release-policy
title: "Dependency and Release Policy"
kind: reference
version: "1.1.0"
last_updated: "2026-07-26"
last_verified: "2026-07-26"
review_cadence_days: 30
status: stable
tags: [reference, dependencies, security, releases]
---

# Dependency and Release Policy

This workspace keeps application code, published npm packages, and infrastructure
images on one reviewed dependency baseline.

## Supported toolchain

- Node.js 24.11 or newer for repository development, CI, and releases
- pnpm 10
- TypeScript 6
- Oxlint for TypeScript linting

CI, conformance, documentation, and release workflows run on Node.js 24. Package
lint errors fail the build. Existing warnings remain visible and are reduced
progressively; a package may opt into stricter warning enforcement once its
warning baseline reaches zero.

Every published package declares `engines.node: ">=22"`. Node.js 22 is the
consumer runtime floor; Node.js 24.11 is the stricter contributor and release
toolchain. The repository-health check enforces the exact public-package
contract so new packages cannot silently omit or weaken it. Browser and React
Native entry points retain their declared non-Node runtime targets; the Node
engine field describes supported Node consumers and package tooling, not a
requirement that browsers provide Node APIs.

TypeScript 7 is not yet the supported compiler because the current `ts-jest`
29.4 line explicitly accepts TypeScript versions below 7. TypeScript 6.0.3 is
therefore the sole intentional direct-major hold. The test-harness
standardization wave must remove or upgrade that peer constraint, run the
workspace-wide TypeScript 7 migration, and only then change this baseline;
forcing the compiler through an incompatible peer range is not permitted.

## Supply-chain controls

`pnpm-workspace.yaml` is the source of truth for installation controls:

- dependency build scripts are denied unless explicitly listed in `allowBuilds`;
- peer dependencies must be declared explicitly instead of being installed
  implicitly (including unused optional tooling peers);
- ordinary releases must age for 24 hours before installation;
- first-party `@bsv/*` packages are exempt so coordinated releases can complete;
- registry provenance downgrades are rejected for recent packages; and
- `pnpm audit --audit-level=high` blocks high and critical advisories in CI and
  release jobs.

Parallel test lanes install with lifecycle scripts disabled. The wallet lanes
then rebuild only the explicitly allowlisted `better-sqlite3` binding they need;
the full build lane remains the single place that runs the workspace's approved
installation scripts.

The version-consistency gate also rejects public package manifests that place
type declarations, test runners, test clients, linters, documentation
generators, or TypeScript build tools in `dependencies`. This prevents
development-only advisory trees from leaking into clean consumer installs.

The workspace carries one audited dependency override. Jest 30.4.2 still
constrains its reporting and coverage graph to minimatch releases that require
`brace-expansion` 1.x/2.x, while GHSA-mh99-v99m-4gvg is fixed only in
`brace-expansion` 5.0.8. The workspace therefore substitutes 5.0.8, verifies
that substitution across the full Jest suite, and tracks removal when Jest
adopts minimatch 10.2.5 or newer. Any future temporary override must likewise
name an owner, evidence, review date, and upstream removal condition in the
repository-health exception registry, and must verify the affected path.

The former AsyncAPI generator override was eliminated by replacing that
dependency with a deterministic
renderer built on the maintained `yaml` parser. This removes the legacy parser,
`brace-expansion`, and `jsonpath-plus` chains instead of masking them with
transitive substitutions.

## Advisory disposition

The verified 2026-07-25 frozen dependency graph has no known audit findings or
accepted advisory holds after applying the single tracked Jest compatibility
substitution. All other advisory paths were removed at their causes:

- the unused message-box `webpack-dev-server` dependency and its vulnerable
  `uuid` path were deleted;
- package builds use the maintained `esbuild` release directly instead of
  inheriting the older release pinned by `tsup`;
- the documentation site uses React Router 8 and a repository-owned static
  renderer instead of the incompatible React Router 6 SSG adapter; and
- lockfile normalization selects the patched Express/body-parser graph.

Do not hide a future advisory with a broad override or dismissal. Remove an
unused dependency, upgrade or replace the owning tool, and verify the frozen
consumer and development graphs first.

## Update and release flow

1. Refresh direct dependencies within their declared semver ranges.
2. Remove obsolete or unused packages before considering overrides.
3. Run the frozen install, version checks, audit, lint, build, tests,
   conformance, and documentation build.
4. Review Dependabot changes as grouped maintenance work. Do not merge a bot PR
   merely because its diff is generated: check runtime relevance, changelogs,
   peer compatibility, audit impact, and full CI.
5. Patch-bump every publishable workspace package whose source or published
   manifest changed.
6. Publish through the OIDC release workflow. Never publish from a workstation.
7. Merge the generated version-sync PR, then release any infra images whose
   first-party dependency ranges changed.

Breaking major upgrades are handled as focused migrations with an explicit
compatibility and rollback plan. They are not forced into the workspace through
transitive overrides.
