import type { Chain } from '../../../sdk/types'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import { runInSeries } from '../../../utility/runInSeries'
import { encodeSyncTransfer } from '../../remoting/SyncTransfer'
import { SnapshotResourceLimitError } from '../SnapshotResourceLimitError'
import type { WalletSnapshotCursor, WalletSnapshotTable } from '../WalletReadSnapshot'
import type { KnexSnapshotArchiveStore } from './KnexSnapshotArchiveStore'
import {
  snapshotArchiveLimits,
  snapshotArchiveTables,
  type SnapshotArchiveManifest,
  type SnapshotArchiveWriter
} from './SnapshotArchive'
import type { SnapshotArchiveSource } from './KnexSnapshotArchiveSource'

export interface SnapshotArchiveCaptureOptions {
  signal?: AbortSignal
  lifetimeMs?: number
  maxBytes?: number
  /** Acknowledged staging progress only; no source IDs, row contents or secrets. */
  onProgress?: (progress: { pages: number; rows: number; bytes: number }) => void
}

export function assertSnapshotArchiveCaptureActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new WERR_INVALID_OPERATION('Snapshot archive capture was cancelled')
}

function packedRows(rows: object[]): Array<Record<string, unknown>> {
  return rows.map(row =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => {
        if (value === null || typeof value !== 'object' || value instanceof Uint8Array) return [key, value]
        // Retain SQL dates from other realms without asking the binary codec to
        // classify their prototype. Standard wallet rows otherwise contain scalars.
        const time = Date.prototype.getTime.call(value)
        if (!Number.isFinite(time)) throw new WERR_INVALID_OPERATION('Snapshot source contains an invalid date')
        return [key, new Date(time)]
      })
    )
  )
}

export type SnapshotArchiveCaptureStore = Pick<KnexSnapshotArchiveStore, 'begin' | 'append' | 'seal' | 'close'>

/** Shared ordered capture; source.close must finish physical ownership cleanup before sealing. */
export async function captureSnapshotArchiveSource(
  source: SnapshotArchiveSource,
  store: SnapshotArchiveCaptureStore,
  identityKey: string,
  chain: Chain,
  options: SnapshotArchiveCaptureOptions = {}
): Promise<SnapshotArchiveManifest> {
  const { signal, lifetimeMs, maxBytes, onProgress } = options
  let writer: SnapshotArchiveWriter | undefined
  let closed = false
  try {
    assertSnapshotArchiveCaptureActive(signal)
    if (source.user.identityKey !== identityKey || source.sourceStorage.chain !== chain) {
      throw new WERR_INVALID_OPERATION('Snapshot source does not match the requested profile and chain')
    }
    writer = await store.begin(
      {
        version: 1,
        snapshotId: source.snapshotId,
        sourceStorage: source.sourceStorage,
        sourceSchema: source.sourceSchema,
        user: source.user
      },
      { lifetimeMs, maxBytes }
    )
    await source.validateClosure()
    const owner = writer
    const progress = { pages: 0, rows: 0, bytes: 0 }
    const captureTable = async (table: WalletSnapshotTable): Promise<void> => {
      let cursor: WalletSnapshotCursor | undefined
      let done = false
      function* pendingPages(): Generator<void> {
        while (!done) yield undefined
      }
      await runInSeries(pendingPages(), async () => {
        assertSnapshotArchiveCaptureActive(signal)
        if (progress.pages >= snapshotArchiveLimits.pages) {
          throw new SnapshotResourceLimitError('Snapshot archive page limit exceeded')
        }
        // The conservative SQL charge bounds fetched payloads before encoding;
        // framing/JSON escaping has a separate exact one-MiB admission below.
        const page = await source.readPage(table, cursor, { maxRows: 128, maxBytes: 131072 })
        const bytes = encodeSyncTransfer({ version: 1, table, rows: packedRows(page.rows) })
        if (bytes.length > snapshotArchiveLimits.pageBytes) {
          throw new SnapshotResourceLimitError('Snapshot archive encoded page limit exceeded')
        }
        assertSnapshotArchiveCaptureActive(signal)
        await store.append(owner, { sequence: progress.pages, table, rows: page.rows.length, done: page.done, bytes })
        progress.pages++
        progress.rows += page.rows.length
        progress.bytes += bytes.length
        onProgress?.({ ...progress })
        assertSnapshotArchiveCaptureActive(signal)
        cursor = page.cursor
        done = page.done
      })
    }
    await runInSeries(snapshotArchiveTables, captureTable)
    await source.close()
    closed = true
    assertSnapshotArchiveCaptureActive(signal)
    const manifest = await store.seal(owner)
    assertSnapshotArchiveCaptureActive(signal)
    return manifest
  } catch (error) {
    // Preserve the initiating error; interrupted cleanup keeps its reservation
    // and is recovered by reap rather than exposing a partial result.
    if (writer !== undefined) await store.close(identityKey, writer.archiveId).catch(() => undefined)
    throw error
  } finally {
    if (!closed) await source.close().catch(() => undefined)
  }
}
