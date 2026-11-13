import { sha256 } from '@bsv/sdk/primitives/Hash'
import { toHex } from '@bsv/sdk/primitives/utils'
import type { TableSettings, TableUser } from '../schema/tables'
import { compareSnapshotJournalRevisions, snapshotJournalRevision } from './journal/SnapshotJournalRevision'

/** Opaque comparison DATA from one coherent source view. Neither digest grants
 * a read handle, backend ownership, primary selection or a completed-copy ACK. */
export interface SnapshotSyncContentPosition {
  readonly version: 1
  readonly binding: string
  readonly metadata: string
  readonly highWater: string
}

export interface SnapshotSyncContentRevision extends SnapshotSyncContentPosition {
  readonly content: string
  readonly floor: string
  /** Present only when the actual source found no intervening metadata events
   * above this same-binding/metadata position, within its retained history. */
  readonly unchangedSince?: string
}

function invalid(): never {
  throw new TypeError('Invalid snapshot sync content revision data')
}

function digest(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 64 || !/^[0-9a-f]{64}$/.test(value)) invalid()
  return value
}

function data(object: object, key: string, optional = false): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key)
  if (descriptor === undefined && optional) return undefined
  if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) invalid()
  return descriptor.value
}

function text(value: unknown, maximum: number, minimum = 1): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) invalid()
  return value
}

function date(value: unknown): string {
  // IndexedDB structured clones can carry another realm's genuine Date.
  // The built-in brand check refuses impostors without invoking their getters.
  let time: number
  try {
    time = Date.prototype.getTime.call(value)
  } catch {
    return invalid()
  }
  if (!Number.isFinite(time)) invalid()
  return new Date(time).toISOString()
}

/** Detach a bounded wire/storage value without invoking accessors. */
export function parseSnapshotSyncContentRevision(input: unknown): Readonly<SnapshotSyncContentRevision> {
  if (
    input === null ||
    typeof input !== 'object' ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(input)) ||
    ![6, 7].includes(Reflect.ownKeys(input).length) ||
    data(input, 'version') !== 1
  )
    invalid()
  const highWater = snapshotJournalRevision(data(input, 'highWater')),
    floor = snapshotJournalRevision(data(input, 'floor')),
    since = data(input, 'unchangedSince', true)
  if (
    compareSnapshotJournalRevisions(floor, highWater) > 0 ||
    (Reflect.ownKeys(input).length === 7 && !Object.hasOwn(input, 'unchangedSince'))
  )
    invalid()
  const unchangedSince = since === undefined ? undefined : snapshotJournalRevision(since)
  if (
    unchangedSince !== undefined &&
    (compareSnapshotJournalRevisions(unchangedSince, floor) < 0 ||
      compareSnapshotJournalRevisions(unchangedSince, highWater) > 0)
  )
    invalid()
  return Object.freeze({
    version: 1,
    binding: digest(data(input, 'binding')),
    metadata: digest(data(input, 'metadata')),
    content: digest(data(input, 'content')),
    highWater,
    floor,
    ...(unchangedSince === undefined ? {} : { unchangedSince })
  })
}

export function parseSnapshotSyncContentPosition(input: unknown): Readonly<SnapshotSyncContentPosition> {
  if (
    input === null ||
    typeof input !== 'object' ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length !== 4 ||
    data(input, 'version') !== 1
  )
    invalid()
  return Object.freeze({
    version: 1,
    binding: digest(data(input, 'binding')),
    metadata: digest(data(input, 'metadata')),
    highWater: snapshotJournalRevision(data(input, 'highWater'))
  })
}

/** Projection of DATA only, not renewal of a source handle or retention lease. */
export function snapshotSyncContentPosition(input: unknown): Readonly<SnapshotSyncContentPosition> {
  const value = parseSnapshotSyncContentRevision(input)
  return Object.freeze({ version: 1, binding: value.binding, metadata: value.metadata, highWater: value.highWater })
}

