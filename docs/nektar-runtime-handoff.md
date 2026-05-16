# Nektar Runtime Handoff

Date: 2026-05-16

`wallet-toolbox-rocksdb` remains a wallet library. It owns local wallet storage,
RocksDB indexes, transaction construction/signing records, provider HTTP
clients, in-process caches, and monitor tasks. It does not own Redis, BullMQ,
NATS JetStream, lane fanout, proof queues, or operator workflows.

## Wallet-Toolbox-Owned Signals

These in-process signals are available for a Nektar runtime bridge to observe or
adapt without making wallet-toolbox depend on a runtime bus:

- `EventBus.BLOCK_MINED`: emitted by `SpvHeaderSync`,
  `Monitor.processNewBlockHeader`, and `TaskArcadeSSE` block events.
- `EventBus.UTXO_INVALIDATE`: emitted when wallet-owned outpoints are confirmed
  spent or invalidated.
- `EventBus.REORG`: emitted by `SpvHeaderSync` and `Monitor.processReorg`.
- `Services.postBeef`: submits the same signed BEEF and txid set to configured
  providers and records provider call metrics.
- `TaskSendWaiting`: processes wallet outbox records locally with bounded
  concurrency and retry priority.
- `WalletToolboxMetrics`: exposes cache, broadcast, queue, and storage metrics.

## Nektar-Owned Runtime Streams

If Nektar adopts JetStream, these streams should live in Nektar packages such as
`packages/endurance`, `packages/runtime-workers`, or `packages/runtime-temporal`,
not inside wallet-toolbox:

- `TX_BROADCAST`: broadcast work queue carrying one signed BEEF/raw tx, one txid
  set, one outbox id, and retry metadata.
- `UTXO_STATUS`: observed spend status updates and cache-invalidation hints.
- `BLOCK_EVENTS`: block headers, block mined notices, and reorg events.
- `PROOF_REQUESTS`: proof lookup and finality work that can complete
  asynchronously after broadcast.

## Boundary Rules

- Cache may accelerate read hints only. Wallet storage and fresh provider checks
  remain authoritative before spendability mutation.
- Broadcast retries must reuse the same signed transaction data and same txid.
  Runtime workers must not generate a replacement transaction as a blind retry.
- Provider disagreement must be recorded per attempt and reconciled through the
  outbox/proof-finality path.
- Nektar runtime code can wrap wallet-toolbox APIs, but wallet-toolbox must not
  import NATS, Redis, BullMQ, Temporal workers, lane workers, or operator
  workflow modules.

## Adapter Shape

A Nektar adapter can be implemented outside this repo with three narrow edges:

- Subscribe to wallet `EventBus` events and publish Nektar runtime events.
- Enqueue wallet outbox work into Nektar-owned `TX_BROADCAST` only after a
  wallet action has produced signed transaction data.
- Consume runtime proof/finality results by calling wallet storage APIs that
  update the existing outbox/proven transaction records.
