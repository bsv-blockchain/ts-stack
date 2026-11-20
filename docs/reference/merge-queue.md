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

## Combined-result qualification

A merge queue builds each proposed combined commit before merging it. The CI,
CodeQL and conformance workflows receive `merge_group.checks_requested` and
check out that synthetic commit. CI selects work from `merge_group.base_sha` to
`merge_group.head_sha`, including preceding queued changes. PR certificates do
not qualify the combined tree. Selected functional, artifact, platform, coverage,
dependency and security gates retain their normal requirements.

The queue must preserve these seven required checks and their app identities:

| App (ID)                 | Required checks                                                                   |
| ------------------------ | --------------------------------------------------------------------------------- |
| GitHub Actions (15368)   | `merge-gate`, `ts-runner`, `Analyze (actions)`, `Analyze (javascript-typescript)` |
| SonarQube Cloud (12526)  | `SonarCloud Code Analysis`                                                        |
| Socket Security (156372) | `Socket Security: Project Report`, `Socket Security: Pull Request Alerts`         |

Qualified maintainer approval and resolved review threads remain required.
Queue validation replaces strict contributor-branch freshness; it does not
replace review or any security check. The release metadata work in PR1627 is
independent of this rollout.

## Sonar analysis of the exact queue commit

Keep Automatic Analysis **on** and `SONAR_CI_ENABLED=false`. Automatic Analysis
reports on ordinary PRs but did not report on the isolated queue commits. A
trusted `workflow_run` controller therefore creates a temporary draft PR with
its head pointing to the exact combined queue SHA. This invokes the existing
Sonar integration without modifying source or manufacturing a check result.

The controller explicitly checks out this repository using the default
`workflow_run` checkout, then verifies HEAD equals `github.sha`, the protected
default-branch commit for that event. Its job has Actions read, contents write and PR write
permissions. It never executes queue code, downloads queue artifacts, merges a
PR, writes a check result or uses `SONAR_TOKEN`. This additional branch/PR write
access and the temporary-PR operational behavior were explicitly approved by
the operator on November 20, 2026.

Before creating a draft, the controller validates the canonical CI run, event,
repository, attempt, queue ref, exact revision and current base ancestry. Each
event supplies only its action, run ID, attempt, revision and ref through explicit
environment fields; the controller does not read or forward event-file contents.
The canonical GitHub run must independently match these advertised fields. Each
run attempt owns a distinct `codex/merge-queue-analysis/` branch. A bot ID, head,
base and body marker identify its PR. Existing changed or unowned objects cause
failure rather than being overwritten. The production command only accepts
`main`; exported helpers allow an explicit disposable base for qualification.

Queue CI has read-only permissions for analysis admission. It waits up to ten
minutes for that draft's exact-revision Sonar analysis and the genuine successful
app-owned check, then runs the existing strict zero-findings PR policy. Accepted
or false-positive new findings and unreviewed hotspots still block. The PR569
exception never applies. Analysis identity, PR ownership and queue ancestry are
checked again after inventory collection. Missing, malformed, stale, failed,
cancelled or incomplete results cannot pass. CI retains the analysis identity,
check ID, revision and inventory result in its Sonar evidence artifact.

When CI completes, the trusted controller closes its owned draft and deletes
only the unchanged owned branch, with read-back verification. It refuses to
close a draft that someone promoted for review or delete a changed ref. If a
controller fails between branch and PR creation, an operator must inspect that
run's branch and exact SHA before removing the orphan; a missing owned PR does
not authorize automatic deletion. Reruns use a new attempt identity. Cleanup
failures appear in the controller run and need operator attention.

GitHub may show approval-required Actions runs for bot-created draft PRs.
**Do not approve those auxiliary workflows or merge/edit the analysis drafts.**
The real queue workflows already validate the combined commit. Defensive names
ensure an accidentally approved auxiliary run cannot publish any of the four
required Actions contexts. Normal contributor PRs retain their existing checks.
The controller never approves a workflow or review.

The auxiliary Sonar scan runs alongside combined-result CI. The measured bot
trial took approximately 56 seconds for Sonar; larger changes and service load
can take longer. Total queue latency is governed by the slowest required check,
plus controller startup and inventory verification. Contributors do not update
or rebase their branches merely because an earlier independent PR merged.

## Qualification evidence and current rollout status