/** SQL collations must not collapse distinct opaque storage identities. Retain
 * and compare the original identity alongside this bounded lookup key. */
export function snapshotSyncContentSourceKey(input: string): string {
  const value = text(input, 130),
    bytes = new TextEncoder().encode(value)
  if (new TextDecoder('utf-8', { fatal: true }).decode(bytes) !== value) invalid()
  return toHex(sha256(new TextEncoder().encode('snapshot-sync-content-source-key-v1\n' + value)))
}

interface ContentMetadataInput {
  sourceStorage: TableSettings
  user: Omit<TableUser, 'activeStorage'> & { activeStorage?: string | null }
  primaryEpoch: string
}
function contentMetadata(input: ContentMetadataInput): unknown[] {
  const primaryEpoch = snapshotJournalRevision(input.primaryEpoch)
  const settings = input.sourceStorage,
    user = input.user
  if (settings === null || typeof settings !== 'object' || user === null || typeof user !== 'object') invalid()
  const userId = data(user, 'userId'),
    identityKey = text(data(user, 'identityKey'), 66),
    chain = text(data(settings, 'chain'), 16),
    dbtype = data(settings, 'dbtype'),
    maxOutputScript = data(settings, 'maxOutputScript'),
    activeStorage = data(user, 'activeStorage', true)
  if (
    typeof userId !== 'number' ||
    !Number.isSafeInteger(userId) ||
    userId < 1 ||
    !/^(02|03)[0-9a-fA-F]{64}$/.test(identityKey) ||
    !['main', 'test', 'stn', 'ttn', 'tstn', 'regtest', 'mock'].includes(chain) ||
    typeof dbtype !== 'string' ||
    !['SQLite', 'MySQL', 'Postgres', 'IndexedDB'].includes(dbtype) ||
    typeof maxOutputScript !== 'number' ||
    !Number.isSafeInteger(maxOutputScript) ||
    maxOutputScript < 0
  )
    invalid()
  const metadata = [
    text(data(settings, 'storageIdentityKey'), 130),
    text(data(settings, 'storageName'), 4096, 0),
    chain,
    dbtype,
    maxOutputScript,
    date(data(settings, 'created_at')),
    date(data(settings, 'updated_at')),
    userId,
    identityKey,
    date(data(user, 'created_at')),
    date(data(user, 'updated_at')),
    activeStorage == null ? null : text(activeStorage, 130, 0),
    primaryEpoch
  ]
  return metadata
}

/** Comparison digest only; this creates no source actor, SQL writer or ACK. */
export function snapshotSyncContentMetadataDigest(input: ContentMetadataInput & { binding: string }): string {
  const binding = digest(input.binding)
  return toHex(
    sha256(
      new TextEncoder().encode(
        'snapshot-sync-content-metadata-v1\n' + JSON.stringify([binding, contentMetadata(input)])
      )
    )
  )
}

/** Internal DATA derivation only. Its caller must actually own the complete
 * source/schema/profile view used for every supplied value. Clock positions
 * consumed by capture alone are excluded; retention floor and all thirteen
 * scope/two global metadata maxima prevent pruned tombstones being mistaken
 * for unchanged content. High-water is an admission bound, not content itself. */
