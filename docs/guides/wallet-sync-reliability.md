---
id: wallet-sync-reliability
title: 'Resumable wallet synchronization and proof recovery'
kind: guide
version: '1.0.0'
last_updated: '2026-09-23'
last_verified: '2026-09-23'
review_cadence_days: 30
status: beta
tags: [wallet, sync, storage, performance]
---

# Resumable wallet synchronization and proof recovery

The unpublished Toolbox 2.14 candidate provides a complete bounded pull-sync
session for local Knex and IndexedDB destinations. Source requests, proof-provider
I/O and progress callbacks run outside exclusive page ownership; the destination
commits each page and its checkpoint atomically. Foreground reads and writes can
proceed between commits. Remote/custom destinations retain the established
exclusive path unless their local provider explicitly supports the required
capability. Existing `syncFromReader`, `syncToWriter` and their result contracts
remain available.

## Consumer contract

```ts
const controller = new AbortController()
const result = await manager.syncFromReaderResumable(identityKey, source, {
  signal: controller.signal,
  maxItems: 1000,
  maxRoughSize: 262144,
  onProgress: progress => {
    // Render counters and state; keep this callback short and non-throwing.
    console.log(progress.state, progress.pages, progress.inserts, progress.updates)
  }
})
```

The result reports `completed` or `cancelled`, actual `paged` or `exclusive`
execution, acknowledged page/entity counts and the last durable checkpoint.
Progress includes reading, preparing, committing, committed and terminal states,
with separate source-read, preparation, queue and commit timings when available.
A callback exception rejects the call; resume from the destination rather than
assuming that no page committed.

Cancellation is cooperative. It waits for an in-flight source read or proof
lookup to drain, discards an uncommitted page, and waits for an already-started
commit acknowledgement. It does not abort a database transaction after its
outcome becomes uncertain or undo acknowledged data. Invoke the API again to
resume; do not use UI counters as a checkpoint. A lost acknowledgement rejects
without automatically replaying a write, and the next session loads the durable
destination checkpoint.

