---
id: repository-health
title: 'Repository Health Controls'
kind: reference
version: '1.3.3'
last_updated: '2026-07-29'
last_verified: '2026-07-29'
review_cadence_days: 30
status: stable
tags: [reference, governance, quality, security, releases]
---

# Repository Health Controls

The repository health controls turn the TypeScript stack maintenance program
into a checked, machine-readable contract. The authoritative program tracker is
[GitHub issue #324](https://github.com/bsv-blockchain/ts-stack/issues/324).

## Sources of truth

`governance/repository-health/projects.json` inventories every pnpm workspace
project. Each entry declares:

- package path and manifest name;
- accountable owner and functional area;
- package profile and runtime targets;
- criticality tier; and
- release mechanism.

The profile definitions in the same file describe the scripts and package
metadata required for Node, browser, CLI, React Native, WASM, private,
documentation, and conformance projects. Profiles standardize the externally
observable contract without requiring every package to use the same build tool.
For every public package, the control also enforces the exact supported
Node.js 22 runtime floor, explicit public npm access, and an explicit
tree-shaking side-effect declaration.

`governance/documentation-policy.json` owns the public package README and
runtime-support documentation contract. `pnpm docs:facts` generates the exact
package/version/runtime/release and conformance facts, while
`pnpm docs:facts:check` rejects stale generated output, stale parity metadata,
package READMEs that do not identify, install, demonstrate, and license the
registry artifact, and missing, duplicated, version-drifted, or
pre-consolidation public package pages.

`governance/repository-health/baselines.json` records the dated starting
measurements for CI, conformance, lint, TypeScript, coverage, security,
SonarCloud, governance, and published package versions. Update a measurement
only from authoritative evidence and retain the evidence URL.

The lint record retains the original 846-warning baseline while ratcheting the
current authored-code result to zero across 1,909 files. The TypeScript record
tracks all 121 governed configurations and their effective strict options,
including seven self-contained deployable-service contexts. `pnpm lint` and
`pnpm typescript:check` are executable zero-debt gates; the historical counts
are evidence, not allowances.

`governance/repository-health/contract-baseline.json` contains the exact package
contract debt present when the control was introduced. The health check rejects
new findings and stale entries for findings that have been fixed. This makes
the baseline a ratchet: debt can fall, but it cannot grow silently.

The `generatedArtifacts` section of `projects.json` records each checked-in
generated boundary, its owning team, source inputs, generator, review policy,
and analysis treatment. Generated output can be excluded narrowly only when
this relationship is explicit. Product source and tests must not be
reclassified as generated to reduce quality findings.

`.github/codeql/codeql-config.yml` is the executable CodeQL boundary. Its
`paths-ignore` entries must exactly match the owned generated artifacts above.
The advanced workflow keeps authored JavaScript/TypeScript and GitHub Actions
analysis on pull requests, `main` pushes, and a weekly schedule with the
`security-extended` suite. The repository's Python files are deterministic
OpenAPI output under `conformance/generated/**`; their source specifications,
locked generator, and checked-in output are verified by codegen CI instead of
being misrepresented as authored Python in CodeQL. A repository-control test
rejects any loss of the authored languages, events, permissions, query
coverage, or required check names.
The advanced workflow is unconditional for each configured event. Do not gate
it on repository variables: those variables are unavailable to fork-origin
pull-request jobs, which would silently skip analysis of external contributions.
The repository-owned `Quality gate — zero new Sonar findings` job waits for
SonarCloud to report the exact pull-request head. It then requires both the
configured Sonar quality-gate verdict and zero new issue records in `OPEN`,
`CONFIRMED`, `ACCEPTED`, or `FALSE_POSITIVE` state, plus zero unreviewed
security hotspots. Including accepted and false-positive states prevents
reclassification from being used as a merge bypass. The existing required
`merge-gate` depends on this job.

In this repository, **quality gate passed** means that strict repository-owned
check passed on the current head SHA as part of the full required CI set.
SonarCloud's green aggregate `Quality Gate passed` verdict is an advisory input
to that decision, never sufficient merge evidence by itself.

`governance/repository-health/exceptions.json` is the only registry for temporary
exceptions. Its schema is in `exception.schema.json`. Every entry requires an
owner, rationale, evidence, creation date, review deadline, and objective
removal condition. Owners must resolve to the same owner registry used by the
workspace inventory. Expired entries fail CI. An empty registry is preferred,
but existing overrides, skipped tests, and analysis suppressions must be
recorded until they are removed.

Test-specific ownership is normalized in
`governance/test-quality/policy.json`. The blocking `pnpm test:governance`
contract inventories required skips, classifies every manual/live/resource
suite, rejects empty tests, ratchets all conformance skip groups, and requires
every property-fuzz suite to declare its package, trust boundary, concrete
invariants, minimum PR budget, and reproducible long-run campaign.
`governance/mutation-testing/policy.json` then pairs all 25 property suites with
focused implementation mutation targets, per-boundary score ratchets, zero
uncovered mutants, and zero invalid mutants.

## Commands

Run the blocking control and its unit tests:

```sh
pnpm health:check
pnpm docs:facts:check
pnpm test:governance
pnpm test:property
pnpm test:mutation --all
pnpm typecheck
```

Render the complete current report:

```sh
pnpm health:report
```

After a PR actually fixes or deliberately reclassifies package-contract
findings, refresh the ratchet in that same PR:

```sh
pnpm health:baseline
pnpm health:check
```

Never refresh the baseline merely to make unexplained new debt pass. A new
temporary hold belongs in the exception registry, not in an unreviewed baseline
rewrite.

### Package artifact checks

A publishable package's `pack:check` command validates the built package rather
than its source tree. The shared checker:

1. creates the exact pnpm release tarball with lifecycle scripts disabled;
2. rejects tests, compiler caches, lockfiles, and uncompiled TypeScript in the
   payload;
3. runs strict `publint` metadata and entry-point validation;
4. runs the `@arethetypeswrong/core` analyzer across every strict Node and
   bundler resolution mode; and
5. installs the tarball into a clean temporary consumer and exercises every
   declared runtime module format. The consumer installs exact tarballs for the
   package's transitive `workspace:` runtime dependency closure, so coordinated
   unpublished version bumps cannot pass by resolving older registry releases.

Build before checking an individual package:

```sh
pnpm --filter @bsv/amountinator build
pnpm --filter @bsv/amountinator pack:check
```

CI runs implemented `pack:check` commands for affected packages after the
shared workspace build. The release workflow repeats every implemented check
before resolving or publishing a release plan. Adding a script therefore adds
a blocking release contract; it must not be a placeholder or a source-only
check.

The workspace typecheck runs after the shared build so cross-package
declarations resolve exactly as downstream consumers see them. It catches
dual-package hazards where one consumer accidentally combines the ESM and
CommonJS `@bsv/sdk` runtime/type conditions: SDK classes with private fields
must retain one nominal identity throughout a consuming application.

## CI behavior

The `Repository health contract` job runs without installing dependencies. It
checks:

1. discovery matches the exact 37-project inventory;
2. names, owners, profiles, criticality, targets, privacy, and release methods
   are internally consistent;
3. generated artifact boundaries have valid owners, sources, generators, narrow
   review/analysis policies, and exact CodeQL exclusion coverage;
4. published package versions match the recorded baseline;
5. exception records are owned, structurally valid, and unexpired;
6. current package-contract findings exactly match the ratcheted snapshot; and
7. generated stack/conformance facts, all 30 public package README contracts,
   and one current consolidated package page per public package are current;
   and
8. the health implementation’s unit tests pass; and
9. the exact SonarCloud pull-request analysis has no new issue findings or
   unreviewed security hotspots, including findings reclassified as accepted
   or false-positive.

Affected package changes also select their matching mutation targets. The
parallel mutation lane restores the shared workspace build, executes only the
focused property and regression tests for each selected implementation
boundary, retains its JSON report, and feeds the required merge gate. SDK,
toolchain, CI, and governance changes deliberately fan out to the full target
registry. A separate scheduled workflow validates all targets weekly.

The job writes a rule-by-rule and project-by-project report to the GitHub Actions
step summary and feeds the required `merge-gate`. Known findings stay visible
until their remediation PR removes them from both the code and baseline.

## Completion discipline

A program checkbox is complete only after the corresponding code is merged and
the relevant test run, alert state, published artifact, or measurement proves
the stated end condition. Intent, a local-only change, or a refreshed baseline
is not completion evidence.
