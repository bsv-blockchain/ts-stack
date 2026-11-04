import { createHash } from 'node:crypto'
import type { SyncMap } from '../schema/entities/EntityBase'
import type { TableProvenTx, TableSyncState } from '../schema/tables'
import { planTransactionMerge } from '../schema/entities/EntityTransaction'
import { planOutputMerge } from '../schema/entities/EntityOutput'
import { planProvenTxReqMergeMetadata } from '../schema/entities/EntityProvenTxReq'
import { planCertificateMerge } from '../schema/entities/EntityCertificate'
import { planCertificateFieldMerge } from '../schema/entities/EntityCertificateField'
import { planCommissionMerge } from '../schema/entities/EntityCommission'
import {
  brc38ImportTransactionMetadata,
  brc38ImportOutputMetadata,
  snapshotSyncTransactionMetadata,
  snapshotSyncOutputMetadata,
  type SnapshotSyncTransactionRow,
  type SnapshotSyncOutputRow
} from '../snapshot/SnapshotSyncActionMetadata'
import {
  brc38ImportRequestMetadata,
  snapshotSyncRequestMetadata,
  type SnapshotSyncRequestRow
} from '../snapshot/SnapshotSyncRequestMetadata'
import {
  brc38ImportSimplePayloadRow,
  nativeSimplePayloadRow,
  type NativeSimplePayloadRow
} from '../snapshot/NativeSnapshotSyncSimpleRows'
import type { WalletSnapshotFieldDescriptor } from '../snapshot/WalletReadSnapshot'
import type { Brc38JsonStreamedRow } from './Brc38JsonBinaryFields'
import { brc38JsonBinaryField } from './Brc38JsonBinaryFields'
import { brc38JsonStructuredField } from './Brc38JsonStructuredFields'
import { brc38JsonTextField } from './Brc38JsonTextFields'
import { nativePackedTextSource } from './Brc38NativePackedTextSources'
import type { Brc38ImportExistingFieldRow } from './Brc38ImportExistingRows'
import {
  chargeBrc38ImportDecodedBudget,
  copyBrc38ImportDecodedValue,
  type Brc38ImportDecodedBudget
} from './Brc38ImportDecodedBudget'

/** Content and selection DATA only. A copied origin/coordinate never admits a
 * source, current row, field installer, private writer or receipt. The enclosing
 * merge must repeat actual source/target/parent/proof/history checks. */
export interface Brc38ImportPolicyField extends WalletSnapshotFieldDescriptor {
  readonly sha256: string
  readonly field: string
  readonly origin: 'original' | 'current' | 'inline'
  readonly sourceIndex?: number
  readonly rowId?: number
}
type Cell = string | Readonly<WalletSnapshotFieldDescriptor>
type Proof = Omit<TableProvenTx, 'rawTx' | 'merklePath'> & {
  rawTx: Readonly<WalletSnapshotFieldDescriptor>
  merklePath: Readonly<WalletSnapshotFieldDescriptor>
}
type State = Omit<TableSyncState, 'syncMap' | 'errorLocal' | 'errorOther'> & {
  syncMap: Cell
  errorLocal?: Cell
  errorOther?: Cell
}
export type Brc38ImportFieldPolicyRow =
  | NativeSimplePayloadRow
  | { readonly table: 'transactions'; readonly value: SnapshotSyncTransactionRow }
  | { readonly table: 'outputs'; readonly value: SnapshotSyncOutputRow }
  | { readonly table: 'provenTxReqs'; readonly value: SnapshotSyncRequestRow }
  | { readonly table: 'provenTxs'; readonly value: Proof }
  | { readonly table: 'syncStates'; readonly value: State }
