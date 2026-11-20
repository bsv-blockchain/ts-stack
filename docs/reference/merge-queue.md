---
id: merge-queue
title: 'Merge Queue Rollout'
kind: reference
version: '1.0.0'
last_updated: '2026-11-20'
last_verified: '2026-11-20'
review_cadence_days: 30
status: experimental
tags: [reference, ci, github-actions]
---

# Merge Queue Rollout

## Merge queue rollout: prerequisites only

The workflow triggers support `merge_group.checks_requested`. A queue run checks
out GitHub's synthetic commit and selects work from `merge_group.base_sha` to
`merge_group.head_sha`, including changes ahead of the current PR. The queue ref
already separates workflow concurrency groups. Local PR certificates cannot
qualify the combined tree. CodeQL and the standalone conformance runner execute
on that tree, and the pinned dependency-review action understands merge-group
base/head fields. Selected functional, artifact, platform and coverage lanes
retain their normal requirements.

**Do not enable the queue on `main` yet.** The internal result gate now requires
both Sonar zero-findings enforcement and dependency review on queue events.
Sonar is still PR-only, so its skipped queue job deliberately fails admission.
The standalone `scripts/sonar-queue-gate.mjs` controller is prepared but not yet
wired into CI: it requires a unique `merge-queue-<full SHA>` short-lived analysis,
checks the exact revision and stable analysis identity before and after collecting
complete issue/hotspot inventories, and rejects accepted or false-positive new
findings. Its unit tests do not establish live vendor support.
This change does not claim complete queue support. Enabling a queue without the
remaining Sonar integration would block merges. A generic CI scan must not
mistake a queue event for `main` and overwrite its analysis.

The November 20 inspection found `SONAR_CI_ENABLED=false` and these seven
required checks, bound to their existing apps:

| App             | Required checks                                                                   |
| --------------- | --------------------------------------------------------------------------------- |
| GitHub Actions  | `merge-gate`, `ts-runner`, `Analyze (actions)`, `Analyze (javascript-typescript)` |
| SonarQube Cloud | `SonarCloud Code Analysis`                                                        |
| Socket Security | `Socket Security: Project Report`, `Socket Security: Pull Request Alerts`         |

The isolated vendor probes
[#1639](https://github.com/bsv-blockchain/ts-stack/pull/1639) and
[#1640](https://github.com/bsv-blockchain/ts-stack/pull/1640) use independent text
files and the same starting commit on a disposable base branch. They test vendor
reporting only; they do not qualify the Actions workflows or change `main`.
Both Socket checks reported success on both synthetic commits:
`1bd8e42a07419f330c8502a7b3abfe9b93240ba6` and
`828c63d772438a6133a90d12a5a65278b4afc20f`. Sonar reported on both individual PR
heads but never on those queue commits. GitHub removed PR1639 at 17:55:47 UTC
with `checks_timed_out`. PR1640 was then dequeued during cleanup. Neither PR
merged or changed its head. The temporary ruleset and all three canary branches
were removed, and the unchanged main source and ruleset were verified. See
[the rollout handle](https://github.com/bsv-blockchain/ts-stack/discussions/1638).

The operator subsequently provisioned repository Actions secret `SONAR_TOKEN`.
Only its metadata was read. The Sonar credential has Execute analysis permission
for `bsv-blockchain_ts-stack` alone and expires on **December 20, 2026**. Replace
it through the secret store before expiry if CI analysis adopts it; never put its
value in logs, a PR, or a coordination message. Automatic Analysis remains on,
and organization-wide secretless analysis remains off. The current dormant
`sonar-project.properties` excludes authored sources that Automatic Analysis
covers, so enabling the existing CI flag alone is not a safe migration.

Credentialed isolated canaries
[#1652](https://github.com/bsv-blockchain/ts-stack/pull/1652) and
[#1653](https://github.com/bsv-blockchain/ts-stack/pull/1653) passed their exact-head
Sonar, Socket, and checkout checks, plus the repository zero-findings controller.
Their queued analysis is still pending a coordinated analysis-method window;
these PR results do not qualify a combined commit. The temporary probe uses
all repository sources and the Automatic Analysis configuration rather than the
narrower dormant CI exclusions. See [the active trial record](https://github.com/bsv-blockchain/ts-stack/discussions/1651).

Complete the rollout in this order:

1. Resolve [Sonar administration #402](https://github.com/bsv-blockchain/ts-stack/issues/402)
   for genuine queue analysis. Project administration and a scoped analysis
   credential are available. Coordinate the shared analysis-method transition;
   disable Automatic Analysis before enabling CI analysis. Establish fork-safe
   PR behavior and verify no duplicate scans. Do not print credentials.
2. Analyze each exact queue revision in an isolated Sonar branch. Enforce the
   complete new-issue and unreviewed-hotspot policy on that revision, with stable
   analysis attribution. Verify the required Sonar app check is actually emitted
   on the same SHA. PR-head results, dummy successful jobs, relaxed findings,
   and replacing an app-bound check with a namesake are not substitutes.
3. Qualify and merge the complete workflow implementation through the existing
   required checks and qualified maintainer review. Keep the seven required
   checks, app identities, review policy and thread resolution intact.
4. Save the live main ruleset and install a queue rule in the same update that
   removes strict branch freshness. Use `ALLGREEN`, two concurrent builds,
   merge method `MERGE`, minimum group size one and maximum two. Set a timeout
   that covers the observed required CI duration. The queue's combined-result
   validation replaces contributor branch updates; no required check is removed.
5. Enqueue two approved, harmless, independent PRs from the same base. Verify
   every required check on both synthetic SHAs, normal back-to-back merges
   without branch updates, and the resulting `main` checks. Do not use bypass.
   If a vendor check is missing, dequeue the canaries and restore the saved
   strict ruleset before handing back a working merge path.

See GitHub's [merge queue configuration guide](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue).
The release metadata work in PR1627 is independent; this rollout does not change
its branch or remove any security requirement to make it mergeable.
