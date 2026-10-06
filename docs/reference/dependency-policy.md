---
id: dependency-release-policy
title: 'Dependency and Release Policy'
kind: reference
version: '1.3.4'
last_updated: '2026-10-06'
last_verified: '2026-10-06'
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

Standalone infrastructure uses npm `package-lock.json` files outside the pnpm
workspace. Its Dependabot entry excludes only the unrelated ancestor
`pnpm-lock.yaml` and `pnpm-workspace.yaml` support files, avoiding the updater's
sub-workspace misclassification; the root entry continues to own both files.
Use recursive filename globs (`**/pnpm-lock.yaml` and
`**/pnpm-workspace.yaml`): GitHub rejects `..` in exclusion patterns and disables
all configured update jobs when the configuration is invalid. The early
dependency policy check rejects that failure before merge. Every infrastructure
manifest and npm lockfile remains monitored. Remove this
workaround when Dependabot respects standalone npm boundaries beneath a pnpm root.

The Python code generator accepts uv >=0.11.32 so Dependabot can resolve its
locked dependency graph with the uv version supplied by GitHub. The codegen
workflow retains an explicit uv 0.11.32 pin, Python 3.12, `uv run --locked`, and
byte-for-byte generated-output verification. A resolver proposal does not
silently change the CI toolchain or authorize different generated types.

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
and reports advisory evidence for release notes and necessity, runtime/build/peer
compatibility, lockfile deduplication, audit and CodeQL results, package and
consumer tests, bundle/performance impact, and affected public versions. Missing
fields produce a warning; they do not waive any security or merge gate.

