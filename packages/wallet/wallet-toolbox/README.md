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

### SQLite migration recovery

The unpublished 2.13.2 candidate runs SQLite migration DDL and the migration
journal update transactionally. Foreign-key enforcement is disabled before the
migration transaction for table rebuilds and restored after success or failure.
Failed migrations can be retried after reopening the database without partial
schema objects from that attempt. MySQL's existing transaction configuration
is unchanged.

This prevents future partial migrations. It does not automatically repair a
store already left with unjournaled schema objects by an older version. Preserve
the database and verified backups and reconcile the exact schema and migration
journal before recovery; do not delete journal rows or wallet data blindly.

## Overview

The Wallet Toolbox is the reference implementation of the BRC-100 wallet interface. It connects the BSV SDK's cryptographic primitives to real storage backends, network services, and signing flows so that application developers don't have to wire these layers together themselves.

BSV Desktop and BSV Browser are the BSV Association reference wallet applications built around this interface. Vendor distributions, including Babbage's Metanet Desktop / Metanet Explorer and Hudos Browser, can implement the same BRC-100 interface against their own product packaging and service defaults.

### Local contact trust

Applications may install a `ContactSource` on `WalletArgs` to resolve identities from the user's
local contacts before querying the certificate overlay. Installing that source is an explicit
personal trust-policy decision: a saved contact is locally authoritative in the same sense as a
self-signed certificate or locally installed trust anchor. Its default infinite trust means “the
user's independent validation overrides third-party trust thresholds,” not “an external certifier
proved this identity.”

The authority is scoped to the wallet user who saved the identity-key association and to that
wallet's local labels and metadata. Authentication or encryption of the contact store proves that
the wallet retained the user's decision; it does not independently prove the real-world identity,
and the infinite-trust value must not be exported as a universal claim for other users.

Contact results retain the discovery result shape for compatibility, but default to type `contact`
and carry empty serial, signature, and revocation-outpoint fields. Consumers must not present those
fields as third-party certification. Connect `ContactSource` only to local, authenticated storage
whose records the user has deliberately saved or validated; never populate it directly from
unauthenticated network data. Pass `forceRefresh: true` to identity discovery when the application
specifically needs to bypass local contact authority and query the overlay.

### Fiat exchange-rate trust boundary

Wallet Toolbox treats exchange-rate providers and custom service adapters as
untrusted financial inputs. Rates must use the supported currency codes, be
finite, positive, and bounded, use USD base with an exact USD rate of 1, and
carry a valid timestamp no more than five minutes in the future. Malformed or
missing requested rates are never merged into the wallet cache.

The default provider transport accepts only credential-free public HTTPS,
pins validated DNS answers in Node.js, rejects redirects and private/special
addresses, and enforces a 15-second deadline plus a 256 KiB response limit.
`fiatExchangeRatesFetch` is an explicitly trusted escape hatch for tests or
controlled local development; production applications should retain the
default transport.

### ARC and Arcade provider configuration

ARC-compatible broadcaster configuration is snapshotted when the provider is
constructed. API keys, callback tokens, deployment IDs, callback URLs, and
custom headers therefore keep the exact reviewed values even if the caller
later mutates its configuration object. Custom headers must be a plain
accessor-free own-data map with valid HTTP token names and bounded string
values; inherited fields and getters are rejected without being used.

The provider URL and an injected `httpClient` remain explicit application or
operator trust decisions. Do not derive them from transaction, peer, or other
untrusted input. Reconstruct the provider to rotate credentials or headers;
mutating the original configuration object does not change a live provider.

### Importing legacy P2PKH outputs

`Setup.fundWalletFromP2PKHOutpoints` and its client equivalent validate each
canonical outpoint, fetched transaction ID, P2PKH ownership script, atomic
signing target, and final wallet transaction before reporting success. Provider
downloads are deadline-bound, redirect-free, and size-bounded; recursive BEEF
construction also limits depth, graph size, aggregate source bytes, and the
number of requested outpoints. If an application already has authenticated
BEEF, pass it explicitly to avoid relying on public transaction-data services.
Do not accept a wallet result that omits the transaction bytes needed for this
binding.

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

