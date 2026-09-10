# BSV Wallet Toolbox

[![Build Status](https://img.shields.io/github/actions/workflow/status/bsv-blockchain/ts-stack/ci.yml?branch=main&label=build)](https://github.com/bsv-blockchain/ts-stack/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@bsv/wallet-toolbox)](https://www.npmjs.com/package/@bsv/wallet-toolbox)
[![npm downloads](https://img.shields.io/npm/dm/@bsv/wallet-toolbox)](https://www.npmjs.com/package/@bsv/wallet-toolbox)

A [BRC-100](https://github.com/bitcoin-sv/BRCs/blob/master/wallet/0100.md) conforming wallet implementation for the BSV blockchain, built on the [BSV SDK](https://bsv-blockchain.github.io/ts-stack/packages/sdk/). Provides persistent storage, protocol-based key derivation, transaction monitoring, chain tracking, and signing — everything needed to build wallet-powered applications on BSV.

## Backup and sync: tested results

**Live E2E testing used a large wallet in the native desktop client**, covering
complete local copies, restart recovery, and repeat sync. Transfer size and oversized-record recovery were
measured separately with synthetic fixtures. The latest proof-recovery follow-up
has synthetic HTTP and read-only source-data validation; its live full-backup
retest is pending.

| Test                         | Verified result                                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full native desktop restores | **Two complete copies; identical entity counts.** Second run: **12m 50s vs 16m 30s (22.3% less time)**.                                                 |
| Retained local backup        | Completed after cancellation, a connectivity pause, and restart recovery; all **12 entity-store counts preserved** on another restart.                  |
| Local reads and repeat sync  | Transaction/output reads passed; sampled transaction bytes matched; repeat sync made **0 inserts, 0 updates**.                                          |
| Transfer size                | **62.7% smaller** encoded byte payload in a synthetic fixture.                                                                                          |
| Oversized single record      | **7 MiB restored in real browser IndexedDB**, matching SHA-256; interrupted upload resumed, corrupt download rejected, repeat sync unchanged.           |
| Automated integration        | Authenticated HTTP backup/restore, interrupted pages, lost acknowledgements, binary byte round-trips, user isolation, and legacy compatibility covered. |

Timing compares successive candidates, not a controlled comparison against upstream
`main`. Byte verification was sampled, not database-wide. See
[test methods and limits](#sync-performance-and-recovery) for details.

## Overview

The Wallet Toolbox is the reference implementation of the BRC-100 wallet interface. It connects the BSV SDK's cryptographic primitives to real storage backends, network services, and signing flows so that application developers don't have to wire these layers together themselves.

BSV Desktop and BSV Browser are the BSV Association reference wallet applications built around this interface. Vendor distributions, including Babbage's Metanet Desktop / Metanet Explorer and Hudos Browser, can implement the same BRC-100 interface against their own product packaging and service defaults.

### What's Inside

| Module             | Description                                                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Wallet**         | Full BRC-100 wallet — action creation, signing, certificate management, identity discovery, output tracking                                      |
| **Storage**        | Pluggable persistence with three backends: **SQLite/MySQL** (via Knex), **IndexedDB** (browser/mobile), and **remote** (client/server over HTTP) |
| **Services**       | Network layer — ARC transaction broadcasting, chain tracking (Chaintracks), merkle proof verification, UTXO lookups via WhatsOnChain             |
| **Monitor**        | Background daemon that watches pending transactions, rebroadcasts failures, handles chain reorganizations, and manages proof acquisition         |
| **Signer**         | `WalletSigner` bridges any BRC-100 wallet to the SDK's `Transaction` signing interface                                                           |
| **Key Management** | `PrivilegedKeyManager` for secure key storage with Shamir secret sharing and obfuscation; protocol-based key derivation per BRC-42/43            |
| **Permissions**    | `WalletPermissionsManager` for fine-grained per-app, per-protocol permission control with grouped approval flows                                 |
| **MockChain**      | In-memory blockchain for testing — mock mining, UTXO tracking, and merkle proof generation without a network                                     |
| **Entropy**        | `EntropyCollector` gathers mouse/touch entropy for high-quality randomness in browser environments                                               |

Durable permission grants queue their internal token transaction for delayed
broadcast, so permission approval does not inherit network-broadcast latency.
The funding planner prefers settled change and uses queued permission ancestry
only as a last resort, keeping the application path fast without hiding funds.

Permission modules may transform calls with `onRequest` and `onResponse`, or
own a P-scheme's semantics with the optional `handleRequest(request, next)`
hook. A semantic handler can return the normal BRC-100 result directly; if it
needs the underlying wallet operation, `next` is guarded so it can be invoked
at most once. Existing transformation-only modules remain compatible. The
standalone `@bsv/ecpm-permission-module` demonstrates this extension by
implementing `p ecpm` point multiplication through `getPublicKey`, without a
new BRC-100 method or wire message.

Immediate actions prefer completed, then unproven, then sending change. A
pathological settled plan is compared with pending alternatives by exact
serialized BEEF plus transaction bytes; queued ancestry is used only when it is
necessary or smaller. Pending change is never withheld, so queued
work cannot strand the balance behind a large reserved input.

### Packages

The toolbox publishes three npm packages from this repo:

- **[`@bsv/wallet-toolbox`](https://www.npmjs.com/package/@bsv/wallet-toolbox)** — Full package with all storage backends (SQLite, MySQL, IndexedDB, remote)
- **[`@bsv/wallet-toolbox-client`](https://www.npmjs.com/package/@bsv/wallet-toolbox-client)** — Browser build; excludes Node-only backends (Knex/SQLite/MySQL)
- **[`@bsv/wallet-toolbox-mobile`](https://www.npmjs.com/package/@bsv/wallet-toolbox-mobile)** — Mobile build; remote wallet storage plus portable local ChainTracks components and adapter contracts

### Sync performance and recovery

Sync pages start at 64 records and adapt after successful commits toward a
five-second page budget. Proof-bearing pages cap growth at 128 records; cheap
metadata pages can grow to 1,000, while provider byte/item ceilings still apply.
The server checks at most eight proofs concurrently and waits for all started
checks to settle on failure before rejecting the page. Every proof still passes
transaction, Merkle path, active-root and active-header validation before a merge.
An authenticated HTTP regression covers 250 synthetic proofs and confirms that
an invalid follow-up page cannot change the committed checkpoint. Stale proofs
can be reconciled through another provider, but only after the replacement passes
the same transaction, membership and active-chain checks. Transaction bytes,
wallet references and source cursor timestamps are preserved. Corrected destination
proofs receive a fresh local timestamp for incremental replication. Unverifiable replacements
stop the page with a recovery message; no record is silently skipped.

A read-only deployment-host sample of 250 proofs took 42.6 seconds with sequential
validation and 5.58 seconds with bounded concurrency, with the same 250 root and
250 header checks. This measures validation only, not full-copy throughput.
Timeouts remain possible during dependency outages; writes are never blindly
replayed, and resumed sync rereads durable destination progress.

The adaptive page controller and optional validated-proof lookup add a small
client bundle cost. The [artifact measurements and limits](./docs/sync-transfer.md#artifact-cost-requiring-review)
include the combined upstream security fixes. These are explicit feature costs;
the RPC validation coordinator remains excluded from browser/mobile bundles.

The transfer extension is an **unpublished 2.12.0 candidate**. Published 2.11.0
has no record-transfer methods. Check exact build provenance and authenticated
runtime capabilities, not a version label alone. An oversized record on a legacy
source cannot be rescued by upgrading only its destination; upgrade the source
before retrying. Records exceeding the negotiated 64 MiB frame limit fail safely
without being skipped or advancing their checkpoint.

Large individual records can use the negotiated
[bounded transfer protocol](./docs/sync-transfer.md), with durable staging,
integrity verification and checkpoint replay protection. Its authenticated
HTTP/SQLite/IndexedDB regression exercises a 7 MiB binary record, an interrupted
upload across client/server restart, a lost part acknowledgement, corrupted
download rejection and a verified restore followed by an unchanged resync.
The current frame limit is 64 MiB; legacy providers must be upgraded to use it.
It also passes with a one-second delay on every authenticated transport send;
that models added latency, not a measured bandwidth limit or a real mobile network.
These synthetic regressions are separate from the large-wallet timing evidence above.

Wallet storage replication applies each received page and its durable sync
checkpoint in one provider transaction. IndexedDB and Knex therefore avoid
per-record transaction startup, and a failed page rolls back without advancing
the checkpoint. Sources fill each bounded page with adaptive, size-aware reads,
and Knex storage adds user-scoped proof lookup indexes. Clients may set
`includeTotals` on a sync-chunk request to receive optional source record totals
for exact progress reporting. Older providers ignore the hint, and totals are
not counted unless requested. New clients also send the writer-local sync-state
identifier selected during provider registration. New providers use it to
disambiguate legacy duplicate checkpoints, while either side remains compatible
with older protocol peers. When a provider rejects a sync page because its
serialized RPC response exceeds the service ceiling, remote clients retry the
read-only request with a smaller chunk budget and remember the working limit
for the rest of the session.

IndexedDB schema version 6 adds a non-unique transaction-ID/user index. Sync
identity lookups, commissions, and relation maps use selective indexes or exact
keys instead of scanning the growing wallet for each row. Proof batch checks
resolve requested transaction IDs through the existing index, preserving primary-key
ordering, pagination, and proof-validation rules. Existing bytes and
legacy duplicate transaction IDs are preserved. Databases upgrade automatically;
older clients that open schema version 5 cannot reopen an upgraded database, so
keep a compatible client when retaining a local backup.

Updated servers advertise `syncCheckpointVersion: 1` in runtime settings.
Compatible clients fetch a compact checkpoint once, then use the checkpoint
returned by each committed page. The complete ID mapping remains durable on
the writer and is no longer downloaded before every page. Older providers use
the existing full-state path; authentication, gateway, and malformed checkpoint
errors remain failures rather than compatibility fallbacks. A retry starts
from the writer's durable checkpoint. `includeNextCheckpoint` is optional, and
legacy requests retain their existing response shape.

When a reader negotiates binary JSON, large schema-defined sync byte fields
are encoded as base64 instead of decimal number arrays. Legacy readers retain
the existing arrays; unrelated numeric fields are never reinterpreted as bytes.
Clients with `binaryRequests: true` use the same compact representation for
sync uploads after the server negotiates binary request support. The default
request setting is unchanged.
Binary JSON parsing preserves the existing marker and escaping rules while
avoiding a JavaScript reviver callback for every scalar byte. The SDK also
prevents certificate work or session recovery from dispatching another request
after the caller's authentication deadline has expired. This does not cancel a
write already received by a server or automatically replay failed writes.

Run the authenticated candidate-provider sync benchmark with:

```sh
pnpm bench:storage-sync
```

Set `WALLET_TOOLBOX_BENCH_MYSQL=true`, `MYSQL_CONNECTION`, and optionally
`WALLET_TOOLBOX_BENCH_MYSQL_DATABASE` to exercise the same fixture through a
MySQL-backed provider. The benchmark reports HTTP p50/p95 latency and the
source-query limits used to fill a 250-record page; it is observational rather
than a cross-machine latency SLA. It also compares the old reviver with the
current parser on identical synthetic data and measures checkpoint size. On
one local Node 24 run, a 1 MiB numeric-array fixture (3.74 MB of JSON) measured
501.2 ms versus 10.1 ms median parsing time across nine alternating samples.
A synthetic 50,000-entry mapping occupied 678,850 bytes; its compact checkpoint
occupied 432 bytes. These are CPU and payload measurements, not a claim of the
same end-to-end network speedup. Encoding the synthetic byte field through
the negotiated sync codec reduced its JSON payload from 3,743,771 to 1,398,163
bytes (62.7%).

Retained integration tests cover authenticated HTTP backup and complete restore
into a fresh IndexedDB store, multipage progression, no-change resync,
interruption/resume, user isolation, malformed checkpoints, and legacy-provider
fallback. Live deployment results must be reported separately with the tested
revision and scope; a partial page sample is not a full restore verification.

A native desktop integration run against candidate runtime
`a88d18abf14b75a3227016bfd947d5a08b3ee236` completed a full remote-to-local
copy in 769.5 seconds, compared with 990.3 seconds for the preceding candidate
run with identical entity counts. Remote reads took 619.2 seconds, local writes
146.0 seconds, and measurement 4.1 seconds. Proof-page writes fell from 75.7 to
9.8 seconds after indexed preflight lookup. These are sequential observations,
not a controlled full-wallet comparison against upstream main. The all-state
100 ms timer probe reported p95 delay of 908 ms; foreground focus was not recorded,
so this does not establish foreground UI latency. Separate 90-second native
foreground probes during a retained backup measured p95 delays of 5 ms for
transactions, 8 ms for outputs, 10 ms for heavier output pages, and 5 ms for
proof requests. Their maxima were 60, 51, 298, and 62 ms respectively; these
samples are not a whole-copy latency guarantee. The retained-backup test also
verified cancellation at a page boundary and automatic checkpoint recovery after
a full native app restart. Development testing required refreshing Vite's cached
linked dependencies to load the candidate schema consistently. See
[PR486](https://github.com/bsv-blockchain/ts-stack/pull/486) for final integration
completion and release evidence. Personal deployment and wallet details are
retained privately, outside this repository.

`listOutputs` reports `totalOutputs` as the full matching result count on every
page for both Knex and IndexedDB storage, including short final pages and pages
requested at or past the end of the result set.

### UMP account continuity and phone changes

Argon2id password derivation uses a proven-ready host backend when one is
registered with `registerArgon2idBackend`. This lets React Native applications
perform the memory-hard operation asynchronously in native code. Browser and
Node runtimes prefer `hash-wasm`; when WebAssembly is unavailable, Wallet
Toolbox falls back to an asynchronously yielding JavaScript implementation
with the same parameters and output. Existing UMP v3 tokens remain
interoperable and do not need migration; users do not need to enable a device
or browser setting. A selected host backend is authoritative, so a derivation
error or malformed output is surfaced instead of silently changing
implementations. The existing `hash-wasm`-compatible utility export retains its
full input and output contract; requests with `secret`, non-binary output, or
non-`Uint8Array` input remain on `hash-wasm` rather than being reinterpreted by
a backend with narrower capabilities. Registration and unregistration are also
exported from the mobile and client package roots. Concurrent cold calls share
one background preload attempt; later calls can retry after it settles. Hosts
must make preload/readiness checks reentrant and cache permanent failures or
apply retry backoff. Unrelated `hash-wasm` errors propagate even when the
WebAssembly global is absent. Native and JavaScript results both pass the same
byte-type and exact-length validation.

`WalletAuthenticationManager` accepts an optional `umpTokenOutpoint` in the
backward-compatible WAB authentication response. Normal verified lookup and
lineage resolution always run first. The WAB pin is considered only when those
checks leave multiple valid UMP tokens, and only when the pinned outpoint is
present in the verified candidates. A pin cannot introduce an outpoint that the
wallet did not independently retrieve and validate.

New WAB registrations are interruption-safe across the off-chain/on-chain
boundary. A WAB that advertises `registrationStatus: "pending"` lets a verified
retry reuse the stored presentation key when a clean UMP lookup confirms that
publication has not happened. After publishing the UMP token, the manager
finalizes WAB idempotently. A lost finalization response is non-fatal: the next
verified login finds the published token and repairs the pending state. Missing
or invalid lifecycle metadata remains fail-closed for established accounts, and
older WAB servers and clients retain their existing wire behavior.

Authenticated applications can verify a phone number and roll the presentation
key, including when the user enters the same phone number:

```ts
await manager.startPhoneNumberChange('+12065550100')
await manager.completePhoneNumberChange(code)
await platformKeyStore.storeSecret('wallet-snapshot', manager.saveSnapshot())
```

The completion call first stages the verified phone association and new key in
WAB while retaining the current presentation key, then publishes the UMP update
that consumes the current token, and finally promotes the staged WAB key. A
transient publish or finalization failure can be retried without duplicating
completed work. If the app restarts between phases, a later verified login
receives both current and pending keys and selects the one backed by the
verified UMP token before idempotently finalizing. Repeating phone verification
also resumes an unpublished staged change without committing another key.
Persist the snapshot immediately after success. Deploy the compatible overlay
topic and WAB schema/routes before enabling this UI.

### Snapshot security

`CWIStyleWalletManager` and `SimpleWalletManager` snapshots contain wallet root
key material and intentionally embed the key needed to restore that material.
Encryption protects their internal representation, but it does not make the
snapshot safe to disclose: **access to a snapshot is access to the wallet**.
Store the complete snapshot as a secret in an OS Keychain, hardware-backed
keystore, or comparably trusted storage. Do not put snapshots in ordinary
localStorage/AsyncStorage, logs, analytics, crash reports, unprotected backups,
clipboard data, or cloud sync. If a snapshot may have escaped trusted storage,
treat the wallet credentials as compromised and rotate them; deleting one copy
does not revoke other copies.

Remote `StorageClient` and credential-bearing Arcade SSE endpoints require
HTTPS. Plain HTTP is accepted only for explicit loopback hosts during local
development. Arcade SSE dependency debug logging remains disabled because its
request URL and headers carry wallet callback credentials.

Certificate signatures fail closed at every wallet trust boundary. Direct and
issuer-mediated acquisition require an affirmative certifier-signature result
before storage, and identity discovery verifies each untrusted overlay
certificate before decryption or trust scoring.

### ChainTracks sources and networks

Wallet services do not require a WhatsOnChain key for ChainTracks. Node
runtimes on mainnet, testnet, and TerraTestNet use the public
Arcade/go-chaintracks v2 HTTP and SSE surfaces by default. Browser and webview
runtimes on mainnet/testnet temporarily select the legacy CORS-enabled service
until the v2 edge serves CORS and OPTIONS; `Services.getHeight` also falls back
to WhatsOnChain on those networks if ChainTracks is unavailable. Bulk batches
still pass through local serialization, hash,
continuity, and genesis checks; providers are tried in priority order; and a
synchronized tracker can continue serving its last-good checked data during a
provider outage. WhatsOnChain remains a mainnet/testnet fallback and anonymous
requests are serialized below its documented public rate.

The supported chain identifiers are `main`, `test`, `stn`, `ttn`, and `tstn`
(`mock` remains available for test utilities). STN and Terra Scaling TestNet do
not have operator-independent public endpoints: set `STN_CHAINTRACKS_URL` or
`TSTN_CHAINTRACKS_URL`, use the matching Arcade environment variable, or inject
an explicit `ChaintracksClientApi`. URLs ending in `/v2` use the reconnecting
go-chaintracks client; existing legacy v1 URLs and explicit clients remain
compatible. Browser and mobile distributions expose the same fetch/SSE client
without Node `Buffer` or filesystem dependencies.

Browser, mobile, and Node applications can instead make a persisted local
ChainTracks instance their primary SDK `ChainTracker`. Immutable checkpoint
assets are read through `BulkFileDataCacheApi` before any network request;
downloaded objects are length-, SHA-256-, linkage-, chain-work-, genesis-, and
proof-of-work-validated before use. Stale present-height reads return the
last-good value immediately while one coalesced refresh runs in the background.
Node services can inject `NodeBulkFileDataValidator` to transfer complete-object
verification through a bounded worker pool; browser and mobile builds retain
the portable `InlineBulkFileDataValidator`. Filesystem deployments can combine
the content-addressed, quarantining `BulkFileDataCacheFs` with
`DurableFileBulkFileDownloadBudget`, which flushes a conservative reservation
before every physical attempt and preserves the allowance across restarts.
`LocalChainTracker` reserves remote clients
for explicit remote-only mode, local exceptions, and quorum-backed consistency
or recovery checks. See
[Local-first ChainTracks](./docs/local-first-chaintracks.md) for packaging,
background synchronization, migration, and advanced-settings requirements.

Arcade is the HTTPS/SSE gateway for Teranode-backed header data. Its v2 edge
must allow browser origins and OPTIONS before browser defaults can use it;
direct Teranode P2P is not included in browser/mobile artifacts.

TTN wallets also register
`https://arcade-v2-ttn-us-1.bsvblockchain.tech` as their first broadcast and
Merkle-proof provider. Mainnet and testnet Arcade broadcasting remains opt-in.
Pass an explicit `arcadeUrl` to override the TTN endpoint or an empty string to
disable it. TTN overlay lookups use the separate `teratestnet` resolver preset
and never fall back to testnet discovery.

### Broadcast rejection and monitor reconciliation

When Arcade is configured, Wallet Toolbox consumes Arcade's status code and
validator detail instead of treating every `REJECTED` event alike. Retryable
parent and locktime conditions stay pending. Terminal validator failures fail
the request, and explicit missing-input or conflict evidence also quarantines
every wallet-owned copy of the consumed input in the same storage transaction.
That quarantine uses Arcade's positive rejection evidence and does not require
WhatsOnChain or another UTXO explorer.

Arcade is also registered as a transaction-status provider, so monitor review
continues on networks without WhatsOnChain. A scheduled bounded pass revisits
pending requests after their immutable creation-age threshold and applies
durable Arcade lifecycle verdicts that may have arrived while SSE was
disconnected, including `SEEN_IN_ORPHAN_MEMPOOL`. Routine proof checks may
refresh diagnostic timestamps without postponing that review. A descendant of
a locally terminal parent is also failed from that storage evidence; the failed
parent output remains quarantined while unrelated inputs are released for
reuse. Mined/known evidence takes precedence over a stale rejection. Provider
absence and provider errors are treated as inconclusive, never as proof that an
output was spent.
After an input conflict has been recorded, a later cached accepted/seen label
cannot restore the failed transaction; recovery requires a mined status and a
Merkle proof validated by the configured chain tracker. Arcade SSE events are
acknowledged in order only after their storage update and cursor persistence
succeed, so a transient storage failure is retried instead of skipped.

Invalid-change review applies the same positive-evidence rule. Only an
explicit successful `isUtxo: false` result is considered spent; a provider
error, rate limit, timeout, missing provider, missing script, or malformed
response is unknown. Read-only scans return the conclusive picture plus the
unknown count. Direct destructive release remains all-or-nothing: any unknown
throws `WERR_UTXO_REVIEW_INCONCLUSIVE` before mutation. The authenticated
Monitor Admin tool instead uses 20-output pages (four provider calls in flight,
five-second per-output review deadline) and may explicitly release the
positively spent subset while retaining and reporting unknowns. Each confirmed
spent output is rechecked for ownership and allocation state under the write
lock, and every release or blocked release records bounded audit evidence.

Core ChainTracks factories accept a final source-options argument when an
application must override the defaults. Set `disableChaintracks`, `disableCdn`,
or `disableWhatsOnChain` to `true` to opt out of an automatic source, or pass an
explicit `chaintracks` client to retain an existing deployment topology. The
same options accept a `bulkFileCache` and `bulkFileDownloadBudget`; all earlier
positional arguments remain unchanged.

## Getting Started

### Installation

```bash
# Full (Node.js servers, CLIs)
npm install @bsv/wallet-toolbox

# Browser apps
npm install @bsv/wallet-toolbox-client

# React Native / mobile
npm install @bsv/wallet-toolbox-mobile
```

### Quick Example

```typescript
import { SetupWallet } from '@bsv/wallet-toolbox'

// Create a wallet with SQLite storage and default mainnet services
const wallet = await SetupWallet({
  env: 'main',
  endpointUrl: 'https://your-storage-server.example.com'
})

// Create a transaction
const result = await wallet.createAction({
  description: 'Send payment',
  outputs: [
    {
      lockingScript: '76a914...88ac',
      satoshis: 1000,
      outputDescription: 'payment'
    }
  ]
})
```

Completed `createAction` and `signAction` results from the public Wallet
interface return Atomic BEEF in `tx` as a numeric array. This preserves the
historical BRC-100 shape across plain JSON bridges; parse it with
`Transaction.fromAtomicBEEF(result.tx)`. The `AtomicBEEF` type and binary Wallet
Wire transports also support `Uint8Array`.

`internalizeAction` accepts canonical BRC-95 envelopes and legacy envelopes
that contain unrelated BEEF branches. The wallet restricts either form to the
declared transaction and its recursive dependencies before independently
validating every transaction, proof, and BRC-29 payment output.

## Documentation

[Full API documentation](https://bsv-blockchain.github.io/wallet-toolbox) is available on GitHub Pages.

See [Managed change, sweeping, and recovery](./docs/managed-change-policy.md)
for the default-basket invariant, automatic funding policy, and supported
`internalizeAction` repair paths.

See [Managed-change liquidity policy](./docs/managed-change-liquidity.md) for
the 144-output / 5,000-satoshi defaults, gradual legacy-wallet migration,
pending-parent policy, exact BEEF comparison, operator tuning, action-batch
alignment, monitoring, and rollout guidance.

See [Prepared BEEF (COOK)](./docs/prepared-beef.md) for the opt-in Knex cache
that creates an exact, verified proof closure once and keeps it ready for a
future `createAction`. Reads, writes, and bounded backfill are separately
controlled and default off; cache misses and failures retain the canonical
BEEF builder.

See [In-memory action batch planning](./docs/action-batch-planning.md) for
capability-negotiated `noSend` planning, compact manifests, compressed binary
pack transport, atomic commit, compatibility behavior, and retained benchmarks.

See [Expiring `noSend` actions](./docs/no-send-expiry.md) for the built-in
BRC-111 `p nosend expiry` module, exact label forms, prefunding, durable
Node/browser/mobile monitoring, storage coordination, and proof-based race
resolution.

### `createAction` performance telemetry

Wallet Storage treats `inputBEEF` as proof data for the inputs declared in the
action. Remote clients retain only those input transactions and their recursive
proof dependencies before request serialization, reducing transfer and parsing
work. The server repeats the same pruning before verification and persistence
as a trust-boundary defense for old, custom, or malicious clients. Structurally
valid but unrelated branches are ignored; malformed BEEF and incomplete or
invalid proof data for a declared input remain errors.

With the optional SDK telemetry sink enabled, legacy `createAction` reports
bounded-cardinality spans for input validation, record/output persistence,
funding candidate selection, fee-aware planning, atomic input claiming, input
assembly, proof fetch, BEEF merge, and final trim/serialization.
Only counts, byte sizes, fee totals, retry counts, and durations are reported;
transaction IDs, scripts, payloads, keys, and identities are not attributes.

The planner uses the same exact / least-over / largest-under selection policy
as the historical allocator, but proves economic sufficiency before writing a
transaction and claims every selected input in one database transaction. Knex
storage automatically adds a composite funding-selection index on migration;
IndexedDB schema version 4 adds corresponding user/basket and outpoint indexes
and resolves transaction-status eligibility in one indexed pass.

The retained fragmented-funding benchmark is runnable with:

```bash
pnpm bench:create-action-funding
pnpm bench:create-action-beef
```

The proof-bearing benchmark includes a prepared-BEEF cohort and asserts that a
prepared hit does not invoke the canonical BEEF builder. A representative
local SQLite one-input run reported 8.04 ms on the cold canonical path and
4.39 ms on the prepared path. Local timings are noise-bound; the intended
production measurement is the authenticated remote/MySQL cohort, where
repeated proof reconstruction has materially higher cost.

Against unmodified commit `c212b5ee7`, a representative 102-input SQLite plan
fell from 622 queries, 102 database transactions, and 107.3 ms to 17 queries,
one transaction, and 8.8 ms. Query and transaction counts remain flat when the
selected input count grows; networked database deployments should benefit most.

The proof-bearing benchmark also exercises the authenticated remote wallet,
real BRC-103 storage RPC, BRC-29 signing, packed WASM digest verification, and
24-level proofs grouped by block. On the PXC staging topology, 20 independent
153-input samples measured 376.0 ms p50 and 461.6 ms p95; the corresponding
direct storage cohort measured 99.3 ms p50 and 137.4 ms p95. A normal one-input
authenticated cohort measured 78.6 ms p50 and 105.6 ms p95. All 3,080 signature
verdicts passed. A selective production-shaped database copy with 110 fragmented
inputs measured 75.5 ms p50 and 155.4 ms p95 for direct storage. The benchmark
captures client, server HTTP, authentication, RPC, storage, signing,
verification, and serialization spans and retains gates of 100 ms p50 / 150 ms
p95 for the normal cohort and 500 ms p95 for the 153-input cohort. These are
regression gates, not universal hardware guarantees.

Trace context remains local to the telemetry carrier and sink. Wallet Toolbox
does not add telemetry headers to AuthFetch, so BRC-103/104, Auth Express
Middleware, AuthSocket, JSON-RPC, and mixed-version remote storage behavior are
unchanged.

The codebase has detailed JSDoc annotations throughout — these will surface inline in editors like VS Code.

### Horizontal Storage scaling

`StorageServer` uses an in-process BRC-103 session manager by default. Before
running multiple processes or replicas behind a non-sticky load balancer, use
the shared Knex implementation against the same migrated wallet database:

```typescript
import { KnexSessionManager, StorageKnex, StorageServer } from '@bsv/wallet-toolbox'

const storage = new StorageKnex(storageOptions)
await storage.migrate(storageName, storageIdentityKey)
await storage.makeAvailable()

const sessionManager = new KnexSessionManager(storage.knex, {
  ttlMs: 24 * 60 * 60 * 1000,
  // Optional. Set to 0 when every authenticated use must update the row.
  touchIntervalMs: 60 * 1000
})

const server = new StorageServer(storage, {
  port: 3000,
  wallet,
  monetize: false,
  sessionManager,
  // Optional: exact trusted proxy chain. Omit for direct-socket IPs.
  trustProxy: 1,
  // Per-IP before auth (default 300/minute).
  preAuthRateLimit: { limit: 300, windowMs: 60_000 },
  // Per-identity before payment/RPC work (default 1,000/minute).
  rateLimit: { limit: 1_000, windowMs: 60_000 },
  // Public CORS is the default. Supply exact origins to opt into a whitelist.
  allowedOrigins: process.env.WALLET_ALLOWED_ORIGINS?.split(','),
  // Optional CSP/security-header overrides for an embedding deployment.
  securityHeaders: {
    contentSecurityPolicy: "default-src 'none'"
  },
  logRpcRequests: false
})
server.start()
```

Shared Knex sessions immediately persist authentication, nonce, identity, and
certificate-state transitions. For an already-authenticated row, the default
manager coalesces only timestamp-only usage touches for up to one minute. This
avoids a synchronous replicated write on every RPC while keeping durable expiry
within a bounded minute of the most recent use. Use `touchIntervalMs: 0` to
retain exact per-request timestamp persistence.

Both stages return HTTP 429 with `ERR_RATE_LIMITED`. For multi-process or
multi-replica deployments, configure a shared `express-rate-limit` store in
both options so limits are aggregate rather than per process. Never use a
permissive trust-all proxy setting; use a known hop count, subnet, or trust
predicate.

The storage service is intentionally reachable by browser apps on previously
unknown domains. With no origin configuration it uses public wildcard CORS
without cookie credentials. Passing `allowedOrigins`, setting
`WALLET_STORAGE_CORS_MODE=allowlist`, or setting the mode to `disabled`
provides opt-in restriction. BRC-103 authentication and optional payment
policy are unchanged by CORS mode.

Every replica must share the same database and session TTL. Run
`sessionManager.pruneExpiredSessions()` from one scheduled maintenance worker;
reads exclude expired rows even before they are physically pruned. Once every
replica uses the shared manager, authenticated requests no longer require
client-IP or cookie affinity.

Run `StorageKnex.migrate(...)` before constructing the manager during an
upgrade. `makeAvailable()` validates and loads an already-migrated database; it
does not apply schema changes.

## Development

```bash
git clone https://github.com/bsv-blockchain/ts-stack.git
cd ts-stack
pnpm install
pnpm --filter @bsv/wallet-toolbox format:check
pnpm --filter @bsv/wallet-toolbox lint
pnpm --filter @bsv/wallet-toolbox typecheck
pnpm --filter @bsv/wallet-toolbox test
pnpm --filter @bsv/wallet-toolbox test:coverage
pnpm --filter @bsv/wallet-toolbox pack:check
pnpm --filter @bsv/wallet-toolbox-client test:browser
pnpm --filter @bsv/wallet-toolbox-mobile test:mobile
```

Tests use Jest. The default and coverage suites are deterministic and must not
depend on live third-party services. Files named `*.man.test.ts` are explicit
manual/integration tests excluded from CI because they require credentials,
network access, or long runtimes. Files named `*.live.test.ts` are public-network
checks, also excluded from deterministic PR coverage. Run exactly one governed
suite with `test:manual -- <path>` or `test:live -- <path>` after reviewing
`governance/test-quality/policy.json`; never batch-run operator suites. CI
merges four Wallet Toolbox coverage shards
for reporting; the complete local `test:coverage` run currently measures
69.12% statements, 59.09% branches, 72.83% functions, and 71.06% lines.

Operational repair, migration, export, and long-running service procedures are
not tests. They live under [`operator/`](./operator/README.md), produce an exact
dry-run plan by default, and require explicit confirmation before they write
state or artifacts. The exact manual-suite disposition inventory in
`governance/test-quality/wallet-toolbox-manual-suites.json` prevents new
operator procedures, fixture generators, diagnostics, or examples from being
silently added as Jest suites.

Reusable source recipes live under [`examples/`](./examples/README.md). Manual
integration suites may validate an example against an explicitly configured
environment, but the example implementation itself does not live inside a test
body.

`pack:check` installs the exact CommonJS tarball and verifies its public API.
The browser and mobile commands build platform-specific packages and reject
Node-only dependency leakage. Publishing and version changes are owned by the
repository release workflow.

## Contributing

We welcome bug reports, feature requests, and pull requests.

1. Fork and clone the repository
2. `pnpm install` at the `ts-stack` repository root
3. Create a feature branch
4. Make your changes and run the relevant package checks above
5. Open a pull request

See the
[repository contribution guidelines](https://github.com/bsv-blockchain/ts-stack/blob/main/CONTRIBUTING.md)
for the full stack-wide policy.

## Contributors

|     | Name                  | GitHub                                                 | Role                       |
| --- | --------------------- | ------------------------------------------------------ | -------------------------- |
|     | Tone Engel            | [@tonesnotes](https://github.com/tonesnotes)           | Lead developer, maintainer |
|     | Darren Kellenschwiler | [@sirdeggen](https://github.com/sirdeggen)             | Core contributor           |
|     | Brayden Langley       | [@BraydenLangley](https://github.com/BraydenLangley)   | Core contributor           |
|     | Ty Everett            | [@ty-everett](https://github.com/ty-everett)           | Core contributor, reviewer |
|     | Jackie Lu             | [@jackielu3](https://github.com/jackielu3)             | Contributor                |
|     | David Case            | [@shruggr](https://github.com/shruggr)                 | Contributor                |
|     | Stephen Thomson       | [@Stephen-Thomson](https://github.com/Stephen-Thomson) | Contributor                |
|     | Chance Barimbao       | [@ChanceBarimbao](https://github.com/ChanceBarimbao)   | Contributor                |

## License

This package is released under the [Open BSV License Version 6](./LICENSE.txt).
The accompanying [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) and
[LICENSES/](./LICENSES/) preserve the package's earlier Open BSV grant.
