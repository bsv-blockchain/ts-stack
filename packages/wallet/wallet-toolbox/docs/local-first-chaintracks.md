# Local-first ChainTracks

Wallet applications can keep and validate their own header chain instead of
making a remote service the normal validation boundary. The browser package
exports IndexedDB ChainTracks. Browser and mobile packages both export the
portable checkpoint cache contract, bounded fetching, local ChainTracks
components, and `LocalChainTracker`; the full package additionally exports a
filesystem checkpoint cache.

## Trust and data flow

1. The release pipeline embeds a checkpoint manifest and immutable 80-byte
   header files in the application artifact. Each manifest entry includes its
   chain, height range, SHA-256 digest, previous hash, last hash, and cumulative
   chain work.
2. A `BulkFileDataCacheApi` implementation reads an embedded object first and
   mutable application storage second. A downloaded replacement is written to
   mutable storage atomically where the platform permits it.
3. `createIdbChaintracks` or another local factory consumes that cache through
   the final `ChaintracksSourceOptions` argument. The manager validates object
   length, digest, genesis, header linkage, declared chain work, and every
   header's proof of work before the object can answer a query.
4. Live ingestion follows bounded binary batches and a reconnecting tip stream
   in the background. IndexedDB in browsers, or the application's durable
   mobile storage adapter, retains the current height and recent headers across
   application restarts.
5. `LocalChainTracker` is supplied to wallet services as the SDK
   `ChainTracker`. A definitive local `false` result is never changed to
   `true` by a remote source.

The embedded checkpoint is a bootstrap optimization, not a bypass. Its bytes
are revalidated locally before use. Release builds should fail when an asset is
missing, its digest differs from the manifest, the manifest is not contiguous,
or the checkpoint age exceeds the application's release policy.

## Portable checkpoint cache

Applications implement the small portable contract below. Packaged assets are
immutable; mutable objects belong in an application-private database or file
area, not a shared HTTP cache.

```ts
import type { BulkFileDataCacheApi, BulkHeaderFileInfo } from '@bsv/wallet-toolbox-client'

class ApplicationHeaderCache implements BulkFileDataCacheApi {
  async get(file: Readonly<BulkHeaderFileInfo>): Promise<Uint8Array | undefined> {
    return (await readPackagedAsset(file.fileName)) ?? readApplicationData(file.fileName)
  }

  async set(file: Readonly<BulkHeaderFileInfo>, data: Uint8Array): Promise<void> {
    await writeApplicationDataAtomically(file.fileName, data)
  }

  async delete(file: Readonly<BulkHeaderFileInfo>): Promise<void> {
    await deleteApplicationData(file.fileName)
  }
}
```

Pass the instance as `sources.bulkFileCache` in the final ChainTracks factory
argument. `sources.bulkFileDownloadBudget` can reserve remote bytes before a
bulk request begins. The manager coalesces concurrent requests for the same
immutable object, bounds each response, retries from one layer only, and never
persists bytes until all validation succeeds.

## Local-primary tracker

Wrap the resulting local client with `LocalChainTracker`. Use at least two
independently operated reference clients when automatic recovery or fallback
validation can affect an acceptance decision.

```ts
import { LocalChainTracker } from '@bsv/wallet-toolbox-client'

const tracker = new LocalChainTracker({
  local: localChaintracks,
  fallbacks: independentReferences,
  mode: 'local-primary',
  requiredFallbackAgreement: 2,
  requiredConsistencyAgreement: 2,
  maxHeightLag: 6,
  autoRecover: true,
  recoverLocal: rebuildLocalFromCheckpoint,
  clearLocal: clearAndRebuildLocal
})

await tracker.synchronize()
const walletServices = new Services({
  ...Services.createDefaultOptions(chain),
  chainTracker: tracker
})
```

`checkConsistency()` compares all available views at a common height and derives
the reference height reached by the configured quorum. A single stale or
inflated reference cannot declare divergence or lag when the configured
agreement is two. Automatic recovery receives the reason, local and reference
heights, lag, comparison height, expected hash, and agreement count; it should
quarantine the old database, rebuild from a verified checkpoint, synchronize,
and return the replacement local client. If the references do not agree, retain
local state and surface diagnostics instead of resetting it.

Remote fallback is exceptional. It is used only in `remote-only` mode or after
the local client throws, and it must reach the configured agreement. A local
proof rejection remains authoritative.

## Application lifecycle and controls

Start synchronization after durable storage is available. Keep it alive while
the platform grants background execution, checkpoint progress on suspension,
and resume immediately on connectivity restoration. Use exponential reconnect
backoff and avoid overlapping synchronization jobs.

An application's advanced chain-management surface should expose:

- local-primary and remote-only modes, with local-primary as the default;
- local height, tip hash, last sync, consistency state, active source, last
  fallback, last recovery, and bounded diagnostic error;
- a manual synchronize action and a quorum consistency check;
- local header storage size and a destructive clear/rebuild action with an
  explicit confirmation;
- checkpoint version/height and the configured independent references.

For migration, preserve the existing remote endpoint as a fallback, create the
local database without blocking the rest of the wallet, and switch the saved
default to local-primary only after initial synchronization succeeds. A user
who explicitly selected remote-only remains remote-only across upgrades.
Clearing local data must not clear keys, transactions, proofs, or other wallet
state.
