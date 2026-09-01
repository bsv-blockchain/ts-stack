# Prepared BEEF (COOK)

COOK stands for **Create Once, Output Kept**. It is the project name for an
opt-in Wallet Storage optimization which builds reusable input proof material
before a later `createAction` needs it.

Production identifiers use `preparedBeef`, not cooking vocabulary. A
**prepared BEEF** is already ready to use: it has been reduced to one root
transaction and its exact dependency closure, independently verified,
serialized, checksummed, and stored. It does not mean “waiting to be cooked.”

## Latency contract

The optimization does not replace the canonical BEEF builder or make a cache
service a new dependency.

1. `createAction` starts proof prefetch while its normal planning and database
   work continue.
2. With prepared reads enabled, Knex performs one user-scoped indexed lookup
   for the selected root transaction IDs.
3. A valid hit is parsed and merged directly. A missing, stale, corrupt,
   oversized, or unsupported artifact is treated as a miss and the existing
   canonical builder runs for only those roots.
4. The action result is completely assembled before any missing roots are
   queued for preparation.
5. The bounded worker starts on a later event-loop turn. `createAction` and
   `processAction` never await verification or persistence performed by that
   worker.

Prepared reads therefore add an indexed lookup on a cold cache, but that lookup
runs inside the existing early prefetch window and overlaps normal foreground
work. Preparation itself is strictly background work. All controls default to
off, so upgrading without enabling COOK preserves the existing normal-action
execution path.

`processAction` also queues a newly finalized transaction when it creates
wallet-managed change. This prepares the source most likely to fund a future
normal action without extending the current request.

## Storage and validity

Knex migrations add a `prepared_beefs` table keyed by `(userId, rootTxid)` and
a singleton `prepared_beef_metadata` proof epoch used to serialize worker
writes with reorganization invalidation. Artifacts are derived data, not wallet
authority:

- the authenticated storage user is part of every read and write key;
- canonical transaction, proof, and output rows remain the source of truth;
- each artifact contains one root transaction plus only its recursive proof
  dependencies;
- the background worker verifies the exact BEEF against the configured chain
  tracker before writing it;
- reads enforce format version, state, checksum, byte length, size ceiling, and
  a complete root transaction;
- proof reorganizations mark ready artifacts stale before another read can use
  them; a database-backed proof epoch also prevents an in-flight worker in
  another server process from writing pre-reorganization material afterward;
- a failed verification leaves an unreadable rejection marker so optional
  backfill does not hot-loop; a later canonical action can retry and replace
  it organically;
- storage purge removes artifacts once no matching unspent managed output
  remains; and
- prepared artifacts are deliberately excluded from wallet synchronization and
  can always be rebuilt.

Knex (SQLite and MySQL) is the persistence implementation. The option is not
part of portable `StorageProvider` or IndexedDB configuration; those providers
retain the normal canonical fallback and do not bundle the background worker.

## Configuration

`StorageKnex` and `Setup.createWalletKnex` accept the same `preparedBeef`
settings:

```ts
const setup = await Setup.createWalletKnex({
  ...args,
  preparedBeef: {
    // Roll out writes before reads so the first read cohort is warm.
    writeEnabled: true,
    readEnabled: false,
    backfillEnabled: false,
    maxQueueSize: 32,
    maxArtifactBytes: 2 * 1024 * 1024,
    backfillBatchSize: 32,
    backfillIntervalMs: 100
  }
})
```

| Setting | Default | Meaning |
| --- | ---: | --- |
| `writeEnabled` | `false` | Queue and persist verified artifacts after foreground action work. |
| `readEnabled` | `false` | Use valid artifacts on the `createAction` proof path. |
| `backfillEnabled` | `false` | Prepare eligible existing managed-change roots in bounded background passes. Requires writes. |
| `maxQueueSize` | `32` | Maximum number of roots waiting for background preparation. New work is safely dropped when full. |
| `maxArtifactBytes` | `2 MiB` | Maximum accepted serialized artifact size on both read and write. |
| `backfillBatchSize` | `32` | Maximum roots selected in one backfill pass. |
| `backfillIntervalMs` | `100` | Delay between low-priority backfill passes. |

The queue is in-process and best effort. A restart, full queue, verification
failure, or persistence failure loses only an optimization opportunity. A
later action can rebuild the same artifact from authoritative storage.

## Rollout toward a 50 ms normal-action target

Use a staged rollout rather than enabling all controls at once:

1. Deploy the migration with all flags off and confirm existing latency and
   error rates are unchanged.
2. Enable writes for a small server cohort. Watch preparation success,
   rejection, artifact bytes, queue pressure, and database load.
3. Once the normal managed-change roots are warm, enable reads for the same
   cohort. Compare `createAction` p50/p95, prepared hit rate, canonical fetch
   count, and returned BEEF bytes with the prior cohort.
4. Enable bounded backfill only if organic writes do not warm the active pool
   quickly enough. Keep it off during database pressure.
5. Expand reads only while correctness fallbacks remain clean and the normal
   one-input cohort moves toward the operator's 50 ms target.

The target is an end-to-end service objective, not a guarantee from this cache
alone. Authentication, HTTP, database commits, signing, and response
serialization still contribute to remote latency. COOK specifically removes
repeated canonical proof reconstruction from prepared hits.

Telemetry uses bounded-cardinality spans:

- `wallet.storage.prepared_beef.lookup` reports requested roots, hits, misses,
  corrupt rows, and bytes;
- `wallet.storage.prepared_beef.prepare` reports attempted roots, prepared and
  rejected counts, and bytes; and
- `wallet.storage.prepared_beef.backfill` reports a failed backfill pass.

The existing `wallet.storage.create_action.beef_prefetch` span also reports
`beef.prepared_hit_count` and `beef.canonical_fetch_count`. No transaction ID,
user identity, script, key, or payload is emitted as a telemetry attribute.

## Rollback

Set `readEnabled`, `writeEnabled`, and `backfillEnabled` to `false`. New actions
immediately use the canonical path, queued work stops being accepted, and the
derived rows can remain in place for a later re-enable on the same COOK-aware
code or be removed by normal purge. Before downgrading to an older Wallet
Toolbox version, delete the derived rows (or drop both additive tables); older
code cannot advance the proof epoch during a reorganization. After returning
to a COOK-aware version, warm artifacts with writes before enabling reads. No
transaction, proof, output, synchronization, BRC-100, or Wallet Wire rollback
is required.
