# In-memory action batch planning

Wallet Toolbox can plan a sequence of `noSend` actions in memory and commit it
atomically when the application uses `sendWith`. This removes per-action storage
round trips without changing the BRC-100 wallet interface, action arguments, or
result shapes. Applications continue to create, sign, and send actions exactly as
before.

## Negotiation and compatibility

`WalletArgs.actionBatchMode` accepts `legacy` (the default) or `auto`. The default
preserves the durable per-action `noSend` behavior expected by existing callers.
Applications that explicitly select `auto` opt into holding intermediate `noSend`
actions in memory until a later `sendWith` commits the batch atomically. In `auto`
mode, the wallet asks its active storage provider for capabilities once. A provider
advertising `actionBatch: { version: 1, ...limits }` enables local planning. A
provider without that capability uses the existing persistence flow before any
workspace begins. A workspace never mixes storage modes or changes active provider.
Large first actions use compact bootstrap only when the provider also advertises
`compactBegin: true`; this keeps new clients compatible with older version-1
servers during a rolling deployment.

The original manifest and one-blob-per-request transport remain version 1. A
provider can independently advertise the additive `manifestVersion: 2`,
`commitByDigest`, and `packedUploads` capabilities. A new client uses each
optimization only when its provider advertises it. Old clients ignore the extra
fields, new clients retain the version-1 path against old providers, and the two
new storage methods are optional for third-party `WalletStorage` implementations.

The capability and its methods are Wallet Toolbox storage extensions. They do not
extend `WalletInterface`, `CreateActionArgs`, `SignActionArgs`, `noSend`,
`noSendChange`, `sendWith`, or their results.

## Lifecycle

1. The first `noSend` action begins a workspace, reserves the canonical funding
   inputs needed for that action plus limited headroom, and returns their proof
   data in one storage call. Format 2 sends only planning metadata and exact
   output-script lengths at bootstrap. Signed transactions and the external
   proof frontier follow through the binary commit path, so a hexadecimal
   script is not duplicated into a large JSON request.
2. The wallet plans, signs, validates, and indexes subsequent actions locally. A
   shared BEEF graph avoids retaining repeated ancestry. The signed transaction
   is the canonical source for output scripts; format 2 carries script digests
   for validation, rather than carrying the same scripts as transaction bytes,
   plan strings, metadata strings, and standalone blobs.
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

Content-addressed raw transactions and the external dependency BEEF travel
inline for batches up to the provider's inline limit (4 MiB by default). Larger
format-2 workspaces prepare a compact digest-only manifest and upload only the
content-addressed physical blobs the server reports missing. Multiple blobs
share one `ABP1` binary pack, bounded by the provider's advertised request size
and item count. Packs use the first mutually supported `CompressionStream`
encoding (`gzip`, then optional Brotli) when it reduces bytes; otherwise they
use identity encoding.

The client sends no HTTP `Content-Encoding` header: a dedicated authenticated
pack-encoding header describes the exact request body seen by BRC-103. The
server bounds both compressed request bytes and decompressed pack bytes,
validates the frame, every SHA-256 digest, prepared-manifest authorization,
batch ownership, and hard lifetime, then inserts the pack in one storage
transaction. The final JSON-RPC call sends only the batch ID and semantic
manifest digest. The server commits the exact prepared manifest retained under
that digest.

Logical blobs are split at the provider's advertised limit (8 MiB by default),
deduplicated by digest, and uploaded with at most four concurrent requests. The
8 MiB value is a physical request target, not a logical transaction limit: one
transaction or dependency BEEF may span any number of chunks. There is no
consensus script-size limit in this path. Incomplete uploads remain scoped to
their authenticated batch and expire with it.

Allocation failure in a particular JavaScript host remains a local resource
failure. It is reported as an operation/runtime failure rather than evidence that
the transaction or script is consensus-invalid.

