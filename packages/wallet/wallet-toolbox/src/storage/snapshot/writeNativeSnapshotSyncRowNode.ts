import type { Knex } from 'knex'
import type { StorageKnex } from '../StorageKnex'
import { ownedNativeRootIdentity } from '../schema/ownedNativeSqliteConnectionsNode'
import { hasBrc38NativePackedSchema, requireBrc38PackedWriter } from '../portable/Brc38NativePackedSchemaNode'
import { hasBrc38NativePackedTextSchema } from '../portable/Brc38NativePackedTextSchemaNode'
import {
  finishBrc38NativePackedTextWalletWrite,
  type prepareBrc38NativePackedTextWalletWrite
} from '../portable/Brc38NativePackedTextWalletNode'
import {
  assertPreparedPackedNativeSnapshotField,
  type PreparedPackedNativeSnapshotField
} from './preparePackedNativeSnapshotFieldNode'
import { snapshotSyncRequestColumns } from './SnapshotSyncRequestMetadata'
import { snapshotSyncActionColumns } from './SnapshotSyncActionMetadata'

export type NativeSimplePayloadTable = 'certificates' | 'certificateFields' | 'commissions'
export type NativeSnapshotPayloadTable =
  NativeSimplePayloadTable | 'provenTxs' | 'transactions' | 'outputs' | 'provenTxReqs'
const definitions = {
  provenTxReqs: { sql: 'proven_tx_reqs', key: 'provenTxReqId', columns: snapshotSyncRequestColumns() },
  transactions: { sql: 'transactions', key: 'transactionId', columns: snapshotSyncActionColumns('transactions') },
  outputs: { sql: 'outputs', key: 'outputId', columns: snapshotSyncActionColumns('outputs') },
  provenTxs: {
    sql: 'proven_txs',
    key: 'provenTxId',
    columns: [
      'created_at',
      'updated_at',
      'provenTxId',
      'txid',
      'blockHash',
      'merkleRoot',
      'height',
      'index',
      'rawTx',
      'merklePath'
    ]
  },
  certificates: {
    sql: 'certificates',
    key: 'certificateId',
    columns: [
      'created_at',
      'updated_at',
      'userId',
      'certificateId',
      'type',
      'certifier',
      'serialNumber',
      'subject',
      'revocationOutpoint',
      'signature',
      'verifier',
      'isDeleted'
    ]
  },
  certificateFields: {
    sql: 'certificate_fields',
    key: 'rowid',
    columns: ['created_at', 'updated_at', 'userId', 'certificateId', 'fieldName', 'fieldValue', 'masterKey']
  },
  commissions: {
    sql: 'commissions',
    key: 'commissionId',
    columns: [
      'created_at',
      'updated_at',
      'userId',
      'commissionId',
      'transactionId',
      'satoshis',
      'isRedeemed',
      'keyOffset',
      'lockingScript'
    ]
  }
} as const
function invalid(): never {
  throw new Error('Native field metadata differs from its actual producer/current row')
}
/** Internal scalar/marker writer, never a fabricated complete wallet DTO.
 * The enclosing entity component freshly selects policy, current parents/maps
 * and profile/primary/session in this transaction. All prepared content attaches
 * before that component may persist maps or the enclosing ACK. */
