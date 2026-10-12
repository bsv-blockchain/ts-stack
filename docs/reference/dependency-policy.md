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
images on one reviewed dependency baseline. Dependency release age is advisory
and never delays installation or blocks a merge. Vulnerability audits, provenance
checks, denied dependency lifecycle scripts, and compatibility checks remain required.

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
and requires the pull request's dependency-evidence section to record release
notes and necessity, runtime/build/peer compatibility, lockfile deduplication,
audit and CodeQL results, package and consumer tests, bundle/performance
impact, and affected public versions.

## Temporary Metro watcher repair

Metro-file-map 0.87.1 consumes only `micromatch.some()`, whose matcher is already
Picomatch 2.3.2. An exact-version paired source/distribution patch uses the same
matcher loop directly, declares that exact dependency, and removes only the
parent-scoped micromatch dependency and unused braces closure. The reviewed
[braces advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) lists no
patched release; the [upstream proposal](https://github.com/micromatch/braces/pull/72)
has not supplied a published repair. No audit exclusion or threshold change is added.

The mobile platform gate checks all 1,120 results independently reproduced from
the unmodified published watcher, event/stat/path contracts, and absence of the
removed dependencies before its existing packed Metro/Hermes compilation,
source-map and bundle checks. All prior assertions and bounds remain.
The dated registry owns this 27th selector, its package extension and patch as
one repair. Remove all three together when a compatible official release removes
the affected path and the complete compatibility, frozen-graph, audit and platform
checks pass. This development-tool repair changes no public package API, version
or production service startup.

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

The root workspace carries seven narrow audited dependency overrides:

- Jest 30.4.2 and Stryker still constrain parts of their reporting and coverage
  graphs to minimatch releases with older `brace-expansion` ranges.
  GHSA-rgw5-rvv9-x895 required 5.0.9. GHSA-6j4f-fj2g-mc7p requires 5.0.10 and
  GHSA-qhr7-859c-m2p7 requires 5.0.11, so the workspace substitutes 5.0.11
  until every supported path resolves it natively.
- `socket.io` in `@bsv/authsocket` still admits `engine.io` releases below
  6.6.10. GHSA-2gc4-cqfq-p2gv is a protocol-revision mismatch that can crash
  the Node process during a transport upgrade, so the workspace selects
  6.6.10, the first patched release, without changing the public Engine.IO API.
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
  24-hour advisory release-age reminder, supported peer ranges, coordinated runtime/tool
  migrations, the TypeScript compiler-API bridge, and forward vendor builds;
- reconciles all public source manifests, recorded published baselines, and npm
  `latest`, explicitly reporting source candidates held by an operator's
  publication decision;
- installs every exact published package in its own locked consumer context with
  lifecycle scripts disabled, allowing its declared peers to resolve normally,
  and runs npm registry signature/provenance verification in every context;
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

## October 6 advisory repair

The protected UMP release qualification detected newly disclosed critical
`proxy-addr` and high `source-map-js` advisories before publication. The root
lock selects the compatible patched releases `proxy-addr` 2.0.8 and
`source-map-js` 1.2.2; the six affected standalone infrastructure locks select
`proxy-addr` 2.0.8. Overlay Server already selected that release.

The upstream [proxy-addr advisory](https://github.com/advisories/GHSA-jqcg-44mw-7w3h)
and [source-map-js advisory](https://github.com/advisories/GHSA-68fv-2mgg-jv7q)
identify those patched versions. Their existing Node engine floors and
transitive dependency contracts remain compatible. The targeted lock refresh
introduces no new dependency
override or exception, and retains the blocking high-severity audit. Requalify
the frozen root, documentation and standalone service graphs before release.

The complete standalone audit also found the older Message Box multipart parser
and legacy UHRP/WAB development watcher paths. Message Box selects the compatible
`@fastify/busboy` 3.2.2 patch, covering the upstream
[boundary advisory](https://github.com/advisories/GHSA-xjh9-v7x6-24jw),
[header advisory](https://github.com/advisories/GHSA-x8mw-p69m-v3mx) and
[disposition advisory](https://github.com/advisories/GHSA-gxm5-99cw-xjw9).
UHRP Basic, UHRP Cloud Bucket and WAB replace their legacy Nodemon/ts-node-dev
watchers with `tsx watch`, retaining source/environment-file watch and telemetry
preload behavior. Production entry points remain unchanged. Removing that
unused watcher closure removes the unpatched `braces` advisory rather than
adding a suppression. The existing full high-severity audit, service suites and
Node 24 runtime contracts remain required.

## Update and release flow

1. Refresh direct dependencies within their declared semver ranges after
   compatibility and security review. Release age is advisory, never an install
   or merge blocker. The dependency inventory may flag a newly published release
   for attention; it cannot impose a hold.
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
