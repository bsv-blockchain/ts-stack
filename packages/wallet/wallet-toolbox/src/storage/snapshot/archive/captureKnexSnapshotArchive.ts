import type { Knex } from 'knex'
import type { Chain } from '../../../sdk/types'
import { WERR_INVALID_PARAMETER } from '../../../sdk/WERR_errors'
import type { StorageKnex } from '../../StorageKnex'
import { KnexSnapshotArchiveStore } from './KnexSnapshotArchiveStore'
import type { SnapshotArchiveManifest } from './SnapshotArchive'
import { openKnexSnapshotArchiveSource } from './KnexSnapshotArchiveSource'
import {
  captureSnapshotArchiveSource,
  assertSnapshotArchiveCaptureActive,
  type SnapshotArchiveCaptureOptions
} from './captureSnapshotArchiveSource'
export type { SnapshotArchiveCaptureOptions } from './captureSnapshotArchiveSource'

/**
 * Capture all thirteen raw standard tables from one retained SQL view. Pages
 * use the existing binary frame, not BRC-38 canonical archive bytes. The reader
 * must own a separate connection/pool from staging and foreground operations.
 */
export async function captureKnexSnapshotArchive(
  reader: StorageKnex,
  staging: Knex,
  identityKey: string,
  chain: Chain,
  options: SnapshotArchiveCaptureOptions = {}
): Promise<SnapshotArchiveManifest> {
  if (reader.knex === staging) {
    throw new WERR_INVALID_PARAMETER('staging', 'a connection pool separate from the retained source reader')
  }
  if (chain !== 'main' && chain !== 'test') throw new WERR_INVALID_PARAMETER('chain', 'main or test')
  // Detach caller-owned options before the first asynchronous boundary.
  const { signal, lifetimeMs, maxBytes, onProgress } = options
  assertSnapshotArchiveCaptureActive(signal)
  const store = new KnexSnapshotArchiveStore(staging)
  await store.reap()
  const source = await openKnexSnapshotArchiveSource(reader, identityKey, { signal, lifetimeMs })
  return await captureSnapshotArchiveSource(source, store, identityKey, chain, {
    signal,
    lifetimeMs,
    maxBytes,
    onProgress
  })
}
