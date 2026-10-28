import { isSnapshotArchiveChain } from '../archive/SnapshotArchiveChain'
import { parseSnapshotSyncContentRevision, type SnapshotSyncContentRevision } from '../SnapshotSyncContentRevision'
import type { TableSettings, TableUser } from '../../schema/tables'
import {
  parseSnapshotJournalReceiptBindingData,
  parseSnapshotJournalReceiptData,
  snapshotJournalDataDigest,
  snapshotJournalDataRecord,
  snapshotJournalDataText
} from './SnapshotJournalReceiptData'
import { snapshotJournalArchiveEncoding, snapshotJournalFieldArchiveEncoding } from './SnapshotJournalArchivePacket'
import {
  compareSnapshotJournalRevisions,
  snapshotJournalRevision,
  type SnapshotJournalRevision
} from './SnapshotJournalRevision'
import type { SnapshotJournalReceipt, SnapshotJournalReceiptBinding } from './SnapshotJournalTypes'

export interface SnapshotJournalArchiveBinding {
  version: 3
  encoding: typeof snapshotJournalArchiveEncoding
  snapshotId: string
  sourceStorage: TableSettings
  sourceSchema: string
  /** Captured operational DATA only, with original nullable selection retained. */
  user: Omit<TableUser, 'activeStorage'> & { activeStorage?: string | null }
  journal: {
    source: Readonly<SnapshotJournalReceiptBinding>
    receipt: Readonly<SnapshotJournalReceipt>
    low: SnapshotJournalRevision
    bootstrap: boolean
    primary: Readonly<{ epoch: SnapshotJournalRevision; activeStorage: string | null }>
    contentRevision?: Readonly<SnapshotSyncContentRevision>
  }
}
export interface SnapshotJournalArchiveManifest {
  version: 1
  archiveId: string
  binding: SnapshotJournalArchiveBinding
  expiresAt: number
  pages: number
  /** Packet frame changes; identity prefixes carry zero and remain charged pages. */
  rows: number
  digest: string
}

function invalid(): never {
  throw new TypeError('Invalid snapshot journal archive binding DATA')
}
function date(input: unknown): Date {
  let time: number
  try {
    time = typeof input === 'string' ? Date.parse(input) : Date.prototype.getTime.call(input)
  } catch {
    return invalid()
  }
  if (!Number.isFinite(time)) invalid()
  const result = new Date(time)
  if (typeof input === 'string' && result.toISOString() !== input) invalid()
  return result
}

/** Detached immutable artifact metadata. Parsing cannot admit a live source,
 * authorize a writer, renew a receipt or select a primary. */
