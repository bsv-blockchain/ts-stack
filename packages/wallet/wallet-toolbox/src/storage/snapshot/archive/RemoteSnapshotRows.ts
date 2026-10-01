import { decodeSyncTransfer } from '../../remoting/SyncTransfer'
import type { WalletSnapshotTable } from '../WalletReadSnapshot'
import { snapshotArchiveLimits } from './SnapshotArchive'
import type { SnapshotArchiveReceipt } from './SnapshotArchiveDirectory'

type Cell = string | number | boolean | Date | Uint8Array
type Kind = 'string' | 'number' | 'boolean' | 'date' | 'bytes' | 'id' | 'fieldName'
export type RemoteSnapshotRow = Readonly<Record<string, Cell>>
interface Schema {
  keys: readonly string[]
  owned: boolean
  required: Readonly<Record<string, Kind>>
  optional?: Readonly<Record<string, Kind>>
}
const timestamps = { created_at: 'date', updated_at: 'date' } as const

// Version-one raw SQL row shapes. This validates representation and ownership;
// portable semantics and proof authentication remain independent consumers.
const schemas: Record<WalletSnapshotTable, Schema> = {
  provenTxs: {
    keys: ['provenTxId'],
    owned: false,
    required: {
      ...timestamps,
      provenTxId: 'id',
      txid: 'string',
      height: 'number',
      index: 'number',
      merklePath: 'bytes',
      rawTx: 'bytes',
      blockHash: 'string',
      merkleRoot: 'string'
    }
  },
  provenTxReqs: {
    keys: ['provenTxReqId'],
    owned: false,
    required: {
      ...timestamps,
      provenTxReqId: 'id',
      status: 'string',
      attempts: 'number',
      notified: 'boolean',
      txid: 'string',
      history: 'string',
      notify: 'string',
      rawTx: 'bytes'
    },
    optional: {
      provenTxId: 'id',
      batch: 'string',
      inputBEEF: 'bytes',
      wasBroadcast: 'boolean',
      rebroadcastAttempts: 'number'
    }
  },
  outputBaskets: {
    keys: ['basketId'],
    owned: true,
    required: {
      ...timestamps,
      basketId: 'id',
      userId: 'id',
      name: 'string',
      numberOfDesiredUTXOs: 'number',
      minimumDesiredUTXOValue: 'number',
      isDeleted: 'boolean'
    }
  },
  transactions: {
    keys: ['transactionId'],
    owned: true,
    required: {
      ...timestamps,
      transactionId: 'id',
      userId: 'id',
      status: 'string',
      reference: 'string',
      isOutgoing: 'boolean',
      satoshis: 'number',
      description: 'string'
    },
    optional: {
      provenTxId: 'id',
      version: 'number',
      lockTime: 'number',
      txid: 'string',
      inputBEEF: 'bytes',
      rawTx: 'bytes',
      noSendExpiryMode: 'string',
      noSendExpiryValue: 'number',
      noSendExpiryDeadline: 'number',
      noSendExpiryState: 'string',
      noSendExpiryAnchorTxid: 'string',
      noSendExpiryAnchorVout: 'number',
      noSendExpiryReleasedAt: 'number',
      noSendExpiryObservedAt: 'number',
      noSendExpiryReclaimTxid: 'string',
      noSendExpiryReclaimRawTx: 'bytes',
      noSendExpiryReclaimDerivationPrefix: 'string',
      noSendExpiryReclaimDerivationSuffix: 'string',
      noSendExpiryReclaimSatoshis: 'number'
    }
  },
  commissions: {
    keys: ['commissionId'],
    owned: true,
    required: {
      ...timestamps,
      commissionId: 'id',
      userId: 'id',
      transactionId: 'id',
      satoshis: 'number',
      keyOffset: 'string',
      isRedeemed: 'boolean',
      lockingScript: 'bytes'
    }
  },
  outputs: {
    keys: ['outputId'],
    owned: true,
    required: {
      ...timestamps,
      outputId: 'id',
      userId: 'id',
      transactionId: 'id',
      spendable: 'boolean',
      change: 'boolean',
      vout: 'number',
      satoshis: 'number',
      providedBy: 'string',
      purpose: 'string',
      type: 'string'
    },
    optional: {
      // SQL permits this legacy column to be null; normalized source rows omit it.
      outputDescription: 'string',
      basketId: 'id',
      txid: 'string',
      senderIdentityKey: 'string',
      derivationPrefix: 'string',
      derivationSuffix: 'string',
      customInstructions: 'string',
      spentBy: 'id',
      sequenceNumber: 'number',
      spendingDescription: 'string',
      scriptLength: 'number',
      scriptOffset: 'number',
      lockingScript: 'bytes'
    }
  },
  outputTags: {
    keys: ['outputTagId'],
    owned: true,
    required: { ...timestamps, outputTagId: 'id', userId: 'id', tag: 'string', isDeleted: 'boolean' }
  },
  outputTagMaps: {
    keys: ['outputTagId', 'outputId'],
    owned: false,
    required: { ...timestamps, outputTagId: 'id', outputId: 'id', isDeleted: 'boolean' }
  },
  txLabels: {
    keys: ['txLabelId'],
    owned: true,
    required: { ...timestamps, txLabelId: 'id', userId: 'id', label: 'string', isDeleted: 'boolean' }
  },
  txLabelMaps: {
    keys: ['txLabelId', 'transactionId'],
    owned: false,
    required: { ...timestamps, txLabelId: 'id', transactionId: 'id', isDeleted: 'boolean' }
  },
  certificates: {
    keys: ['certificateId'],
    owned: true,
    required: {
      ...timestamps,
      certificateId: 'id',
      userId: 'id',
      type: 'string',
      serialNumber: 'string',
      certifier: 'string',
      subject: 'string',
      revocationOutpoint: 'string',
      signature: 'string',
      isDeleted: 'boolean'
    },
    optional: { verifier: 'string' }
  },
  certificateFields: {
    keys: ['fieldName', 'certificateId'],
    owned: true,
    required: {
      ...timestamps,
      userId: 'id',
      certificateId: 'id',
      fieldName: 'fieldName',
      fieldValue: 'string',
      masterKey: 'string'
    }
  },
  syncStates: {
    keys: ['syncStateId'],
    owned: true,
    required: {
      ...timestamps,
      syncStateId: 'id',
      userId: 'id',
      storageIdentityKey: 'string',
      storageName: 'string',
      status: 'string',
      init: 'boolean',
      refNum: 'string',
      syncMap: 'string'
    },
    optional: { when: 'date', satoshis: 'number', errorLocal: 'string', errorOther: 'string' }
  }
}

