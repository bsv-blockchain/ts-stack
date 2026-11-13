# BSV Wallet Toolbox

## Sync and recovery candidate

PR569 adds bounded wallet sync, portable recovery and durable primary handoff.
Use the [implementation map](./docs/implementation-544.md) for current entry points
and the [acceptance contract](../../../specs/wallet/sync-portability-program.md)
for the concrete merge requirements. Historical source checkpoints and test
campaign logs remain in Git history. Deployment and native TTN acceptance evidence
are maintained by network-ops; a passing component test does not establish a
platform or production deployment result.

## Diagnosing foreground BEEF verification failures

The staging integration validates and repairs selected funding proofs before
returning input BEEF to the signer. Failed canonical recovery retains the typed
proof error and releases the ordinary failed allocation; it cannot return a
stale proof as successful funding evidence. Remote calls remain outside the
allocation transaction. Mobile SDK forwarding retains every public root export
as its original external SDK object. No wire, schema or resource limit changes.

Foreground Storage processing retains its signed transaction before proof
verification and submission. An error response therefore does not prove that
no transaction exists or that a replacement spend is safe. Reconcile the
existing action before creating another payment. With a WalletLogger enabled,
failed verification now records the last root's height, expected root and
accepted/declined/pending result, or the structural stage when no root was
checked. Provider exceptions remain exceptions rather than invalid-proof
verdicts; public error identities and all verification checks are preserved.
This diagnostic distinction does not identify a historical missing-header or
wrong-root cause when that provider response was never retained. Publication
of these source changes and upgrading remote Storage are separate operations.

## Remote storage timeouts

`StorageClient` accepts optional `authFetchOptions` in its existing third
constructor argument. This applies to the Node, browser and mobile packages.
Omitting it preserves the installed SDK's defaults.

```ts
import { type WalletInterface } from '@bsv/sdk'
import { StorageClient } from '@bsv/wallet-toolbox'

declare const wallet: WalletInterface
const storage = new StorageClient(wallet, 'https://storage.example/rpc', {
  authFetchOptions: {
    requestTimeoutMs: 60_000,
    responseTimeoutMs: 60_000
  }
})
```

`requestTimeoutMs` bounds transport fetch and body consumption;
`responseTimeoutMs` independently bounds the authenticated response waiter.
Both default to 30 seconds. The response-wait option requires an SDK release
containing `AuthFetchOptions.responseTimeoutMs`; older supported SDKs retain
their existing behavior and option types. The declared SDK peer ranges remain
unchanged. Other certificate/session deadlines and caller operation deadlines
are independent. A local timeout does not undo a server-side financial write;
reconcile its outcome before deciding whether to resubmit it.

## Optional local transaction recovery

The 2.15.0 source candidate adds explicit local SQLite recovery controllers as
separate deep imports. Action recovery retains one fixed-layout, two-phase
`noSend` allocation, prepared transaction and final signed bytes. Funding recovery
binds one BRC-29 payment to its acquisition and atomically retains wallet ownership,
monitor work and a durable receipt. Ordinary BRC-100 calls and defaults are unchanged.
The new funding capability requires SDK 3.3.0; legacy root and existing deep
consumers retain the declared older SDK peer compatibility.

Install the auxiliary schemas explicitly in the active local wallet database.
Reopen them after restart, and preserve a consistent whole database plus wallet
keys. These journals are not included in ordinary entity backup/sync or BRC-38/39
exports. Browser, mobile, IndexedDB and remote provider wrappers do not acquire
these capabilities by upgrading. During rollback, stop new operations, reconcile
outstanding work and retain the original journals; deleting them loses recovery.

