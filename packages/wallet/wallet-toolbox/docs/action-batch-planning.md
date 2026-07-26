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
Large first actions use compact bootstrap only when the provider also advertises
`compactBegin: true`; this keeps new clients compatible with older version-1
servers during a rolling deployment.

The capability and its methods are Wallet Toolbox storage extensions. They do not
extend `WalletInterface`, `CreateActionArgs`, `SignActionArgs`, `noSend`,
`noSendChange`, `sendWith`, or their results.

## Lifecycle

1. The first `noSend` action begins a workspace, reserves the canonical funding
   inputs needed for that action plus limited headroom, and returns their proof
   data in one storage call. When its scripts or proof data exceed the inline
   target, the client sends only planning metadata and exact script lengths.
   Full transaction, script, and proof bytes follow through the chunked commit
   path, so they never have to fit in the bootstrap JSON request.
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
than eight outputs. Its canonical funding target includes the marginal P2PKH
input fee and enough value to recover an economically viable first change output,
so a low basket minimum cannot repeatedly select inputs that satisfy the nominal
deficit but cost too much to use.

Extensions add at most 64 outputs per storage call, but there is no cumulative
reservation, workspace-size, action-count, or spend-chain limit. Additional
bounded calls continue for as long as the workspace needs confirmed funding.
They use the same exact, least-over, then largest-under selection policy as
normal funding. Retry targets are incremental shortfalls: the planner credits
the value and count of every unconsumed reserved output before asking for more.
Confirmed inputs already used by staged transactions remain reserved until
commit but are not credited as available funding. Proactive EWMA requests
likewise subtract the unconsumed pool, initialize from the first complete
sample, and increase geometric runway only when the provider fulfills both the
requested count and value. Empty or partial extensions therefore cannot
compound a target against unchanged wallet state.
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
most four concurrent requests. The 8 MiB value is a physical request target, not
a logical transaction limit: one transaction, locking script, or dependency BEEF
may span any number of chunks. Incomplete uploads expire with their batch.

Allocation failure in a particular JavaScript host remains a local resource
failure. It is reported as an operation/runtime failure rather than evidence that
the transaction or script is consensus-invalid.

The planner, validator, digest pipeline, browser IndexedDB store, and chunk
assembler retain `Uint8Array` storage throughout this path. SQL adapters create
buffer views only at the driver boundary. Atomic commit also
preloads external inputs, baskets, tags, and labels once per manifest instead of
repeating those lookups for every action. These are implementation details; the
manifest format and BRC-100 arguments and results are unchanged. The storage
capability adds only the optional, negotiated `compactBegin` flag described
above.

Wallet and locally hosted storage construction can receive an optional
`scriptVerifier`. Batch and ordinary action checks pass explicit consensus
context and known source-output heights to that verifier. A provider with a
packed Spend lane verifies all selected staged inputs in one backend scheduling
pass, allowing a warm native/WASM implementation to handle large scripts without
changing the wallet contract. If no verifier is supplied, the SDK TypeScript
interpreter remains the default.

Verifier configuration is process- or page-local. A browser or local wallet
verifier accelerates checks performed by that wallet; it is not serialized over
BRC-100 or storage RPC. A remote storage process must create, preload, and inject
its own verifier into `StorageKnex` if server-side atomic-commit checks should use
the same backend. Backend initialization, ABI, or memory failures propagate as
operational failures and are never rewritten as invalid-script verdicts.

## Deployment behavior for large scripts

