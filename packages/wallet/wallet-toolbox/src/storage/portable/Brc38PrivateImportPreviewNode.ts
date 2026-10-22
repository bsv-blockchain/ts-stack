import { randomUUID } from 'node:crypto'
import type { StorageKnex } from '../StorageKnex'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import type { SnapshotJournalReceiptPolicy } from '../snapshot/journal/SnapshotJournalReceipt'
import { snapshotJournalRevision } from '../snapshot/journal/SnapshotJournalRevision'
import {
  captureBrc38KnexDestinationFence,
  withBrc38KnexDestinationFence,
  brc38DestinationSelection,
  type Brc38KnexDestinationFence,
  type Brc38ImportMode
} from './Brc38KnexDestinationFence'
import type { Knex } from 'knex'

export interface Brc38PrivateImportPreview {
  readonly protocol: 'brc38-private-import-preview/v1'
  readonly previewId: string
  readonly bindingSha256: string
  readonly archiveSha256: string
  readonly expiresAt: number
  readonly target: Readonly<Brc38KnexDestinationFence>
}
function invalid(): never {
  throw new Error('Private import preview is missing, inconsistent or superseded')
}
function validateProfile(value: Brc38KnexDestinationFence): void {
  if (value.userId !== null && !Number.isSafeInteger(value.userId)) invalid()
  if (
    value.activeStorage !== null &&
    (typeof value.activeStorage !== 'string' || Buffer.byteLength(value.activeStorage) > 256)
  )
    invalid()
  if ((value.userId === null) !== (value.activeStorage === null)) invalid()
  if ((value.userId === null) !== (value.primaryEpoch === null)) invalid()
  if (value.primaryEpoch !== null) snapshotJournalRevision(value.primaryEpoch)
}
export function decodeBrc38PrivateImportPreview(
  store: KnexBrc38StagingStore,
  json: string
): Readonly<Brc38PrivateImportPreview> {
  const payload: unknown = JSON.parse(json),
    bound = store.binding
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) invalid()
  const value = payload as Brc38PrivateImportPreview
  if (bound === undefined || value.protocol !== 'brc38-private-import-preview/v1') invalid()
  if (
    typeof value.previewId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.previewId)
  )
    invalid()
  if (
    value.bindingSha256 !== bound.digest ||
    value.archiveSha256 !== bound.binding.archiveSha256 ||
    value.expiresAt !== store.limits.expiresAt
  )
    invalid()
  const destination: unknown = value.target
  if (destination === null || typeof destination !== 'object' || Array.isArray(destination)) invalid()
  const selected = brc38DestinationSelection(value.target)
  if (
    selected.identityKey !== bound.binding.identityKey ||
    selected.chain !== bound.binding.chain ||
    selected.targetStorageIdentityKey !== bound.binding.targetStorageIdentityKey
  )
    invalid()
  if (
    value.target.backend !== 'SQLite' ||
    typeof value.target.backendSha256 !== 'string' ||
    typeof value.target.schemaVersionSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.target.backendSha256) ||
    !/^[0-9a-f]{64}$/.test(value.target.schemaVersionSha256) ||
    typeof value.target.schemaSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.target.schemaSha256) ||
    typeof value.target.epoch !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.target.epoch)
  )
    invalid()
  snapshotJournalRevision(value.target.revision)
  if (snapshotJournalRevision(value.target.ceiling) === '0') invalid()
  validateProfile(value.target)
  const target = Object.freeze({
    ...selected,
    backend: value.target.backend,
    backendSha256: value.target.backendSha256,
    schemaVersionSha256: value.target.schemaVersionSha256,
    schemaSha256: value.target.schemaSha256,
    epoch: value.target.epoch,
    revision: value.target.revision,
    ceiling: value.target.ceiling,
    userId: value.target.userId,
    activeStorage: value.target.activeStorage,
    primaryEpoch: value.target.primaryEpoch
  })
  const projected = Object.freeze({
    protocol: value.protocol,
    previewId: value.previewId,
    bindingSha256: value.bindingSha256,
    archiveSha256: value.archiveSha256,
    expiresAt: value.expiresAt,
    target
  })
  if (JSON.stringify(projected) !== json) invalid()
  return projected
}
/** A durable read-only destination preview for an already authenticated private
 * archive. Re-preview replaces only this charged receipt, retaining original
 * archive/profile/limits/deadline. Old preview IDs cannot authorize a step. */
export async function previewBrc38PrivateImport(
  store: KnexBrc38StagingStore,
  storage: StorageKnex,
  mode: Brc38ImportMode,
  receiptPolicy: SnapshotJournalReceiptPolicy
): Promise<Readonly<Brc38PrivateImportPreview>> {
  const bound = store.binding
  if (bound === undefined) invalid()
  const json = await store.prepareImportPreview(async () => {
    const target = await captureBrc38KnexDestinationFence(
      storage,
      {
        identityKey: bound.binding.identityKey,
        chain: bound.binding.chain,
        targetStorageIdentityKey: bound.binding.targetStorageIdentityKey,
        mode
      },
      receiptPolicy
    )
    return JSON.stringify({
      protocol: 'brc38-private-import-preview/v1',
      previewId: randomUUID(),
      bindingSha256: bound.digest,
      archiveSha256: bound.binding.archiveSha256,
      expiresAt: store.limits.expiresAt,
      target
    })
  })
  return decodeBrc38PrivateImportPreview(store, json)
}
export async function readBrc38PrivateImportPreview(
  store: KnexBrc38StagingStore
): Promise<Readonly<Brc38PrivateImportPreview>> {
  const json = await store.readImportPreview()
  if (json === undefined) invalid()
  return decodeBrc38PrivateImportPreview(store, json)
}
/** The full activation owner must additionally provide bounded ID mappings,
 * durable commit/lost-ack recognition and explicit primary authorization. */
export async function withBrc38PrivateImportPreview<T>(
  store: KnexBrc38StagingStore,
  storage: StorageKnex,
  previewId: string,
  receiptPolicy: SnapshotJournalReceiptPolicy,
  write: (trx: Knex.Transaction) => Promise<T>
): Promise<T> {
  return await store.withImportPreviewRead(async json => {
    const preview = decodeBrc38PrivateImportPreview(store, json)
    if (preview.previewId !== previewId) invalid()
    return await withBrc38KnexDestinationFence(storage, preview.target, receiptPolicy, async trx => {
      if (Date.now() >= preview.expiresAt) invalid()
      return await write(trx)
    })
  })
}
