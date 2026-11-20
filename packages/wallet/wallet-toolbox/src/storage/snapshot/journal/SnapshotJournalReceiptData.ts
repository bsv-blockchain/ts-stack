import { sha256 } from '@bsv/sdk/primitives/Hash'
import { toHex } from '@bsv/sdk/primitives/utils'
import { brc38Utf8ByteLength } from '../../portable/Brc38Utf8Length'
import { compareSnapshotJournalRevisions, snapshotJournalRevision } from './SnapshotJournalRevision'
import type { SnapshotJournalReceipt, SnapshotJournalReceiptBinding } from './SnapshotJournalTypes'

function invalid(): never {
  throw new TypeError('Invalid snapshot journal receipt DATA')
}

/** Closed wire DATA only. No backend, lease, writer or primary is admitted. */
export function snapshotJournalDataRecord(input: unknown, names: readonly string[]): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== 'object' ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(input)) ||
    Reflect.ownKeys(input).length !== names.length
  )
    invalid()
  const row: Record<string, unknown> = Object.create(null)
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(input, name)
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) invalid()
    Object.defineProperty(row, name, { value: descriptor.value, enumerable: true })
  }
  return row
}

export function snapshotJournalDataDigest(input: unknown): string {
  if (typeof input !== 'string' || !/^[0-9a-f]{64}$/.test(input)) invalid()
  return input
}

export function snapshotJournalDataText(input: unknown, maximumBytes: number, minimum = 0): string {
  if (
    typeof input !== 'string' ||
    input.length < minimum ||
    input.length > maximumBytes ||
    brc38Utf8ByteLength(input) > maximumBytes ||
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(new TextEncoder().encode(input)) !== input
  )
    invalid()
  return input
}

/** Shared exact preimage. Callers validate their own boundary before hashing.
 * A digest is comparison/provenance DATA, never transferable source authority. */
export function hashSnapshotJournalReceiptBinding(value: SnapshotJournalReceiptBinding): string {
  return toHex(
    sha256(
      new TextEncoder().encode(
        'snapshot-journal-receipt-binding-v1\n' +
          JSON.stringify([
            value.backend,
            value.epoch,
            value.source,
            value.schema,
            value.storageIdentity,
            value.identityKey,
            value.userId,
            value.chain
          ])
      )
    )
  )
}

export function parseSnapshotJournalReceiptBindingData(input: unknown): Readonly<SnapshotJournalReceiptBinding> {
  const row = snapshotJournalDataRecord(input, [
    'backend',
    'epoch',
    'source',
    'schema',
    'storageIdentity',
    'identityKey',
    'userId',
    'chain'
  ])
  if (
    typeof row.epoch !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.epoch) ||
    typeof row.identityKey !== 'string' ||
    !/^(02|03)[0-9a-f]{64}$/.test(row.identityKey) ||
    typeof row.userId !== 'number' ||
    !Number.isSafeInteger(row.userId) ||
    row.userId < 1 ||
    typeof row.chain !== 'string' ||
    !['main', 'test', 'stn', 'ttn', 'tstn', 'regtest', 'mock'].includes(row.chain)
  )
    invalid()
  return Object.freeze({
    backend: snapshotJournalDataDigest(row.backend),
    epoch: row.epoch,
    source: snapshotJournalDataDigest(row.source),
    schema: snapshotJournalDataDigest(row.schema),
    storageIdentity: snapshotJournalDataText(row.storageIdentity, 256, 1),
    identityKey: row.identityKey,
    userId: row.userId,
    chain: row.chain
  })
}

/** Offline structural validation. The actual artifact/endpoint owner must
 * separately check current time, profile, schema, integrity and admission. */
export function parseSnapshotJournalReceiptData(
  input: unknown,
  binding: SnapshotJournalReceiptBinding
): Readonly<SnapshotJournalReceipt> {
  const row = snapshotJournalDataRecord(input, ['requestId', 'binding', 'highWater', 'floor', 'expiresAt']),
    ownedBinding = parseSnapshotJournalReceiptBindingData(binding),
    highWater = snapshotJournalRevision(row.highWater),
    floor = snapshotJournalRevision(row.floor)
  if (
    highWater === '0' ||
    compareSnapshotJournalRevisions(floor, highWater) > 0 ||
    row.binding !== hashSnapshotJournalReceiptBinding(ownedBinding) ||
    typeof row.expiresAt !== 'number' ||
    !Number.isSafeInteger(row.expiresAt) ||
    row.expiresAt < 1
  )
    invalid()
  return Object.freeze({
    requestId: snapshotJournalDataDigest(row.requestId),
    binding: snapshotJournalDataDigest(row.binding),
    highWater,
    floor,
    expiresAt: row.expiresAt
  })
}

export interface SnapshotJournalArchivePosition {
  binding: string
  highWater: string
}

/** A requested lower bound is DATA. The actual producer chooses full repair
 * when this physical/profile binding or retained interval no longer matches. */
export function parseSnapshotJournalArchivePosition(
  input: unknown
): Readonly<SnapshotJournalArchivePosition & { highWater: ReturnType<typeof snapshotJournalRevision> }> | undefined {
  if (input === null) return undefined
  const row = snapshotJournalDataRecord(input, ['binding', 'highWater'])
  return Object.freeze({
    binding: snapshotJournalDataDigest(row.binding),
    highWater: snapshotJournalRevision(row.highWater)
  })
}

/** Exact comparison with a previous immutable field capture. It supplies no
 * source actor, renewal, SQL fence, primary authority or financial ACK. */
export interface SnapshotJournalFieldArchiveReference {
  readonly source: Readonly<SnapshotJournalReceiptBinding>
  readonly receipt: Readonly<SnapshotJournalReceipt>
}
export function parseSnapshotJournalFieldArchiveReference(
  input: unknown
): Readonly<SnapshotJournalFieldArchiveReference> {
  const row = snapshotJournalDataRecord(input, ['source', 'receipt']),
    source = parseSnapshotJournalReceiptBindingData(row.source)
  return Object.freeze({ source, receipt: parseSnapshotJournalReceiptData(row.receipt, source) })
}