Only one page is in flight. The new API defaults to 1,000 rows and 262,144 rough
encoded bytes (256 KiB). Options must be positive safe integers, no greater than
1,000 rows and 10,000,000 rough bytes. Existing sync methods retain their prior
defaults. The new default is a measured starting point for constrained clients,
not a universal memory ceiling. A single large record can exceed a rough page target;
the existing separately negotiated 64 MiB transfer-frame bound still applies.
See [bounded transfers](https://github.com/bsv-blockchain/ts-stack/blob/main/packages/wallet/wallet-toolbox/docs/sync-transfer.md).
There is no unbounded prefetch queue or hidden parallel merge.

## Identity, network and persistence safety

Missing, unrecognized or mismatched chain declarations fail with the existing
`WERR_NETWORK_CHAIN` before sync state or user writes. Live sync never infers a
provider's chain. Legacy providers without access capabilities retain exclusive
ownership; they still need matching chain declarations. Both sync directions
honor returned `ProcessSyncChunkResult.error` values as well as thrown errors.
Neither path advances counts or checkpoints after an error, and a nonterminal
page that makes no checkpoint progress fails explicitly.

Sessions pin wallet identity, destination instance and manager generation.
Switching/destroying the destination fences late replies before mutation. The
page commit rechecks the durable checkpoint and any proof rows inspected during
preparation, preventing concurrent sessions or monitor repairs from overwriting
newer state. Input pages and checkpoint values are detached before asynchronous
validation. No new persisted schema or archive envelope is introduced.

The queue permits at most eight concurrent readers on providers advertising safe
reads. Writers remain exclusive. Foreground work has priority, with bounded
bypass (eight grants or one second of queue age) so background sync can still
progress. Legacy providers remain exclusive. Advertising a capability is a
provider correctness promise, not merely a performance hint.

The adaptive controller separates fixed page latency from marginal record cost,
uses a bounded sample window, starts with 64 records, limits growth to 2x and
caps proof pages at 128 records and metadata pages at 1,000. A prolonged one-row
floor probes recovery. These bounds prevent the previous fixed-latency feedback
loop from permanently collapsing page size, without treating a slow proof page
as evidence that all later metadata is equally expensive.

## Canonical proof recovery

Assembled BEEF is checked before spending or broadcasting. An invalid root can
trigger bounded recovery through the configured chain tracker and active-chain
header/proof provider. A block hash alone does not establish canonicality.
Recovery validates the path, root, height, transaction identity and actual
80-byte header; it preserves transaction bytes and txid-only ancestry. Valid
BEEF takes the fast path without database proof lookups or graph copying.

At most eight proof lookups run concurrently, and SQL lookups use batches of at
most 250 distinct transaction IDs. Built-in stores atomically compare previous
proof authority fields before persisting a correction and invalidate prepared
BEEF in the same transaction. Delayed monitor responses cannot overwrite newer
proofs. Custom stores lacking compare-and-set support can repair the outgoing
BEEF without claiming that the shared proof record was persisted.

Unavailable canonical evidence produces `WERR_INVALID_MERKLE_ROOT` with its
existing public/JSON identity and retry guidance. Recovery does not fabricate
success or broadcast a transaction. Historical stores still need independent
operator auditing; an upstream fix is not evidence that every deployed record
was repaired.

## Timestamp boundaries and snapshot scope

This API preserves BRC-40's inclusive `since` boundary and existing entity order,
ID mapping, tombstones and merge rules. Records arriving later with the same
last timestamp must remain discoverable. Consequently, a large imported batch
sharing one timestamp can require a complete boundary reread even when it has
no changes. The benchmark deliberately tests this case. Advancing beyond that
boundary without a coherent source contract would lose valid peer changes.

A successful live merge is an eventual replica, not a point-in-time source
snapshot or authorization to activate a new primary. Existing BRC-38/BRC-39
export/import contracts are unchanged. Issue #544 remains open for coherent
remote snapshots, streamed archives and consumer adoption.

## Next-stage design checkpoint (not implemented)

A future source-snapshot capability should negotiate a versioned contract
separately from ordinary sync and bounded transfer. A snapshot must bind the
authenticated wallet, network, storage identity, source schema, entity ordering
and immutable high-water position. Use a stable per-entity cursor (including a
tie-breaker) within that immutable view; do not reinterpret live timestamp/offset
checkpoints as coherent snapshots. The exact wire names remain subject to shared
conformance review and independent provider implementation.

Creation must establish the entire snapshot consistently, using a transactional
read view or immutable staging with an atomic manifest. Bound retained snapshots,
bytes, lifetime, per-identity concurrency and cleanup across replicas. A durable
resume token must bind the snapshot digest and cursor, reject another identity,
and fail explicitly after expiry. A restarted reader may resume the same
immutable snapshot or restart a new one; it must never combine both silently.

Streaming BRC-38 encoding should preserve canonical record order, binaries,
nullable history, source provenance and the standard's deliberate exclusions.
BRC-39 streaming must preserve the released envelope, KDF and authentication:
stage decrypted bytes privately, verify the complete authentication tag and
semantic relationships, then atomically activate an isolated import. Partial
plaintext is never active wallet data. Bound memory, worker/IPC queues, KDF work
and temporary disk independently; record crash recovery and safe cleanup.

Release gates for that next stage are old/new independent reader/writer vectors,
wrong password/identity/network and corruption cases, same-timestamp/tombstone
relationships, restart at every durable boundary, repeated import, native
browser/mobile evidence and wallet adoption. No partial archive or optimistic
activation should be labeled complete while those gates remain outstanding.

## Reproducible validation

The fixture uses 10,000 same-timestamp labels (including tombstones), 64 proofs
with 32 KiB transactions and associated wallet transactions. It compares
exclusive capability fallback with paged mode on native Chromium IndexedDB,
SQLite and authenticated HTTP-to-SQLite. The same source state is restored
between modes. It reports full-copy time, CPU/RSS or browser heap, SQL queries,
response body bytes, foreground percentiles, event-loop delays and page timings.
It also checks unchanged-boundary replay, incremental tombstones and a settled
unchanged copy. A 15 ms source delay tests fixed-overhead behavior.

```sh
pnpm --filter @bsv/wallet-toolbox bench:storage-sync
pnpm --filter @bsv/wallet-toolbox-client bench:sync
```

Native Chrome/Chromium is required (`CHROME_BIN` can select it). Emulator tests
remain useful for deterministic storage faults; fake IndexedDB timings do not
represent browser database performance. The acceptance fixture bounds full-copy
time, memory growth and foreground/event-loop p95, and requires foreground p95
to improve at least 2x without doubling full-copy time. Those are fixture gates,
not latency guarantees for every wallet, device or provider.

### September 23 local measurements

Measured sequentially on macOS arm64, Node 24.19.0 and pnpm 10.33.2, using the
256 KiB fixture above. The control is this branch's exclusive capability fallback;
it isolates scheduling behavior, not every change since the released package.
Foreground latency starts when its timer callback runs. Event-loop delay is
reported separately so synchronous CPU stalls remain visible. The exclusive
control has very few completed foreground samples because it holds the queue.

| Backend / mode | Full copy ms | Foreground samples | Foreground p50 / p95 / p99 ms | Event-loop p95 / p99 ms | Pages |
| --- | ---: | ---: | --- | --- | ---: |
| Chromium IndexedDB / exclusive | 4027.1 | 1 | 4021.50 / 4021.50 / 4021.50 | 1.30 / 1.60 | 45 |
| Chromium IndexedDB / paged | 4110.0 | 384 | 0.90 / 25.90 / 132.60 | 1.30 / 1.70 | 45 |
| sqlite / exclusive | 2368.7 | 1 | 2342.43 / 2342.43 / 2342.43 | 85.12 / 106.86 | 45 |
| sqlite / paged | 2373.8 | 133 | 0.17 / 0.32 / 0.40 | 84.86 / 109.29 | 45 |
| http / exclusive | 26184.7 | 5 | 0.25 / 26092.86 / 26092.86 | 250.70 / 271.70 | 47 |
| http / paged | 26394.8 | 319 | 0.24 / 0.35 / 0.40 | 255.93 / 271.98 | 47 |

Native browser peak JS heap was 79.8 MB exclusive and 56.3 MB paged. SQLite
full-copy CPU was 1.86/1.86 seconds and sampled RSS growth 127.6/60.1 MB.
Authenticated HTTP CPU was 25.93/26.08 seconds, RSS growth 152.1/95.1 MB,
and response bodies 7,173,777/7,172,813 bytes. Values are exclusive/paged;
HTTP bytes exclude headers, requests and TLS framing. HTTP and SQLite include
source and destination in the same process. Absolute RSS includes the test
runner and previously allocated heap; sampled growth is not a total memory cap.

SQLite issued 31,612/31,876 SQL queries and HTTP issued 32,241/32,866, including
foreground operations. Extra queries reflect completed foreground work; this
change does not claim a database-query reduction. Paged maximum commit times
were 142 ms (browser), 104 ms (SQLite) and 81 ms (HTTP). Maximum measured paged
queue wait was 1 ms in the browser and 0 ms in the local SQL/HTTP fixtures.

All modes preserved the full same-timestamp boundary reread: 45 pages locally
and 47 over HTTP; a subsequent settled unchanged copy used two pages. The
network fixture remains CPU-heavy, with about 256 ms event-loop p95 despite
short queue waits. Moving crypto/serialization off the main thread is future
work; queue responsiveness must not be represented as eliminating that cost.
These are reproducible local observations, not cross-device performance promises.

Adjacent local spending benchmarks also pass: the pathological 178-source BEEF
plan used 17 queries and about 198 ms; the eight-source cold/prepared paths used
14 queries and about 7.3/5.8 ms. The funding, action-batch and legacy storage-sync
benchmark gates pass. Their existing external PXC cohorts require their governed
MySQL environment and were not executed by the default local invocation.