export async function writeNativeSnapshotSyncRow(
  storage: StorageKnex,
  trx: Knex.Transaction,
  table: NativeSnapshotPayloadTable,
  metadata: Readonly<Record<string, unknown>>,
  inline: ReturnType<typeof prepareBrc38NativePackedTextWalletWrite>,
  fields: Readonly<Record<string, PreparedPackedNativeSnapshotField>>,
  currentId?: number
): Promise<number> {
  const root = storage.knex,
    original = ownedNativeRootIdentity(root),
    check = (): void => {
      requireBrc38PackedWriter(trx)
      if (
        original?.slot !== 0 ||
        storage.knex !== root ||
        ownedNativeRootIdentity(root)?.token !== original.token ||
        ownedNativeRootIdentity(trx)?.token !== original.token ||
        ownedNativeRootIdentity(trx)?.slot !== 0
      )
        invalid()
    }
  check()
  if (
    !Object.hasOwn(definitions, table) ||
    !(await hasBrc38NativePackedSchema(trx)) ||
    !(await hasBrc38NativePackedTextSchema(trx)) ||
    metadata === null ||
    typeof metadata !== 'object' ||
    Array.isArray(metadata) ||
    fields === null ||
    typeof fields !== 'object' ||
    Array.isArray(fields) ||
    Reflect.ownKeys(metadata).length > 40 ||
    Reflect.ownKeys(fields).length > 8 ||
    inline.fields.length > 7 ||
    (currentId !== undefined && (!Number.isSafeInteger(currentId) || currentId < 1))
  )
    invalid()
  const definition = definitions[table],
    row: Record<string, unknown> = {},
    descriptors = Object.getOwnPropertyDescriptors(metadata)
  for (const key of Reflect.ownKeys(metadata)) {
    if (typeof key !== 'string' || !definition.columns.some(column => column === key)) invalid()
    const descriptor = descriptors[key]
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid()
    const value: unknown = descriptor.value
    // Keep missing legacy broadcast/retry fields absent: inserts retain the
    // schema defaults and updates retain the destination's current counters.
    if (value === undefined && table === 'provenTxReqs' && (key === 'wasBroadcast' || key === 'rebroadcastAttempts'))
      continue
    if (value instanceof Date) {
      if (!Number.isFinite(value.getTime())) invalid()
      row[key] = new Date(value.getTime())
    } else if (
      value === undefined ||
      value === null ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    )
      row[key] = value
    else if (typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= 65536) row[key] = value
    else invalid()
  }
  if (
    !(row.created_at instanceof Date) ||
    !(row.updated_at instanceof Date) ||
    (table !== 'provenTxs' &&
      table !== 'provenTxReqs' &&
      (typeof row.userId !== 'number' || !Number.isSafeInteger(row.userId) || row.userId < 1))
  )
    invalid()
  for (const name of Reflect.ownKeys(fields)) {
    if (typeof name !== 'string' || !definition.columns.some(column => column === name)) invalid()
    const property = Object.getOwnPropertyDescriptor(fields, name)
    if (
      property === undefined ||
      !property.enumerable ||
      !Object.hasOwn(property, 'value') ||
      inline.fields.some(value => value.field === name)
    )
      invalid()
    const stage = property.value as PreparedPackedNativeSnapshotField
    assertPreparedPackedNativeSnapshotField(storage, table, name, stage)
    row[name] = stage.descriptor.kind === 'binary' ? trx.raw('zeroblob(0)') : ''
  }
  const inlineNames = new Set<string>()
  for (const field of inline.fields) {
    if (
      table === 'provenTxs' ||
      inlineNames.has(field.field) ||
      !definition.columns.some(column => column === field.field) ||
      inline.row[field.field] !== '' ||
      !(field.bytes instanceof Uint8Array)
    )
      invalid()
    inlineNames.add(field.field)
    row[field.field] = ''
  }
  const booleans =
    table === 'certificates'
      ? ['isDeleted']
      : table === 'commissions'
        ? ['isRedeemed']
        : table === 'provenTxReqs'
          ? ['notified', 'wasBroadcast']
          : table === 'transactions'
            ? ['isOutgoing']
            : table === 'outputs'
              ? ['spendable', 'change']
              : []
  for (const field of booleans) {
    if (!Object.hasOwn(row, field)) continue
    if (row[field] !== true && row[field] !== false && row[field] !== 0 && row[field] !== 1) invalid()
    row[field] = row[field] === true || row[field] === 1 ? 1 : 0
  }
  const created = row.created_at,
    updated = row.updated_at,
    normalized = await storage.validateEntityForInsert({ ...row, created_at: created, updated_at: updated }, trx)
  let id: number
  check()
  if (currentId === undefined) {
    if (definition.key !== 'rowid') delete normalized[definition.key]
    const inserted: Array<Record<string, unknown>> = await trx(definition.sql)
        .insert(normalized)
        .returning(definition.key),
      actual = inserted[0]?.[definition.key]
    if (inserted.length !== 1 || typeof actual !== 'number' || !Number.isSafeInteger(actual) || actual < 1) invalid()
    id = actual
  } else {
    if (
      definition.key !== 'rowid' &&
      Object.hasOwn(normalized, definition.key) &&
      normalized[definition.key] !== currentId
    )
      invalid()
    const key = {
      [definition.key]: currentId,
      ...(table === 'provenTxs' || table === 'provenTxReqs' ? {} : { userId: row.userId })
    }
    if ((await trx(definition.sql).where(key).update(normalized)) !== 1) invalid()
    id = currentId
  }
  check()
  if (Object.keys(fields).length !== 0) await storage.writePreparedNativeSnapshotFields(table, id, fields, trx)
  if (table !== 'provenTxs') {
    if (definition.sql === 'proven_txs') invalid()
    await finishBrc38NativePackedTextWalletWrite(trx, definition.sql, id, inline.fields)
  }
  check()
  return id
}