export function createSnapshotSyncContentRevision(input: {
  binding: string
  floor: string
  highWater: string
  revisions: readonly string[]
  sourceStorage: TableSettings
  user: Omit<TableUser, 'activeStorage'> & { activeStorage?: string | null }
  primaryEpoch: string
}): Readonly<SnapshotSyncContentRevision> {
  const binding = digest(input.binding),
    floor = snapshotJournalRevision(input.floor),
    high = snapshotJournalRevision(input.highWater)
  if (
    compareSnapshotJournalRevisions(floor, high) > 0 ||
    !Array.isArray(input.revisions) ||
    input.revisions.length !== 15
  )
    invalid()
  const revisions = Array.from({ length: 15 }, (_, index) => {
    const revision = snapshotJournalRevision(data(input.revisions, String(index)))
    if (compareSnapshotJournalRevisions(revision, high) > 0) invalid()
    return revision
  })
  const metadata = contentMetadata(input)
  const bytes = new TextEncoder().encode(
    'snapshot-sync-content-revision-v1\n' + JSON.stringify([binding, floor, revisions, metadata])
  )
  const metadataBytes = new TextEncoder().encode(
    'snapshot-sync-content-metadata-v1\n' + JSON.stringify([binding, metadata])
  )
  return Object.freeze({
    version: 1,
    binding,
    content: toHex(sha256(bytes)),
    metadata: toHex(sha256(metadataBytes)),
    floor,
    highWater: high
  })
}

/** An actual provider-owned monotone MVCC counter, not fifteen invented SQL
 * streams. Lease/cache bookkeeping does not advance that wallet-data counter.
 * Its distinct domain and physical epoch binding keep it separate from SQL. */
export function createSnapshotSyncClockContentRevision(
  input: ContentMetadataInput & { binding: string; highWater: string }
): Readonly<SnapshotSyncContentRevision> {
  const binding = digest(input.binding),
    highWater = snapshotJournalRevision(input.highWater),
    metadata = contentMetadata(input)
  return Object.freeze({
    version: 1,
    binding,
    highWater,
    floor: '0',
    content: toHex(
      sha256(
        new TextEncoder().encode(
          'snapshot-sync-mvcc-content-revision-v1\n' + JSON.stringify([binding, highWater, metadata])
        )
      )
    ),
    metadata: toHex(
      sha256(new TextEncoder().encode('snapshot-sync-content-metadata-v1\n' + JSON.stringify([binding, metadata])))
    )
  })
}

/** Equality is useful only after independent current source/destination checks. */
export function sameSnapshotSyncContentRevision(left: unknown, right: unknown): boolean {
  const a = parseSnapshotSyncContentRevision(left),
    b = parseSnapshotSyncContentRevision(right)
  return a.binding === b.binding && a.content === b.content
}

/** Comparison DATA only. Both endpoint owners still independently establish
 * the actual current source/destination state and durable completed copy. */
export function snapshotSyncContentConfirms(previous: unknown, observed: unknown): boolean {
  const old = parseSnapshotSyncContentRevision(previous),
    current = parseSnapshotSyncContentRevision(observed)
  return (
    current.binding === old.binding &&
    current.metadata === old.metadata &&
    compareSnapshotJournalRevisions(
      snapshotJournalRevision(current.highWater),
      snapshotJournalRevision(old.highWater)
    ) >= 0 &&
    (current.content === old.content || current.unchangedSince === old.highWater)
  )
}

/** Persist only its base coordinates, never an interval-confirmation claim. */
export function snapshotSyncContentRevisionData(input: unknown): Readonly<SnapshotSyncContentRevision> {
  const value = parseSnapshotSyncContentRevision(input)
  return Object.freeze({
    version: 1,
    binding: value.binding,
    content: value.content,
    metadata: value.metadata,
    highWater: value.highWater,
    floor: value.floor
  })
}

/** Coordinates remain DATA; an observation cannot confirm a future point in
 * the same physical/metadata binding, even when no source rows are fetched. */
export function assertSnapshotSyncContentPositionNotFuture(position: unknown, revision: unknown): void {
  const since = parseSnapshotSyncContentPosition(position),
    current = parseSnapshotSyncContentRevision(revision)
  if (
    since.binding === current.binding &&
    since.metadata === current.metadata &&
    compareSnapshotJournalRevisions(
      snapshotJournalRevision(since.highWater),
      snapshotJournalRevision(current.highWater)
    ) > 0
  )
    throw new TypeError('Content position exceeds the actual source high-water')
}
