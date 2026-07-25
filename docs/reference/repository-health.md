---
id: repository-health
title: "Repository Health Controls"
kind: reference
version: "1.0.0"
last_updated: "2026-07-25"
last_verified: "2026-07-25"
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

`governance/repository-health/baselines.json` records the dated starting
measurements for CI, conformance, lint, TypeScript, coverage, security,
SonarCloud, governance, and published package versions. Update a measurement
only from authoritative evidence and retain the evidence URL.

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
The advanced workflow keeps JavaScript/TypeScript, Python, and GitHub Actions
analysis on pull requests, `main` pushes, and a weekly schedule with the
`security-extended` suite. A repository-control test rejects any loss of those
languages, events, permissions, query coverage, or required check names.
`CODEQL_ADVANCED_ENABLED` is the repository-level cutover gate: keep it `true`
after advanced setup is activated. It exists only to prevent default and
advanced analysis from uploading concurrently during the migration PR.

`governance/repository-health/exceptions.json` is the only registry for temporary
exceptions. Its schema is in `exception.schema.json`. Every entry requires an
owner, rationale, evidence, creation date, review deadline, and objective
removal condition. Owners must resolve to the same owner registry used by the
workspace inventory. Expired entries fail CI. An empty registry is preferred,
but existing overrides, skipped tests, and analysis suppressions must be
recorded until they are removed.

## Commands

Run the blocking control and its unit tests:

```sh
pnpm health:check
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
7. the health implementation’s unit tests pass.

The job writes a rule-by-rule and project-by-project report to the GitHub Actions
step summary and feeds the required `merge-gate`. Known findings stay visible
until their remediation PR removes them from both the code and baseline.

## Completion discipline

A program checkbox is complete only after the corresponding code is merged and
the relevant test run, alert state, published artifact, or measurement proves
the stated end condition. Intent, a local-only change, or a refreshed baseline
is not completion evidence.