**Implementation and full rollout qualification remain pending. Do not enable
main solely from these vendor probes.** The baseline main ruleset is 19713320,
with strict freshness and no merge-queue rule as of this record.

The first isolated probes [1639](https://github.com/bsv-blockchain/ts-stack/pull/1639)
and [1640](https://github.com/bsv-blockchain/ts-stack/pull/1640) produced both
Socket checks on their synthetic SHAs but no Sonar check; the queue timed out.
Their resources were removed. PR-only probes 1652/1653 were closed unmerged and
removed without entering the queue.

The subsequent credentialed native scan
[44818122541](https://github.com/bsv-blockchain/ts-stack/actions/runs/44818122541)
failed at queue SHA `1a46dc928a5a6ef179fa2fa0aa779ffb25077a39`: the Node heap
limit was reached and SonarJS 14.6 emitted invalid UTF-8 Protobuf errors. A second
scan was cancelled. SonarSource has
[confirmed that this defect can omit taint-analysis results](https://community.sonarsource.com/t/sonarjs-14-3-invalid-utf-8-protobuf-errors-pr-analysis-times-out-before-upload/190532/3).
Increasing memory alone would not establish complete security analysis.
Automatic Analysis was restored on November 20 at 21:22:40 UTC; the incomplete
Sonar branches were removed. No native queue pass is claimed.

The exact-SHA draft [1658](https://github.com/bsv-blockchain/ts-stack/pull/1658)
then passed genuine Sonar and the repository zero-findings gate at
`ef44be4789010d62d797eb6bdd918a5ee1101b3a`. A fixed disposable workflow
[44821173160](https://github.com/bsv-blockchain/ts-stack/actions/runs/44821173160)
used `GITHUB_TOKEN` to create draft
[1659](https://github.com/bsv-blockchain/ts-stack/pull/1659) at
`1a46dc928a5a6ef179fa2fa0aa779ffb25077a39`. Its genuine Sonar check and strict
zero-findings gate also passed. The resulting auxiliary Actions run required
approval and executed zero jobs. These prove vendor behavior, not complete
production workflow or main queue qualification. The failed native runs remain
visible and are not reclassified by later Sonar results on the same SHAs.
All four R2/R3 trial PRs were subsequently closed unmerged; their six exact
refs and isolated ruleset 27762462 were deleted and read-back verified.

The operator's project-scoped Execute analysis credential is stored as repository
secret `SONAR_TOKEN` and expires **December 20, 2026**. The auxiliary approach does
not use it. Do not enable dormant CI analysis or disable Automatic Analysis as
part of this rollout. If native analysis is adopted later, first verify the
vendor fix, complete source coverage, fork-safe PR behavior, check attribution
and secure credential renewal. Never expose a credential in logs or discussions.

## Rollout and rollback

1. Qualify the finished implementation locally and on its exact PR head,
   including strict Sonar and CodeQL findings. Test the actual helper code on
   isolated queue commits with all seven required checks. Keep main unchanged.
2. Obtain the existing qualified maintainer approval, resolve review threads,
   and merge the workflow PR through normal protection. Verify main and the
   trusted default-branch controller before enabling queue admission.
3. Save the complete live main ruleset and effective inherited rules. In one
   update, add `merge_queue` and remove strict freshness, preserving every
   required check and app binding, review rule and thread-resolution rule.
   Start with `ALLGREEN`, two concurrent builds, `MERGE`, minimum group size
   one and maximum two. Use a timeout covering observed required CI duration.
4. Enqueue two approved harmless independent PRs from the same base. Record
   their original head SHAs, both combined SHAs and all required results.
   Verify consecutive merges without source-branch updates, resulting main
   checks and auxiliary cleanup. Never use a protection bypass.
5. If a required result is absent or the controller fails, dequeue pending
   rollout canaries and restore the saved strict ruleset. Automatic Analysis
   stays on and the existing PR merge path remains available. Close only owned
   canary PRs and remove only verified unchanged trial refs/rules. Record the
   failure and remaining resources rather than claim success.

See the [coordination and trial record](https://github.com/bsv-blockchain/ts-stack/discussions/1651),
GitHub's [merge queue guide](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue),
and its [GITHUB_TOKEN event behavior](https://docs.github.com/en/actions/concepts/security/github_token).