See [local action recovery](https://bsv-blockchain.github.io/ts-stack/guides/local-action-recovery/)
and [local funding recovery](https://bsv-blockchain.github.io/ts-stack/guides/local-funding-recovery/)
for construction limits, deep imports, verification and unresolved service obligations.
A local receipt does not prove settlement, a content license or protected delivery.

Internal recovery JSON ownership uses a fresh call-local context for scalar,
array and record checks. It retains the same deterministic stored bytes, error
identities, descriptor/prototype/cycle checks and fixed resource bounds; the
refactor requires no caller or stored-format migration. It never retains
ownership state or authority between calls.

## Receiving already-broadcast payments

The 2.14.9 source candidate completes broadcast results even when storage
already marks the request `unmined` or `completed`. This fixes first receipt
without a mining proof on shared storage, and the same result path when another
storage worker advances the request before the broadcast result refresh. The
stored advanced state remains intact; unsuccessful provider results still
reject receipt and do not credit new recipient outputs. Repeated successful
receipt remains idempotent. A payment carrying its valid mining proof follows
the existing proof path without rebroadcast.

SQL storage now serializes receipt ownership across independent processes
through a durable user/TXID claim. The migration preserves legacy transaction
and output rows, including historical duplicates, while adding the claim table.
Ambiguous historical receipts still require separate reconciliation; this
change prevents a new same-recipient overlap from creating another local credit.
Back up and preflight the database before rollout, then upgrade all storage
instances together; an older instance can bypass the new receipt claim.
Pending claims recover after their database-timed lease expires. No
public API or wire migration is required. Browser IndexedDB does not use the
SQL receipt claim. Source versions are candidates until published through the
protected release workflow; upgrading an app alone does not upgrade its remote
storage server.

The 2.15.3 source candidate restores legacy AtomicBEEF normalization before the
strict argument framing check. An exactly decoded envelope may contain unrelated
branches from an older sender; internalization retains only its declared payment
and required dependencies, then reruns the unchanged SDK validator. Truncated or
trailing data, an absent subject and missing dependencies remain rejected. Normal
chain proof, Script, remittance ownership and receipt checks still run. SQL receipt
admission and manager forwarding use canonical bytes without changing other caller
arguments. No API, wire or schema migration is required. Upgrade the wallet host
and remote Storage separately; a source candidate is not a deployed release.
For a previously rejected receipt, reconcile the original TXID before retrying the
original import. Do not create a replacement payment or rebroadcast a mined one.

## Reorg proof recovery

`TaskReorg` compares the latest 12 heights after each processed tip, including
when ChainTracks events are unavailable. It journals pending ranges before
remote work, retries unresolved heights every minute without requiring a new
tip, and recovers observed gaps after monitor downtime. Each attempt reviews
at most `recentDepth` fresh heights and `recentDepth` pending heights; the
default is 12 and zero disables this fallback. Ranges are compacted without
dropping pending work; compaction may recheck intervening heights.

The lagged `TaskReviewProvenTxs` audit starts at the minimum stored proof
height on the built-in SQL and IndexedDB providers, leaves an empty wallet
uncheckpointed, repairs older checkpoints in empty history, and retains fair
bounded retries through restart and tip retreat. Custom storage providers may
override `getProvenTxsReviewStartHeight`; its safe default starts at zero when
proofs exist, so custom providers can retain a longer initial audit.
Recent rolling scans and these forward cursors do not establish detection of
an arbitrary historical reorg below both cursors; deeper ancestry reconciliation
remains separate work.

Coordinate the upgrade of all monitor writers sharing a storage database:
older versions do not understand compact retry checkpoints and may overwrite
pending recovery work. The durability evidence covers one active Monitor owner
with sequential restart; concurrent checkpoint writers are unqualified, and
this change adds no ownership lock. Public Storage API serving topology is
independent of the internal monitor worker's ownership.

No SQL schema or manual data rewrite is required. IndexedDB automatically
upgrades to version 7 to add a nonunique `proven_txs.height` index, avoiding a
proof-blob scan during audit bootstrap. Close other connections using older
code before upgrading, and retain a backup of browser wallet data. Reverting
to code opening an older IndexedDB version requires a compatible restore or a
forward fix. Source merge does not publish a package or upgrade a running wallet.

## Backup and recovery: keep both keys and wallet data

**A root key or seed alone is not a complete BRC-100 wallet backup.** Users
need recoverable key material **and** wallet records, including derivation
metadata, transactions and basketed outputs. A database copy or BRC-39 file
preserves data; it does not replace root-key recovery. Wallet-manager snapshots
can contain keys and must be protected as secrets, but are not storage backups.

Wallet builders must provide both recovery paths, explain what their product
backs up, and test restoration after device or storage-provider loss. Storage
replication helps availability but does not replace versioned, independently
accessible backups and a tested restore procedure.

- [Wallet backup and recovery](https://bsv-blockchain.github.io/ts-stack/guides/wallet-backup-recovery/) — recovery inventory, product/operator responsibilities and user guidance.
- [BRC-38/39 integration](https://bsv-blockchain.github.io/ts-stack/guides/wallet-data-portability/) — current export/import APIs, provider constraints, restore versus merge and limits.
- [Recovery drill and checklist](https://bsv-blockchain.github.io/ts-stack/guides/wallet-recovery-drill/) — clean-device recovery, negative tests and evidence template.
- [AI-agent implementation brief](https://bsv-blockchain.github.io/ts-stack/guides/wallet-recovery-agent-brief/) — source-grounded task and review guidance.

These guides cover the recovery design. The measurements below describe
specific tests and do not establish that every wallet product has complete
key-and-data disaster recovery.

The unpublished 2.15 candidate captures BRC-38 source settings, wallet identity
and standard table closure in one local provider read view. SQLite and IndexedDB
tests cover independent writes during capture. A local MySQL 8.4.11 fixture
verifies repeatable-read isolation, read-only enforcement and connection cleanup
without changing session defaults. Exact proof and checkpoint reads inside these
provider-owned snapshots retain the consistent view without requesting write
locks; ordinary writable transactions retain their row locks. The critical
`wallet-read-snapshot-consistency` mutation target covers the complete transaction
classification and lookup methods with all six retained, portable and generated
read-view suites. Generated schedules exercise direct/retained failure cleanup,
cross-provider tokens, partial/exact selectors and independent writable work;
ordinary lookups also preserve returned checkpoint date/boolean normalization.
The original property strength and zero-uncovered/invalid/unexecuted mutation
gates apply. Deployed/PXC recovery remains unqualified. Custom providers
opt in with `supportsReadSnapshot` and `readSnapshot`. Use the export option
`requireSnapshot: true` to refuse unsupported capture; old custom-provider calls
retain their documented caller-quiesced fallback.
Recognized optional nullable JSON fields are omitted in a detached archive copy;
array entries and meaningful falsy values are preserved. The legacy helpers still
materialize the full document/file, and IndexedDB writers wait during capture.
Run `pnpm test:snapshot-archive-crash` for native SQLite process recovery and
`pnpm test:snapshot-archive-mysql` for the disposable MySQL fixture from this
package. Local MySQL qualification uses Docker Desktop and requires the pinned
image already present. Required wallet CI shard 1 provisions that same immutable
image on its ephemeral Linux runner, then runs both native fixtures from the
same-head build before Jest. Hosted MySQL mode accepts only the local default
Unix socket. The fixture uses a unique ownership label, loopback port, bounded
memory/CPU/process count and temporary data volume; individual Docker calls,
readiness and the child proof have deadlines. Failure or cancellation drains
owned work and attempts exact-owner cleanup before reporting its outcome;
unproved cleanup fails qualification. Other wallet shards do not start MySQL.

The unpublished candidate adds optional `@bsv/wallet-toolbox/portable` and
`@bsv/wallet-toolbox/portable/node` streaming entries. They require explicit
resource ceilings, coherent source validation and private staging. They preserve
the existing archive format and materialized APIs. Private-file appends check
the actual byte length before copying and own the supplied bytes before
asynchronous writes, including Node Buffers and Buffer subviews. See the
[streaming contracts and remaining limits](https://bsv-blockchain.github.io/ts-stack/guides/wallet-data-portability/#unpublished-bounded-streaming-entries)
before integrating them. Full issue #544 production qualification remains open.

The candidate also contains internal SQL journal primitives for exact revisions,
bounded metadata pages, bootstrap with a durable explicit row allowance,
source-table observers, and recovery of an
interrupted journal installation. Owned generations also bind explicit receipt
capacity/lifetime policy; exact receipts are persisted, read and collected in
bounded caller-owned transactions. Receipts prove a captured prefix and cannot
reopen a lost retained view. The internal `openSnapshotJournalSource` controller
reserves two owned native connections before its writer barrier, pins the profile
and generation, persists the receipt, and publishes after receipt commit and
closure verification. It requires an existing file-backed WAL database with
`better-sqlite3` or a static `mysql2` connection; other drivers refuse before pool
construction. Physical cleanup retains provider admission, and an unproved close
fences further sources. If source work and transaction cleanup both fail, the
ownership error retains the original source failure and each rollback cause.
Run `pnpm test:snapshot-journal-crash` for the
SQLite process-loss fixture and `pnpm test:snapshot-journal-mysql` for the isolated
MySQL client/server-process recovery fixtures. Internal floor transactions reserve
the global writer clock before current receipt locks and cannot pass a live
receipt's prefix. Tombstone collection examines at most 256 primary-key rows,
including live and newer records, and binds its cursor to one epoch, floor and
stream. Native WAL/RC/RR checks cover twenty-four real process-loss boundaries.
The internal `maintainSnapshotJournal` provider controller validates the complete
owned generation and excludes the configured migration owner before each short
floor or collection transaction. It shares source admission through cancellation,
rollback and physical cleanup; failed cleanup fences further retained admission.
The working candidate registers source and receiver migrations, provides bounded
generation-aware delta pages and destination staging, and keeps raw source
sync-state provenance separate from native checkpoints. Its explicit local SQL
`WalletStorageManager.reconcileJournal` iterator uses fair background admission
for each destination transaction, checks the current manager selection, and
reports destination-persisted byte/row counters. A short source SQL primary fence
is acquired in the scheduled commit and remains held through that one commit's
physical cleanup. Source reads, proof preparation and observers run between
commits. Lost replies re-read committed custody; cancellation reports stopped
only after physical source closure. A complete window does not activate a
restored primary. Fresh full scans can repair interrupted custody in the same
profile after source-generation or destination-primary replacement. V2 persists
the producing generation with each association, refuses old mappings as current
IDs, and sweeps unobserved associations after all current rows have been applied.
Creation ownership can follow a renumbered source ID only when the actual native
preimage and parents still match recorded ownership. Staged archive merge and
restore preserve archived managed-change policy;
any later operational migration is separate from restoration. The existing
aggregate restore helper retains its historical policy upgrade.

The working local SQL candidate also negotiates journal support freshly in ordinary
push, pull and backup operations. Acknowledged windows can advance incrementally
within the same actual source and destination generation. Primary transitions
copy conflicting data outside foreground admission, then check every contributing
source's current data and primary under short physical fences before selecting
the destination. Cancelled operations retain durable progress and drain their
source before reporting stopped. Journal provider and checkpoint types are
available from the server, client and mobile entry points without importing SQL
implementations into their public data contracts.

The current working source also implements authenticated remote snapshot
destinations, packed-IDB sources and inactive restore/publication, bounded large
fields, full native composition/recovery and device backup lifecycle contracts.
These additions remain functionally unqualified. The
[current implementation map](./docs/implementation-544.md) records their entry
points and qualification wiring; the [candidate delivery guide](./docs/delivery-544.md)
records migration, compatibility and rollback requirements. Production readiness
still requires complete current-system qualification, including physical quotas
and the required host/device evidence.

Required wallet CI shard 1 also runs both native journal entry points from the
same-head build after the existing archive fixtures. The complete journal mutation
aggregate and native recovery checks are separate qualification requirements.

Both native archive entry points include interrupted auxiliary profile and numeric
relation migrations through the real migrator. The numeric relation fixture
terminates seven migration boundaries, repairs the abandoned migration lock and
compares recovered membership with an independent source-table oracle. The MySQL
entry point also observes relation writer/reader lock ordering under both
supported isolation levels and checks late composite pages against 8,192
interleaved map rows per relation. It requires bounded handler reads and the
auxiliary primary-key range plan. These synthetic fixture results qualify the
tested engine/configuration; deployed PXC remains a separate acceptance gate.

SQL providers also expose `supportsRetainedReadSnapshot` / `openReadSnapshot`
for a local view held across idle reads, with one view per provider, one read at
a time, and bounded lifetime/cancellation. Await `closed`/`close()` for physical
cleanup. This low-level view occupies a caller-pool connection; driver deadlines
remain separate and a single-connection pool cannot serve other work until
release. The [durable local SQL backup integration](#durable-local-sql-backup-integration-215-candidate)
below adds bounded pages and uses a dedicated reader to preserve foreground
capacity. IndexedDB and remote RPC do not expose retained views. See the
[retained view contract](https://bsv-blockchain.github.io/ts-stack/guides/wallet-sync-reliability/#retained-local-sql-read-views-unpublished-candidate).
The SQL candidate also includes [bounded archive staging](https://bsv-blockchain.github.io/ts-stack/guides/wallet-sync-reliability/#shared-sql-snapshot-staging-unpublished-internal-component)
for the ongoing remote snapshot implementation. This internal component does not
add an authenticated export endpoint or a browser/mobile database adapter.
Its metadata-only receipt directory binds every page and all thirteen table
positions to the archive root before arbitrary-table reads; each payload is
checked against that verified directory. The original binding JSON bytes are
preserved as the hash preimage. This verifies transport integrity, not the source's
honesty or portable transaction/proof semantics.
An additional internal SQL request table binds retries to an immutable deadline
and archive, reserves capacity before source acquisition, and retains bounded
terminal receipts through cleanup. Its internal capture controller shares the
provider's single owned reader slot, publishes readiness after physical cleanup,
and drains cancellation/shutdown. Completed archives survive controller replacement;
failed cleanup fences admission and retains its reservation. The candidate now
adds a negotiated authenticated archive transport on migrated WAL/MySQL servers
and both client variants, with bounded responses and durable admission/status.
`getSnapshotArchiveTransport(identityKey)` is a low-level API; remote row reading,
ordinary sync/export adoption and portable validation remain incomplete. Server
or client `snapshotArchives: false`, or provider `snapshotSync: false`, disables
this capability. See the [transport contract](https://bsv-blockchain.github.io/ts-stack/guides/wallet-sync-reliability/#authenticated-snapshot-archive-transport-unpublished-candidate).
The candidate's additive source-owner table now retains request/archive capacity
until the exact controller acknowledges physical source cleanup. Cross-controller
cancellation fences the next page; pending cleanup reports an error and keeps its
reservation. Do not mix older candidate binaries or remove the owner schema while
captures remain. The reader now waits for an exact completion acknowledgement through bounded
pending-cleanup polling, preserving independent failures. The additive guard
migration now permits exact-owner recovery after physical source closure, using
stable local SQLite WAL guard files or a same-server MySQL connection lock.
Older unguarded owners remain reserved, and changed backend identities fail closed.
An unproved native close also fences further snapshot sources on that provider,
even after its read promise settles. Ordinary read failures remain retryable
after physical cleanup succeeds.
Keep the guard files and bindings intact and drain captures before downgrade.
The server reader capability remains unadvertised pending complete qualification.
The auxiliary profile-key migration preserves standard-table indexes and legacy
OFFSET ordering while adding indexed snapshot selection for eight direct tables.
Its triggers track independent writers; bounded bootstrap batches survive restart,
and readers enable the index only from a complete migration in their retained
view. See the [migration and recovery contract](https://bsv-blockchain.github.io/ts-stack/guides/wallet-sync-reliability/#auxiliary-profile-indexes-unpublished-candidate).
The separate numeric relation migration indexes label/tag maps while retaining
both parent ownership bases, tombstones and cross-profile inconsistency checks.
It preserves composite cursor and legacy OFFSET order, resumes bounded bootstrap
after interruption, and bounds MySQL paging before and after statistics refresh
with the auxiliary primary index and indexed source lookups. See its
[migration and recovery contract](https://bsv-blockchain.github.io/ts-stack/guides/wallet-sync-reliability/#auxiliary-numeric-relation-indexes-unpublished-candidate).
The certificate-field migration adds collation-preserving composite keys and
independent direct/parent ownership. Empty text keys, interrupted bootstrap and
case-only renames retain their source meaning. It leaves standard indexes and
legacy cursor order intact; readers require the complete migration in their
pinned view. See the [certificate migration and recovery contract](https://bsv-blockchain.github.io/ts-stack/guides/wallet-sync-reliability/#auxiliary-certificate-field-indexes-unpublished-candidate).
The global proof/request migration adds exact profile reference counts and
presence guards, with resumable bootstrap and retained ordinary/archive reads.
Direct and request-based proof references remain independent; removing the last
reference collects its auxiliary presence guard. Standard rows, text comparisons,
indexes and cursor/portable bytes remain unchanged. See the
[global migration and recovery contract](https://bsv-blockchain.github.io/ts-stack/guides/wallet-sync-reliability/#auxiliary-global-proofrequest-indexes-unpublished-candidate).
The additive SQLite conflict-repair migration installs metadata-bound witnesses,
rebuilds all four index families in bounded resumable pages, and retires obsolete
auxiliary rows without changing standard wallet data. Reader adoption follows
journal publication inside the pinned view. Legacy ownership checks distinguish
triggers from views even when their names coincide; foreign readers of auxiliary
data refuse migration. Preserve partial state for recovery;
ordinary downgrade refuses, while explicit `dropAllData()` retains its destructive
contract. See the [SQLite generation migration contract](https://bsv-blockchain.github.io/ts-stack/guides/wallet-sync-reliability/#sqlite-conflict-safe-index-generation-unpublished-candidate).
SQLite identity and journal-observer validation read fresh bounded metadata pages
for each operation. Metadata is grouped in one pass, and installed schema
definitions are checked in pages of at most sixteen. Exact metadata, DDL,
validation order and error identities are retained; there is no cross-operation
schema cache. The existing schema and BRC-38/39 formats need no migration. Global-index
validation groups fresh table and index metadata only inside its pinned SQLite
transaction. Individual reads remain the fallback outside a transaction, for
unsupported drivers or oversized groups; the public table validator retains its
original three-argument contract.
The complete sync/streaming/restore program remains in progress on #569.

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

SQLite migration handling introduced in 2.13.2 runs transactional migration DDL
and the migration journal update together. The unpublished profile-index and
numeric relation, certificate-field and global proof/request migrations are explicit resumable exceptions: auxiliary keys and progress commit
in bounded batches before its final migration journal entry. Foreign-key enforcement is disabled before the
migration transaction for table rebuilds and restored after success or failure.
Failed transactional migrations can be retried after reopening the database
without partial schema objects from that attempt. These resumable index
migrations instead retain their verified auxiliary objects and committed progress;
see its linked recovery contract before retrying an interrupted migrator. MySQL's existing transaction configuration
is unchanged.

Transactional migration handling prevents partial table rebuilds. It does not automatically repair a
store already left with unjournaled schema objects by an older version. Preserve
the database and verified backups and reconcile the exact schema and migration
journal before recovery; do not delete journal rows or wallet data blindly.

### Postgres storage

`StorageKnex` runs on Postgres through the knex `pg` client. Install `pg` in the
application and pass a Postgres knex:

```ts
import { knex as makeKnex } from 'knex'

const knex = makeKnex({ client: 'pg', connection: { host, port, user, password, database } })
const storage = new StorageKnex({ ...StorageKnex.defaultOptions(), chain: 'main', knex })
```

`ChaintracksStorageKnex` and `adminStats` do not support Postgres. Snapshot
auxiliary migrations, including packet-label rollback, remain no-ops on Postgres;
SQLite and MySQL retain their forward-recovery downgrade safeguards.

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
metadata is deliberately not a BRC-100 wire extension. Since 2.14.1, it lives in a
shared local WeakMap rather than on the public result object, preserving exact
accounting across separately loaded bundles while allowing strict binary result
validation. Upgrade the wallet host and permission manager together. If an older
host reports a result-serialization failure, check its transaction history before
retrying: the wallet may already have created or completed the action.

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

Adaptive snapshot paging isolates observations by table, separates fixed page latency from marginal row cost, and uses the actual committed payload charge to forecast the next request. A known next table starts at the original 64-row budget; repeated observations of the same table retain their history. A newly expensive page immediately shrinks the next work budget even when recent pages have equal row counts; sustained recovery remains smoothed to avoid request-size oscillation. Caller row and byte limits remain authoritative, and an oversized individual row still refuses without advancing the checkpoint. These forecasts do not establish a WAL, allocation or memory bound. This change needs no wire or schema migration. Full #544 qualification and production performance evidence remain required.

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

Missing capabilities, remote destinations, self-copies and primary reconciliation
retain exclusive execution. Supported ordinary local SQL copies use the durable
snapshot path described below. The legacy atomic-page capability probe retains
its serialized fallback; snapshot validation and I/O failures reject. Page ceilings are rough encoded
size hints; the existing negotiated per-record transfer bounds still apply to
large records. One page is in flight, and progress does not accumulate wallet
records or per-record logs. Legacy source pagination retains the existing eventual
replication contract. Supported local SQL sources use one coherent retained view;
the destination remains a merged replica. Remote snapshot handles and streaming
portable archives require their separate consistency and format contracts.
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

### Profile update failures

`CWIStyleWalletManager.addProfile` and `deleteProfile` commit the local profile
list when the replacement UMP token is published. A factor-decryption or
publication failure preserves the previous list, so a failed creation can be
retried with the same name. Concurrent creations reserve names without regard
to case until each attempt settles. A failed deletion of the active profile
attempts to restore that profile and preserves the original update error if
restoration also fails.

Restoring the active wallet can fail after publication has succeeded. In that
case, the token and profile list already contain the change, and the default
profile may remain active. Inspect `listProfiles()` before retrying and switch
to an available profile as needed. This bookkeeping fix does not correct the
underlying factor-decryption error; diagnose that error separately.

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
backward-compatible WAB authentication response. When verified lookup returns
competing records, the pin anchors its own update lineage. A password or token
update that consumes the pinned outpoint supersedes it, including a multi-hop
update whose old pin is available only in authenticated token ancestry.
Each token input must prove spend authorization, including across confirmation;
ordinary funding inputs do not establish token lineage. Unmined updates also
require complete funding ancestry. A truncated input reference cannot override
the verified pin. An unrelated historical continuation
cannot override that lineage. A pin cannot
introduce an unverified token or resolve competing descendants of a spent pin.
Clients link explicit overlay history past confirmed Merkle anchors. UMP hosts
must request retained token lineage with a history decider and preserve it in
lookup BEEF (`@bsv/overlay` 2.6.4 and `@bsv/overlay-topics` 2.0.1, or equivalent
custom hosting). If an older host names an absent pin but omits its authenticated
source, lookup remains indeterminate instead of choosing an unrelated continuation.
Ordinary lineage resolution still applies when no pin relationship is present.
Operators should clear redundant pins after unpinned lookup independently returns
the correct current token; pinning is a recovery measure for remaining forks.

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
script and bounded amount are authorized before signing. With a compatible SDK,
its local signer also authorizes independently validated storage commission and
locally derived change, bound to exact output indices, scripts and amounts. The
permissions wrapper preserves this private decision; serialized results or
unknown wallet adapters do not gain this authority. Other unrequested outputs
cannot consume the faucet input.

Upgrade wallet-toolbox to 2.14.6 and the SDK to a release exposing
`completeBoundAction.outputAuthorizationVersion=1` together. Older SDK peers retain
the existing strict behavior and cannot redeem a fee-bearing faucet input for an
empty wallet. Main currently carries the separate SDK3.1 candidate; SDK2 hosts
need an additive backport or the documented SDK3 migration.

The signed action is staged locally, labeled, and recorded in a recovery basket
before broadcast. Internalization clears the output's custom instructions, and
standard `listActions` does not return them. A retry with the same wallet root
can recover the prior faucet action; missing, substituted, ambiguous, or
result-only recovery evidence fails closed. Preserve the wallet's storage when
reconciling an interrupted signup.

For restart-safe WAB registrations, store an unpublished UMP token checkpoint
before faucet redemption. Pass `pendingRegistrationTokenSaver` in
`WalletAuthenticationManagerOptions` and synchronously verify that the token
bytes are stored before the callback resolves. On app restart, call
`loadPendingRegistrationToken(bytes)` before starting authentication. The token
contains encrypted UMP fields and no plaintext wallet root, snapshot key, or on-chain
outpoint. Keep it through failed funding and logout; clear it only after a
successful authenticated snapshot has been stored and
`hasPendingRegistrationToken()` returns false. If an older pending WAB
registration has no checkpoint, the manager refuses to redeem its faucet output
again. Recover that registration using its original wallet state instead of
creating a new root. A checkpoint for another presentation key does not block
login to an already published wallet; retain that checkpoint until its own
registration is reconciled.

A WAB that advertises `registrationStatus: "pending"` lets a verified retry
reuse the stored presentation key when a clean UMP lookup confirms that
publication has not happened. The loaded checkpoint reconstructs the original
root, so the wallet can recover its prior faucet action. After publishing the
UMP token, the manager finalizes WAB idempotently. A lost finalization response
is non-fatal: the next verified login finds the published token and repairs the
pending state. Missing or invalid lifecycle metadata remains fail-closed for
established accounts; WAB wire behavior is unchanged.

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

The supported chain identifiers are `main`, `test`, `stn`, `ttn`, `tstn`, and
`regtest` (`mock` remains available for test utilities). STN, Terra Scaling
TestNet, and regtest do not have operator-independent public endpoints: set
`STN_CHAINTRACKS_URL`, `TSTN_CHAINTRACKS_URL`, or `REGTEST_CHAINTRACKS_URL`, use
the matching Arcade environment variable, or inject an explicit
`ChaintracksClientApi`. Like TTN, the default regtest services use Arcade
(`REGTEST_ARCADE_URL`) as broadcaster and Merkle-path provider and register no
legacy ARC fallback.

`regtest` is Teranode's regression network (go-chaincfg `RegressionNetParams`):
the canonical regtest genesis header and a proof-of-work limit of `0x207fffff`.
Only a caller that names `regtest` gets that limit; every other chain, and every
header check that names no chain, keeps the mainnet limit of `0x1d00ffff`.
Regtest proof of work costs nothing to produce, so a regtest wallet trusts its
ChainTracks service for the header chain. Use it for private test deployments
only. URLs ending in `/v2` use the reconnecting
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
The Go client accepts both TypeScript reorg events and Go events carrying
`orphanedHashes`, `commonAncestor`, `newTip`, and `depth`. It resolves only the
announced hashes, validates their headers and linkage to the common ancestor,
and uses `maxReorgHeaders`, one `requestTimeoutMsecs` deadline per event, and
unsubscribe cancellation to bound the work. Existing reorg listener arguments
are unchanged. `streamErrorCount` exposes malformed events and stream failures;
optional `onStreamError(message)` receives single-line diagnostics capped at
512 characters. Observer exceptions do not stop later events. A rejected event is reported and
subsequent complete events already received in the same SSE chunk still run in
order. These events do
not by themselves prove the server's canonical-chain selection.

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

The experimental local `getBrc197InternalizationCapabilities()` and
`internalizeBrc197Action()` extension accepts the literal fixed-child remittance
for the optional BRC-197 exemplar through the complete wallet ownership pipeline.
Ordinary BRC-29 validation and remote BRC-100 methods remain unchanged.
Read the [fixed-child intake guide](../../../docs/guides/brc197-fixed-child-wallet.md)
for explicit capability selection and the outstanding native, recipient spending
and activation-before-funding qualification gates.

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
  // Per-IP before auth (default 3,000/minute).
  preAuthRateLimit: { limit: 3_000, windowMs: 60_000 },
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

The existing fourth shard first runs all three native-browser test files serially,
then runs its remaining ordinary tests in a separate Jest invocation. The complete
64-case browser inventory, exact source/run identity, report hash and separately
retained LCOV must pass the root coverage receipt gate. Discovery checks prove
that exactly those three whole files moved out of ordinary sharding. All 67 wallet
matrix rows, the original job and case deadlines, browser pin, memory and parallel
job limits remain unchanged.

`pnpm test:property` selects every registered Wallet Toolbox property suite, including
the portable BRC-38/39 suites. Keep the manual-test ignore option before the
boolean runner options and file list: Jest treats it as an array and otherwise
consumes appended file paths as exclusions. The root governance regression checks
the actual Jest argument parser and the complete registered selection.

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

This package is released under the [Apache License 2.0](./LICENSE).
The accompanying [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) and
[LICENSES/](./LICENSES/) preserve the package's earlier Open BSV grant.

## Sync and recovery reference

Use the [implementation map](./docs/implementation-544.md) for current source
entry points, [primary handoff](./docs/primary-handoff.md) for recovery after an
uncertain reply, and the [acceptance contract](../../../specs/wallet/sync-portability-program.md)
for PR569 completion. Earlier checkpoint narratives remain in Git history.

## Consumer integration and qualification commands

The entries and commands below remain subject to the current candidate status, exact-source qualification and supported-platform requirements.

### Candidate Node KDF worker and device backup lifecycle

The unpublished streaming Node BRC-39 implementation now selects a ready
registered Argon2id backend or runs the portable derivation in a one-shot Node
worker. NFC encoding, Argon2id parameters and the BRC-39 envelope are unchanged.
Password/salt and key buffers transfer by ownership. Delivery follows actual
worker exit; cancellation requests termination and waits for exit. A selected
native backend remains authoritative and its failure never triggers a fallback.
Native cancellation waits for actual settlement and erases late keys. A cleanup
failure exposes `Brc38StagingCleanupError.retryCleanup()` and retains admission.
`maximumKdfMilliseconds` defaults to 30,000 and accepts 1 through 30,000. Only one
KDF is admitted per loaded module instance. The worker's V8 heap limit does not
bound external WASM memory; the explicit stream KDF memory policy remains
required, and hosts must budget all installed instances together. Worker,
packaged-consumer and platform cases are authored and have not been run against
this source. The existing materialized codec retains its behavior.

`DeviceBackupController` is exported by the Node, client and mobile storage
entries. Its dedicated version-1 device preference record contains only
`automaticSync` and bounded host catalog IDs in `backupDestinations`. Versionless
records with these fields migrate without changing their selection; unknown
versions or malformed values refuse. Hosts explicitly persist migration with
`setPreferences`; opening the controller performs no automatic synchronization
or wallet schema reset. Keep catalog credentials and storage paths outside this
record. See `examples/deviceBackup.ts` for host lifecycle integration.

Each participating profile supplies its own manager, identity/network binding
and authenticated destination factory. The controller serializes bounded runs,
checks current profile bindings and calls `syncToWriterResumable`. It never
activates a primary, restores a sender progress checkpoint, or combines profile
records. The destination's durable checkpoint controls each fresh run. Provider
factories must return a new owned provider and close its actual pending I/O;
reused providers and active profile providers refuse ownership. Negotiated
providers yield between atomic commits; older providers retain their serialized
fallback. `syncAutomatically` follows the device preference, while `syncNow`
requests a manual run. There is no constructor timer. Hosts call the automatic
method from their own foreground cadence, await `suspend()` before shutting
profile storage down, call `resume()` on return, and await `close()` before
manager destruction. Suspension also waits for any actual preference write. Destination open/close
and preference writes use 30-second observation deadlines; a timeout retains
the original pending operation and concrete cleanup instead of abandoning it.
A physical cleanup failure fences subsequent runs until `retryCleanup()`
succeeds. An ordinary sync failure remains visible even after cleanup succeeds.
These lifecycle and declaration cases are authored, unrun candidate work;
complete #544 system qualification remains open.

### Candidate browser streaming export and first-party KDF worker

`encryptBrc39BrowserStreamToQuarantine` is an additive client/mobile/portable
export entry. It uses the existing incremental WebCrypto AES-CTR/SDK GHASH
component for encryption as well as decryption. It retains partial AES blocks
across arbitrary input boundaries, emits bounded ciphertext and produces the
standard 128-bit GCM tag without AAD. A private output receives the tag only
after complete coherent source validation and actual source/crypto closure.
Salt/nonce use native secure randomness, new exports preserve canonical Argon2
strength and NFC, and the standard file is plaintext bytes plus 113 envelope
bytes. The existing SDK GHASH shared-CPU and secure-erasure limitations remain;
this source addition does not claim constant-time or platform qualification.
Source/output providers own their actual I/O and durable publication. An error
retains concrete cleanup and discards unpublished output.

This new export entry requires a preloaded asynchronous worker/native Argon2id
backend, refusing a missing/cold backend before deriving on the UI thread.
`BrowserArgon2idWorkerBackend` supplies an optional first-party worker adapter;
`installBrowserArgon2idWorker` installs its worker-side protocol only when called
from the host's fixed trusted bundled dedicated-worker entry. The installed
handler accepts only native dedicated-worker message events: empty origin, null
source and a trusted browser dispatch. This is a MessagePort channel check; it
does not select or restrict the application's hosting domain. Constructing or
importing the adapter does not launch a worker. Await `preload()` before
`registerArgon2idBackend()`. Each derivation transfers bounded password/salt/key
buffers through one newly owned worker. It retains selected scalar parameters,
checks actual readiness and deadlines, erases owned inputs, and invokes native
worker termination before key delivery. Browsers expose no worker exit event:
API termination is not a measured OS-thread exit or a physical memory quota.
Worker memory, foreground latency and supported platform behavior require their
separate tests. Failed termination retains the original Worker and concrete
`retryCleanup()`; unregister and await `close()` at host lifecycle shutdown.
A selected ready backend's failure never falls back to another implementation.
See `examples/browserBackupWorker.ts` and `examples/browserBackup.ts` for a fixed
worker entry and host export integration. Never construct a worker from archive
metadata, a backup catalog ID or another untrusted URL.

Browser worker/NFC/foreground cases, native GCM encryption oracles, streaming
legacy-decoder interoperability, arbitrary block boundaries, semantic/close
failure and cancellation cases are authored and unrun. Node combined KDF and
quarantine failures now retain both original cleanup owners in order rather
than losing the concrete retry behind an aggregate. Full #544 qualification
and release readiness remain open; these source changes have not triggered CI.

### Optional wallet script-verifier capabilities

`scriptVerifier` accepts the exported `WalletScriptVerifier` contract: an SDK
`SpendVerifierInterface`, an SDK `BdkVerifierInterface`, or a backend implementing
both. Existing per-input backends require no adapter. A whole-transaction-only
backend uses the JavaScript interpreter for declined transactions, unresolved
source fallbacks and per-input diagnostics after a consensus rejection. Backend
initialization and resource failures propagate unchanged. Optional digest batches
remain limited to the wallet's exact canonical P2PKH recognition lane; general
scripts retain whole-transaction or per-input verification. No backend is loaded
or installed by the declaration, and no wire, database or caller migration is
required. Full implementation and qualification of #544 remain in progress.

### Concrete internalization results

`Wallet.internalizeAction()` declares the `StorageInternalizeActionResult` it
already returns, including `isMerge`, `txid` and net managed-change `satoshis`.
It remains compatible with the SDK's `InternalizeActionResult`; no runtime,
wire, permission or database behavior changes.

Fresh empty private native local-packed installation reuses the existing exact
`spentBy, outputId` cleanup index instead of retaining a duplicate `spentBy`
tree. The installer checks actual index definitions, keys, collation, flags,
physical rowids and the retained query plan inside its existing savepoint.
Ordinary and occupied profiles retain their original indexes. All other
canonical indexes, including membership retirement order, remain installed.
This is a capacity implementation change; complete native layout and full #544
qualification still require their independent evidence under the original caps.

The private native migration adapter retains the original migration object
metadata, including optional `config`, in its TypeScript return contract. It
remains assignable to the existing Knex migration source; migration execution,
owner checks and rollback behavior are unchanged. Full program qualification
remains pending.

Fresh unpublished native baseline installation shares packed-pointer observers
per binary/text family and INSERT/DELETE event. Each fixed source ID still
selects the current parent's physical rowid with the original missing-parent
behavior. Occupied legacy/per-ID families remain supported; complete fresh
schema comparison rejects mixed families. All 56 independent SQL cases and all eleven native C components pass. Actual
packed-plus-baseline installation still fails under the unchanged native page
ceiling; complete native and production qualification remain pending.

Fresh unpublished native identity witnesses omit primary-key self-assignments
and key-change predicates from their UPSERT helpers. Nonkey comparisons,
nested-write UPSERT behavior and complete occupied helper families remain.
All eight new independent source traces pass, and genuine native validation
accepts complete old/new helpers while refusing mixed or altered families.
The packed layout uses319of336pages, two fewer than before; combined baseline
installation still fails. Full #544 implementation and qualification remain
pending.

Fresh native baseline generations use fixed inventory coordinates in the 141 internal source observer names. The event bodies, all 47 physical source tables, clocks and pointer observers are unchanged. Occupied full-name generations retain their complete family; mixed or altered families fail exact validation. The fixed names remove 3,027 SQL definition bytes plus 3,027 separately stored schema-name bytes; page savings remain unmeasured. Actual Linux ARM candidate14 passes the original runtime contract and all twelve C components, including an independent 47-source/423-transition/2,784-check compact-name component. The native authorizer admits the fresh positional spelling only and refuses case-insensitive temporary shadows, altered coordinates, direct events and retired/comparison actors. Actual component feedback: all 48 independent SQL cases pass with zero skips. The genuine cold baseline installs at 326/336 pages, accepts complete old and new observer-name families, rejects mixed/altered families, and restores the exact schema and geometry through real savepoint rollback. The source-owned delivery CLI passes all 13 records and delivers exact candidate14 bytes, with all preparation/component/CLI groups and fixture contents drained. The full packed-plus-baseline installation still fails SQLITE_FULL before journal installation; packed geometry is 319/336 pages. The 6,054 metadata-byte saving is measured, but no packed-plus-baseline page saving or full-system qualification is claimed. Native limits and the original whole-case/property controls remain unchanged; this component does not establish complete #544 qualification.

Fresh authenticated private native migrations create auxiliary archive pages and requests with one clustered composite primary tree each. Both original keys are already non-null; columns, affinities, payloads, request expiry indexing and logical key operations remain unchanged. Ordinary SQLite/MySQL creation and occupied tables retain their existing definitions. The original nullable archive header key, private staging/payload tables, operational source rowids and ten physical identity witnesses are unchanged. Complete fixed DDL, actual private writer, pre-generation state and case-insensitive temporary shadow checks gate creation in the original migration transaction. Actual Linux feedback passes all seven new independent SQL cases and genuine fresh/occupied archive families, temporary shadows, late creation, bad source binding, persisted restore admission, absent/extra index removal and exact savepoint rollback. Cold allocation is 307 pages, packed is 317, and packed plus baseline installs at 336/336. Complete snapshot source binding now validates after compaction. The subsequent journal CREATE TABLE snapshot_journal_generation fails SQLITE_FULL, so complete journal capacity and full #544 qualification remain open. Native candidate14, pin8, limits and all original case/property controls are unchanged.

The fresh native local-packed installer now reconciles its snapshot source binding around the fixed spent-by index compaction. It validates the original complete generation and empty unpublished source, verifies that only the redundant nonunique index disappeared while all observers and identities remain exact, conditionally updates the original binding and validates the complete new generation. The existing layout savepoint owns the index and binding together. The preserved allocation37 sample shows the archive change allows packed plus baseline installation at 336 pages, then exposes the old binding mismatch; The later native39 run validates the complete repaired binding and all four negative controls, then retains the first journal-table SQLITE_FULL failure. Full journal capacity and system qualification remain open.

Fresh private native journal generations group the complete 24 original packed-pointer emitters into four family/event observers. The original positional factory and occupied generation families remain supported. Fixed coordinates and actual unique/physical parent lookups preserve pointer replacement, missing-parent deletion and original event selection. Complete mixed, partial or altered families refuse. Actual feedback passes all 14 independent SQL cases and both genuine native fresh grouped and occupied original positional families. Altered SQL, missing or mixed observers, temporary shadows and a partial group refuse; real savepoints restore the exact schema, generation and geometry. The grouped plan removes 20 trigger definitions and 3,198 SQL bytes while retaining every other definition. Cold fresh journal allocation is 329/336 pages, compared with 330/336 for the original family. Complete packed plus baseline remains 336/336 and the first journal table still fails SQLITE_FULL. The original 32 whole native system cases remain pending; this is component proof, not full-system qualification. A disposable ordinary SQLite copy rebuild saved only six pages and did not fit the complete graph; native VACUUM is not implemented or claimed.

The Node compiler uses the SDK’s CommonJS declarations so optional verifier
backends share nominal SDK transaction types with the wallet. Client and mobile
compiler configurations retain the ESM declaration context. This build correction
changes no public wallet API or runtime behavior.

Fresh empty native local packed layouts consolidate parent-admission and key-move guards by fixed coordinate and original error identity. Every original marker, actual-parent check and unrelated quota/content/lifetime definition remains in force; occupied layouts retain their original complete guard families. Mixed, missing or altered definitions refuse. The change is internal schema definition data and introduces no archive or public API migration. Complete combined packed, baseline and journal capacity and full native system qualification remain required before release.

Fresh empty private native local packed layouts now use stable compact internal observer names. Table and index names, preparation/source anchors, every event body, predicate, error and source coordinate remain exact. Complete occupied original and parent-grouped families keep their original names. Complete mixed, missing or altered families and temporary shadows refuse. This internal definition-data change does not change the archive vocabulary or relax native resource limits; combined native capacity and full-system qualification remain pending.

Native publication inventory compares restored timestamps with the exact SQLite ISO-text representation written by StorageReader/StorageKnex, including header users and packed metadata rows. It rejects different timestamps or numeric encodings rather than accepting multiple representations. The genuine composed16MiB path exposed this mismatch after complete restore; full system qualification remains pending. Small4MiB exhaustion controls, original deadlines/cases, and all native resource enforcement remain unchanged.

Packed native sync-state inventory uses the exact preserved syncStateId as its TEXT attachment coordinate; sync states have no remapped entity ID. Signed and zero keys retain their original meaning. Independently selected certificate-field rowids and strict safe-integer, content, identity and source checks remain in place.

Published structured resource records persist immutable limits and the original working-allocation ceiling, excluding live owners and cancellation signals. Each finite publication inventory creates one real allocation owner at that ceiling and shares it across the full pass; persisted owner objects and widened bounds are refused. This does not revive the private import or supply physical, source, or semantic authority. Full composed-path and system validation remain pending.

An occupied compact import metadata family remains valid in a genuine retained read-only published-copy inspection. The copy uses the original native clustered-table definitions; fresh compact creation still requires a native owner. Exact complete family, SQL/NULL/object-count/temporary-shadow checks and both native/copy membership rechecks remain mandatory. Ordinary SQLite transactions cannot claim native compact-family or copy ownership. Full composed-path and system qualification remain pending.

Published wallet journal verification reuses the caller’s actual retained SQL transaction, including a genuine read-only copied-profile actor. It does not open a nested transaction and assume that child inherits membership. Actual root callers retain their original transaction path, while the journal/schema/receipt/identity/primary and physical owner checks remain independent. This preserves one coherent read scope without enrolling another actor; complete composed and system validation remain pending.

Small snapshot-journal schema rows now transfer their exact type, name, table and SQL bytes together with their lengths in one at-most-16KiB BLOB response. Larger rows retain the original individual bounded chunks and strict UTF-8 decoding. Every invocation reads the actual retained schema view; original per-definition, name, complete source JSON and object-count bounds, NULL SQL and ordering remain unchanged. This reduces measured repeated metadata round trips without caching schema verdicts or raising resource limits. Full native bootstrap and system qualification remain pending.

Native local-baseline generation checks now compare every selected definition in fresh SQLite queries containing at most eight definitions and 8KiB of definition bindings, plus the fixed scalar LIMIT; an existing longer definition retains its individual query. Exact SQL bytes, complete family counts and primary-index checks remain. Both total and distinct-name counts prevent a duplicate from masking a missing object, and the actual current native actor is rechecked while assembling and executing each batch. No schema verdict is cached, no definition or limit changes, and the original error identity is retained. Full composed bootstrap and system qualification remain pending.

Actual native snapshot schema reads now select at most eight length records per response and transfer groups whose complete BLOB bytes fit the existing 16KiB response allowance. SQL rechecks the aggregate before transfer; longer rows retain their original individually bounded chunks. Temporary row coordinates and lengths remain data in the actual retained transaction. Exact ordering, all original JSON/SQL/name/object bounds, strict UTF-8 and NULL handling remain; there is no cached verdict or changed production quota. Full composed and system qualification remain pending.

Current native all47 baseline installation now uses the existing atomic journal source-addition migration. It validates the complete old/new plans in the actual writer, refuses installation while live capture receipts remain, preserves events, retained floor and bootstrap progress, and rotates the journal epoch so old source bindings cannot resume. Idempotent retries with an already-installed baseline do not repeat the migration. Existing native actor/profile/primary checks, definitions, quotas, deadlines and the source-addition protocol remain unchanged. Full composed and system qualification remain pending.

Whole-feature native test fixtures explicitly admit 16 MiB, matching the existing composed integration allowance. The independent default preview admission remains 4 MiB. The complete schema has a measured minimum above the old 336-page private-stage allowance, so successful full-feature fixtures use the unchanged native formula at their explicit admission (1,360 pages). Five capacity assertions follow that deliberate fixture migration; all original test names, counts, semantic assertions and deadlines remain. Independent four-MiB controls retain the original 336-page ceiling and exercise actual quota exhaustion and rollback; the full-feature fixture verifies genuine packed/baseline/journal sealing after its real native writer completes. No product default, native quota formula, VFS/C implementation or original property control is relaxed. Supported data, copy/WAL/recovery and concurrent-owner peaks still require measurement before a production recommendation; this test admission is not that qualification.

Whole-native full-feature fixture admission separately selects 16 MiB for authenticated decoded/working allocation and 16 MiB for aggregate physical storage, preserving the 64 KiB serialized-row limit. The original derived-TEXT contract requires an 8 MiB working allocator and a 16 MiB decoding budget; admitting only 64 KiB for allocation cannot exercise it. The preview helper retains its original coupled allocation default and adds an explicit optional allocation selection. Small 4 MiB exhaustion controls retain 64 KiB allocation. All native quota/heap/address/FD derivation formulas, production defaults, C candidate and original semantic tests remain unchanged. The full selection derives a 49 MiB SQLite heap and 128 MiB address-space allowance under the existing formula; this is a fixture envelope, not a production recommendation. Current full native and new admission-case validation remains required.

Private content staging captures an owned byte copy before queued I/O, including Node Buffer inputs. Buffer.slice() shares caller memory; staging uses the existing detached-copy helper so caller mutation cannot change a pending append and cleanup cannot erase caller bytes. Finite chunk bounds, working/lifetime charges, replay-prefix comparison, independent stored-byte hashes and cleanup remain unchanged. The original derived-TEXT byte-preservation contract is the regression control.

Fresh private native local schemas retain individual literal field guards and original observer names, and fresh journals retain complete individual positional pointer emitters. This preserves independent historical-emitter conversion and damaged-definition rollback contracts. Complete occupied grouped/named families remain recognizable under their existing exact validators; no occupied database is rewritten. Compact physical tables and source-owned quota, generation, ownership, mixed/missing/altered/TEMP refusal and rollback safeguards remain.

The complete canonical migration regression fixture explicitly admits 8 MiB of aggregate physical storage, preserving 64 KiB row and working-allocation ceilings. Its measured empty main database is 1,503,232 bytes; the actual small 4 MiB fixture limits the main database to 336 pages (1,376,256 bytes) after its unchanged three-image recovery reservation. An independent control compares both real page ceilings and verifies the complete schema fits the larger bounded allowance with recovery headroom. Original migration algorithms, exact DDL/names/callbacks/configs, selected rollback/replacement retry and case deadlines remain unchanged. The small default and exhaustion controls remain 4 MiB. This is an empty-schema test allowance; production data, concurrency and recovery peaks still require qualification. No production default or native resource formula is changed.

PushDrop infers the actual getPublicKey/createSignature wallet capability through a generic parameter while defaulting to WalletInterface for existing full-wallet annotations and public wallet access. Constructor and method runtime bodies/defaults are unchanged, and emitted JavaScript remains byte-identical. Actual ProtoWallet and full-wallet declaration checks cover both forms without casts or invented wallet methods; the original six script tests remain intact alongside two appended regressions. SDK output propagation and release ownership are coordinated separately; full program qualification remains pending.

The required wallet coverage matrix now gives every original native snapshot
pair case its own lane. The first unchanged original case measured 214.5 seconds
of genuine two-profile setup, selected effects and cleanup; a shared40-minute
shard cannot admit all18 cases. Each lane keeps the existing40-minute limit for the original
780-second case bound, two600-second native delivery steps and dependency setup. The
ordinary shards route this file to these mandatory lanes. The aggregate gate
rereads each actual Jest report, checks all18 original names and selected passes,
and requires every distinct cohort exactly once at the current commit, test-file
hash and plan hash. Missing, stale, duplicated, skipped or altered evidence fails.
These source changes do not yet qualify the full18 cases or the complete system;
the separate original21 composed cases and six real-UTC expiry cases remain
mandatory, and mutation inventories and scoring gates are unchanged.

Two additional mandatory pairs cover retained-journal native staging and authenticated field-artifact/native cache reuse. The complete pair inventory is20 and the wallet matrix has58 lanes. An explicit original18 name/pattern/count/order baseline and original56-lane subset remain verified. All existing runtime, timeout, pin, corpus, seed and report-union gates are unchanged. The two new genuine native cases are authored and typechecked, but remain unexecuted until full qualification.

Mutation targets retain both complete native functional files as explicit
`requiredFunctionalTests` affected inputs, while their baselines execute the
remaining genuine component suites and original registered properties. Six
one-hour expiry waits cannot be repeated inside a hosted mutation baseline.
The independent required CI lanes preserve all original21 composed and18 pair
cases and verify the complete actual report union at the current head. Canonical
mutant ranges, minimum300 property runs, global score ratchets and zero
uncovered/invalid/unexecuted gates are unchanged. Coverage gaps remain failures
that require meaningful component tests; this source routing is not a claim
that the mutation program or full system has passed.

Current wallet mutation targets use reviewed explicit component selections in
`governance/mutation-testing/wallet-component-tests.json`. The original wider
component universe remains an affected input, every registered property is
mandatory, and the registry bytes and resulting configuration are bound to the
exact-head qualification identity. Related-test discovery was measured to keep
368 of371 suites for a broad target; shared imports do not provide a useful
resource boundary. Selection narrows repeated execution, never the canonical
mutant inventory or score/zero-uncovered/invalid/unexecuted gates. Every target
with browser-owned source includes a bridge to all60 original cases across19
native browser case files, and the KDF worker target retains its dedicated real
worker coverage bridge. These tests delegate to the existing native controller
and relay only actual per-test instrumentation counters. The full original
browser catalogue remains independently mandatory. Neither selected test
presence nor a scoped native pass establishes full coverage, process-tree
qualification or completion; holes require meaningful component tests.

Wallet component CI explicitly delivers the source-pinned official Chrome for
Testing155.0.8059.39 ARM64 archive. Its measured198202003-byte archive expands
to415397541 bytes across306 entries; the archive and289475976-byte executable
are checked against separate fixed SHA256 pins. Transport is bounded, extraction
stays inside an owned private directory, and changed bytes, lengths, paths or
symlink substitutes fail. The installer preserves Chrome sandbox flags and, on restricted Ubuntu hosts,
installs a temporary AppArmor attachment for the exact verified executable.
The always-run cleanup removes that attachment and verifies its absence; the
global user-namespace restriction is unchanged. It exposes `CHROME_BIN` and an
explicit owned delivery receipt for the enclosing job;
its receipt is delivery-only and grants no runtime or process-tree qualification.
Mutation setup follows the actual selected tests, avoiding the download for
node-only targets; ordinary wallet shards also receive the native browser.
Complete real browser/controller/Stryker coverage and cleanup qualification are
still required, with no skipped cases or substituted browser.

Native browser delivery follows the actual Jest glob selection, including ordered
negative exclusions, through the declared Node toolchain's standard glob matcher.
Whole-package and genuinely matched native tests receive the pinned browser;
node-only patterns do not. Exact canonical mutation and full functional scopes
remain unchanged, and routing controls grant no runtime qualification.

The unchanged native request-sync oracle measured47.3 seconds for its two
complete23.5-second preparations. Its selected case now receives90 seconds,
within the original function's120-second finite ceiling; the other59 cases
retain30 seconds. Shared test-only budgets align the catalogue, driver, CDP and
Jest timers with startup and the retained30-second cleanup allowance. The
original28/30-second failures remain evidence. All original data, assertions,
crypto parameters, production expiries and memory/PID bounds remain unchanged.
This is measured test admission; full browser, mutation and system qualification
are still required, and the measured latency remains a performance baseline.

### Measured native connection heap admission

The complete small all13 fixture reached a genuine `SQLITE_NOMEM` opening
the retained reader (operation1, slot3), after6956 native requests. Its observed
address peak was8728KiB against32MiB, and simultaneous JavaScript working
charges peaked at31852 bytes against the original65536-byte owner. The
SQLite heap minimum is now8MiB for four simultaneous connection schemas and
page caches, with the existing larger-row derivation unchanged. The 64KiB
row/working, IPC, address, descriptor, disk and lifetime allowances remain
unchanged. Explicit4MiB allocator exhaustion controls remain independent.
The replacement executable must pass all13 original native component modes
and the actual all13 fixture before admission or runtime qualification is
claimed. This unreleased feature's fixture budget is not a production sizing
recommendation.

### Decoded page scratch lifetimes

Actual original64KiB inventory tracing found packed payload scratch charged for
18412 bytes after all copy/hash/native transactions had drained, followed by
another5602-byte proof scratch reservation. Both reduced the later retained
6400-byte metadata copy to only5602 bytes available. Temporary copy/hash and
proof scratch now reserve alongside retained page data and release once only
when their successful phase has physically drained, before the next phase.
Descriptors, original provenance, normalized/current/SQL rows remain charged;
rollback, failed preparation and retained cleanup never refund those copies or
a pending scratch reservation. Original row/working/page limits, proof checks,
data/oracles and native pin remain unchanged. Concurrent reservation, refusal,
idempotence and cancellation controls cover the original accounting ceiling.
The original all13 inventory and wider qualification still require current
runtime evidence; this accounting correction is not a production sizing claim.

The drained-scratch correction advances the original inventory to actual SQL
metadata preparation. Its blanket16384-byte descriptor reservation charged
small rows as though they held the maximum64 fields, in addition to unchanged
per-value normalization/SQL-copy charges. Metadata now reserves1024 bytes for
its own-key/descriptor containers plus256 per actual field (still at most64),
then retains every existing512-byte/16-times-string per-value charge. The
bounded key array is reused. Original65,536-byte page/row/working limits,
semantic validation, native transactions and negative controls remain. Runtime
validation of the complete inventory and wider system is still pending.

The next original inventory trace reaches the transaction table (page6) and
confirms text preparation has the same blanket16384-byte charge for a small
shallow metadata container. That container now uses the same1024-plus256-per-
actual-field accounting, explicitly capped at64 fields. Every actual UTF-8
conversion keeps its original512-plus16-times-byte precharge. Retained copies,
validation and original65,536-byte admission remain; full inventory/runtime
qualification is not inferred from these source corrections.

### Separate measured128KiB initial workload profile

The unchanged64KiB reference still refuses the output-table page: its next
retained metadata clone needs8272 bytes with4792 available, after temporary
scratch has drained. A separate128KiB profile now selects that allowance before
authentication, native handoff and restore; it never renews a saved admission.
It uses the same complete13-table fixture, data, mappings, exact bytes, proof,
cleanup and transfer widths64/256/1024. The independent oracle checks the exact
initial128KiB allocation throughout. The original64KiB positive reference and
its independent exact64KiB oracle remain unchanged and unqualified. Small-budget
refusal/cancellation/concurrency controls remain. The new measured profile has
the same original180-second source lifetime and an enclosing180-second test
allowance; old64KiB tests retain their original30-second allowance. This is a
sizing experiment, not a default/admission policy change or qualification claim.

The initial128KiB profile reaches COMPLETE in all three original transfer
widths, then exposes a fixture-only inventory reader error. The fixture used a
legacy destination fence despite disabling that public snapshot capability.
Inventory now uses the authenticated private store's actual owned query-only
slot3 transaction, enters the irreversible frozen comparison phase, proves query_only=1 and rejects an attempted setting change,
then runs the same independent complete-table/bytes/mapping/proof oracle.
Production fences, schemas, settings and grants remain unchanged. Complete
inventory/current gates still need runtime verification;64KiB reference remains
open and no whole-system qualification is inferred.

The final inventory fixture now enters the actual frozen native comparison
phase after COMPLETE, before borrowing the query-only reader. Immutability of
connection settings is a frozen-phase contract; ordinary import read leases
are physically read-only and separately checked at scope exit. The existing
setting-change refusal remains intact and is tested in its correct phase.
This lifecycle correction changes no native policy or original64KiB data.

Measured inventory contract: the identical all13-table fixture fully passes
initial128KiB admission at64/256/1024-byte transfers, including frozen reader
refusals, exact table/row/mapping/BLOB/proof inventory and complete cleanup.
Actual shared working peaks are69010,73578 and102002 bytes, all above64KiB;
128KiB leaves29070 bytes (22.18% of capacity) above the largest observed peak.
The historical64KiB positive failure is retained in operator evidence; the
current64KiB cases explicitly require the typed fixed-allocation refusal with
its exact error message, unchanged initial allowance/data and actual cleanup.
The128KiB full positive profile replaces the unrealistic capacity expectation
openly, following the maintainer's measured-limits direction. No runtime default
or existing admission is enlarged or renewed. Broader supported-workload,
concurrency/recovery, native memory/RSS and production sizing remain required;
this component result does not qualify the complete program or all hosts.

### Complete native source recipes

The Linux qualification/provisioning path selects the static component entry
for the actual ARM64/x64 Node24.18.0 ABI137 worker. Its separate `--check-host`
mode emits the actual Docker target only after the immutable registry check;
the provisioner compares it with the kernel architecture before allocation,
downloads or compiler work. Build metadata never grants a runtime descriptor or
worker attestation. Linux ARM64 and x64 now have distinct immutable component
entries. The genuine x64 source build passes all thirteen original contracts;
its 1381576 bytes have SHA256
`64384ba37ba21adb443830876658097890d476182086a89b32a8a2cc4cf7266b`.
The original x64 worker's tasks and cgroups were verified absent after cleanup.
Other platforms still refuse without a fallback. The original thirteen native contracts,
resource limits and exclusive pinned delivery are unchanged.

Native driver source inputs, the exact SQLite dependency cohort, Windows addon
source inputs and original Unix compiler arguments share one immutable internal
`native/source_recipe.cjs`. Source preparation previously omitted four included
local observer/pointer contract files; it now captures the complete same driver
cohort as candidate compilation and packaged artifact copying. Every source plan
records platform, architecture and owned compiler working directory; its relative
arguments use the original candidate recipe and stay within the captured root.
Pure plans cover Linux and Darwin on ARM64/x64. Darwin selects the worker
architecture explicitly with `-arch arm64` or `-arch x86_64` and omits the Linux
`-D_GNU_SOURCE` and `-ldl` flags. Linux compiler arguments remain unchanged.
The controlled preparation worker accepts those actual Unix platforms/architectures
with the unchanged Node24.18.0/ABI137 requirement. Windows source capture uses the
same driver/addon cohort through its separate original qualified-toolchain route.
These are source/build paths; source plans never enroll a host, change a runtime
pin or qualify a wallet. Exact native17 LinuxARM pin remains unchanged. Other host
artifacts/toolchains/supervisors and real qualification remain required. New
regressions inspect every actual captured source/SQLite digest and transitive
include, plus unsupported-target refusal before filesystem work. Compilers and
other operating systems are not executed by those pure plan regressions.

Candidate builders also check the architecture and executable kind encoded in
actual captured ELF64, thin Mach-O64 or PE32+ image headers before recording a
successful build receipt. Windows checks the staged driver's/addon's actual
bytes against its captured hash and requires the matching executable/DLL kind.
This catches compiler target mismatches, including a Darwin compiler default
that differs from a Node worker running under Rosetta. Header checks are a build
consistency check; they neither fully validate a loadable image nor grant runtime
admission. Synthetic format regressions provide no foreign-host qualification.
The existing runtime pins, protected-path checks and real host qualification
remain required.

### Windows first-artifact bootstrap

`tools/Brc38WindowsBootstrapBuild.cjs` separates first-artifact preparation from
the normal qualified Windows candidate builder. `prepareWindowsBootstrapSource`
captures all actual driver/addon C inputs, fixed SQLite source, bounded exact
Node24.18.0/ABI137 header/import-library inputs and the generated immutable MSVC
policy. It rejects missing/duplicate headers and checks captured Node version
macros. This preparation is pure source DATA on every host and runs no compiler or OS
helper. Before actual Windows compilation the authored PowerShell helper creates a protected actor-only NTFS
build directory before source bytes exist, refusing reparse ancestors and
unprotected or differently owned build parents. Its pathname/ACL observations
are build storage checks, not the runtime native HANDLE identity boundary.

`buildWindowsBootstrap` requires the actual Windows ARM64/x64 Node worker and
compiles the fixed supervisor and addon recipes directly through the reviewed
MSVC path. It uses explicit arguments and environment, no shell, bounded parent
output/deadlines and actual postimage/target checks. It does not require an addon
or supervisor that has not yet been built, and it never runs the new candidates.
The independently controlled isolated Windows worker must already enforce
compiler-tree resources, a finite outer deadline and physical shutdown. A parent
close or termination is explicitly not a compiler-tree drain receipt; every root
is retained even on successful compilation until the original worker physically
stops. A failed child prevents further work and requires that original shutdown.
Preparation-only failure cleanup retries actual retained descriptors before
removing only its own uncompiled source directory.

Bootstrap receipts remain unqualified build DATA: no runtime/artifact/toolchain
registry is populated, no host is enrolled, and no wallet capability is granted.
Actual Windows compiler, DACL/helper, complete process tree, addon/supervisor,
image/handle replacement and runtime cases must be qualified on that host before
fixed artifact entries are committed. Pure capture regressions use real authored
C/SQLite and explicitly synthetic Node dependency DATA, not Windows execution.
The source recipe does not claim an end-to-end or production-qualified Windows
route until the independent worker and actual platform qualification are proved.

The authored `Brc38WindowsBootstrapController.ps1`, managed
`Brc38WindowsBootstrapJob.cs` and `Brc38WindowsBootstrapWorker.cjs` now wire the
outer **process** worker. Inside an independently owned Windows host, invoke the
controller with `-Configuration <private-absolute-json-file>`. The configuration
contains `architecture`, exact `nodeExecutable` filename/size/SHA256, the
existing `bootstrap` options, and the ordered exact `controllerInputs` cohort
exported by `bootstrapWorkerPlan`. The configuration's parent is the protected
actor-only output parent; the controller creates its own private child and
freezes a new worker-options file. It holds real configuration/controller/Node
read descriptors against write/delete while the original worker runs.

The Windows controller prepares only the authored managed controller, creates
an unnamed non-inherited Job with kill-on-close and no breakaway flags, and
starts the exact Node24.18/ABI137 process suspended. Before resumption it assigns
and reads back actual Job membership, 12GiB aggregate memory, 512 active
processes and affinity to at most four available processors. Node heap remains
1536MiB. A monotonic600-second worker deadline encloses both original180-second
compiler stages and bounded source/helper/readback work; an additional10-second
drain allowance verifies actual original process exit and zero active Job
members. Even after Node exit0 it terminates remaining descendants. Concrete
original thread/process/Job handles must close before successful exported DATA.
The controller then checks actual source/Node postimages and protected candidate
hashes/PE targets, closes original file descriptors and retains every build root.
These are existing qualification-capacity bounds, not measured Windows production
sizing; actual Windows workload/headroom and failure cases remain to qualify.

PowerShell/.NET preparation occurs before the Node Job. The independently
controlled host must bound that preparation and controller lifetime, provide
network/token/VM isolation and physically stop if cleanup cannot be proved.
Job observations prove only that original process tree; they never claim VM
shutdown. A parent-controller crash leaves kill-on-close protection but no
verified drain receipt. `inspectBootstrapWorkerResult` validates exported DATA,
not live handles, runtime identity or host enrollment. Synthetic portable tests
cannot prove Windows Job, compiler, ACL, replacement or physical-host behavior.
Actual Windows end-to-end qualification and fixed trusted artifact entries
remain required. These maintainer tools are repository-only, not public wallet
exports or shipped runtime candidates.

### Unix first-artifact contract bootstrap

In an independently controlled Linux or Darwin ARM64/x64 Node24.18.0 ABI137 worker,
`node tools/Brc38NativeBootstrapQualification.cjs --sqlite-source /input/sqlite3.c --output-parent /private/work`
builds the reviewed pinned source and runs the same thirteen original contracts
used by native delivery. It captures and rechecks the actual immutable executable
descriptor, retains failed cleanup for concrete retry, and leaves a bounded
exclusive receipt in its owned root. The worker owner must inspect the evidence
and physically stop the worker before releasing its roots.

Linux launches its retained proc-fd. Darwin compares its actual private build
pathname and private directory to the still-open inode before and after each
contract. The isolated worker owner must exclude other actors with its UID:
these comparisons are not atomic pathname protection or a wallet installation.
The existing macOS runtime still requires its protected root-owned chain. Real
Darwin compilation, contract execution, resource behavior and protected delivery
remain unqualified.

This unpublished maintainer tool resolves first-artifact testing without an
existing runtime pin. Its receipt is comparison data: it installs nothing,
enrolls no host, and cannot authorize wallet execution. Real architecture-specific
resource and worker qualification, reviewed static pins, and protected delivery
remain required. Normal delivery still refuses an absent or mismatched pin.
Limits remain attached to their named resources; first-artifact evidence does
not establish production sizing or justify tighter arbitrary caps.

The root **Wallet native candidate contracts** workflow provides an isolated
Linux x64 first-artifact worker. It runs on a manual dispatch or a push to
`codex/native-bootstrap-qualification`; that auxiliary ref leaves a PR's long
integration campaign running. `scripts/provision-wallet-native-tests.sh
--bootstrap-only` retains the existing pinned compiler image, SQLite bytes,
source recipe, resource bounds and all thirteen contracts. Its uploaded source
identity and component receipt support review of a later static pin change.
It exports no runtime executable and runs no mutation, release or deployment
campaign. The ordinary no-argument provisioner and every integration, runtime,
platform and final qualification gate remain required.

### Darwin root copy and ordinary-actor qualification

The maintainer source route now separates root file preparation from ordinary
wallet execution. After genuine first-artifact qualification and an explicitly
reviewed fixed Darwin entry, an independently admitted worker can run
`tools/Brc38DarwinNativeInstall.cjs --source /absolute/native-candidate` as root
with Node24.18.0 ABI137. A missing platform pin refuses before filesystem work.
The destination is derived internally:
`/Library/Application Support/BSV Wallet/native/<architecture>/<sha256>/native-contract`.
There is no destination, platform or pin override. Root-owned directory identity,
exclusive creation, streamed exact source/target bytes and immutable mode555 are
checked. Existing files never change. Failed files remain as evidence; failed
actual descriptor closure keeps a concrete retry owner and blocks another copy.
These root/POSIX checks and comparison DATA do not attest Darwin ACLs or enroll a
runtime, host or wallet. Privileged installation requires separate authorization.

The non-root wallet actor then runs
`tools/Brc38DarwinNativeQualification.cjs --sqlite-source /absolute/sqlite3.c --output-parent /private/absolute/directory`.
It selects its actual Darwin architecture and fixed registry entry internally,
refuses an unsafe installed image through the original SDK factory before
compilation, retains that same original protected descriptor across its fresh
source build and all thirteen unchanged contracts, and checks the source and
installed launch postimages before closing it. It does not create or replace an
installed executable. The original SDK checks effective ordinary-actor writes,
including ACLs, and the root-owned path chain at launch; file-copy metadata is not
an ACL or launch verdict. Both phases require the original worker owner's
resource/network/lifetime isolation and verified physical drainage. Source and
Linux private filesystem regressions do not establish actual Darwin behavior.
No Darwin pin, actual root installation, foreign-host execution, production
budget change or completed platform/full-system qualification is supplied here.

### Existing Hyper-V outer worker for Windows bootstrap

`tools/Brc38WindowsBootstrapHyperV.ps1 -Configuration C:\Private\host-options.json -GuestCredential (Get-Credential)` is a maintainer source route for an independently admitted Windows Hyper-V host. It requires an already prepared disposable guest: exact VM GUID, name `ts569-native-windows-bootstrap-<fresh run UUID>` and Notes `brc38-bootstrap/<same UUID>`, initially Off with no VM worker process. It creates no VM, disk, account, runtime pin or paid capacity. The guest's retained local disk and all failure/build directories remain available for inspection.

The host work order uses protocol `brc38-windows-bootstrap-host-work-order/v1` and exactly these fields: `protocol`, `runId`, `vmId`, `architecture`, `guestActorSid`, `hostController`, `guestController`, and `guestConfiguration`. All three source inputs carry integer `bytes` and exact `sha256`; the two guest inputs also carry their canonical local `filename`. The guest controller basename must be `Brc38WindowsBootstrapController.ps1`. `tools/Brc38WindowsBootstrapHost.cjs` validates and freezes this bounded comparison DATA; it cannot authorize a host or SDK descriptor. Actual source/configuration files are separately held read-only and rechecked by the host/guest controllers. Credentials are supplied as a private in-memory PSCredential and never serialized into the work order or receipt.

Before starting that original guest, the host checks static16GiB memory, four CPUs, no virtual NIC, nested virtualization or checkpoints, local file-backed disks without pass-through/reparse paths, disabled guest file-copy integration and disabled enhanced sessions. This adapter currently requires the documented English integration-service name; other host locales and actual architecture availability remain qualification work. It uses [PowerShell Direct](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/powershell-direct), which does not depend on a guest network, to check the actual guest OS architecture and an ordinary, non-System, non-elevated actor SID before launching any existing bootstrap helper or managed compiler preparation.

A fresh SYSTEM scheduled watchdog is registered and read back before VM start, independently of the host controller and guest. Its20-minute deadline encloses startup, PowerShell/.NET preparation and the original nested600-second Node/compiler Job. The controller also checks its own monotonic/UTC deadline, fixed VM settings and watchdog while waiting. Every outcome stops only the same owned VM, observes actual Off state and absence of the captured original VM process using PID plus creation time, and removes its watchdog only after that proof. A failed or unproved shutdown keeps the watchdog and fails; a scheduled task or process-tree receipt alone never proves physical VM shutdown. A30-second shutdown request wait and separate30-second observation window are bounded independently. No VHD, VM, original build root or another actor's task is removed.

The16GiB/four-CPU outer allowance preserves4GiB of OS/controller headroom around the existing12GiB inner Job. The20-minute preparation allowance and60-second watchdog action bound are provisional qualification containment, not measured Windows demand or production recommendations. Actual startup/compiler/controller/recovery/resource/network/token/physical-stop proof, watchdog crash and failed-stop behavior, genuine source/toolchain/artifact provenance and the Windows addon/supervisor/runtime contracts remain mandatory before qualification. This source has not run on Windows or Hyper-V. Linux work-order/filesystem regressions cannot substitute for those results, cannot establish ARM64 Hyper-V availability, and cannot populate the empty Windows registries. The full goal remains unqualified.

### Architecture-specific Linux browser delivery

The source-owned browser delivery CLI now selects a fixed Chrome for Testing
155.0.8059.39 archive from the actual Node Linux ARM64 or x64 architecture. The
existing ARM64 pin and `browserPin` export remain unchanged. The separate x64
pin records the genuine official `linux64` archive:198195769 bytes,309 entries
and416502722 expanded bytes, with the297680200-byte x64 ELF executable. Exact
archive and executable digests are checked before delivery; extraction stays
inside the architecture-specific archive root. Another platform or architecture
refuses before creating a private delivery directory. There is no fallback to
another browser or inferred artifact pin.

Both archives are listed by [Google Chrome for Testing](https://googlechromelabs.github.io/chrome-for-testing/).
A delivered artifact is data, with `runtimeQualified:false` and
`processTreeQualified:false`. The actual browser catalogue, worker, resource and
physical process-tree checks remain mandatory on an admitted native worker.
The ARM64 CI lane and all case/cleanup bounds are unchanged; source support and
artifact capture do not qualify the complete x64 Docker provisioning script or
the full system. That script requires an actual Docker-capable Linux worker; an
existing containerd-only worker cannot be silently substituted.

### Frozen comparison scratch collection

Final authenticated native comparison may retire unreferenced scratch content
created by its reconstruction passes. The native authorizer permits only direct
updates of the existing main-database collection progress `nextFamily` field;
the source-owned SQL guards still require alternating families. Insert, delete,
slot changes, schema/settings, wallet/source rows, pointers and clocks remain
protected. The genuine drained-lifecycle regression stages both binary and text
scratch, collects one chunk per pass after freezing, and verifies cleanup plus
those negative controls. The previous executable fails at the observed progress
update; all five actual comparison lifecycle cases pass on the corrected ARM
executable. The full customer workflow exposed this omission after all 14 rows
committed; publication, restart and repeat import still require a complete rerun.

At the preceding comparison-lifecycle checkpoint, both Linux ARM and x64
candidates passed all thirteen original native contracts, with original worker/process/cgroup cleanup verified before their
static pins were adopted. ARM is 1,353,552 bytes with SHA-256
`295ae7b2511b7565dd49ed352ba9e8de5cf6b924c89cb021e1d9ec5bcac929dd`;
x64 is 1,381,576 bytes with SHA-256
`4ae3984e9c4a89dd3628ae9ff86613f61c3813f281ac6c16dedbe98279dd4af1`.
Current normal delivery, packaging and complete customer/platform qualification
remain required. No public API, wire format, schema, existing admission, native
resource formula or browser limit changes. Existing unreleased minor-version
and host-specific migration requirements still apply.

### WAL recovery copy format

The new recovery copy finishes through the pinned SQLite engine's own rollback
journal before a frozen comparison process opens it. Online backup can preserve
WAL header versions even when its destination was configured for DELETE mode.
A post-copy SQL PRAGMA attempts a WAL open before it can change those versions,
which the original private scratch VFS correctly refuses. Finalization therefore
uses the pinned engine's journaled transition under the same actual copy owner,
retained source READ, physical quota and original operation deadline. No direct
filesystem/header write, immutable-open shortcut or extra WAL/SHM allowance is
introduced. The source file and original financial expiry remain unchanged.

The rebuilt Linux ARM64 component is 1,353,568 bytes with SHA-256
`0eca37f702a2597cc39ee5b266ece6c189034caca80356e22a1b94e5afa40a31`.
All thirteen original native component contracts pass on that exact source build.
The same native source also passed all thirteen original contracts on actual
Linux x64 in the isolated candidate-contract workflow. That component is
1,385,664 bytes with SHA-256
`9e50ead53bd9aa0757f7aebcde29be6bd7ce3faecaad00249515d66198987fed`.
Both reviewed static pins bind those measured artifacts; bootstrap evidence
never installs or admits an executable. The ARM64 frozen-copy transport diagnostic
also passes after real original expiry, including complete proof bytes,
cancellation, capacity refusal and cleanup. Full composed expired recovery,
normal delivery and complete platform qualification remain separate required
gates. All original native ABI, source-build/loader checks and resource limits
remain mandatory.

### Closed-facade copy deadline

The full occupied customer workflow passes final native comparison and its
physical copy, then reaches a retained receiving callback after the SQL facade
has intentionally closed. Reading the facade's live-operation deadline getter
there wrongly refuses the handoff. The merge captures the same original absolute
deadline before copying and retains it as clock data. Each receiving callback
still checks actual actor and target membership, cancellation, its original
monotonic deadline, shared working ownership and the physically drained native
copy owner. No admission is renewed, SQL facade reopened or resource ceiling
changed. The failed full workflow and its physical cleanup are retained; current
complete customer, recovery, repeat-import and whole-system qualification remain
pending. Native source, recipes and genuinely qualified ARM/x64 pins are unchanged.

### Measured complete-customer scenario allowance

The complete source405 customer attempt took 2,509 seconds before its first
publication callback, without reaching customer write, current recovery or
repeat import. The overall customer test now allows two hours plus 30 seconds
for cleanup. Each original operation still has one fixed initial one-hour
admission: first import, a distinct completed-current recovery purpose, and a
new repeat import with a different reservation. The test preserves and asserts
the first source limits and projection deadline; no old reservation is renewed.
The three-minute helper default, one-hour component ceilings, cancellation and
separate actual-expiry cases, original data/oracles and UTC/monotonic checks
remain. This scenario allowance is not a production default or performance SLO.
The source408 two-hour fixture experiment failed during setup at the unchanged
JSON index ceiling and is withdrawn. Current full customer validation is pending.
The existing 145-minute hosted native lane remains. An actual two-family native
collector comparison measured about 749 ms at 32 chunks versus 225 ms at 256,
with longer writer transactions at the larger batch. Batching stays unchanged;
that component result does not explain the complete workflow cost.

### Original-stage expiry cleanup

An expired original native stage cannot acquire another writer to release its
derived TEXT holds. The store now retains the bounded JavaScript metadata
charge until its same SQL facade and physical kernel owner have drained, as
recovery-copy cleanup already does. Persisted holds and chunks remain charged
in the original private database; this releases no database quota, grants no
SQL access, removes no foreign hold, and renews no deadline. A live original
stage cannot use the deferred expiry path. Physical drainage failures retain
the callback and charge for explicit retry; successful disposal also releases
the pending metadata.

A genuine regression waits for the existing fixture's original three-minute
UTC expiry, checks the actual retained TEXT hold and refused writer, and
requires the working charge to survive callback closure until physical owner
drainage and fixture directory removal. The Linux before/after regression passed:
the old implementation retained the TEXT charge, while the prior 49 native
private contracts passed, including real original expiry. Root checks, all five
comparison cases, both copy-owner cases, native delivery regressions and the
complete offline packed consumer also passed. This is scoped cleanup evidence.
The measured one-hour full customer failure remains unqualified. Review the
supported workload and repeated checkpoint costs together before choosing a
proportionate optimization or measured time allowance. The one-hour ceiling
is not a proved production requirement; expiry cleanup must work for any
chosen allowance. The authorized 30% browser increase remains until review
after the full goal is achieved. Full customer, platform, mutation and
exact-head CI qualification remain open.

### Bounded checkpoint reconstruction batches

Independent checkpoint inventory still validates every original journal page,
row, observation and mapped ID. It now reconstructs the complete sync map at a
completion boundary or after a bounded window of at most 128 pages/mappings,
rather than after every page. Retained delta metadata is explicitly charged;
tighter working headroom falls back to individual reconstruction. Existing
larger pages retain their individual path. Ordered counter resets and overflow
before a reset, per-page duplicate refusal, cross-page mapping conflicts, dates
and all unknown JSON members remain checked. Both original-source passes,
authenticated EOF and final full-byte postimage comparisons remain. No source
or activation verdict is cached and no production limit or expiry changes.
The original one-hour customer failure remains evidence. A later original run
measured three completed checkpoint comparisons at 34.4–34.5 seconds, then
failed the separate cutover image check. Complete customer and production
performance qualification remain pending.

After successful physical disposal, a failed metadata observer remains queued.
Both `discard()` and `close()` now retry that metadata release without repeating
SQL teardown, kernel release or filesystem removal. The store stays closed and
its original expiry remains unchanged. Two native fault controls use real finite
expiry and require the 8 KiB working charge to survive the failure, then drain
after retry; persisted catalog quota remains until explicit collection. These
controls supplement the unchanged original three-minute expiry regression.
Full customer, platform, fault and exact-head qualification remain open.

### Composed image and comparison scheduling

A complete frozen native SQL image includes the persisted content-collector
scheduling bit. The previous collector advanced it even with no work, so a
native control changed and restored the full image without retiring a chunk.
Collection now alternates while either queue has work and returns to zero when
both queues are empty. Empty calls leave that quiescent state unchanged, including
after an odd retirement page. All schema, reference, writer and page bounds
remain; the complete image still includes the scheduler.

Cutover now checks the original private image against the receiving-copy receipt
before fresh reconstruction and collection. The kernel must already be in its
immutable semantic comparison phase. All complete row, field, provenance and
checkpoint comparisons still run; the original source fence is checked again
afterward. The actual receiving owner separately reads its complete typed image
and verifies physical copied bytes before source retirement and target
activation. No image field is omitted or normalized, no receipt or ownership
verdict becomes authority, and no API, wire, schema, limit or expiry changes.

The previous original customer run passed all three checkpoint comparisons in
34.4–34.5 seconds, compared with about 624 seconds before batching, then stopped
at the image consistency check before retirement and activation. The current
ordering correction alone did not complete the workflow: another original run
passed three checkpoint comparisons in about 35 seconds and then failed the
full-image consistency check at cutover. No timeout or memory-limit event caused
that failure. Two genuine native regressions cover empty and odd-page
quiescence; original customer write/restart/repeat and complete qualification
remain required. The correction changes no image oracle, capacity or deadline. Supported workload, measured
headroom and total engineering cost must justify discretionary limits; these
fixture measurements do not establish production sizing.

### Durable incremental private checkpoints

The owned native merge now selects an additive private checkpoint window. Each
page still commits entity effects, actual ID mappings, provenance, stock
checkpoint scalar metadata and its destination receipt atomically. The complete
operational map remains at its recorded materialization boundary while pages are
pending in the inactive candidate. It is materialized from authenticated source
rows and actual committed mappings at completion or the existing bounded
128-page/mapping reconstruction window, in the final page's same writer and ACK.
A larger originally admitted single page is materialized immediately; import
capacity, original budgets and deadlines are unchanged. Pending numeric mappings
bound the next prepared page so a window cannot overrun its existing allowance.

Private v2 observations add an explicit `materializedNextRow` within the existing
512-byte journal observation allowance. Existing v1 bytes remain readable and
mean that each page already materialized its map. Resume follows an existing v2
cursor even if the new option is absent; timestamps and generated reference
values retain their original meanings. Lost-ACK replay returns the committed
receipt without repeating entity or map effects. Later archived sync-state pages
remain inert provenance and cannot advance across pending map effects. Mapping
conflicts with the original operational map are checked during materialization;
a deferred page ACK proves its durable row/map/journal effects, not a complete
operational-map or activation verdict. Failed preparation or materialization
leaves the candidate inactive and retains the original recovery admission.

The final independent inventory continues to reconstruct the entire expected
map from the original source and every actual committed page, including unknown
JSON members, counter resets, dates and mapping conflicts. Full source/current
ownership, schema, copied-image and physical-content checks remain. No published
BRC-38/39 format, database DDL, native binary or default legacy helper behavior
changes. Newly written private v2 candidates require this implementation on
resume; older binaries must not operate on them. Matching unpublished 2.15.0
candidate artifacts and retained original v1 custody remain the recovery path.

This implementation is authored and UNQUALIFIED. Protocol boundary controls,
genuine occupied import/cancellation/resume/repeat/independent comparison,
performance/resource measurements and complete platform qualification are still
required. No production capacity or latency claim follows from the window.

### Occupied proof identity compatibility

Native occupied archive merge retains the exact incoming transaction ID spelling
for the existing BINARY-index lookup and stored proof identity, matching the
legacy entity and IDB paths. Hexadecimal proof comparisons remain case-insensitive,
and case variants within one incoming page still trigger the alias guard. An
unchanged proof reuses its original local ID, complete bytes and metadata; later
rows map to that ID rather than a second normalized copy. Changed/new proofs
still require full raw transaction, Merkle path and active-header verification.
The independent final inventory checks the exact stored identity as well as all
proof bytes. No wire, schema, resource-limit or data migration is introduced.
This correction remains unqualified until the actual regression and complete
customer workflow pass; source presence is not a release or production verdict.

The targeted proof-spelling qualification explicitly selects the existing
16 KiB native read allowance and a fresh fifteen-minute fixture admission.
All three initial five-minute packets expired during complete candidate
preparation before the proof oracle ran; that failed evidence is retained.
The selection changes no production resource ceiling, original customer data,
existing fixture defaults, or already-admitted expiry. Every actual UTC and
monotonic expiry check, finite operation guard, cleanup owner and complete proof
byte/metadata assertion remains. These test allowances are not production SLOs.

Explicit PostgreSQL data deletion keeps the journal source and destination
rollback callbacks under the same existing SQL-dialect guard as forward
migrations. Their recorded PostgreSQL entries remain no-ops, while SQLite and
MySQL retain actual journal cleanup and ordinary downgrade refusals. A
regression exercises both real migration callbacks through `dropAllData()` on a
PostgreSQL Knex client and refuses any snapshot SQL or connection acquisition.
No PostgreSQL snapshot capability, schema, API or data-format migration is added.

The complete private native restore success fixture explicitly admits 8 MiB of
physical storage so the current full journal schema fits after its unchanged
three-image recovery reservation. The small 4 MiB helper default and exhaustion
controls remain. All thirteen tables, provenance, foreground profiles, replay,
cancellation, expiry, 300-case property seed and owner/deadline/allocation bounds
remain. The schema batching regression chooses the actual settings UPDATE
observer name from its independent SQL inventory, then checks its canonical
source definition; retained legacy and compact names preserve identical byte,
ordering, rollback, query-count and 16 KiB response-bound assertions. These are
qualification corrections, not production resource or schema changes.

### Native runner qualification allowances

The three original runner/refold/lost-ACK contract cases now select fresh
one-hour fixture admissions and the existing 16 KiB native read allowance,
with a 30-second outer runner cleanup margin. The old source-only 30-second
runner timeout and default three-minute fixture could not accommodate genuine
all-47 candidate preparation: measured partial proof cases took 360.523–361.225
seconds, and the unchanged full customer import/write/restart/repeat case took
2,364.459 seconds. These cases also perform repeated independent full inventories
and real refolds/reopens. All original test data, operations, assertions,
4096-operation guards, policy-resume checks, actual UTC/monotonic expiry and
cleanup owners remain. No expired packet is renewed. Production ceilings,
defaults and the original customer case are unchanged. These fresh contract
selections remain unqualified until their actual runs; one-hour admissions are
test containment, not production latency promises. Worst-case sequential
qualification can consume three hours plus bounded setup/cleanup; actual cost,
including failed runs and agent/operator effort, must be recorded.

The preceding source419 proof-spelling regressions all passed on Linux ARM,
and the unchanged original customer case completed both imports, its later
write and current restart recovery, all 47 semantic/auxiliary/provenance checks,
and eight independent complete checkpoint reconstructions. Its other 20
customer scenarios and the broader fault/platform/performance and exact-head
qualification remain open. Passing one workflow does not prove those gates.

The first full native runner contract passed on source420 in 783.690 seconds
(788.011 seconds for its supervised Jest step), including scope drainage, all
47 final families, unchanged repeat results, policy-resume refusal and real
reservation reopen. The foreground-refold selection failed normally after
576.509 seconds: its drain probe expected a completed candidate user at every
yield, but the inactive refold deliberately clears every family before recopy.
No timeout or resource limit was hit; the source user remained present.

The drain probe now permits an empty candidate only for the first genuine
rebuild's terminal CLEAR or initial COPY journal boundary, with zero records
and an independent empty query against every physical family. Other boundaries
still require one candidate user. Every source-user check and the final complete
all-47 inventory, original data, mutation, repeated-result, policy-resume and
reopen assertions remain. This corrects a phase-inappropriate probe, not a
production refold change. The corrected selection and committed-ACK-loss case
still require actual qualification; the failed probe receipt is retained.

### Jest native fixture setup

The original wallet Jest optimization bound only `Math` inside its test VM
with `sandboxInjectedGlobals: ['Math']`, avoiding global proxy overhead during
complete native fixture construction. The readiness configuration now also binds
String, Number, Object, Array and Reflect to their existing realm values,
as verified above. On the same Linux ARM64 inputs, the earlier Math-only comparison found that
the original native proof-pair case failed its existing fixture lifetime with
the default binding; changing only this setting passed the complete case in
207.349 seconds. That configuration-only comparison is diagnostic evidence;
the authored configuration still requires the original native lane capture.

The independent profiles, 131,073-byte proof, other payloads and assertions are
preserved. The binding comparison used the then-current 600-second fixture and
660-second case; the paired-fixture budget described above now adds measured
coverage headroom. This setting affects the test harness and changes no production resource ceiling,
wire format, persisted data or runtime API. Whole native, platform, performance
and exact-head CI qualification remain separate requirements.

Native action contract failures identify the mismatched column without printing
wallet values, payloads or identities. The full original scalar/date/binary row
comparisons and rejection of internal row identifiers remain intact. A named
column diagnoses a failed contract; it does not qualify its production behavior.

Native proof sync validates hex identifiers while retaining their original
stored spelling for indexed lookup and persistence. Lowercasing before a
case-sensitive lookup could miss an existing uppercase proof, insert another
row and redirect the transaction proof link. Cryptographic comparisons still
normalize hex inside the original streamed proof oracle, and duplicate-page
comparison still rejects case aliases. Complete native proof contracts also
compare the total proof-row count before and after the occupied merge, alongside
all original bytes, metadata, mapping and durable acknowledgement checks.

The native MySQL archive fixture also records the schema from the complete
current production migration lifecycle. It requires the latest native journal
migration in the captured source binding and independently verifies that its
migration row is published exactly once; the original complete capture, source
metadata, relationship and byte assertions remain unchanged.

The disposable native MySQL archive and journal qualification fixtures each
allow 2 GiB of memory. A complete current-schema archive capture passed at the
former 1 GiB cap, but the subsequent profile fixture was killed by the kernel
for exceeding it (Docker OOM event and exit 137). The bounded allowance covers
both engine memory and the existing 512 MiB RAM-backed data volume. CPU, PID,
data-volume, case, readiness and cleanup bounds remain unchanged. This is a
test-fixture allowance, not a production sizing recommendation; later full
qualification must measure its headroom.

The complete native MySQL certificate qualification group has a 90-second child
allowance; the other eight groups retain 60 seconds. On the pinned local fixture,
certificate took 34.4 seconds. The preceding archive, profile and relation groups
ran about twice as slowly in hosted CI, where certificate reached its former
60-second deadline. This measured allowance preserves every process-loss,
locking, schedule and seek case, assertion and deterministic property seed.
The 60-second server-readiness deadline, 15-second Docker commands, 1 MiB child
output ceiling and fixture resource caps remain unchanged. It is a qualification
budget, not a production latency target or a performance/headroom claim.

The isolated MySQL server-crash fixture resets its auxiliary journal before the
first crash child, as it already does between later boundaries. The complete
production migration now installs that journal; resetting the synthetic fixture
therefore makes the original CREATE boundaries available. An independent full
source-row comparison must remain equal after reset. All 24 server-crash cases
across READ COMMITTED and REPEATABLE READ, source/epoch/marker checks and original
child deadlines remain unchanged. No customer migration performs this reset.

Journal capture, retention and maintenance fixtures use their original custom
receipt policy. Their explicit historical setup runs every migration preceding
the registered journal, including the SQLite index generation, then installs
their original journal policy. It independently requires no journal generation
table or migration row before that installation. Production receipt-policy
ownership remains strict; the complete current production migration is still
used by the ordinary archive, generation and server-crash fixtures. All original
fixture datasets, assertions, isolation modes and time bounds remain.

The native SQLite journal generation crash, capture and retention fixtures use the same explicit pre-journal historical setup as their MySQL counterparts. This retains every preceding migration and independently checks that the journal generation and migration record are absent before installing the original fixture policy. The complete WAL crash boundaries, data assertions and child deadlines remain unchanged; normal production migrations retain their policy ownership checks.

Whole-wallet fixture integration retains live page-reader counters, compares retained rows in their explicit primary-key order, and selects the existing explicit legacy notification normalizer for the occupied-source oracle. Legacy stage refusal checks the current exact private-native ownership error and still proves no callback or file effects. The empty native bootstrap fixture admits a bounded 8 MiB physical allowance after its 4 MiB allowance (336 database pages with the existing rollback reservation) could not install the fixed journal schema. Logical, working-memory, expiry, process-loss and data assertions remain unchanged. The original wider-shard and isolated native resume runs both exceeded their 30-second test clocks; those failed samples remain retained.

The two complete native candidate resume contracts now explicitly retain the original 180-second fixture lifetime and admit it plus a bounded 30-second cleanup allowance in the test harness. The previous 30-second harness clocks preempted the existing owner lease in both wider-shard and isolated runs. All 47-table COPY/resume, signed-ID/recovery, foreign-key, UNIQUE rebuild and key-swap assertions and the finite operation guard remain unchanged. Production limits and the actual fixture expiry are unchanged and cannot be renewed by this allowance. Full elapsed-time and resource evidence is still required; this test admission is not a performance or headroom claim.

The native candidate resume fixtures use positive safe basket and label identities, as required by the published thirteen-table sync journal. Negative logical wallet IDs disable that journal; the source-read fence then correctly refuses the source. The original failed full-file run is retained. These cases now check the actual enabled clock before and after source mutation and label setup. They preserve negative auxiliary monitor IDs, signed inactive sync-state inventory, all 47-table comparisons, parent replacement, interrupted recovery, natural-key reuse and UNIQUE swaps. The production journal and activation safeguards are unchanged; this corrects a fixture that had invalidated its own published source.

The complete valid-source resume run passed COPY/resume in 149.368 seconds; its UNIQUE rebuild was interrupted at the actual 180-second owner expiry. That second fixture performs an initial COPY, child-first cleanup and a complete fresh COPY. It now explicitly admits two existing 180-second copy windows under one finite owner, plus 30 seconds of harness cleanup. The first fixture retains its 180-second owner and 210-second harness. Shared fixture defaults, production deadlines, step bounds, source guards and every inventory/recovery/UNIQUE assertion are unchanged. The expired sample remains failed evidence; this measured fixture admission does not establish production performance.

The full wallet campaign on source451 passed its four original recovery prerequisites but stopped when the private incoming page allocation case reached its 30-second Jest clock. Its existing native fixture owner allows 180 seconds. The same mismatch occurred in 21 declarations across 12 native contract files; those harnesses now admit the original owner plus 30 seconds of cleanup. Fixture lifetimes, shared defaults, operation deadlines, datasets, assertions and production limits are unchanged. Existing longer contract clocks are preserved. This admission remains finite and requires full-file and whole-wallet validation; it is not a production performance claim. The failed sample is retained. The isolated Postgres fixture used 770.668 MiB of fresh disk-backed data without an OOM or storage exhaustion, and its owned container and volume were removed and independently verified before diagnosis.

Native integration failures retain their original merge and capture exceptions instead of replacing unexpected failures with observer-state assertions. The retained-source and scalar TEXT test oracles identify differing field names and extent coordinates without printing archive bytes or identity values. Every original equality, refusal, lifetime and cleanup assertion remains. These diagnostics resolve failed integration evidence; they do not qualify the full source or change production behavior.

The native journal capture, destination writer and maintenance paths inspect
and require the sealed profile's original zero busy timeout on the actual
borrowed connection. Fresh stock SQLite writers still set and verify zero.
The native occupied merge runner releases its original bounded operation frame
after both scoped actors drain and before invoking progress observers; operation,
allocation and expiry ceilings remain unchanged. These are compatible integration
corrections, with no API, wire or schema migration. Qualification remains pending.
Retained-source tests capture the current persisted user header independently.
All seventeen scalar TEXT fields retain exact positive windows from one coherent
view; each forged physical length uses a fresh view and must preserve its original
read/close error and refuse reuse, because a failed physical read retires the view.

Measured native test admission is local to the complete workflows that exceeded
their original 180-second fixture lifetime: copy/allocation uses 360 seconds;
each three-date user-inventory workflow uses 540 seconds for setup, initial full
merge and source-revision refold; large-record metadata/hash uses 480 seconds
for setup and its original 120-second window phase. Each harness adds 30 seconds
for cleanup. The fixture default, production operation/IPC/read ceilings and
all original cases, fault variants and datasets remain unchanged. These finite
allowances require measured validation; earlier expiry failures remain evidence.

The complete authenticated native merge fixture selects one finite 1200-second
reservation plus 30 seconds of harness cleanup. The measured initial workflow
expired at 540059 milliseconds during final inventory; the allowance covers
that 540-second initial window, a second full window for repeat/resume, and
120 seconds for independent inventory and custody checks. All six original
variants, Unicode/NUL data, 1024-byte reads, full semantic/custody/range checks
and finite operation bounds remain. The original reservation expires without
renewal or reset. Shared fixture defaults and production limits are unchanged;
full native and system qualification remains required.

The authenticated public-entry cases run as six dedicated CI coverage lanes,
separate from the six lower-level native merge contracts. Each lane reports all
six original names, one passing selected case and five pending unselected cases.
The aggregate gate requires every distinct lane at the current head, source and
routing-plan hashes and rereads the original report bytes. Missing, duplicate,
stale, changed, failed or skipped evidence refuses the gate. Ordinary wallet
shards omit this file only because these mandatory lanes cover its full union.
All existing coverage lanes and their budgets remain. This CI integration does
not qualify the full workflow or establish production readiness.

Authenticated native merge contract failures report bounded phase counters,
completed-operation timing and the remaining original reservation lifetime.
The report retains no operation list, wallet values, payloads or identities and
rethrows the original error. It helps distinguish setup, repeated baseline work
and incoming merge costs while preserving the six variants, full dataset,
allocation assertions and finite workflow limits; it is diagnostic evidence,
not complete qualification.

Native baseline schema selection reuses successful same-call TEXT-family
validation, which already verifies the complete binary family on the actual
transaction. Absent TEXT still requires an independent binary check. Full
observer, family, index and owner checks remain fresh, with no cached verdict
or increased resource limit. This removes duplicate queries from bounded
merge operations; whole-workflow performance still requires measurement.

The bounded baseline schema regression targets the original physical
window-progress table in either supported observer naming family. It requires
exactly one matching observer, rejects both its removal and altered definition,
and verifies exact generation, page-count and complete object rollback.
The fresh private fixture can use historical names without weakening the
compact-family or mixed-schema checks.

If an in-flight native merge operation fails and the runner subsequently refuses
its original binding, storage root or finite lifetime, the same runner refusal
retains the original operation failure as `Error.cause`. Its class, message and
refusal behavior remain; the cause does not renew ownership or permit progress.
Cancellation and destination-owner assertions retain their existing behavior.

The authenticated native fixture reads reservation custody with the package's
existing `better-sqlite3` driver through an independent readonly stock Knex
connection after controller drainage. The actual driver refuses writes and
missing files; it does not substitute a retained native facade or authorize an
owner. Resume, repeat and negative encrypted replays emit at most 1024 bytes per
chunk, matching the fixture's original ciphertext cap. Payload bytes, all six
variants and the original semantic/custody/resource assertions remain; full
native and system qualification is still required.

Confirmed IndexedDB internalization resolves and validates the block header
before opening the storage writer. The asynchronous header lookup therefore
cannot finish an IndexedDB transaction before its proven transaction, wallet
transaction and recipient outputs are stored. Missing or malformed headers and
invalid proofs still refuse before writes. The upstream five-case regression
is retained unchanged. The unpublished candidate includes main's confirmed-internalize fix with its
coherent release and migration notes. Full native and system qualification
remains required.

The confirmed intake path also retains recipient ownership when valid incoming
AtomicBEEF carries an anchored parent but omits the recipient BUMP and the actual
storage lookup finds an existing recipient proof. The lookup remains inside the
writer; output and basket credit use that same writer without a header lookup,
network publication or new proof request. A separate genuine IndexedDB regression
uses the real proof lookup and stored record; the original five upstream cases
remain unchanged. This compatible correction does not change stored schemas or
public APIs. Whole-system and physical-platform qualification remain pending.

Fresh hosted builds require the fixed native CJS/source assets before the
compiled quota factories are imported. The ordinary wallet build now compiles,
installs its existing bounded artifact cohort, then checks the original generated
quota-source bytes. It does not change generated SQL/C, runtime admission or
qualification. A clean-output build must exercise this order; reused outputs are
insufficient evidence. The repository-health CI job installs locked root and
wallet compiler dependencies and rebuilds the audited esbuild binary before
running its unchanged complete control suite, including real ts-jest/esbuild
configuration regressions. No check is skipped or suppressed.

### Reproducible native test SQLite input

Native test provisioning selects the UDL-enabled SQLite 3.53.4 amalgamation
from the frozen `better-sqlite3` installation. Its 9,516,284 bytes and SHA-256
match the qualified source recipe. The public SQLite ZIP contains a differently
generated parser and cannot reproduce that build. An explicit
`TS_STACK_NATIVE_SQLITE_SOURCE` still undergoes the same exact size and digest
checks. The compiler recipe, executable registry, thirteen standalone contracts
and full system qualification requirements remain unchanged.

### Own-data remote codec reconstruction

Binary transfer restoration and authenticated snapshot protocol dictionaries
reuse the JSON-RPC codec's own-data descriptor batch. No remote property name
uses an assignment or inherited setter. Valid own reserved spellings remain
round-trippable in general binary frames; the snapshot protocol retains its
closed field schema and rejects accessor, inherited and extra fields. Framing,
wire bytes, limits, dates, binary contents and compatibility are unchanged.
The helper is internal to codecs; package entry exports are unchanged.

### Qualification descriptor and transfer oracles

Qualification filesystem readers bind metadata and bytes to the same opened descriptor, preserve the original physical inode checks and close handles on refusal. Worker-asset manifests and compatibility cohort inputs retain their existing finite bounds; qualification fixtures retain every original assertion, case and deadline. The Worker-module transfer oracle uses an independent arbitrary 32-byte mock key rather than hashing password inputs; physical Argon2/KDF execution remains separately required. No public API, archive/database format, production KDF or runtime/resource/default migration is introduced. Full system and exact-head analyzer qualification remain pending.

## Pre-construction conflict recovery

The held 2.15.0 candidate preserves remote storage's empty attempted-TXID sentinel

## Internalization refusal and rollback boundaries

Signer and storage boundaries independently validate the AtomicBEEF subject,
proof verdict and requested ownership before admitting outputs. Early basket
classification and final basket admission share the same pure policy: the
wallet's default basket cannot be a custom insertion destination. Both checks
retain the existing error identity and occur before a basket lookup or write.

Synthetic port-fault regressions cover inconsistent verifier and validator
results, missing inclusion information, transaction races, degenerate child
keys and failed publication. They verify the retained storage state as well
as the error. Failed publication restores only inputs transitioned by that
attempt and does not admit requested outputs, labels, baskets or tags;
bookkeeping preserves a different recorded spender even when a legacy row
still says spendable. These checks do not replace chain verification or prove
real-network broadcast. Public methods, remittances, schemas and defaults
require no migration.

The failed-publication fixture supplies the optional new-request signal through
a disclosed synthetic storage port and uses real SQLite ownership writes and
rollback. The ordinary concrete provider path retains its existing behavior.
Additional mined recovery and tag-free insertion cases check retained balances,
proof identities, transaction lifecycle and empty metadata without network I/O.

The failed-publication regression binds both stored inputs to the transaction
actually consumed. At the publication boundary it observes committed SQLite
spend transitions for own and foreign rows, then checks restoration of the
complete original rows apart from their update timestamps.

## Pre-construction conflict recovery

The 2.15.0 candidate preserves remote storage's empty attempted-TXID sentinel
only for a bounded double-spend review before transaction construction. It does
not authorize a retry. Applications must verify complete competing transactions
against the requested explicit inputs, synchronize the accepted winner, then
read fresh state before rebuilding. Upgrade the application SDK alongside the
wallet parser. Use the existing JSON wallet API for structured review errors;
the binary wire format is unchanged. No database or call migration is required.

### Existing certificate types

With the compatibility SDK, existing BRC-100 methods can list, prove and relinquish
historical certificates without rewriting them. Listing and proof use unchanged
storage RPCs. For relinquishment, upgrade the storage server SDK as well: its
existing reference validator must accept the historical type. New signing and
acquisition remain strictly 32 bytes. See [the compatibility contract](../../../specs/wallet/legacy-certificate-wire.md).

Streamed scalar TEXT checks its following row delimiter before finishing a provisional field. Reader-only snapshot peers refuse destination operations through the existing negotiation error even with absent source/session DATA; valid source/page DATA remain detached before asynchronous work. The field-policy success fixture uses a valid sync-state status and retains independent invalid-status rejection. No consumer migration, archive-format, resource-default or capability expansion.

Authenticated import regression tests retain the physical oversized-row extent refusal before payload loading using a genuine owned provisional store, and separately prove sealed-row mutation rejection with unchanged authenticated reads. Indexed data reads still prohibit OFFSET and data aggregates; only bounded SQLite catalog seal checks are admitted. The complete native checkpoint-delta regression uses the existing 180-second fixture lifetime as its outer test guard, preserving the original residual native and staging deadlines, all fields, maps, unknown members, bytes and allocation checks. No production behavior, default or limit changes; full-system qualification remains pending.

Integration test fixtures retain exact binary descriptors while keeping read observations outside descriptor data. Authorization query fixtures exercise the coherent read and packed-text query seams with the original authenticated ownership predicate and pagination. Schema-definition tests verify bounded name/SQL projections, exact ordered type/name pairs and each page limit. Complete native allocation/resume workflows explicitly select the existing 16 KiB read option; 1 KiB defaults, original finite owners and all independent data/rollback/custody assertions remain. The occupied IndexedDB request component uses its existing 120-second verifier window with 30 seconds of outer cleanup allowance. No production behavior, default, wire/schema, API or resource limit changes; full-system qualification remains pending.

Private publication and profile-mode regressions match the current filesystem guard error while independently checking the actual restricted mode and unchanged exact device/inode. Copied-root and physical-lease regressions match the current ownership guard. All original refusal, descriptor-close, payload, copy and retirement assertions remain; production guards and defaults are unchanged.

Native streamed integration cases use a finite 210-second outer test window around the fixture's existing 180-second wall-clock and monotonic lifetime, leaving 30 seconds for its original physical-owner cleanup. This does not renew the fixture or change native operation deadlines, resource limits, data, assertions or production defaults. Schema-order cases retain their original 30-second test guard; their observed query-abort failure requires separate cause evidence. Full system qualification remains pending.

Native streamed qualification uses genuine scalar satoshi metadata for its stale-writer countercase, and independently checks that closed prepared-TEXT installers leave wallet metadata and pointers unchanged. Its finite SQL observer bound is derived from the original 1 KiB window count (15,822 measured statements across 129 windows; 17,024 observations allowed for that fixture), retaining the SQL-byte cap and every read-drain, payload and writer assertion. The optional local-schema positive case selects a supported 5 MiB aggregate physical allowance to cover the existing native database/rollback page formula; the ordinary case and default remain 4 MiB, and a separate real 4 MiB negative retains the original SQLITE_FULL cause. All original datasets, cases, operation deadlines, row allocations and production defaults remain; full-system qualification is pending.

### Complete native candidate fixture envelopes

The complete original natural-key and current-data-fence coverage cases measured
176.103 and 175.889 seconds in the Linux qualifier. The preceding current-data
case failed at 180.028 seconds, at the original coherent-source admission check.
The supported ten-minute diagnostic retained every original callback, data,
assertion, 1 KiB read and real expiry check; it is diagnostic evidence only.
These cases and the full independent inventory matrix now explicitly select one
initial five-minute test fixture lifetime and a further 30 seconds for cleanup.
The larger COPY/resume case selects ten minutes; its complete UNIQUE rebuild
selects twenty minutes. The private page allocation case selects two five-minute
setup/copy windows, while the incoming-range case retains its existing fifteen
minutes. Each lifetime is fixed at creation, shared by its actual actors, and
cannot be renewed. The ordinary fixture default remains three minutes.

All original cases, datasets, negative/rollback/custody checks, source WAL busy
proof, escaped-source refusal, finite operation counts and native read choices
remain. Production deadlines, native per-operation limits, memory/byte caps,
public APIs, archive formats and provider defaults are unchanged. These test
budgets are not production SLOs. Full uninstrumented affected-case coverage,
contended hosted execution and whole-system qualification remain required.

### Authenticated native structured source replay

Canonical structured-field completion on a reopened original native source selects the existing authenticated source-read mode. The helper still proves its actual native owner and read-only slot, sealed metadata, original archive hash and unchanged pre/post source state; receiver and unauthenticated native admission are unchanged. A real encrypted/sealed native regression checks independent raw/canonical history and notify bytes and rejects reuse after physical close. No public authority flag, persistence/wire format, production default or resource limit changes. The allocation-regression contract also observes the original coherent-source refusal after its existing inner error-identity, greater-counter and rollback checks. Full composed recovery and system qualification remain required.

Packed IndexedDB operational synchronization accepts all supported wallet chains, including regtest, and retains exact source/destination network binding before user registration. Persisted operational checkpoints use that same chain set across reopen; this does not expand the BRC-38 archive main/test format. Authenticated remote destination admission uses the same operational chain validation; real Node/mobile HTTP regtest copies retain committed progress across server replacement. BRC-38 archive negotiation remains main/test. Regression cases cover actual packed manager push/pull and committed reopen on every supported chain, plus regtest atomic rollback, lost-ack progress, namespace isolation and stale-primary refusal. Native migration qualification compares completed source schemas with the current registered migration version while separately proving the required journal stamp; historical process-loss fixtures retain an exact pre-migration cutoff. No public API, archive format, production default or resource limit changes. Full-system and exact-head CI qualification remain required.

Signed sync-state provenance now follows the same admitted key domain through fresh bootstrap, bounded metadata/cursor/frame reads and durable source-provenance storage. The provenance reader starts at the first actual key when no cursor is supplied; an explicit zero cursor still means keys greater than zero. Other entity identifiers stay positive, MySQL source bootstrap stays unsigned, and provenance never writes destination sync-state rows or primary selection. Schema, field encodings, quotas and native ABI are unchanged.

The opt-in `journalFields: true` copy route also negotiates
`snapshotJournalFields` for authenticated remote destinations. Upload ownership,
immutable byte readiness and durable financial acknowledgment are separate;
completion drains source and upload owners. See [journal artifact transport](docs/journal-artifact-transport.md)
for limits, restart/cancellation behavior and the separate remote primary-handoff
requirement. This candidate route remains subject to full integration qualification.

### Exact field-window recovery

Field peers advertise source recovery and target upload recovery separately from
field-copy support. On an opted-in manager pull, an interrupted window resumes
only its exact stored source receipt. A READY target upload can finish from its
actual stored bytes; a partial upload or local intake reopens the original source
capture and replays its bounded packets. Recovery neither creates another capture
nor extends the original expiry. It cannot begin a replacement financial window.
If the original source has expired, the manager retires its matching resources
and requires a fresh bootstrap. Cleanup matches the original source/receipt and
cannot retire another capture for that profile.

After acknowledging a recovered window, the same manager invocation observes a
fresh source so changes made after the interrupted view are included. Progress
counts accumulate across the actual windows; each checkpoint and financial ACK
remains scoped to its own window. Separate recovery advertisements preserve old
peer negotiation. Persisted references contain comparison DATA, never SQL source
or writer authority. These paths do not grant primary selection. Remote primary
handoff, stale-writer fencing and full-system qualification remain required.

The unpublished 2.15.0 readiness corrections acquire the actual native comparison
lease before recovery admission and recheck committed `WAL_ACTIVATING` state
before physical promotion. Published native wallets enable SQLite passive
checkpointing after promotion and reopen; retained readers, original WAL quotas,
ABI and pins remain authoritative. Schema verification compares exact SQL bytes
inside SQLite and returns bounded scalar counts. Prepared-content admission
performs the complete fresh binary/TEXT/preparation checks once through their
existing composition instead of repeating full nested checks. Forwarding operations share
Promise and await implementations to reduce generated mobile state machines,
while preserving immediate work, fresh promises and original rejection objects.
No API, wire, persisted-schema or consumer migration is required. Qualification
must cover the final complete source; earlier partial runs do not establish it.

The private native merge runner composes its fresh status read and one bounded
step inside the same actual merge I/O owner. The step retains every original
candidate, journal, source, quota and cleanup check; it no longer opens a separate
complete candidate scope merely to repeat the immediately preceding status read.
A completed episode still takes a fresh source scope before its complete composed
inventory, and every operation drains before yielding. Status DATA cannot be
supplied by a caller or reused across operations. Original test lifetimes, case
inventories, operation guards, read/allocation limits and native pins remain.

Journal maintenance configuration obtains policy and epoch from one complete,
fresh generation validation in that call. It retains no schema verdict between
calls, and each subsequent maintenance writer independently verifies its actual
generation and physical ownership. Missing migration stamps still refuse fresh
configuration reads.

The independent native user inventory tests author and verify their original
October 3 timestamp through the admitted source writer after real activation.
Activation stamps a changed primary with current UTC; setting the test baseline
afterwards preserves the intended older, equal and newer header comparisons.
All three dates and their original corruption, refold and resource checks remain.

Linux CI keeps disposable snapshot-sync and HTTP journal SQLite fixtures in
private directories on its existing `/dev/shm` filesystem. Other platforms use
the normal temporary directory. WAL, locking, process-crash recovery, independent
databases, assertions and deadlines remain unchanged; compiler caches stay on
their normal storage. No filesystem or container memory allowance is increased.

The retained snapshot integration suite builds empty schemas with the actual
registered migrations in `beforeAll` and physically closes their connections.
Each case owns independent file copies, checks current migrations, and rotates
its journal epoch through the validated source-addition writer. A regression
checks distinct epochs versus both the template and another copy, unchanged
empty templates and data isolation. Migration-specific suites keep their own
fresh fixtures. WAL, process-crash recovery, original cases and deadlines remain
exercised against independent databases.

Expired native recovery translates the original import journal's physical
destination address only after the actual frozen copy matches the complete
original image. The original admitted preview remains bound; every current
schema, clock, profile and semantic check is retained. Real UTC expiry fixtures
recheck the clock after early timer wakeups without renewing any deadline.
No API, wire, schema or native ABI migration; full recovery qualification remains.

The expiry integration fixtures retain their original case timeout and actual
UTC expiry assertion. The copied scratch retains fresh physical ownership
checks around each read. Targeted file-copy/primary ABA and early-wake
regressions do not establish full native recovery qualification.

Read-only native merge-page history follows the actual bounded operation owner, including a fresh frozen recovery copy after original import expiry. Historical writer and checkpoint timestamps remain bounded by the immutable original admission. Comparison never renews financial import authority; current owner, seal, schema, page-chain and charge checks remain required. No API, wire, schema, native ABI or resource-limit migration; complete recovery qualification remains required.

Read-only native merge-target alias lookup now uses the exact borrowed transaction of its actual bounded operation owner, including frozen recovery after original import expiry. Original financial admission, query-only mode, complete receipt, journal/schema/row/mapping checks and all limits remain unchanged. No public API, wire, schema or native ABI migration; complete expired-recovery qualification remains required.

Read-only original proof-field comparison now uses the actual bounded operation owner, including a frozen recovery copy after the immutable import deadline. Complete original byte/hash comparison, genuine source and borrowed-read ownership, cancellation, working charges and financial expiry remain enforced. No public API, wire, schema, native ABI or resource-limit migration; complete composed recovery qualification remains required.

Proof inventory drains complete page-history reconstruction before reserving its separate proof scratch frame. Both phases retain the same actual borrowed native transaction, shared working owner, fresh source/schema and complete byte/cache checks. The fixed original allocation ceiling and all financial and operation deadlines remain unchanged. No API, wire, persisted schema, native ABI or consumer migration; complete expired-recovery qualification remains required.

## SDK4 hotfix peer requirement

The SDK4 peer alternative starts at `@bsv/sdk ^4.0.1`, which restores numeric
wallet results and legacy wire compatibility. Existing SDK2/3 alternatives and
lower bounds remain unchanged. SDK4 users should install the 4.0.1 hotfix; no
application-wallet wire or data migration is required.

The PR569 archive packet-label downgrade guard returns a rejected Promise and
requires forward recovery to preserve stored artifacts. The November 11 follow-up
preserves that contract while removing an unnecessary async wrapper; it requires
no additional data migration.