export function parseSnapshotJournalArchiveBinding(input: unknown): SnapshotJournalArchiveBinding {
  const row = snapshotJournalDataRecord(input, [
    'version',
    'encoding',
    'snapshotId',
    'sourceStorage',
    'sourceSchema',
    'user',
    'journal'
  ])
  if (row.version !== 3 || row.encoding !== snapshotJournalArchiveEncoding) invalid()
  const journal = snapshotJournalDataRecord(row.journal, [
      'source',
      'receipt',
      'low',
      'bootstrap',
      'primary',
      ...(row.journal !== null && typeof row.journal === 'object' && Object.hasOwn(row.journal, 'contentRevision')
        ? ['contentRevision']
        : [])
    ]),
    source = parseSnapshotJournalReceiptBindingData(journal.source),
    receipt = parseSnapshotJournalReceiptData(journal.receipt, source),
    contentRevision =
      journal.contentRevision === undefined ? undefined : parseSnapshotSyncContentRevision(journal.contentRevision),
    primary = snapshotJournalDataRecord(journal.primary, ['epoch', 'activeStorage']),
    low = snapshotJournalRevision(journal.low),
    epoch = snapshotJournalRevision(primary.epoch),
    storage = snapshotJournalDataRecord(row.sourceStorage, [
      'created_at',
      'updated_at',
      'storageIdentityKey',
      'storageName',
      'chain',
      'dbtype',
      'maxOutputScript'
    ]),
    user = snapshotJournalDataRecord(row.user, [
      'created_at',
      'updated_at',
      'userId',
      'identityKey',
      ...(row.user !== null && typeof row.user === 'object' && Object.hasOwn(row.user, 'activeStorage')
        ? ['activeStorage']
        : [])
    ])
  if (
    typeof journal.bootstrap !== 'boolean' ||
    (journal.bootstrap ? low !== '0' : compareSnapshotJournalRevisions(low, receipt.floor) < 0) ||
    compareSnapshotJournalRevisions(low, receipt.highWater) > 0 ||
    storage.storageIdentityKey !== source.storageIdentity ||
    storage.chain !== source.chain ||
    !isSnapshotArchiveChain(storage.chain) ||
    (storage.dbtype !== 'SQLite' && storage.dbtype !== 'MySQL') ||
    typeof storage.maxOutputScript !== 'number' ||
    !Number.isSafeInteger(storage.maxOutputScript) ||
    storage.maxOutputScript < 0 ||
    user.userId !== source.userId ||
    user.identityKey !== source.identityKey ||
    (user.activeStorage ?? null) !== primary.activeStorage
  )
    invalid()
  if (
    contentRevision !== undefined &&
    (contentRevision.binding !== receipt.binding ||
      contentRevision.highWater !== receipt.highWater ||
      contentRevision.floor !== receipt.floor)
  )
    invalid()
  const activeStorage = primary.activeStorage === null ? null : snapshotJournalDataText(primary.activeStorage, 256)
  return {
    version: 3,
    encoding: snapshotJournalArchiveEncoding,
    snapshotId: snapshotJournalDataDigest(row.snapshotId),
    sourceSchema: snapshotJournalDataText(row.sourceSchema, 256, 1),
    sourceStorage: {
      created_at: date(storage.created_at),
      updated_at: date(storage.updated_at),
      storageIdentityKey: snapshotJournalDataText(storage.storageIdentityKey, 130, 1),
      storageName: snapshotJournalDataText(storage.storageName, 4096),
      chain: storage.chain,
      dbtype: storage.dbtype,
      maxOutputScript: storage.maxOutputScript
    },
    user: {
      created_at: date(user.created_at),
      updated_at: date(user.updated_at),
      userId: source.userId,
      identityKey: source.identityKey,
      ...(user.activeStorage === undefined ? {} : { activeStorage })
    },
    journal: {
      source,
      receipt,
      low,
      bootstrap: journal.bootstrap,
      primary: Object.freeze({ epoch, activeStorage }),
      ...(contentRevision === undefined ? {} : { contentRevision })
    }
  }
}

/** Distinct ordered streams; never reinterpret fifteen streams as thirteen
 * complete BRC-38 tables or count identity prefixes as copied wallet rows. */
export const snapshotJournalArchiveStreams = Object.freeze([
  ...(
    [
      'transactions',
      'outputs',
      'certificates',
      'txLabels',
      'outputBaskets',
      'outputTags',
      'commissions',
      'syncStates',
      'provenTxs',
      'provenTxReqs',
      'txLabelMaps',
      'outputTagMaps',
      'certificateFields'
    ] as const
  ).map((table, tableId) => Object.freeze({ stream: 'scope' as const, tableId, table })),
  Object.freeze({ stream: 'physical' as const, tableId: 8, table: 'provenTxs' as const }),
  Object.freeze({ stream: 'physical' as const, tableId: 9, table: 'provenTxReqs' as const })
])

/** Distinct immutable field DATA binding. Its source/profile/receipt metadata
 * follows the existing exact journal contract; no SQL source actor is parsed. */
export interface SnapshotJournalFieldArchiveBinding extends Omit<
  SnapshotJournalArchiveBinding,
  'version' | 'encoding'
> {
  version: 4
  encoding: typeof snapshotJournalFieldArchiveEncoding
}
export interface SnapshotJournalFieldArchiveManifest extends Omit<SnapshotJournalArchiveManifest, 'binding'> {
  binding: SnapshotJournalFieldArchiveBinding
}
export function parseSnapshotJournalFieldArchiveBinding(input: unknown): SnapshotJournalFieldArchiveBinding {
  const row = snapshotJournalDataRecord(input, [
    'version',
    'encoding',
    'snapshotId',
    'sourceStorage',
    'sourceSchema',
    'user',
    'journal'
  ])
  if (row.version !== 4 || row.encoding !== snapshotJournalFieldArchiveEncoding) invalid()
  const common = parseSnapshotJournalArchiveBinding({ ...row, version: 3, encoding: snapshotJournalArchiveEncoding })
  return { ...common, version: 4, encoding: snapshotJournalFieldArchiveEncoding }
}