export type Brc38ImportFieldPolicyTable = Brc38ImportFieldPolicyRow['table']
type Extents = Readonly<Record<string, Readonly<Brc38ImportPolicyField>>>
function invalid(): never {
  throw new Error('Private import field policy differs from its complete original/current DATA')
}
function identifier(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) invalid()
  return value
}
function finite(value: unknown, optional = false): number | undefined {
  if (optional && value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid()
  return value
}
function date(value: unknown, optional = false): Date | undefined {
  if (optional && value === undefined) return undefined
  if (!(value instanceof Date) || !Number.isFinite(Date.prototype.getTime.call(value))) invalid()
  return new Date(Date.prototype.getTime.call(value))
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096) invalid()
  return value
}
function descriptor(
  field: string,
  value: Readonly<{ bytes: number; sha256: string }>,
  kind: Brc38ImportPolicyField['kind'],
  origin: Brc38ImportPolicyField['origin'],
  coordinate: Readonly<{ sourceIndex?: number; rowId?: number }>,
  budget: Brc38ImportDecodedBudget
): Readonly<Brc38ImportPolicyField> {
  chargeBrc38ImportDecodedBudget(budget, 2048)
  const bytes = value.bytes,
    sha256 = value.sha256
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    bytes > 1000000000 ||
    typeof sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(sha256)
  )
    invalid()
  return Object.freeze({ field, kind, bytes, sha256, origin, ...coordinate })
}
function metadataCopy(
  metadata: Readonly<Record<string, unknown>>,
  omit: ReadonlySet<string>,
  budget: Brc38ImportDecodedBudget
): Record<string, unknown> {
  chargeBrc38ImportDecodedBudget(budget, 16384)
  if (
    metadata === null ||
    typeof metadata !== 'object' ||
    Array.isArray(metadata) ||
    Reflect.ownKeys(metadata).length > 64
  )
    invalid()
  const fields: Record<string, unknown> = Object.create(null)
  for (const name of Reflect.ownKeys(metadata)) {
    if (typeof name !== 'string') invalid()
    const property = Object.getOwnPropertyDescriptor(metadata, name)
    if (property === undefined || !property.enumerable || !Object.hasOwn(property, 'value')) invalid()
    if (!omit.has(name)) fields[name] = copyBrc38ImportDecodedValue(property.value, budget)
  }
  return fields
}
function complete(
  table: Brc38ImportFieldPolicyTable,
  fields: Readonly<Record<string, unknown>>,
  extents: Extents,
  original: boolean
): Brc38ImportFieldPolicyRow {
  switch (table) {
    case 'transactions':
      return {
        table,
        value: original
          ? brc38ImportTransactionMetadata(fields, extents)
          : snapshotSyncTransactionMetadata(fields, extents)
      }
    case 'outputs':
      return {
        table,
        value: original ? brc38ImportOutputMetadata(fields, extents) : snapshotSyncOutputMetadata(fields, extents)
      }
    case 'provenTxReqs':
      return {
        table,
        value: original ? brc38ImportRequestMetadata(fields, extents) : snapshotSyncRequestMetadata(fields, extents)
      }
    case 'certificates':
    case 'certificateFields':
    case 'commissions':
      return original
        ? brc38ImportSimplePayloadRow(table, fields, extents)
        : nativeSimplePayloadRow(table, fields, extents)
    case 'provenTxs': {
      const allowed = ['created_at', 'updated_at', 'provenTxId', 'txid', 'height', 'index', 'blockHash', 'merkleRoot'],
        rawTx = extents.rawTx,
        merklePath = extents.merklePath
      if (
        Object.keys(fields).some(name => !allowed.includes(name)) ||
        Object.keys(extents).some(name => !['rawTx', 'merklePath'].includes(name)) ||
        rawTx?.kind !== 'binary' ||
        merklePath?.kind !== 'binary'
      )
        invalid()
      const id = identifier(fields.provenTxId)
      if (!original && (!Number.isSafeInteger(id) || id < 1)) invalid()
      return {
        table,
        value: {
          created_at: date(fields.created_at)!,
          updated_at: date(fields.updated_at)!,
          provenTxId: id,
          txid: text(fields.txid),
          height: finite(fields.height)!,
          index: finite(fields.index)!,
          blockHash: text(fields.blockHash),
          merkleRoot: text(fields.merkleRoot),
          rawTx,
          merklePath
        }
      }
    }
    case 'syncStates': {
      const allowed = [
          'created_at',
          'updated_at',
          'syncStateId',
          'userId',
          'storageIdentityKey',
          'storageName',
          'status',
          'init',
          'refNum',
          'when',
          'satoshis',
          'syncMap',
          'errorLocal',
          'errorOther'
        ],
        cell = (name: string, optional = false): Cell | undefined => {
          const extent = extents[name]
          if (extent !== undefined) {
            if (extent.kind === 'binary' || fields[name] !== undefined) invalid()
            return extent
          }
          if (optional && fields[name] === undefined) return undefined
          if (typeof fields[name] !== 'string') invalid()
          return fields[name]
        },
        status = fields.status
      if (
        Object.keys(fields).some(name => !allowed.includes(name)) ||
        Object.keys(extents).some(name => !['syncMap', 'errorLocal', 'errorOther'].includes(name)) ||
        typeof fields.init !== 'boolean' ||
        (status !== 'unknown' &&
          status !== 'success' &&
          status !== 'error' &&
          status !== 'identified' &&
          status !== 'updated')
      )
        invalid()
      return {
        table,
        value: {
          created_at: date(fields.created_at)!,
          updated_at: date(fields.updated_at)!,
          syncStateId: identifier(fields.syncStateId),
          userId: identifier(fields.userId),
          storageIdentityKey: text(fields.storageIdentityKey),
          storageName: text(fields.storageName),
          status,
          init: fields.init,
          refNum: text(fields.refNum),
          when: date(fields.when, true),
          satoshis: finite(fields.satoshis, true),
          syncMap: cell('syncMap')!,
          errorLocal: cell('errorLocal', true),
          errorOther: cell('errorOther', true)
        }
      }
    }
  }
}
/** Prepare complete original policy DATA after actual archive admission and
 * independent semantics. Inline binary DATA is hashed from its actual decoded
 * bytes, never replaced with an empty payload or manufactured source producer. */
