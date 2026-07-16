# In-memory action batch planning

Wallet Toolbox can plan a sequence of `noSend` actions in memory and commit it
atomically when the application uses `sendWith`. This removes per-action storage
round trips without changing the BRC-100 wallet interface, action arguments, or
result shapes. Applications continue to create, sign, and send actions exactly as
before.

## Negotiation and compatibility

`WalletArgs.actionBatchMode` accepts `auto` (the default) or `legacy`. In `auto`
mode, the wallet asks its active storage provider for capabilities once. A provider
advertising `actionBatch: { version: 1, ...limits }` enables local planning. A
provider without that capability uses the existing persistence flow before any
workspace begins. A workspace never mixes storage modes or changes active provider.

The capability and its methods are Wallet Toolbox storage extensions. They do not
extend `WalletInterface`, `CreateActionArgs`, `SignActionArgs`, `noSend`,
`noSendChange`, `sendWith`, or their results.

## Lifecycle

1. The first `noSend` action begins a workspace, reserves the canonical funding
   inputs needed for that action plus limited headroom, and returns their proof
   data in one storage call.
2. The wallet plans, signs, validates, and indexes subsequent actions locally. A
   shared BEEF graph and content-addressed locking-script blobs avoid retaining
   repeated ancestry and script copies.
3. If confirmed funding runs low, the wallet extends its reservation pool using
   an EWMA estimate and geometrically increasing runway. Forwarded staged change
   needs no reservation or extension.
4. `sendWith`, or a normal action created while the workspace is open, validates
   and atomically persists every staged action. Only the requested transactions
   are sent; earlier actions retain their `nosend` status.
5. Broadcast occurs after the storage transaction. Delayed mode returns after the
   batch is durably queued; immediate mode uses the existing aggregate broadcaster
   and review results.

Intermediate state is deliberately session-scoped. If the wallet process exits,
the uncommitted transaction workspace is lost and its durable reservations expire
or are released by cleanup. The final commit is the remote durability boundary.

## Reservations and cleanup

Reservations belong to individual outputs, not the wallet. Other wallet activity
can use unreserved outputs normally. A uniqueness constraint prevents one output
from belonging to two active batches.

The initial reservation includes at most three extra candidates and never more
than eight outputs. Extensions retain at most 64 outputs of headroom and use the
same exact, least-over, then largest-under selection policy as normal funding.
Leases last 15 minutes with a 60-minute hard lifetime. Long-running workspaces
renew near 80% of the lease; commit may atomically reacquire an expired reservation
when no conflicting spend or reservation occurred. Commit, abort, wallet
destruction, expiry cleanup, and the one-minute monitor task release unused state.

## Atomic commit and payload transport

The provider checks graph order, duplicate spends, scripts, TXIDs, signatures,
fees, commissions, leases, and output metadata before persistence. Transactions,
outputs, labels, tags, maps, and proof requests are written under one database
transaction together with reservation consumption and release. Batch ID plus a
semantic manifest digest makes persistence retries idempotent.

Content-addressed raw transactions, dependency BEEF, and locking scripts travel
inline for batches up to the provider's inline limit (4 MiB by default). Larger
workloads prepare a manifest, upload only missing blobs through authenticated raw
binary requests, and commit by digest. Logical blobs are split at the provider's
advertised limit (8 MiB by default), deduplicated by digest, and uploaded with at
most four concurrent requests. Incomplete uploads expire with their batch.

## Rollout and measurement roadmap

The compatibility boundary permits a server-first rollout: deploy schema and
provider support, then deploy clients in `auto` mode. Old clients ignore the
capability; new clients fall back against old providers. Operators can use
`actionBatchMode: 'legacy'` for controlled comparisons.

The retained benchmark is the performance regression gate:

```bash
pnpm --filter @bsv/wallet-toolbox bench:action-batch
```

It records planning, signing and validation, storage RPCs, database transactions,
request bytes, commit and broadcast time, CPU, and incremental peak heap. Physical
SQLite runs compare 1, 10, 50, and 250 action chains at 1 KiB and exercise each
larger script size with a real action, including the 4 MiB upload path. Its complete
model covers dependent, independent, explicit-input, and two-step signing workloads
at every action count; 1 KiB, 64 KiB, 1 MiB, and 4 MiB scripts; and 25, 100, and
250 ms storage RTT. Production rollout should additionally track reservation
conflicts, extensions, expiries, commit retries, upload deduplication, commit
duration, and broadcaster review outcomes by provider type.
