---
id: local-funding-recovery
title: 'Crediting a Payment Exactly Once in a Local Wallet'
kind: guide
version: '1.0.0'
last_updated: '2026-10-08'
last_verified: '2026-10-08'
review_cadence_days: 30
status: experimental
tags: [wallet, utxo, recovery, sqlite, private-overlay]
---

# Crediting a Payment Exactly Once in a Local Wallet

A seller can lose the response to a wallet credit after the wallet has already
written the output. Repeating an ordinary request does not establish which
acquisition caused that effect, whether its receipt survived, or whether the
same output was assigned elsewhere. BRC-195 therefore requires an explicit
`internalizeOnce(operation)` and `getInternalization(id)` capability.

The unpublished local reference implementation provides that capability through
`RecoverableFundingController` and `SQLiteFundingRecoveryStore`. Its intent,
wallet ownership, completion receipt and deferred broadcast request use the
same local wallet database. Ordinary `Wallet.internalizeAction`, BRC-100 wire
requests and remote providers keep their existing behavior. This is an installed
wallet-side capability, not an additional field that an arbitrary BRC-100 client
can send to acquire it.

## Installation and authority

Import `SQLiteFundingRecoveryStore` from
`@bsv/wallet-toolbox/out/src/storage/fundingRecovery/SQLiteFundingRecoveryStore`
and `RecoverableFundingController` from
`@bsv/wallet-toolbox/out/src/signer/fundingRecovery/RecoverableFundingController`.
Explicitly install with `SQLiteFundingRecoveryStore.install(activeStorage, chain)`
and construct `new RecoverableFundingController(wallet, store)`. On restart use
`SQLiteFundingRecoveryStore.open(activeStorage, chain)`; absence is a recovery
failure, not permission to initialize an empty replacement.

The chain descriptor is owned and sealed. Its network must match the wallet's
configured network; for supported public networks its genesis must match that
network's known genesis. A mock chain has an explicitly supplied genesis and
installed test tracker. The same store cannot switch chain, storage identity or
capacity. A different active provider and an active action-batch workspace are
rejected. The seller identity must be this wallet's identity, and the storage user
must belong to it. This version uses local SQLite; remote, IndexedDB and mobile
providers do not acquire the capability through an interface cast.

The caller is trusted wallet-side application code. It must authenticate the
buyer and selected service, authorize the acquisition, verify its retained quote
and acceptance policy, and durably reserve the acquisition before invoking this
controller. This code does not replace application permissions, selected-chain
currentness or the BRC-195 seller ledger. Do not expose its low-level storage
commit hook to an untrusted client.

The optional recovery modules require the SDK 3.3.0 output-protocol helpers.
Existing wallet imports and the ordinary storage construction/internalization
methods retain compatibility with SDK 2.8.11. The local hook's declaration is
separate from the new funding-operation types so disabling this feature does not
pull an SDK 3.3.0-only type into an existing consumer.

## One output, one operation

Supply the closed `OutputWalletFundingOperation` represented by the SDK's
[payment funding inspection](./private-overlay-release.md) helper. Its ID binds
the seller, acquisition ID and exact chain/transaction/output identity. It also
retains buyer, price, derivation prefix and suffix, and the Atomic BEEF. Money
must be a positive integer within the Bitcoin money range; decoded payment BEEF
is bounded to 64 KiB. No caller object or byte-array alias becomes retained state.

Every semantic field is immutable for an operation. Different valid BEEF
encodings for the same raw transaction may be submitted without creating a new
operation. A retry verifies the candidate it will use and retains that evidence
with the accepted receipt. An already completed operation returns its original
receipt. Proof bytes are never a funding identity.

The auxiliary table has a unique claim for the chain/transaction/output tuple
across this wallet database. A second acquisition cannot reserve the same output.
A transaction may contain distinct payments with different BRC-29 derivations;
each exact output has its own operation and can be credited once. For each
operation, the controller derives the expected BRC-29 P2PKH script and scans
every output. Exactly one must match. A duplicate matching script is rejected
even if the duplicate has a different amount.

## Commit and recovery

The controller first persists the intent and reserves terminal storage capacity.
It then verifies the transaction's Script and SPV evidence against the configured
wallet tracker. The ordinary signer and storage validation boundaries also remain
in use. Inclusion-header retrieval happens before the ownership write transaction.
The selected service must separately establish its promised acceptance policy;
wallet verification is not an assertion of unspentness or permanent chain state.

