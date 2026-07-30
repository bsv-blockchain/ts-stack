---
id: ci-performance
title: 'CI Performance Governance'
kind: reference
version: '1.0.0'
last_updated: '2026-07-30'
last_verified: '2026-07-30'
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

The main CI workflow builds the workspace once and shares immutable outputs
with isolated test lanes, skips empty affected-package lanes, installs through
the setup-node pnpm cache, caches the immutable MongoDB test binary, and
rebuilds native/build tools only in jobs that execute them. Browser lanes
retain exact package-composition reports without rebuilding the workspace.
These optimizations reduce repeated CPU, network, and setup work without
removing coverage, mutation, platform, security, or package-consumer checks.

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
