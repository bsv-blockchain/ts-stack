---
id: dependency-release-policy
title: 'Dependency and Release Policy'
kind: reference
version: '1.3.0'
last_updated: '2026-08-04'
last_verified: '2026-08-04'
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
- TypeScript 7.0.2 native compiler, with the official TypeScript 6 compatibility API for API-dependent tools
- Oxlint for TypeScript linting

CI, conformance, documentation, and release workflows run on Node.js 24.
Root and package lint are warning-free and use blocking warning denial. A new
warning is a regression, not baseline debt to be accepted or ratcheted later.
The root `.oxlintrc.json` supplies the common correctness policy and
environment-specific overrides; package lint scripts select owned source
paths and inherit that policy. Node built-ins must use the explicit `node:`
protocol. Orphaned ESLint configuration is removed rather than allowed to
suggest a second, unenforced policy.

Every published package declares `engines.node: ">=22"`. Node.js 22 is the
consumer runtime floor; Node.js 24.11 is the stricter contributor and release
toolchain. The repository-health check enforces the exact public-package
contract so new packages cannot silently omit or weaken it. Browser and React
Native entry points retain their declared non-Node runtime targets; the Node
engine field describes supported Node consumers and package tooling, not a
requirement that browsers provide Node APIs.

TypeScript 7.0.2 is the authoritative compiler for every direct `tsc` build and
workspace typecheck. TypeScript 7.0 deliberately ships without a stable
JavaScript compiler API, so the repository follows the TypeScript team's
supported side-by-side migration: `@typescript/native` provides `tsc`, while
the `typescript` dependency aliases `@typescript/typescript6` for `ts-jest`,
`ts-node`, `tsdown`, and other API consumers. The peer range remains valid
without an override, and native TypeScript 7—not the test transformer—owns the
type-correctness gate. The exact contract, removal condition, and verification
commands are documented in
[TypeScript Compiler and Tooling Boundary](./typescript-toolchain.md).

## Automation boundaries

Dependabot proposes one coordinated multi-ecosystem maintenance PR each month.
Patch and minor updates remain automated across the root workspace, standalone
infrastructure lockfiles, deployment images, code generators, and GitHub
Actions. The single open version-maintenance slot does not apply to security
updates, so an old monthly PR cannot block immediate advisory remediation.
Security updates are grouped only within a package-manager ecosystem and are
never delayed into the monthly cross-ecosystem version update. First-party
`@bsv/*` versions remain owned by the release graph.

Major changes that alter a runtime, compiler, or persisted-data contract are
held from the routine monthly PR until their focused migration is ready:

- Future TypeScript compiler majors are held in both root and standalone
  infrastructure npm scopes; TypeScript 7 patch and minor maintenance remains
  eligible for the monthly update.
- Node majors are held in the governed container-base manifest so CI, release,
  and every runtime image move together.
- MySQL and MongoDB majors are held until backup/restore, supported upgrade
  paths, application compatibility, live validation, and rollback have been
  exercised.

These holds delay only semver-major updates; compatible maintenance releases
continue to flow. Removing a hold requires updating its supported-version
documentation and completing the relevant migration evidence in the program
tracker. GitHub Actions are pinned to immutable commit SHAs with accurate
release-version comments; a generated action bump is still reviewed for
permissions, runtime changes, and behavior before merge.

Dependabot is a proposal mechanism, not a reviewer or release manager. A
maintainer must establish why each change is needed, inspect changelogs and
runtime/deployment effects, remove obsolete dependencies, and require the same
tests, security analysis, and package checks as human-authored work. Bot noise,
conflicting single-package bumps, and first-party version PRs are consolidated
or closed rather than merged piecemeal. CI recognizes dependency-shaped diffs
and requires the pull request's dependency-evidence section to record release
notes and necessity, runtime/build/peer compatibility, lockfile deduplication,
audit and CodeQL results, package and consumer tests, bundle/performance
impact, and affected public versions.

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

The version-consistency gate rejects public package manifests that place test
runners, test clients, linters, documentation generators, or TypeScript build
tools in `dependencies`. Type packages remain development-only unless the
governed project inventory names one as a declaration dependency because the
published `.d.ts` surface imports that external module. A governed declaration
dependency must be shipped in `dependencies`, its corresponding runtime module
must be a dependency or peer, and clean packed consumers must typecheck it.
This keeps build-only advisory trees out of consumer installs without shipping
unresolvable public declarations.

The root workspace carries two narrow audited dependency overrides:

- Jest 30.4.2 still constrains parts of its reporting and coverage graph to
  minimatch releases with older `brace-expansion` ranges. The follow-up
  GHSA-rgw5-rvv9-x895 requires `brace-expansion` 5.0.9, so the workspace
  substitutes 5.0.9 until every supported path resolves it natively.
- Stryker 9.6.1's current `typed-rest-client@2.3.1` dependency pins vulnerable
  `qs@6.15.1` exactly. A parent-scoped substitution selects 6.15.3 until
  upstream accepts 6.15.2 or newer. This replaces a fragile lock-only
  substitution that an unrelated graph refresh could silently undo.

Both substitutions are verified through the affected Jest/mutation paths and
have owners, evidence, review dates, and upstream removal conditions in the
repository-health exception registry. Standalone service locks also need
temporary `gaxios` substitutions, and Message Box plus UHRP cloud storage need
`uuid`; the Wave 37 review removed every substitution from a service where the
frozen graph stayed clean without it. The machine-readable registry now maps
every remaining selector and exact value to its exception. CI rejects a new,
changed, stale, expired, unowned, or upstream-unlinked override.

Wave 39 repeated the removal rehearsal by regenerating every standalone lock
without its `gaxios`, `uuid`, and `brace-expansion` substitutions and checking
the natural dependency graph. It also rechecked the root Jest/minimatch,
typed-rest-client/qs, and isolated Redocly closures, then refreshed affected
locks for the current `brace-expansion`, `fast-uri`, `ip-address`, and
`socket.io-parser` advisories. All 19 remaining selectors still prevent a
reproduced vulnerable resolution or preserve the governed reproducible
generator, so none can be removed safely yet. The method, result, count, and next rehearsal are enforced in
`governance/dependency-release-policy.json`.

The independently locked OpenAPI generator also carries a narrow Redocly
compatibility override. It is isolated from runtime packages, registered with
the same owner/review/removal fields, and must regenerate identical checked-in
output. These three exceptions are not permanent policy: their review dates
are removal deadlines unless fresh evidence justifies an explicit extension.

The former AsyncAPI generator override was eliminated by replacing that
dependency with a deterministic
renderer built on the maintained `yaml` parser. This removes the legacy parser,
`brace-expansion`, and `jsonpath-plus` chains instead of masking them with
transitive substitutions.

## Persistent reconciliation

`governance/dependency-release-policy.json` is the machine-readable authority
for cadence, evidence, release ownership, temporary substitutions, and
scheduled verification. On the first day of every month and after successful
npm or infrastructure release workflows, the read-only verification workflow:

- generates a direct-versus-latest inventory and separates compatible updates
  from major migration projects, versions younger than the repository's
  24-hour release-age floor, supported peer ranges, coordinated runtime/tool
  migrations, the TypeScript compiler-API bridge, and forward vendor builds;
- reconciles all 30 source manifests, recorded published baselines, and npm
  `latest`, explicitly reporting source candidates held by an operator's
  publication decision;
- installs every published package with lifecycle scripts disabled and runs
  npm registry signature/provenance verification;
- pulls every checked-in deployment image by its immutable digest; and
- verifies generated package, support, conformance, coverage-reporting, and
  version facts.

The resulting JSON and frozen install evidence is retained for 90 days. A
registry version ahead of or divergent from source ownership, a missing
integrity/provenance record, an unavailable immutable image, or documentation
drift fails the workflow. A source candidate ahead of the recorded npm
baseline is not silently presented as published; it remains visibly
`first-party-release-held` until an operator authorizes the release.

## Advisory disposition

The verified 2026-07-27 frozen root and infrastructure dependency graphs have
no known audit findings after the registered compatibility substitutions. All
other advisory paths were removed at their causes:

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

1. Refresh mature direct dependencies within their declared semver ranges.
   Never bypass the 24-hour release-age floor merely to make the inventory
   report `current`.
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
8. Run or inspect the dependency/release verification workflow and retain its
   package versions, integrity/provenance records, image digests, and
   direct/latest inventory with the release evidence.

The generated sync PR may refresh infrastructure lockfiles with
`npm install --package-lock-only --ignore-scripts`. That command names no
package, executes no lifecycle script, and only produces a reviewed committed
lock for later `npm ci` and audit use. OpenSSF Scorecard alerts #200 and #221
are the same governed false positive after workflow line movement; retain the
check and the exception evidence rather than deleting the deterministic lock
refresh.

Breaking major upgrades are handled as focused migrations with an explicit
compatibility and rollback plan. They are not forced into the workspace through
transitive overrides.

See [Release and Operations Guide](./release-operations.md) for the complete
preflight, publication, reconciliation, image, failure, and rollback path.