The planner, validator, digest pipeline, browser IndexedDB store, and chunk
assembler retain `Uint8Array` storage throughout this path. SQL adapters create
buffer views only at the driver boundary. Atomic commit also preloads blob rows,
external inputs, baskets, tags, and labels once per manifest instead of
repeating those lookups for every action. It stores only the external input
proof frontier for each persisted request and reuses the already validated
complete BEEF graph for immediate/delayed share preparation. The full graph is
still reconstructed and verified before persistence. These are storage
implementation details; BRC-100 arguments and results are unchanged.

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
| Local Node wallet with Knex | TypeScript execution was the normal path; its default 32 MiB stack budget could turn local exhaustion into an invalid-action error. Repeated action persistence added storage round trips and row lookups. | A preloaded verifier can execute ordinary and batch checks in explicit consensus mode. Default JS execution has no arbitrary consensus stack cap. `noSend` chains plan in memory, bulk-load shared rows, and commit atomically. |
| Browser wallet with IndexedDB | Large byte values were commonly boxed or hex/string copied, and validation stayed on the TypeScript interpreter. | Browser VeriFast uses the same consensus context and typed-byte paths. IndexedDB stores packed blobs in one transaction and the wallet receives the configured verifier. Host quota or memory exhaustion remains a browser resource failure, not consensus invalidity. |
| Browser/Node wallet using remote Toolbox storage | The first large action and later commit values could encounter JSON/body limits; repeated scripts appeared in several JSON/manifest fields; every blob needed a request; and server verification could not be configured independently. | Compact bootstrap and format-2 manifests derive scripts from signed transactions. Manifest-authorized, compressed, multi-blob binary packs avoid JSON expansion and reduce request count. Digest-only commit makes the final request small. Client and server independently preload/inject verifiers, and server commit batches selected spends. |

For latency-sensitive startup, call `await verifier.preload()` before constructing
or first using the wallet. The default adaptive mode deliberately lets a cold
first call use the TypeScript interpreter while WASM warms in the background;
`mode: 'always'` instead waits for WASM. In a remote deployment, repeat that
startup step in both the client runtime and every storage-server process.

The remaining transport boundaries are resource and protocol facts rather than
consensus limits. Raw action-batch pack requests stay bounded and logical values
chunk around that bound. Cicada/Wallet Wire uses typed bytes and zero-copy frame
handoffs. Browser XDM uses structured clone. HTTP JSON and React Native retain
their existing BRC-100 encodings, so operators must configure infrastructure
request limits for ordinary non-batched calls or use action batching for
multi-megabyte transaction flows.

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
provider support, then explicitly deploy selected clients with
`actionBatchMode: 'auto'`. Old clients ignore the capability; new clients fall
back against old providers. Operators can omit the option or use
`actionBatchMode: 'legacy'` to retain durable per-action persistence.

The retained benchmark is the performance regression gate:

```bash
pnpm --filter @bsv/wallet-toolbox bench:action-batch
```

On the same Apple Silicon host with Node.js v25.9.0, a representative cold
250-action, 1 KiB-script run reduced planning/signing/validation from
19,117.03 ms in legacy mode to 10,907.93 ms in batch mode (42.9%, or 1.75x).
Including atomic commit, total local time was 19,163.87 ms versus 11,462.13 ms
(40.2% lower), while storage calls fell from 501 to 2 and database transactions
from 252 to 3. At 100 ms storage RTT those calls represent 50,100 ms versus
200 ms of control-path latency, a 99.6% reduction.

A generic single 4 MiB zero-filled script took 1,258.13 ms through the legacy
path and 208.60 ms through format 2, including upload and atomic commit: 83.4%
less local time. Its instrumented requests fell from 13,982,465 bytes to 8,064
bytes. The one 4,195,234-byte logical pack compressed to 5,233 bytes and was
uploaded in one call. This synthetic compression ratio represents highly
repetitive data; incompressible data falls back to identity encoding without
expansion. Absolute times remain host- and database-dependent.

It records planning, signing and validation, storage RPCs, database transactions,
request bytes, commit and broadcast time, CPU, and incremental peak heap. Physical
SQLite runs compare 1, 10, 50, and 250 action chains at 1 KiB and exercise each
larger script size with a real action, including the 4 MiB upload path. Its
complete model covers dependent, independent, explicit-input, and two-step
signing workloads at every action count; 1 KiB, 64 KiB, 1 MiB, and 4 MiB
scripts; and 25, 100, and 250 ms storage RTT. The measured cases deliberately
include both many-small-action and few-large-action shapes so transport tuning
is not fitted to one contract or graph. Production rollout should additionally
track reservation conflicts, extensions, expiries, commit retries, pack
compression, upload deduplication, commit duration, and broadcaster review
outcomes by provider type.