function invalid(): never {
  throw new TypeError('Invalid snapshot archive row frame')
}

export function remoteSnapshotKeys(table: WalletSnapshotTable): readonly string[] {
  if (!Object.hasOwn(schemas, table)) invalid()
  return [...schemas[table].keys]
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  // This private helper only receives decoded bytes. JSON parsing and binary
  // restoration create enumerable string-keyed data properties, never accessors
  // or symbols; arbitrary caller objects are validated at the cursor boundary.
  if (Object.keys(value).length > 64) invalid()
  return Object.fromEntries(Object.entries(value))
}

function cell(value: unknown, kind: Kind): Cell {
  switch (kind) {
    case 'bytes':
      if (!(value instanceof Uint8Array)) invalid()
      return value
    case 'date': {
      if (typeof value !== 'string' || value.length > 32) invalid()
      const date = new Date(value)
      if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) invalid()
      return date
    }
    case 'id':
      if (!Number.isSafeInteger(value) || (value as number) < 1) invalid()
      return value as number
    case 'fieldName':
      if (typeof value !== 'string' || value.length > 200 || Array.from(value).length > 100) invalid()
      return value
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) invalid()
      return value
    case 'boolean':
      if (typeof value !== 'boolean') invalid()
      return value
    case 'string':
      if (typeof value !== 'string') invalid()
      return value
  }
}

function row(input: unknown, schema: Schema, userId: number): RemoteSnapshotRow {
  const fields = record(input)
  for (const name of Object.keys(schema.required)) if (!Object.hasOwn(fields, name)) invalid()
  const result: Record<string, Cell> = {}
  for (const [name, value] of Object.entries(fields)) {
    const kind = Object.hasOwn(schema.required, name)
      ? schema.required[name]
      : schema.optional !== undefined && Object.hasOwn(schema.optional, name)
        ? schema.optional[name]
        : undefined
    if (kind === undefined) invalid()
    Object.defineProperty(result, name, { value: cell(value, kind), enumerable: true })
  }
  if (schema.owned && result.userId !== userId) invalid()
  return result
}

export interface RemoteSnapshotFrame {
  readonly rows: readonly RemoteSnapshotRow[]
  readonly charges: readonly number[]
}

/** Decode one independently bounded frame only after its receipt hash was verified. */
export function decodeRemoteSnapshotFrame(
  bytes: Uint8Array,
  receipt: SnapshotArchiveReceipt,
  userId: number
): RemoteSnapshotFrame {
  if (bytes.length < 1 || bytes.length > snapshotArchiveLimits.pageBytes) invalid()
  remoteSnapshotKeys(receipt.table)
  const frame = record(decodeSyncTransfer(bytes))
  if (
    Object.keys(frame).length !== 3 ||
    frame.version !== 1 ||
    frame.table !== receipt.table ||
    !Array.isArray(frame.rows) ||
    frame.rows.length !== receipt.rows ||
    frame.rows.length > snapshotArchiveLimits.rowsPerPage
  )
    invalid()
  const rows = frame.rows.map(input => row(input, schemas[receipt.table], userId))
  const charges = rows.map(value =>
    Object.values(value).reduce<number>(
      (sum, entry) =>
        sum +
        64 +
        (typeof entry === 'string' ? entry.length * 2 : entry instanceof Uint8Array ? entry.byteLength * 2 : 0),
      0
    )
  )
  return { rows, charges }
}

/** The cached frame remains private; callers own every returned mutable value. */
export function detachRemoteSnapshotRow(value: RemoteSnapshotRow): Record<string, Cell> {
  return Object.fromEntries(
    Object.entries(value).map(([name, entry]) => [
      name,
      entry instanceof Uint8Array ? new Uint8Array(entry) : entry instanceof Date ? new Date(entry.getTime()) : entry
    ])
  )
}
