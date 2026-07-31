---
id: ci-performance
title: 'CI Performance Governance'
kind: reference
version: '1.1.0'
last_updated: '2026-07-31'
last_verified: '2026-07-31'
review_cadence_days: 30
status: stable
tags: [reference, ci, performance, github-actions]
---

# CI Performance Governance

The weekly `CI performance trend` workflow classifies successful pull-request
CI runs as full-scope (at least 50 executed, non-skipped jobs) or targeted,
retains the latest 20 of each class, and compares median and p95 end-to-end duration with
`governance/ci-performance-baseline.json`. A material regression fails the
workflow and requires timing evidence before its budget or baseline changes.

The uploaded JSON report retains run, job, and step duration; queue time;
prepare-job duration; artifact upload/download duration; and variance. This
separates targeted feedback from the complete merge gate so a changing PR mix
cannot make the trend appear faster or slower by accident.

The zero-install scope job resolves three distinct package sets from the
workspace dependency graph. Directly changed package importers own coverage
suites; their reverse-dependency closure owns non-instrumented regression,
compatibility, and browser checks; and the forward closure supplies every build
prerequisite. This preserves behavioral coverage of possible consumers without
paying to regenerate unchanged packages' coverage reports.
A lockfile-only change selects the importers whose lock snapshots actually
changed instead of treating the root lockfile as a global invalidation. Root
compiler and workspace controls still select the complete graph deliberately.

Mutation selection follows each target's exact implementation, property,
regression, configuration, and policy inputs. Package-wide mutation suites
expand only where their configuration really covers the whole package. Image
jobs follow changed build contexts: a CI-workflow-only change selects no
application image, while shared image/runtime contract inputs deliberately fan
out to the registered consumers.

The main CI workflow builds the selected graph once and shares immutable
outputs with isolated test lanes, skips empty lanes, installs through the
setup-node pnpm cache, caches the immutable MongoDB test binary, and rebuilds
native/build tools only in jobs that execute them. Browser lanes retain exact
package-composition reports without rebuilding the workspace. The cheap
repository-health, scope, Sonar, and dependency-review gates complete before
dependency installation, and all expensive matrices cancel unfinished siblings
after the first failure.
These controls reduce repeated CPU, network, and setup work without weakening
the tests selected by the dependency or registered trust-boundary graph.

To refresh the evidence without changing the baseline:

```bash
GITHUB_TOKEN=... node scripts/ci-performance.mjs \
  --collect \
  --baseline governance/ci-performance-baseline.json \
  --output ci-performance-report.json
```

Changing the committed baseline requires a reviewed PR:

```bash
GITHUB_TOKEN=... node scripts/ci-performance.mjs \
  --collect \
  --write-baseline governance/ci-performance-baseline.json
```

Review the 40 exact run links, classification threshold, sample summaries,
workflow or runner changes, and the stated median/p95 budget. Never loosen a
budget solely to make a red trend green.
