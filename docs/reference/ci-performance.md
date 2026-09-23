---
id: ci-performance
title: 'CI Performance Governance'
kind: reference
version: '1.2.0'
last_updated: '2026-09-23'
last_verified: '2026-09-23'
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
compiler, workspace and shared CI execution controls select the complete graph deliberately.

Mutation selection follows each target's exact implementation, property,
regression, configuration, and policy inputs. Package-wide mutation suites
expand only where their configuration really covers the whole package. Image
jobs follow changed build contexts. Changes to the shared CI workflow validate
all infrastructure build lanes; unrelated documentation workflow changes do not.
Shared image/runtime contract inputs fan out to the registered consumers.

The main CI workflow builds the selected graph once and shares immutable
outputs with isolated test lanes, skips empty lanes, installs through the
setup-node pnpm cache, caches the immutable MongoDB test binary, and rebuilds
native/build tools only in jobs that execute them. Browser lanes retain exact
package-composition reports without rebuilding the workspace. The cheap
repository-health, scope, Sonar, and dependency-review gates complete before
dependency installation. Matrix siblings finish after a failure so acceptance
evidence includes every selected shard. Within a regression or coverage shard,
packages execute serially because individual test runners already use worker
pools; this prevents nested pools starving real-cryptography integration tests.
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

## Sampling and investigation

The collector searches up to ten pages of successful PR runs, deduplicates source
heads, and paginates each run's complete job list. It retains 20 full-scope and
20 targeted runs, including job and step timings. When history cannot supply the
required sample, it writes the partial report before failing; incomplete samples
cannot establish a new baseline. API requests and pagination are bounded.

The September review found that the July baseline predates the optical-codec
mutation target and later QA additions. In the recovered 40-run sample, full-scope
median/p95 was 2,007/2,254 seconds and targeted median/p95 was 566/833 seconds.
The optical-codec mutation job dominated full runs (median 1,378 seconds), while
wallet coverage dominated the longer targeted runs. Those observations do not by
themselves justify raising the budget. Keep the historical baseline until a
reviewed workload comparison and measurements justify a replacement.

The duplicate-tracking codec regression now bounds its fixture's search and
avoids constructing a successful Jest matcher for every redundant frame. It
still sends more than the actual tracking limit, checks every acceptance result,
repeats the final frame and verifies exact recovered bytes. Mutation and property
coverage, payload sizes, test counts and timeout budgets remain governed.

## Complete release acceptance

Dispatch `CI` manually on the reviewed main commit to select the entire governed
workspace, all infrastructure build lanes and mutation targets. This deliberately
uses the workflow's all-scope path instead of comparing only the latest commit.
Source merges still validate their affected scope automatically.

Every execution lane uses an explicit successful-preparation condition that
survives intentionally skipped PR-only gates on a main push and honors explicit
workflow cancellation so obsolete runs cannot hold the concurrency slot. The final result
gate independently checks scope outputs against each job result: selected jobs
must succeed; missing, cancelled or skipped selected jobs fail the merge gate.
Only genuinely unselected lanes and main's PR-only checks may be skipped.
Do not infer full release acceptance from a green documentation-only push.