export function prepareBrc38ImportOriginalFieldPolicy(
  table: Brc38ImportFieldPolicyTable,
  sourceIndex: number,
  metadata: Readonly<Record<string, unknown>>,
  source: Readonly<Brc38JsonStreamedRow>,
  budget: Brc38ImportDecodedBudget
): Brc38ImportFieldPolicyRow {
  if (!Number.isSafeInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= 1000000000) invalid()
  chargeBrc38ImportDecodedBudget(budget, 16384)
  const extents: Record<string, Readonly<Brc38ImportPolicyField>> = Object.create(null),
    omit = new Set<string>()
  for (const [family, fields] of [
    ['binary', source.binaries],
    ['structured', source.structured ?? {}],
    ['text', source.texts ?? {}]
  ] as const) {
    if (Object.keys(fields).length > (family === 'text' ? 7 : 3)) invalid()
    for (const [name, value] of Object.entries(fields)) {
      if (
        Object.hasOwn(extents, name) ||
        Object.hasOwn(metadata, name) ||
        value.field !== name ||
        (family === 'binary'
          ? !brc38JsonBinaryField(table, name)
          : family === 'structured'
            ? !brc38JsonStructuredField(table, name)
            : !brc38JsonTextField(table, name))
      )
        invalid()
      extents[name] = descriptor(
        name,
        value,
        family === 'binary' ? 'binary' : 'utf8',
        'original',
        { sourceIndex },
        budget
      )
      omit.add(name)
    }
  }
  for (const name of Object.keys(metadata)) {
    if (!brc38JsonBinaryField(table, name) || metadata[name] == null) continue
    const value = metadata[name]
    if (!(value instanceof Uint8Array) && !Array.isArray(value)) invalid()
    chargeBrc38ImportDecodedBudget(budget, 2048 + 16 * value.length)
    if (
      Array.isArray(value) &&
      value.some(byte => typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255)
    )
      invalid()
    const bytes = Buffer.from(value)
    try {
      extents[name] = descriptor(
        name,
        { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
        'binary',
        'inline',
        { sourceIndex },
        budget
      )
    } finally {
      bytes.fill(0)
    }
    omit.add(name)
  }
  return complete(table, metadataCopy(metadata, omit, budget), Object.freeze(extents), true)
}
/** Current descriptors come from fresh indexed marker/pointer reads. They stay
 * DATA and must be re-read in the actual final writer before selecting policy. */
export function prepareBrc38ImportCurrentFieldPolicy(
  selected: Readonly<Brc38ImportExistingFieldRow>,
  budget: Brc38ImportDecodedBudget
): Brc38ImportFieldPolicyRow | undefined {
  if (selected.metadata === undefined) {
    if (
      Object.keys(selected.binaries).length !== 0 ||
      Object.keys(selected.structured).length !== 0 ||
      Object.keys(selected.texts ?? {}).length !== 0
    )
      invalid()
    return undefined
  }
  const table = selected.table
  if (
    ![
      'provenTxs',
      'transactions',
      'outputs',
      'certificates',
      'certificateFields',
      'commissions',
      'provenTxReqs',
      'syncStates'
    ].includes(table)
  )
    invalid()
  chargeBrc38ImportDecodedBudget(budget, 16384)
  const extents: Record<string, Readonly<Brc38ImportPolicyField>> = Object.create(null)
  for (const [name, value] of Object.entries(selected.binaries)) {
    if (!brc38JsonBinaryField(table, name) || !Number.isSafeInteger(selected.binaryRowId) || selected.binaryRowId! < 1)
      invalid()
    extents[name] = descriptor(name, value, 'binary', 'current', { rowId: selected.binaryRowId }, budget)
  }
  const textFields = table === 'provenTxs' ? [] : nativePackedTextSource(table).fields
  for (const [name, value] of Object.entries(selected.texts ?? {})) {
    if (
      !textFields.some(field => field === name) ||
      !Number.isSafeInteger(selected.textRowId) ||
      (table !== 'syncStates' && selected.textRowId! < 1) ||
      Object.hasOwn(extents, name)
    )
      invalid()
    extents[name] = descriptor(name, value, 'utf8', 'current', { rowId: selected.textRowId }, budget)
  }
  for (const [name, value] of Object.entries(selected.structured)) {
    const actual = selected.texts?.[name]
    if (!brc38JsonStructuredField(table, name) || actual?.bytes !== value.bytes || actual.sha256 !== value.sha256)
      invalid()
  }
  return complete(
    table as Brc38ImportFieldPolicyTable,
    metadataCopy(selected.metadata, new Set(), budget),
    Object.freeze(extents),
    false
  )
}
/** Shared original existing-row policy selection only. Request history/notify,
 * canonical proof replacement and operational checkpoints are separate complete
 * preparations; this result never permits an effect or records a verdict. */
export function selectBrc38ImportExistingFieldPolicy(
  current: Brc38ImportFieldPolicyRow,
  incoming: Brc38ImportFieldPolicyRow,
  map: SyncMap
): Readonly<{ row: Brc38ImportFieldPolicyRow; quarantineReclaimTxid?: string }> | undefined {
  switch (incoming.table) {
    case 'transactions': {
      if (current.table !== incoming.table) invalid()
      const selected = planTransactionMerge(current.value, incoming.value, map)
      return selected === undefined
        ? undefined
        : {
            row: { table: incoming.table, value: selected.row },
            ...(selected.quarantineReclaimTxid === undefined
              ? {}
              : { quarantineReclaimTxid: selected.quarantineReclaimTxid })
          }
    }
    case 'outputs': {
      if (current.table !== incoming.table) invalid()
      const value = planOutputMerge(current.value, incoming.value, map)
      return value === undefined ? undefined : { row: { table: incoming.table, value } }
    }
    case 'certificates': {
      if (current.table !== incoming.table) invalid()
      const value = planCertificateMerge(current.value, incoming.value)
      return value === undefined ? undefined : { row: { table: incoming.table, value } }
    }
    case 'certificateFields': {
      if (current.table !== incoming.table) invalid()
      const value = planCertificateFieldMerge(current.value, incoming.value)
      return value === undefined ? undefined : { row: { table: incoming.table, value } }
    }
    case 'commissions': {
      if (current.table !== incoming.table) invalid()
      const value = planCommissionMerge(current.value, incoming.value)
      return value === undefined ? undefined : { row: { table: incoming.table, value } }
    }
    case 'provenTxReqs': {
      if (current.table !== incoming.table) invalid()
      return { row: { table: incoming.table, value: planProvenTxReqMergeMetadata(current.value, incoming.value) } }
    }
    case 'syncStates':
      if (current.table !== incoming.table) invalid()
      return undefined
    case 'provenTxs':
      invalid()
  }
}
