import type { Brc38ComposedDatabaseImage } from './Brc38ComposedDatabaseImageNode'
import type { Brc38ProfileInventoryBinding } from './Brc38PublishedProfileNode'
import { snapshotJournalRevision, type SnapshotJournalRevision } from '../snapshot/journal/SnapshotJournalRevision'

/** Original composed-target lineage DATA. The owning publication/cutover
 * controller still proves the actual source, complete semantics, physical copy,
 * target owner, manager queue and durable source retirement independently.
 * Neither this record nor its image is an activation/selection capability. */
export interface Brc38ComposedProfileReceipt {
  readonly protocol: 'brc38-composed-profile/v1'
  readonly decisionId: string
  readonly source: Readonly<{
    inventory: Readonly<Brc38ProfileInventoryBinding>
    fixedSha256: string
    copySha256: string
    copyBytes: number
    epoch: string
    revision: SnapshotJournalRevision
    primaryEpoch: SnapshotJournalRevision
    userId: number
    activeStorage: string
  }>
  readonly image: Readonly<Brc38ComposedDatabaseImage>
  readonly maximumReadBytes: number
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const sha = /^[0-9a-f]{64}$/
function invalid(): never {
  throw new Error('Composed profile original lineage data differs')
}
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).length !== keys.length
  )
    invalid()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (
    keys.some(
      key => descriptors[key] === undefined || !('value' in descriptors[key]) || descriptors[key].enumerable !== true
    )
  )
    invalid()
}
function count(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]{0,20})$/.test(value) ||
    BigInt(value) > 4n * BigInt(Number.MAX_SAFE_INTEGER)
  )
    invalid()
  return value
}
/** Capture and normalize bounded DATA at the original call boundary. Unknown
 * members, noncanonical counters/revisions and changed protocol refuse rather
 * than silently discarding information during persisted recovery. */
export function copyBrc38ComposedProfileReceipt(
  selected: Brc38ComposedProfileReceipt
): Readonly<Brc38ComposedProfileReceipt> {
  exact(selected, ['protocol', 'decisionId', 'source', 'image', 'maximumReadBytes'])
  const source = selected.source,
    image = selected.image
  exact(source, [
    'inventory',
    'fixedSha256',
    'copySha256',
    'copyBytes',
    'epoch',
    'revision',
    'primaryEpoch',
    'userId',
    'activeStorage'
  ])
  exact(source.inventory, ['rootId', 'profileId', 'policySha256'])
  exact(image, ['protocol', 'sha256', 'schemaObjects', 'tables', 'rows', 'cellBytes'])
  if (
    selected.protocol !== 'brc38-composed-profile/v1' ||
    !uuid.test(selected.decisionId) ||
    ![source.epoch, source.inventory.rootId, source.inventory.profileId].every(
      value => typeof value === 'string' && uuid.test(value)
    ) ||
    ![source.fixedSha256, source.copySha256, source.inventory.policySha256, image.sha256].every(
      value => typeof value === 'string' && sha.test(value)
    ) ||
    !Number.isSafeInteger(source.copyBytes) ||
    source.copyBytes < 4096 ||
    !Number.isSafeInteger(source.userId) ||
    source.userId < 1 ||
    typeof source.activeStorage !== 'string' ||
    source.activeStorage.length < 1 ||
    Buffer.byteLength(source.activeStorage) > 1024 ||
    image.protocol !== 'brc38-composed-database-image/v1' ||
    !Number.isSafeInteger(image.schemaObjects) ||
    image.schemaObjects < 47 ||
    image.schemaObjects > 4096 ||
    !Number.isSafeInteger(image.tables) ||
    image.tables < 47 ||
    image.tables > 512 ||
    image.tables > image.schemaObjects ||
    !Number.isSafeInteger(selected.maximumReadBytes) ||
    selected.maximumReadBytes < 1 ||
    selected.maximumReadBytes > 16384
  )
    invalid()
  const value: Readonly<Brc38ComposedProfileReceipt> = Object.freeze({
    protocol: selected.protocol,
    decisionId: selected.decisionId,
    source: Object.freeze({
      inventory: Object.freeze({
        rootId: source.inventory.rootId,
        profileId: source.inventory.profileId,
        policySha256: source.inventory.policySha256
      }),
      fixedSha256: source.fixedSha256,
      copySha256: source.copySha256,
      copyBytes: source.copyBytes,
      epoch: source.epoch,
      revision: snapshotJournalRevision(source.revision),
      primaryEpoch: snapshotJournalRevision(source.primaryEpoch),
      userId: source.userId,
      activeStorage: source.activeStorage
    }),
    image: Object.freeze({
      protocol: image.protocol,
      sha256: image.sha256,
      schemaObjects: image.schemaObjects,
      tables: image.tables,
      rows: count(image.rows),
      cellBytes: count(image.cellBytes)
    }),
    maximumReadBytes: selected.maximumReadBytes
  })
  if (Buffer.byteLength(JSON.stringify(value)) > 4096) invalid()
  return value
}
export function readBrc38ComposedProfileReceipt(json: string): Readonly<Brc38ComposedProfileReceipt> {
  if (typeof json !== 'string' || Buffer.byteLength(json) > 4096) invalid()
  const value = copyBrc38ComposedProfileReceipt(JSON.parse(json) as Brc38ComposedProfileReceipt)
  if (JSON.stringify(value) !== json) invalid()
  return value
}
