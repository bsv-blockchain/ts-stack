# What We Did

This PR implements the transaction recovery plan described in `PLANNED_CHANGES.md`,
then tightens a few edges that came out of review.

The original problem was that a transaction could be successfully broadcast, remain
unmined for long enough to hit the proof-attempt timeout, be marked `invalid`, then
have `reviewStatus` restore its inputs to spendable even though the original
transaction might still be accepted by the network. That could let the wallet create
a second transaction spending the same inputs.

## Wallet Recovery Changes

### Broadcast Tracking

We added durable broadcast state to `proven_tx_reqs`:

- `wasBroadcast`
- `rebroadcastAttempts`

`wasBroadcast` is set when a req reaches a network-accepted state such as
`unmined`, `callback`, or `unconfirmed`. The getter also derives broadcast state
from the current status and request history so older or partially populated records
still behave defensively.

The Knex migration backfills `wasBroadcast = true` for existing reqs already in
accepted/valid network states, including `unmined`, `callback`, `unconfirmed`, and
`completed`. That backfill was an important review fix: without it, in-flight reqs
from before the migration could still be treated as never broadcast.

### Proof Timeout Rebroadcast

`TaskCheckForProofs` no longer treats missing proofs after the attempt limit as proof
that a broadcast transaction is invalid. If the req was broadcast, it is reset to:

- `status = 'unsent'`
- `attempts = 0`
- `rebroadcastAttempts += 1`

That lets `TaskSendWaiting` pick it up and send it through the normal broadcast path
again. If the req was never broadcast, the old behavior remains appropriate: the req
can become `invalid`.

We also added `maxRebroadcastAttempts` to monitor options as a circuit breaker. The
default is `0`, meaning unlimited rebroadcast cycles. Review caught an off-by-one in
the first implementation; the final behavior allows exactly the configured number
of rebroadcast cycles and invalidates only on the next timeout.

### Shared Timeout Logic

The secondary proof-timeout path in `EntityProvenTx.fromReq()` now uses the same
rebroadcast accounting as `TaskCheckForProofs`. This matters because that secondary
path can otherwise bypass the monitor task's counter and mark a broadcast req
invalid early.

The shared behavior lives on `EntityProvenTxReq.applyProofTimeout()`.

### `reviewStatus` Input Restoration Guard

`reviewStatus` still marks transactions failed when their req is truly invalid, and
it still restores inputs for transactions that are safe to abandon.

The guard is now more conservative than the initial plan. `PLANNED_CHANGES.md`
proposed blocking restoration while a req was in a short "live" status list such as
`unmined`, `callback`, `unconfirmed`, `sending`, or `unsent`.

After review, we inverted that idea: inputs are restored only when there is no
blocking req for the txid. A req blocks restoration unless it is in a terminal
failure state that is safe for input recovery:

- `invalid`
- `doubleSpend`

That means statuses such as `unknown`, `nonfinal`, `unprocessed`, `nosend`,
`completed`, and `unfail` also prevent restoration. This intentionally handles
partially reconciled states where `transactions.status = 'failed'` but the req still
shows that the transaction may be active or already valid.

### Purge Hardening

Review also found that `purgeData` swallowed every error from
`getBeefForTransaction()` while collecting proof dependencies for spendable UTXOs.

That catch now ignores only the expected "missing local BEEF / txid not known to
storage" cases. Unexpected errors, such as internal storage failures, invalid proof
state, or validation errors, are rethrown.

## Tests Added Or Updated

The PR adds focused regression coverage rather than the full scenario harness sketched
in `TESTING_PLAN.md`.

Coverage now includes:

- migration backfill for `wasBroadcast`
- `EntityProvenTxReq.wasBroadcast` derivation from status/history
- proof-timeout rebroadcast behavior
- `maxRebroadcastAttempts` circuit-breaker behavior
- secondary timeout behavior in `EntityProvenTx.fromReq()`
- `reviewStatus` refusing to restore inputs for blocking req statuses, including
  `unknown`, `nonfinal`, and `completed`
- `reviewStatus` still restoring inputs when there is no req or only terminal
  failure reqs
- `purgeData` rethrowing unexpected BEEF lookup errors

## CI And PR Maintenance

Several supporting changes were made so the PR could keep passing against the
monorepo:

- fixed docs-site SSG output for the root route
- updated recursive workspace build filtering
- allowed required native dependency build scripts
- relaxed slow Mongo memory startup timing in tests
- synchronized wallet-toolbox `2.1.24` workspace references and lockfile entries
- fixed the conformance workflow argument forwarding
- merged the current `main` branch into the PR branch to pick up Node 24 workflow
  changes and confirm the branch is no longer behind the target branch

## Where We Differed From `PLANNED_CHANGES.md`

The implementation follows the plan's core invariant: a transaction that was accepted
by the network must not have its inputs restored merely because proof lookup timed
out.

The main differences are:

1. We used the persisted `wasBroadcast` column, but still derive defensively from
   status/history. The plan presented those as alternatives; the implementation uses
   both because it gives durable state while protecting migrated or partial records.

2. The `reviewStatus` guard became stricter than the proposed live-status list. The
   final code restores only when no non-failure req exists for the txid, which covers
   more edge states than the initial SQL sketch.

3. The circuit breaker was adjusted during review so `maxRebroadcastAttempts = 2`
   means two rebroadcast cycles are allowed, with invalidation on the third timeout.

4. The test work is focused regression coverage instead of the complete mock service
   and block simulator harness proposed in `TESTING_PLAN.md`. The focused tests cover
   the behavior that caused the incident and the review issues found in the PR.

5. `purgeData` hardening and the CI/docs fixes were outside the original recovery
   plan, but they were needed to address review feedback and keep the PR mergeable.

## Resulting Invariants

- Broadcast transactions time out into rebroadcast, not immediate invalidation.
- Never-broadcast invalid transactions can still fail and release their inputs.
- `reviewStatus` is safe to run even against partially reconciled transaction/req
  state.
- Existing migrated reqs in accepted network states are treated as already broadcast.
- Unexpected purge-time BEEF lookup failures are visible instead of silently ignored.
