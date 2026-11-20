---
id: merge-queue-operators
title: 'Checking Merge Queue Health'
kind: reference
version: '1.0.0'
last_updated: '2026-11-20'
last_verified: '2026-11-20'
review_cadence_days: 30
status: experimental
tags: [reference, ci, github-actions]
---

# Checking Merge Queue Health

For a queued PR, record its source head and the synthetic commit GitHub is
currently validating. Inspect required checks on that exact synthetic SHA,
including their app identities. A successful check on the source branch cannot
replace combined-result evidence.

Confirm that the genuine Sonar result belongs to the controller's owned draft
and that the repository zero-findings gate passed on the same revision. Keep
Automatic Analysis enabled. Missing analysis, a failed scan, an incomplete
inventory or a neutral infrastructure result needs investigation and is not a
successful security result.

After CI completes, inspect the controller cleanup run. Its temporary draft
should be closed and its unchanged owned branch removed. A changed branch or
promoted draft requires operator inspection; never remove someone else's work
merely because its name resembles an analysis branch.

If the queue cannot supply a required result, follow the saved-ruleset rollback
in `docs/reference/merge-queue.md`. Preserve the required check identities,
review and thread-resolution rules. Record actual evidence and unresolved
failures before reporting the queue healthy.