| Deployment | Before these changes | Current behavior |
| --- | --- | --- |
| Local Node wallet with Knex | TypeScript execution was the normal path; its default 32 MiB stack budget could turn local exhaustion into an invalid-action error. Repeated action persistence added storage round trips. | A preloaded verifier can execute ordinary and batch checks in explicit consensus mode. Default JS execution has no arbitrary consensus stack cap. `noSend` chains plan in memory and commit atomically. |
| Browser wallet with IndexedDB | Large byte values were commonly boxed or hex/string copied, and validation stayed on the TypeScript interpreter. | Browser VeriFast uses the same consensus context and packed typed-byte paths. IndexedDB and the wallet receive the configured verifier. Host quota or memory exhaustion remains a browser resource failure, not consensus invalidity. |
| Browser/Node wallet using remote Toolbox storage | The first large action and later commit values could encounter JSON/body limits; each staged action was validated separately and server verification could not be configured independently. | Capability-negotiated compact bootstrap avoids sending large first-action bytes as JSON. Content-addressed binary chunks carry unbounded logical blobs. Client and server independently preload/inject verifiers, and server commit batches selected spends. |

For latency-sensitive startup, call `await verifier.preload()` before constructing
or first using the wallet. The default adaptive mode deliberately lets a cold
first call use the TypeScript interpreter while WASM warms in the background;
`mode: 'always'` instead waits for WASM. In a remote deployment, repeat that
startup step in both the client runtime and every storage-server process.

The remaining transport boundaries are resource and protocol facts rather than
consensus limits. Raw action-batch upload requests stay bounded and chunk around
that bound. Cicada/Wallet Wire uses typed bytes. Browser XDM uses structured
clone. HTTP JSON and React Native retain their existing BRC-100 encodings, so
operators must configure infrastructure request limits for ordinary non-batched
calls or use action batching for multi-megabyte transaction flows.

The remote server derives the batch user ID and active-storage state from the
BRC-103 authenticated identity for every management call and binary upload.
Caller-supplied user IDs or active-state claims are never authoritative, and the
JSON-RPC dispatcher exposes only the public remote-storage protocol rather than
low-level provider methods. Authenticated RPC and blob requests are rate-limited
by identity key without limiting the number of actions, transactions, or blobs
in a workspace; operators can configure the rate and a shared multi-replica
store through `WalletStorageServerOptions.rateLimit`.

## Rollout and measurement roadmap

The compatibility boundary permits a server-first rollout: deploy schema and
provider support, then deploy clients in `auto` mode. Old clients ignore the
capability; new clients fall back against old providers. Operators can use
`actionBatchMode: 'legacy'` for controlled comparisons.

The retained benchmark is the performance regression gate:

```bash
pnpm --filter @bsv/wallet-toolbox bench:action-batch
```

On the same Apple Silicon host with Node.js v25.9.0, a representative cold
250-action, 1 KiB-script run reduced planning/signing/validation from
19,020.51 ms in legacy mode to 11,785.46 ms in batch mode (38.0%, or 1.61x).
Including the deliberately heavier atomic commit, total local time was
19,062.33 ms versus 18,261.81 ms (4.2% lower), while storage calls fell from 501
to 2 and database transactions from 252 to 3. At 100 ms storage RTT those calls
represent 50,100 ms versus 200 ms of control-path latency, a 99.6% reduction.

The same run reduced a single 1 MiB action from 304.86 ms to 215.30 ms total
(29.4%) and a 4 MiB action from 1,231.91 ms to 826.64 ms (32.9%), including
chunk upload and atomic commit. Retaining an existing generic 8 MiB
`Uint8Array` at the persistence entry point took a 0.004 ms median versus
142.9 ms to box it with `Array.from`; it also avoids approximately 64 MiB of
number slots for an 8 MiB payload. Absolute times remain host- and
database-dependent.

It records planning, signing and validation, storage RPCs, database transactions,
request bytes, commit and broadcast time, CPU, and incremental peak heap. Physical
SQLite runs compare 1, 10, 50, and 250 action chains at 1 KiB and exercise each
larger script size with a real action, including the 4 MiB upload path. Its complete
model covers dependent, independent, explicit-input, and two-step signing workloads
at every action count; 1 KiB, 64 KiB, 1 MiB, and 4 MiB scripts; and 25, 100, and
250 ms storage RTT. Production rollout should additionally track reservation
conflicts, extensions, expiries, commit retries, upload deduplication, commit
duration, and broadcaster review outcomes by provider type.