The docs-site Mermaid graph selects DOMPurify 3.4.16 instead of 3.4.13 for
[GHSA-p98j-92pf-mc4p](https://github.com/advisories/GHSA-p98j-92pf-mc4p).
The reviewed [3.4.16 release](https://github.com/cure53/DOMPurify/releases/tag/3.4.16)
fits Mermaid 11.16.1's existing `^3.3.3` range and exceeds the seven-day release
age. pnpm regenerates only that package resolution, integrity and existing graph
reference; all importers, manifests and unrelated resolutions remain unchanged.
The governed bundle inventory records the same version, with its license
expression and license-file hash unchanged. This private documentation dependency does not change wallet runtime packages,
public APIs or candidate versions. Frozen installation, root checks, docs tests
and a built-site browser check qualify the ordinary Mermaid consumer. No service
or package is deployed by this source change.

The October 3 independent qualification on the application-runtime branch passed the frozen
installation and high-severity audit with no known vulnerabilities, all seven docs
unit tests, 140 source-page frontmatter/link checks and 145 built-page link checks.
Actual Chrome renders all 14 Mermaid diagrams across the wallet lifecycle and LCH
production guides without page errors. The existing license inventory and root
health checks pass; no public runtime package or version changes with this update.

## October 6 compatible audit remediation

The October 5 advisory database update identified the existing locked
`proxy-addr` 2.0.7 and `source-map-js` 1.2.1 resolutions. The workspace now
selects the upstream patched
[proxy-addr 2.0.8](https://github.com/advisories/GHSA-jqcg-44mw-7w3h) and
[source-map-js 1.2.2](https://github.com/advisories/GHSA-68fv-2mgg-jv7q)
within their parents' existing ranges. The six affected standalone server
locks also select proxy-addr 2.0.8; the Overlay lock already selected it.
Package manifests, public APIs, peers, overrides and unrelated resolutions
remain unchanged. Both patches retain their existing Node runtime floors and
dependency graph; source-map-js still has no runtime dependencies.

The proxy-addr patch was published September 15. The source-map-js patch was
published September 30 and was about 131 hours old at review: older than the
governed 24-hour floor, younger than the automatic seven-day delay for
ordinary updates. Its targeted security resolution used
`pnpm --config.minimumReleaseAge=1440 --recursive update --depth Infinity
--lockfile-only --ignore-scripts --no-save source-map-js`. This is an explicit
security selection, with the ordinary workspace default, provenance policy
and lifecycle denial preserved. No permanent age exclusion, override or
advisory dismissal was added. pnpm generated the workspace lock, and
`npm update proxy-addr --package-lock-only --ignore-scripts --audit=false
--fund=false --workspaces=false` generated each affected standalone lock.

The coherent batch must pass frozen installs, security audits, complete root
checks, affected consumers and the exact-head hosted gate before review.
Lockfile remediation does not publish a package or deploy a service. Protected
publication and normal source-owned availability, provenance and rollback
checks remain separate requirements for any later service rollout.

## Temporary Metro watcher dependency repair

Metro-file-map 0.87.1 uses only micromatch.some(), whose matcher is already
Picomatch 2.3.2. The exact-version paired source/distribution patch calls that
same loop directly, declares the same exact Picomatch dependency and removes
only the scoped micromatch dependency and its now-unused braces closure.
The reviewed [braces advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
lists no patched release; the [upstream proposal](https://github.com/micromatch/braces/pull/72)
is still unreleased. No advisory exclusion or audit threshold change is added.

The existing mobile platform gate checks 1,120 watcher results frozen from the
unmodified published implementation, event/stat/path contracts, and absence of
the removed matcher packages before its packed Metro/Hermes compilation,
source-map/composition and unchanged bundle budgets. The dated override registry
owns the patch, exact package extension and scoped removal as one repair. Remove
all three together when an official compatible release removes the affected
path and the full compatibility, frozen graph, audit and platform checks pass.
This build-tool repair does not change published wallet APIs or package versions.

## Temporary standalone service watcher repair

The basic and cloud UHRP services and WAB use Nodemon 3.1.14 with a parent-scoped
Chokidar 4.0.3 substitution, removing the same affected braces closure without
an advisory exclusion. Nodemon already resolves watched globs to literal
directories; the source-owned adapter retains the old anymatch 3 ignore
semantics, including recursive literal directories, custom cwd, dotfiles,
regex and function options. WAB replaces ts-node-dev with this same CLI.
The existing Node/ts-node/telemetry execution paths remain intact, with explicit
TypeScript and env extensions, manual `rs` and graceful shutdown regressions
run before each service's ordinary tests. The service-copy policy keeps both
adapter and native regression identical across all three service contexts.

The three new registered substitutions bring the combined retained count to 30. Remove them and the adapter together after a compatible official Nodemon
release resolves the dependency path natively and all watcher, frozen audit,
service and protected Linux image gates pass. These standalone development
tools change no public npm candidate version, service HTTP API, production
startup or persisted schema; deployed images require separate promotion.

## Supply-chain controls

`pnpm-workspace.yaml` is the source of truth for installation controls:

- dependency build scripts are denied unless explicitly listed in `allowBuilds`;
- peer dependencies must be declared explicitly instead of being installed
  implicitly (including unused optional tooling peers);
- ordinary releases wait seven days before automatic installation; the governed
  inventory floor remains 24 hours, including explicitly reviewed security updates;
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

The September 30 audit refresh also selects compatible transitive releases within
existing ranges: `engine.io` 6.6.10 in the workspace and Message Box server;
`ip-address` 10.7.1 in Message Box, both UHRP servers and WAB; `fast-uri` 3.1.8 in
Message Box; and `undici` 6.28.1 in WAB. The workspace additionally selects
`ip-address` 10.7.2, whose reviewed change since 10.7.1 only accepts the ARPA
suffix case-insensitively and without the root dot. Wallet rate-limit and CHIRP
consumer tests pass with that resolution. These generated lock changes add no
manifest ranges or overrides. All selected versions exceed the seven-day release
age. Upstream releases preserve their module and Node contracts; service suites,
AuthSocket coverage and frozen-install audits qualify the affected consumers.
The relevant upstream releases are [Engine.IO](https://github.com/socketio/socket.io/releases/tag/engine.io%406.6.10),
[ip-address](https://github.com/beaugunderson/ip-address/compare/v10.3.1...v10.7.2),
[fast-uri](https://github.com/fastify/fast-uri/releases/tag/v3.1.8) and
[Undici](https://github.com/nodejs/undici/releases/tag/v6.28.1).
Source reconciliation does not release packages or deploy service images.

The follow-up Axios audit correction selects `axios` 1.20.0 in the five existing
Message Box, UHRP basic, UHRP cloud, notifier and WAB locks. Only Axios resolution
and dependency metadata change; manifests, declared ranges, lock formats and all
other resolved versions are preserved. The already-selected `form-data` 4.0.6
satisfies the raised dependency floor. Review of the
[1.19.0](https://github.com/axios/axios/releases/tag/v1.19.0) and
[1.20.0](https://github.com/axios/axios/releases/tag/v1.20.0) releases includes
configuration hardening, proxy behavior, cancellation and declaration changes.
The services use ordinary own-property request options; their frozen installs,
high/critical audits, builds where applicable and deterministic suites pass on
Node 24. Public workspace manifests and browser/mobile dependency graphs are
unchanged. Infrastructure locks are container/function build inputs, so this
correction needs no public npm version change or consumer migration. Hosted
Linux image and exact-head analysis gates remain required before promotion;
these local results do not establish deployed behavior.

The subsequent gRPC correction selects `@grpc/grpc-js` 1.14.5 in all seven
standalone service locks, addressing two advisories found by the September 30 audit:
[GHSA-m9gg-hp2v-232j](https://github.com/advisories/GHSA-m9gg-hp2v-232j) and
[GHSA-f596-whhp-79r4](https://github.com/advisories/GHSA-f596-whhp-79r4).
The reviewed [1.14.5 release](https://github.com/grpc/grpc-node/releases/tag/%40grpc/grpc-js%401.14.5)
preserves the Node engine and dependency ranges; its fixes also cover stale call
retention, status fields and completed HTTP/2 streams. Chaintracks Server and
Wallet Infra additionally adopt the already-reviewed `ip-address` 10.7.2 within
their existing ranges. Package-manager regeneration changes only these nine
resolved nodes; manifests, lock formats, all other dependencies, the workspace
lock and the earlier Axios correction are unchanged.

All seven frozen installs, allowlisted native rebuilds, builds and lints pass
on Node 24, with 658 service tests and seven zero-finding audits. Wallet Infra
has no standalone test script; its build/lint and the shared dependency checks
are reported separately. Each installed gRPC copy passes an ordinary loopback
unary call and client cancellation; both changed IP consumers pass IPv4/IPv6
parsing and invalid-syntax checks. The gRPC registry's unpacked size grows by
49,814 bytes; no public workspace/browser/mobile graph changes. These are
compatibility checks, not a throughput or memory benchmark. No public npm
version or consumer migration changes; protected Linux image and exact-head
analysis gates still qualify the eventual service artifacts before promotion.

The Overlay Express authenticated root-response test fixture declares
`express-rate-limit` 8.6.1 as a development dependency, reusing the existing
workspace resolution. Its limiter runs before JSON parsing and authentication,
and teardown shuts down its per-fixture memory store. The reviewed
[8.6.1 changelog](https://github.com/express-rate-limit/express-rate-limit/blob/v8.6.1/docs/reference/changelog.mdx)
retains the middleware API used here; Node and Express peer requirements fit the
existing toolchain. Only that importer reference is added to the generated lock.
No package resolution, production route, runtime dependency or wallet graph changes.

The combined workspace and standalone registries carry 30 audited dependency overrides, including:

- Jest 30.4.2 still constrains parts of its reporting and coverage graph to
  minimatch releases with older `brace-expansion` ranges. The follow-up
  advisories GHSA-qhr7-859c-m2p7, GHSA-6j4f-fj2g-mc7p and
  GHSA-q2hr-2g5m-vwhr require `brace-expansion` 5.0.12, so the workspace
  and existing standalone substitutions select 5.0.12 until every supported
  path resolves it natively. The release preserves the existing module exports,
  types and Node engine range.
- `socket.io` in `@bsv/authsocket` still admits `engine.io` releases below
  6.6.10. The workspace now retains upstream's explicit first-patched-release
  substitution, matching this branch's already-selected 6.6.10 resolution.
  Its existing public API and tested consumer behavior remain unchanged.
- Express/body-parser, Superagent, and Stryker's `typed-rest-client@2.3.1` can
  retain vulnerable `qs` releases. A version-bounded substitution selects
  6.16.0, the first release that also fixes the bracket/comma array-limit bypass
  and attacker-controlled `isBuffer` denial-of-service advisories. This
  replaces fragile lock-only selections that an unrelated graph refresh could
  silently undo.
- Vite's PostCSS graph can select `nanoid` releases below the current patched
  3.x boundary, so the workspace selects 3.3.18 until that graph resolves it
  natively.
- `remark-mdx-frontmatter@5.2.0` still requires vulnerable `toml` 3.x while
  consuming only its compatible `parse()` API. The workspace selects TOML
  4.2.0, which fixes both current high-severity parser advisories, until the
  docs plugin adopts the patched line directly.
- Jest's Istanbul reporting chain and the standalone WAB server can still
  select `js-yaml` 3.15.1. The workspace and WAB lock select the compatible
  3.15.2 security release until those parent ranges advance naturally.

These substitutions are verified through their affected Jest, mutation,
documentation, and build paths and have owners, evidence, review dates, and
upstream removal conditions in the repository-health exception registry.
Standalone service locks also need
temporary `gaxios` substitutions, and Message Box plus UHRP cloud storage need
`uuid`; the Wave 37 review removed every substitution from a service where the
frozen graph stayed clean without it. The machine-readable registry now maps
every remaining selector and exact value to its exception. CI rejects a new,
changed, stale, unowned, or upstream-unlinked override. Elapsed review dates
produce maintenance reminders in source CI and fail the separate weekly
maintenance audit (`node scripts/repository-health.mjs --maintenance`).

The 2026-10-01 review rechecked all 25 selectors against the frozen graph.
Jest, Stryker, and socket.io still admit the vulnerable `brace-expansion` and
`engine.io` ranges, so those two substitutions stay. The earlier findings still
hold for the rest: the supported graphs select exact `gaxios@7.1.3`, admit
`uuid@9`, and pin `qs@6.15.1` without their registered substitutions, while the
current frontmatter plugin still requests TOML 3.x. New upstream majors can
remove some legacy paths only through a coordinated Stryker or Google Cloud
migration. Metro 0.87.1 replaced its `image-size` dependency with an in-tree
parser, so the former Metro-scoped substitution was retired; the mobile
platform contract verifies that boundary. The method, result, count, and next
rehearsal are enforced in
`governance/dependency-release-policy.json`.

The independently locked OpenAPI generator also carries a narrow Redocly
compatibility override. It is isolated from runtime packages, registered with
the same owner/review/removal fields, and must regenerate identical checked-in
output. These exceptions are not permanent policy: their review dates
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
- reconciles all public source manifests, recorded published baselines, and npm
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
no known vulnerable dependency issues after the registered compatibility substitutions. All
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
