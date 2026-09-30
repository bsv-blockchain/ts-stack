---
id: local-action-recovery
title: 'Recovering an Exact Local Wallet Action'
kind: guide
version: '1.0.0'
last_updated: '2026-09-30'
last_verified: '2026-09-30'
review_cadence_days: 30
status: experimental
tags: [wallet, utxo, recovery, sqlite]
---

# Recovering an Exact Local Wallet Action

An interrupted application cannot safely repeat an uncertain funding request and
assume it gets the same transaction. A wallet may already have reserved inputs,
created change descriptors or signed a transaction before the caller loses the
response. Keeping an application-side reference after the response does not cover
that interval. The reference must be retained with the allocation itself.

The unpublished Wallet Toolbox implementation adds an explicitly installed local
SQLite capability. `RecoverableActionController` offers `prepare`, `finalize` and
`recover` above the existing wallet. It uses ordinary BRC-100 request and result
types, but these three methods are **not new BRC-100 transport methods**. Ordinary
`Wallet.createAction` and `Wallet.signAction` retain their existing behavior.
Remote storage, IndexedDB, wallet-provider switching and an ephemeral action-batch
workspace do not acquire this capability by implementing the existing interface.
These optional modules use SDK 2.9 helpers. Existing wallet imports and ordinary
storage methods remain compatible with SDK 2.8.11 when this feature is disabled.

## Installation and ownership

Import `SQLiteActionRecoveryStore` from
`@bsv/wallet-toolbox/out/src/storage/actionRecovery/SQLiteActionRecoveryStore`
and `RecoverableActionController` from
`@bsv/wallet-toolbox/out/src/signer/actionRecovery/RecoverableActionController`.
Install the auxiliary schema explicitly with
`SQLiteActionRecoveryStore.install(activeStorage)`, then construct
`new RecoverableActionController(wallet, store, originator)` inside the trusted
wallet integration. On restart, use `SQLiteActionRecoveryStore.open(activeStorage)`.
Opening never initializes missing state. A missing, incompatible or corrupt store
is a recovery failure; do not turn it into a fresh allocation by calling `install`.

The store must use the **same SQLite database** as the active local `StorageKnex`
provider. Claims and retained funding descriptors share the wallet's allocation
transaction. A separate application database, an in-memory receipt or two
independently committed SQLite transactions cannot provide that guarantee.
The controller rejects a different active provider or an active action-batch
workspace. The integration is trusted wallet-side code: its explicit originator
binds operation identity but does not replace application authentication, user
permission checks or transaction approval.

An operation is bound to the wallet user and public identity, storage identity,
chain, originator, caller-selected operation ID and canonical creation request.
Use a stable ID of one to 128 ASCII letters, digits, dots, underscores or hyphens.
Reusing an ID with a different request is a conflict. Retain the original request
alongside the ID; `recover` requires it and does not infer a new request from
current application state. Distinct originators and wallet identities have
distinct operation namespaces.

## Preparation, signing and recovery

Preparation requires `options.noSend: true`, `signAndProcess: false`,
`randomizeOutputs: false` and full transaction evidence. It rejects `sendWith`,
`knownTxids`, `trustSelf`, `returnTXIDOnly` and BRC-177 expiry-protected labels.
Those labels retain their ordinary wallet route; they are not silently weakened
by this recovery profile. The opt-in path always retains complete source bytes.

`prepare(operationId, createArgs)` returns the original
`signableTransaction.reference` and its Atomic BEEF. The wallet retains the exact
funding inputs, public derivation descriptors, outputs and allocation reference
before committing. It completes source evidence outside the write transaction,
using only the retained funding roots and local wallet storage. Interrupted
completion resumes that same plan. It does not select another set of inputs or
mark a committed recoverable allocation failed merely because its response was
lost. If preparation fails before allocation commits, its operation claim and
wallet changes roll back together.

The application can inspect the funded layout and collect any external input
signatures before calling `finalize(operationId, createArgs, signArgs)`.
`signArgs.reference` must identify that preparation. Only unlocking scripts may
change: version, locktime, prevouts, input order, sequences, output values, scripts
and output order remain bound. The controller signs wallet-managed inputs and
requires successful Script verification for every input with no missing-input
skips. It saves the completed Atomic BEEF and canonical signing-request digest
**before** wallet processing. Finalization always remains `noSend`.

`recover(operationId, createArgs)` returns one of three states. `absent` means no
operation exists in this retained store and does not allocate anything. `prepared`
returns the original signable result, completing saved local evidence when needed.
`finalized` returns the retained final transaction. Recovery rechecks its layout
and every input script, resumes processing if needed, and reconciles a lost
processing response against the wallet's exact transaction ID and raw bytes.
It does not sign again after final bytes have been retained. Cancellation or a
conflicting wallet transaction is an error, not a successful recovered purchase.

Submitting or broadcasting the final transaction is a separate authorized action.
This controller neither calls a broadcaster nor guarantees an overlay's admission,
private delivery, currentness or acquisition result. Its complete Script checks
also do not establish seller authority, lineage or a selected chain view's mining
evidence. Compose those independently specified checks before making domain
claims or releasing secrets.

## Storage, bounds and lifecycle

The version-one auxiliary tables are `wallet_action_recovery_v1` and
`wallet_action_recovery_metadata_v1`. No signing secret is stored, but the requests,
transaction history, references and public derivation metadata remain private
wallet data. Preserve the database and wallet keys together. Existing wallet
entity backup, snapshot and sync APIs do **not** include this auxiliary schema.
A copied set of ordinary wallet entities is not evidence that recovery operations
have been restored. Use a consistent complete local database backup for this
capability, and test reopening it with the correct wallet identity.

The initial store admits at most 4,096 operations and 64 MiB of retained payloads;
installation may lower both limits. Reopening or reinstalling does not change
them. Installation owns its limit values before yielding to the database, so
later changes to the caller's configuration cannot change the retained contract.
Each operation is limited to 16 MiB across its binding, allocation,
completed funding result, prepared BEEF and final BEEF. Canonical records have
bounded nesting and item counts; descriptors use at most 2,048 inputs or outputs,
and descriptor text fields are limited to 4,096 UTF-8 bytes. These are local
capability bounds, not changed BRC-100 limits. A large transaction may exceed the
aggregate record bound even when an individual BEEF fits.

The implementation separates canonical JSON/binary ownership from wallet-specific
descriptor validation. The existing `ActionRecoveryCodec` deep imports and
version-one record bytes remain unchanged. Funding-root membership uses a set
of the validated input transaction IDs, avoiding a repeated scan for every root
without changing order, duplicate rejection or source binding. This internal
refactor requires no persisted-data migration. Both complete modules retain
the full recovery test selection and independent critical mutation gates.

Capacity exhaustion is explicit. There is no automatic pruning or deletion of
completed operation identities, no implicit namespace reset, and no claim of
unbounded retention. Preserve existing state and resolve outstanding operations
before planning an operator-managed store lifecycle. Never delete an operation
merely to retry the same uncertain funding request. Expanding configuration or
moving between providers requires a separately specified migration; it is not
part of this version-one capability.

The reference tests use isolated local databases and public fixtures. They cover
real wallet funding and signing, concurrent retries, fixed-input rollback, lost
responses, and process termination before and after allocation commit, before
the prepared response, before final processing, and after the processing commit.
They establish those local boundaries. They do not establish production miner
acceptance, remote-provider recovery, browser storage support or a deployed
application's permission and backup policies.