Permission-token basket membership and tags are discovery hints, not authority.
Before using a stored token, the manager binds it to its exact BEEF outpoint and
one-satoshi output, verifies the canonical PushDrop field signature and locally
derived locking key, strictly decodes every signed grant field, and rechecks the
requested filters against that signed content. Unsigned, foreign-wallet,
substituted, malformed, or mislabeled rows grant no permission. Token issuance,
renewal, coalescing, and revocation also bind every requested input and output to
the final wallet transaction; a partial-action reference never authorizes a
different transaction. When the underlying Wallet Toolbox signer adds a storage
service charge, its exact wallet-funded amount is carried locally into the
spending check so the charge is visible and counted in authorization. This
metadata is deliberately not a BRC-100 wire extension.

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

`sendWith` transaction IDs form one atomic broadcast set: the wallet never
silently slices that set into separately submitted groups. A set is limited to
1,000 unique transactions, including a transaction created or signed by the
current call. Oversized or noncanonical requests are rejected before storage
commit. The background monitor bounds both discovery and re-expansion of older
queued batches; an oversized legacy batch is skipped as a whole and reported
for operator recovery rather than partially broadcast.

`Setup.makeEnv()` returns a development `.env` template containing newly
generated private keys but never prints it. Callers must deliberately write the
returned text to a protected local file and must not route it through ordinary
application, CI, or shared terminal logs.

### Packages

The toolbox publishes three npm packages from this repo:

- **[`@bsv/wallet-toolbox`](https://www.npmjs.com/package/@bsv/wallet-toolbox)** — Full package with all storage backends (SQLite, MySQL, IndexedDB, remote)
- **[`@bsv/wallet-toolbox-client`](https://www.npmjs.com/package/@bsv/wallet-toolbox-client)** — Browser build; excludes Node-only backends (Knex/SQLite/MySQL)
- **[`@bsv/wallet-toolbox-mobile`](https://www.npmjs.com/package/@bsv/wallet-toolbox-mobile)** — Mobile build; remote wallet storage plus portable local ChainTracks components and adapter contracts

### Sync performance and recovery

Sync pages start at 64 records and adapt after successful commits toward a
five-second marginal-work budget. A bounded history separates fixed read and
commit overhead from per-record work, so slow fixed latency does not collapse
large copies to one record per request. A two-record probe permits recovery from
the single-record floor. Proof-bearing pages cap growth at 128 records; metadata
pages can grow to 1,000, while provider byte/item ceilings still apply. These are
work estimates, not deadlines: an individual proof or unavailable dependency can
still take longer.
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

The transfer extension is included in the published 2.13.2 graph. Older 2.12.0
providers have no record-transfer methods. Check exact build provenance and
authenticated runtime capabilities, not a version label alone. An oversized record on a legacy
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

Output synchronization requires a local mapping for every non-null source basket
ID. A missing mapping rejects the page so its transaction and checkpoint can roll
back; retry after transferring the missing basket. Newer source updates apply
basket changes, including explicit removal. Same-time or older updates preserve
local relinquishment. Previously unbasketed records require a verified newer
source update to repair; no heuristic rewrites existing wallet state.

`StorageKnex.getRawTxOfKnownValidTransaction()` can read a cold store while the
caller holds a transaction, including SQLite's single-connection pool. Settings
are read through that transaction without entering the shared cache or starting
prepared-BEEF background work; ordinary `makeAvailable()` remains the explicit
store-wide startup operation. An absent optional `inputBEEF` does not prevent
returning stored raw transaction bytes.

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

### Resumable pulls and foreground access

`WalletStorageManager.syncFromReaderResumable(identityKey, reader, options)`
adds per-page progress and cancellation without changing the existing sync
method signatures. The result reports `completed` or `cancelled`, page and row
counts, the last acknowledged checkpoint, and the selected execution mode.

The new resumable API defaults to a 256 KiB rough page target, with an explicit
ceiling up to 10 MB. Existing sync methods retain their previous defaults.

```ts
const cancellation = new AbortController()
const result = await storage.syncFromReaderResumable(identityKey, reader, {
  signal: cancellation.signal,
  maxItems: 128,
  maxRoughSize: 262144,
  onProgress: progress => console.log(progress.state, progress.pages)
})
// A later invocation loads durable destination progress, including any page
// whose acknowledgement was lost. Do not replay a saved request manually.
```

Local SQLite/MySQL and IndexedDB destinations advertise `storageAccess.version`
1 with atomic sync checkpoints. Their paged pull reads and prepares one source
page outside manager write ownership, then queues its atomic data/checkpoint
commit. Network-backed proof checks finish before that queue is acquired; the
commit rejects changed proof records. Payloads are detached during preparation,
and a prepared page can only be consumed once. Foreground operations can run
between pages and during source/proof I/O. Supported reads share up to eight
slots; writers remain exclusive. A waiting background page gets a turn within
eight foreground grants or after one second of waiting at the next release.
This bounds queue preference, not the duration of a provider operation.

Cancellation before a commit discards that page. Cancellation during a commit
waits for its acknowledgement, reports the committed checkpoint, then stops.
Source I/O also settles before the stopped result: custom providers must supply
their own I/O deadlines. Failures propagate without blind write replay; restart
loads the durable checkpoint. Changing the selected primary fences an older
session before its next write. Concurrent copies of the same source cannot both
commit the same checkpoint. Progress observers receive independent checkpoint
copies and run outside page ownership in paged mode.

Missing capabilities, remote destinations, self-copies, existing whole-copy
methods and primary reconciliation retain exclusive execution. A failed
capability lookup falls back to serialization. Page ceilings are rough encoded
size hints; the existing negotiated per-record transfer bounds still apply to
large records. One page is in flight, and progress does not accumulate wallet
records or per-record logs. Source pagination retains the existing eventual
replication contract: this API is **not a coherent source snapshot**. Source
snapshot handles and streaming portable archives require their separate
consistency and format contracts.
The existing timestamp boundary is inclusive: an unchanged copy can reread rows
sharing the final timestamp, including an entire same-timestamp import. Those
rows are not rewritten. This protects late same-time arrivals; a coherent source
revision/snapshot is needed to eliminate that boundary traffic safely. Smaller
`maxRoughSize` values (for example 262144) reduce transient authenticated HTTP
memory and event-loop work for constrained devices, at the cost of more pages.

Every live sync checks declared network chains before registering a destination
user or checkpoint. A missing or unrecognized chain is not inferred. Thrown and
returned provider errors take precedence over `done`, counters and checkpoint
hints; unfinished pages without durable progress stop instead of spinning.
`WERR_NETWORK_CHAIN` and `ProcessSyncChunkResult.error` remain compatible.

### Canonical proof recovery during actions

When services are configured, selected-change BEEF is checked before returning
to the signer, including embedded ancestry and prepared artifacts. The actual
send/monitor path checks its rebuilt bundle as well. Valid graphs avoid extra
proof-record reads and copies; checks run with at most eight operations in
flight. Stale roots trigger bounded canonical lookups. Replacement transaction
bytes, Merkle membership, root and active header must agree before use.

SQLite/MySQL and IndexedDB persist verified corrections with a compare-and-set
against the original proof, and invalidate prepared artifacts in the same
transaction. A concurrent repair is never overwritten. Custom providers may
implement `compareAndSetProvenTxProof`; the default repairs only the outgoing
graph. Failed recovery retains the source records, stops before broadcast, and
returns `WERR_INVALID_MERKLE_ROOT` with its txid, root and height across JSON-RPC.
Failed construction releases its funding reservation through the existing
failed-action cleanup; it does not mark the input spent without evidence.

Standalone storage construction without configured services retains its offline
contract; its caller must validate before signing or broadcasting. This change
does not audit historical block-hash metadata or repair every stored proof:
BEEF root validity and an operator's historical-store audit remain distinct.

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

UMP renewal consumes only the exact canonical predecessor returned for its
outpoint. Its signed fields, presentation/recovery hashes, and locally derived
admin-token locking key are verified before the old token is signed. The manager
locates the predecessor at its actual input index and accepts the completed
action only when it preserves every authorized input and output, contains one
exact one-satoshi replacement token, and reports the transaction's real ID.

WAB faucet funding is subject to the same action-completion binding. The faucet
response must contain the exact declared Atomic BEEF target and output zero must
commit to the supplied nonzero R-puzzle scalar. The manager signs that outpoint
at its actual wallet input index and sends the fee-adjusted balance only to an
explicit BRC-29 output derived for the authenticated wallet. That output's exact
script and bounded amount are authorized before signing; an unrequested wallet
output cannot consume the faucet input. The signed action is staged locally,
labeled, and recorded in a recovery basket before broadcast. A retry recovers
and internalizes that exact transaction, or recognizes its already-internalized
managed output, instead of authorizing a second destination. Missing, reordered,
substituted, ambiguous, or result-only transactions fail closed.

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

Remote storage responses must also complete BRC-103 mutual authentication;
ordinary HTTP fallback responses are rejected. Without an explicit
`serverIdentityKey`, the first authenticated server identity reached through
the configured HTTPS endpoint is authoritative for that client instance and
cannot change during its lifetime. Applications that independently provision
or validate the server key should pass it as `serverIdentityKey` to pin the
expected peer from the first response. In either mode, the
`storageIdentityKey` returned by the authenticated `makeAvailable()` response
is authoritative for that client instance. It may be distinct from the server
transport identity; applications that independently provision it can pin it
with the separate `storageIdentityKey` option. JSON-RPC responses are accepted
only when their version and request ID match and they contain exactly one of
`result` or `error`.

Certificate signatures fail closed at every wallet trust boundary. Direct and
issuer-mediated acquisition require an affirmative certifier-signature result
before storage, and identity discovery verifies each untrusted overlay
certificate before decryption or trust scoring.

BRC-100 originators may include a numeric port for compatibility, including
local-development ports. Permission and administrator authority is deliberately
scoped to the normalized lowercase hostname: all ports on one hostname are the
same originator. Existing authenticated permission tokens that recorded a port
are discovered through a bounded compatibility lookup and compared by hostname.

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

The configured ChainTracks endpoint remains the authority for the selected
chain view. Its transport bytes are not trusted blindly: JSON and binary reads
remain under one deadline and fixed byte ceilings, redirects are rejected, SSE
events have byte and idle-time limits, and every returned header is canonical,
proof-of-work-valid, and bound to the requested network, height, or hash before
use. Binary batches must be exact 80-byte linked sequences. The additive
`GoChaintracksServiceClientOptions` limits can be lowered for constrained hosts.
Live metadata is accepted only as a complete record with positive local
identities. Reorganization deactivation lists are bounded by their declared
depth, start at the old tip, contain no duplicates, and form one descending
linked chain before wallet monitor callbacks receive them. Remote diagnostic
text is reduced to bounded single-line output. The monitor repeats these checks
at its own trust boundary for custom event adapters, requires every configured
chain source to match the wallet network, and retains at most 4,096 unique
deactivated headers by default. `MonitorOptions.maxQueuedDeactivatedHeaders`
can lower that ceiling. Prepared-proof invalidations are coalesced and drained
during teardown; partial event subscriptions and rejected application
callbacks are contained and reported through bounded monitor events.
The legacy `BHServiceClient` applies the same endpoint, whole-body deadline,
byte, range, hash, linkage, and proof-of-work checks. Its historical public
`cache` property remains for source compatibility but is diagnostic only:
neither callers nor old or rejected roots can make it authoritative, and every
Merkle-root verdict resolves the current canonical header again so
reorganizations remain visible.
Local ChainTracks instances also validate and copy submitted headers, ignore
duplicate pending submissions, and retain at most 4,096 by default; the live
SSE adapter applies the same default queue ceiling. Construction rejects
unsupported networks, unsafe recursion/queue limits, and malformed ingestor
collections. Library logging is silent by default; applications that need
operational output must provide the existing optional `logging` callback.
Startup methods await initialization and surface failures; a failed attempt can
be retried, while `destroy()` drains sources and releases storage even if the
instance never became available. Header and reorganization subscriptions are
bounded, deleted on unsubscribe, and receive isolated snapshots so one listener
cannot alter another listener's event.

Local persistence treats both stored metadata and adapter calls as integrity
boundaries. Memory-backed trackers are instance-isolated; IndexedDB and Knex
require one active tip and one active header per height, reject nonconsecutive
parent links, bound ancestor walks, and fail closed on malformed state. Knex
serializes tip mutation with an internal transaction lock row. Run every
ChainTracks Knex migration before serving traffic. On MySQL, the migration
changes hex identifiers to `VARCHAR(64)` and cached header bytes to `LONGBLOB`;
because the former `VARBINARY(32)` representation could irreversibly truncate
live identifiers, the derived live-header cache is cleared and rebuilt from
authenticated bulk data during that migration.

To downgrade to code that predates the repair migration, first stop every
ChainTracks writer and take a verified database backup together with the
authenticated bulk-header data needed to rebuild the live cache. Using the
current `ChaintracksKnexMigrations` source, run a targeted `knex.migrate.down`
for only
`2026-09-17-001 repair MySQL live-header encodings and bulk blob`. Its `down`
is intentionally a schema no-op: it removes that migration's ledger entry but
must leave the repaired `VARCHAR(64)` identifier columns, `LONGBLOB` bulk data,
the `chaintracks_state` lock row, and authenticated bulk files intact. Validate
that retained schema and data against the older code in a non-production copy
before starting it. Never roll down the initial migration, recreate the tables,
or convert the identifiers back to truncating `VARBINARY(32)` columns.

Bulk-file additions and extensions reach durable storage before becoming
visible in memory. Reconciliation and any replacement spanning multiple files
commit atomically in the built-in Knex and IndexedDB adapters, preserve stored
bytes omitted from an update, and restore the prior manager state on failure.
Custom `ChaintracksStorageBulkFileApi` implementations remain source compatible,
but must implement the additive `replaceBulkFiles` method before the manager
will perform a multi-file replacement; this fail-closed rule prevents a restart
from observing gaps or overlapping stale rows.

WhatsOnChain is authoritative only when an application deliberately enables it
as a fallback chain source. URLs returned by its resource manifest are not
local/operator configuration: they are treated as untrusted locators and must
remain credential-free public HTTPS. Node downloads resolve, approve, and pin a
public address into the TLS connection; browser downloads retain HTTPS,
redirect, CORS, deadline, and byte controls. Resource manifests, recent-header
JSON, binary files, and legacy WebSocket frames are bounded and strictly
validated. WebSocket history is admitted in ordered chunks, live queues are
capped, and every candidate header is canonical and proof-of-work-valid before
its declared target can affect chain-work selection.

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
before every physical attempt, serializes replicas through the shared state
file, and preserves the allowance across restarts. A crash-abandoned
`<stateFile>.lock` is deliberately not reclaimed automatically: after proving
that no writer is active, an operator must remove that narrow lock directory or
choose a fresh ledger path. Cache files are read only up to their advertised
size plus one rejection byte and writes must match the advertised SHA-256.
Cache replacement, promotion, and quarantine are serialized through a
per-object `<digest>.headers.lock` directory with the same fail-closed,
operator-confirmed abandoned-lock procedure. Callers may release or reuse their
input buffers immediately because the cache snapshots identity metadata and
bytes before waiting for that lock.
`LocalChainTracker` reserves remote clients
for explicit remote-only mode, local exceptions, and quorum-backed consistency
or recovery checks. See
[Local-first ChainTracks](./docs/local-first-chaintracks.md) for packaging,
background synchronization, migration, and advanced-settings requirements.

Legacy filesystem import/export is restricted to path-free manifest and data
filenames beneath the caller-selected root. A missing manifest is created only
for a definite not-found error; permission, size, parse, and integrity failures
remain visible. Local files must form a contiguous genesis-anchored chain and
all reads, writes, reader buffers, and queued lock operations are bounded.

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
The SSE client validates and owns every status record, retains at most 64 events
and 4 MiB by default, and enforces a 256 KiB ceiling per event. The additive
`maxEventBytes`, `maxPendingEvents`, and `maxPendingBytes` options may lower
those limits. A malformed, excessive, or failed event closes the stream and
prevents queued successors from advancing beyond the last durable cursor.
Client logging is silent unless `log` is supplied, and transport errors never
forward credential-bearing EventSource objects. Monitor startup awaits its
ChainTracks subscriptions and retries transient setup failures; removal and
teardown close Arcade SSE before storage is destroyed. Monitor operational
logging is likewise opt-in through `MonitorOptions.logging`.

### Transaction-status authentication

Transaction-status providers are untrusted observations, not permission to
change an arbitrary wallet transaction. Every result is copied and accepted
only when its txid is one of the exact requested ids and its depth agrees with
`mined`, `known`, or `unknown`. Terminal and input-conflict evidence is allowed
only on an internally consistent unknown lifecycle result. Competing txids and
diagnostics are bounded, and the durable provider name comes from local
configuration rather than the remote response.

A malformed provider response is recorded as that provider's failure and the
service tries the next configured source. Arcade additionally binds the whole
`GET /tx/{txid}` response to the request before interpreting lifecycle or proof
fields. Provider errors and omitted results remain unknown; they never become
mined, known, terminal, or input-conflict evidence by default.

### Raw transaction acquisition

Raw-transaction providers must return an accessor-free result whose declared
txid exactly matches the request. Transaction data is accepted only as a
nonempty dense byte array no larger than 32 MiB, copied before hashing, and
returned as wallet-owned bytes. The computed transaction hash must still match
the request. Provider attribution comes from local configuration, and an
invalid result is discarded before the next provider is tried.

### Merkle-proof authentication

Wallet proof providers are untrusted inputs. An ordinary `getMerklePath`
success is accepted only when a bounded, copied path contains an explicit leaf
for the requested transaction, computes the supplied header's Merkle root at
the same height, and the complete header resolves through the wallet's
proof-of-work-valid chain service. The monitor independently asks its configured
ChainTracks source to affirm that root and height before persisting proof state
or restoring a failed transaction. Raw transaction bytes must also hash to the
same txid.

Custom ordinary proof providers must return both a `MerklePath` and complete
`BlockHeader`; a path-only result is treated as unavailable. The additive
`getValidatedMerklePath` compatibility hook still permits a path-only custom
provider when its caller-supplied validator independently resolves and
authenticates the header. No proof-provider response, mined status label, or
non-null path alone is authority to release wallet funds.

Every configured proof provider is treated as untrusted. Wallet Toolbox checks
transaction membership, header/root agreement, and the active ChainTracks root
before a proof can be persisted; a stale orphan proof is rejected and the next
provider is tried. The lagged proven-transaction review retains unresolved
reorg heights and bounds retry work per run while its forward cursor continues,
so temporary provider lag cannot turn one failed repair attempt into a
permanent checkpoint skip. Failed retries rotate behind waiting heights, and
temporarily ineligible heights remain queued when the chain tip retreats.
Compound proofs may mark multiple transactions; validation checks membership
of the requested transaction. No consumer or database migration is required.

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

Provider responses are copied as accessor-free data, capped at 4,096 detail
rows, and bound to the requested outpoint whenever details are supplied. A
configured UTXO provider remains a locally chosen operational oracle: these
structural checks prevent response confusion but do not turn non-membership
claims into cryptographic proofs. Whole-wallet compatibility reviews stop
before provider work when more than 10,000 candidates would be inspected;
operators should use the bounded Monitor Admin pages for larger wallets. Manual
review inputs require canonical compressed identity keys and exact modes,
booleans, page sizes, and offsets. A release rechecks the exact user, txid,
vout, value, basket, and allocation state under the write lock.

Transaction-history and broadcast providers are locally selected operational
oracles, but their response objects are never trusted as wallet-owned state.
Script-history observations are bound to the exact normalized script hash and
endianness, copied into a dense 4,096-entry maximum, and checked for canonical
transaction IDs, safe heights, duplicates, and conflicts. WhatsOnChain calls
have a 30-second whole-request deadline by default; the additive
`requestTimeoutMsecs` option may be set from 1 through 3,600,000 milliseconds.

Broadcast accepts at most 1,000 unique requested transactions in a 64 MiB BEEF.
Each provider receives its own strict reparse and copied txid list. Results must
contain exactly one invariant-consistent entry for each request; provider names
come from local registration, competing transactions and diagnostics are
bounded, and raw transaction, BEEF, endpoint, and txid-list diagnostics are not
retained. In `UntilSuccess` mode, malformed, throwing, or soft-timed-out
providers remain inconclusive and the next provider is tried. A provider's
double-spend assertion becomes terminal only when the wallet independently
gets conclusive spent evidence for at least one exact input; an unavailable or
unknown UTXO oracle cannot quarantine funds by itself.

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
  touchIntervalMs: 60 * 1000,
  // Optional global and per-identity rolling bounds for unsigned claims.
  maxInitialRequestNonces: 100_000,
  maxInitialRequestNoncesPerIdentity: 100_000
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
  // Bound database/cursor work caused by list and sync offsets.
  maxRpcListOffset: 1_000_000,
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

Run `storage.migrate(...)` before enabling this manager on any replica. The
additive `2026-09-16-001 add auth message replay claims` migration creates the
`auth_message_nonces` uniqueness table used to atomically consume every signed
BRC-103 message nonce and identity-scoped initial-request nonce across replicas.
Missing the migration causes authentication processing to fail closed. All
replicas must share this table; a per-process or per-replica table does not
provide replay protection during load-balanced routing.

Signed per-session nonce claims fail closed at their configured bound and are
retained across sliding TTL extensions for the full active session. Unsigned
initial-request claims instead use global and per-identity rolling windows: when
either window is full, its oldest claim is evicted. Expired claims are removed
across identities during admission. This preserves exact replay rejection
within the configured TTL/cardinality windows without allowing unauthenticated
nonces to grow storage without bound or disable all future handshakes.

Schema migration is an operator-owned server lifecycle step. Authenticated
remote `StorageClient.migrate(...)` and `destroy()` RPCs are compatibility
no-ops; wallet tenants cannot run global DDL or close the shared provider.

The standard resource profile rejects list, find, and sync offsets above
1,000,000 before storage access (`WALLET_STORAGE_RPC_MAX_LIST_OFFSET`). Small
and high-throughput profiles default to 100,000 and 10,000,000 respectively.
Operators with legitimately larger wallet histories can raise the bound; use
`-1` only when all tenants are trusted and the database has an independent
workload guard.

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

### Overlay identity verification

Final identity discovery copies bounded resolver receipts, verifies their
transaction graph and canonical anchors with the wallet's existing
`Services.getChainTracker()`, and then validates the standard subject-signed
identity envelope and certificate. The wallet finally re-binds each verified
certificate to the requested subject or to every requested public attribute,
so a lookup host cannot substitute a different valid identity. Transaction and certificate reuse remain
bounded and canonical evidence is rechecked before cached results are used;
fresh provider tokens bracket asynchronous anchor checks where the configured
tracker supplies them. Invalid candidate evidence is dropped, while typed
limit/timeout outcomes propagate to the caller.
Direct `identityUtils` callers must supply a canonical `ChainTracker`; missing
context or invalid evidence produces no overlay identities. Local contacts
retain their separate policy. Inclusion does not establish unspentness or
freshness. See [identity verification](docs/identity-verification.md) for
current C01/C02/C03 contracts, compatibility characterization, and limits.

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
merges four Wallet Toolbox coverage shards for reporting. The C01 local
`test:coverage --runInBand` run passed 225 suites and 2,188 tests, with one
pre-existing skipped test. Its all-files totals were 45.75% statements, 38.86%
branches, 42.57% functions, and 45.46% lines; that collection includes imported
`out/src` code as well as source files. Use the exact run's coverage report,
rather than comparing unlike source-only and combined collections.

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