Under a SQLite write guard, the controller refreshes existing transaction and
output ownership reads. It writes any new ownership, input-spend observations,
transaction state, labels, proof or monitor request, and the receipt together.
If any write or receipt check fails, that transaction rolls back. The previously
retained intent stays available for reconciliation. A process-local mutex is not
the atomicity mechanism.

For an unmined new transaction, the wallet retains an `unsent` proof request and
an `unprocessed` transaction for the existing monitor. This operation does not
broadcast while holding a database transaction or wait for a broadcast response.
The installed wallet must run its ordinary monitor to process that durable work.
An ownership receipt does not promise immediately spendable balance while this
transaction is still unprocessed.
For a verified mined transaction, the proof and completed transaction are stored
with the same ownership receipt.

`accepted` means that this exact output was credited and its receipt committed.
It does not mean the transaction was broadcast, mined, remains unspent, or that a
protected result was delivered. Later monitor failure or reorganization does not
rewrite that historical receipt into an absent payment. The seller reconciles
release eligibility and any failure under its separately retained contract.

`getInternalization(id)` returns `absent` only when the installed, readable journal
has no record. A retained intent without a completion decision returns `unknown`.
A conclusively wrong or duplicate BRC-29 payment script returns a durable
`rejected` result with no wallet effect. Transient verification or storage errors
throw; they never manufacture absence or rejection. After a lost response, look
up the original ID. An accepted receipt advances the original acquisition once.
An unknown intent may resume only that same operation and its immutable terms.
Never create a replacement payment to resolve uncertainty.

## Capacity, backup and compatibility

The auxiliary schema uses local format `wallet-funding-recovery-v1`. Installation
defaults to at most 4,096 records and 64 MiB of reserved record capacity. Every
intent reserves 96 KiB for the complete operation plus 4 KiB for its receipt;
therefore the default byte limit admits at most 655 operations. Smaller explicit
limits are supported and sealed. Capacity exhaustion fails before any wallet
effect. Rejected and pending claims continue occupying their reservations and
funding fences. This version has no implicit expiry or garbage collection.
The optional capacity argument accepts numeric `records` and `bytes` values;
the declaration does not restrict `records` to the default literal 4,096.
For example, a dedicated one-operation journal can install with
`SQLiteFundingRecoveryStore.install(activeStorage, chain, { records: 1, bytes: 102400 })`.
Both values still pass the same integer and maximum-capacity checks at runtime.
Installation copies its capacity values and chain before yielding to the database;
later changes to the caller's configuration object cannot change the installed
contract.

This adapter reserves its receipt capacity when an operation is retained. That
alone does not reserve capacity for an earlier quote. The seller integration must
guarantee wallet capacity alongside its quote and protected-result reservations,
including every writer sharing the wallet journal. A free-space check without a
durable reservation or an enforced dedicated quota cannot justify advertising
BRC-195 readiness. Completing that quote-to-wallet capacity composition is a
separate service integration requirement.

Preserve the complete SQLite database and its wallet keys using a consistent
whole-database backup. Legacy entity export, BRC-38/39 snapshot and ordinary sync
do not include these auxiliary tables. Restoring only ordinary wallet entities
does not restore this recovery capability. Keep existing recovery state while
rolling back application adoption; an older application cannot safely resume
new pending operations merely because it can still open the ordinary wallet.

The tests cover retained-intent failure, exact output ownership, distinct outputs
in one transaction, alternate proof encodings, immutable capacities, corrupted
records, lost replies and five actual process-termination boundaries. Generated
properties exercise operation binding, funding uniqueness and receipt replay.
The rejection regressions also assert that valid JSON stored as a binary value
or oversized text cannot become a receipt, and that changed native ownership
metadata rolls back without completing the retained operation. Restoring the
original record or managed ownership permits the original operation to recover.
Their synthetic inclusion fixtures run real transaction verification against an
explicit local tracker; they are not real-chain funding or a network-acceptance
demonstration.
An integration test also passes the retained request to the ordinary wallet
monitor with a local synthetic processor response. It verifies the unmined
transition and unchanged receipt/balance after replay; it does not contact a
public transaction processor.
