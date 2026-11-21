---
id: merge-queue-contributors
title: 'Using the Merge Queue'
kind: reference
version: '1.0.0'
last_updated: '2026-11-20'
last_verified: '2026-11-20'
review_cadence_days: 30
status: experimental
tags: [reference, ci, github-actions]
---

# Using the Merge Queue

When the queue is enabled for `main`, finish the PR's required checks, obtain
qualified maintainer approval and resolve review conversations before requesting
its normal merge. GitHub then validates the proposed combined commit before it
lands. Independent branches do not need an update merely because another PR
merged first.

A genuine source conflict still needs a contributor fix. A failed combined test
also needs investigation: read the failed queue run and change the source when
necessary. Do not treat an old PR-head pass as evidence for the new combined
commit or bypass a missing security check.

Temporary bot-authored analysis drafts are created for Sonar to inspect exact
queue commits. Do not merge or edit these drafts or approve their auxiliary
Actions runs. The controller owns their lifecycle; ordinary PR review stays on
the contributor's original PR.

See `docs/reference/merge-queue.md` for the current rollout
status, retained protections, evidence and rollback procedure.
