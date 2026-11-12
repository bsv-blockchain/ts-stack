import type { Knex } from 'knex'
import type { StorageKnex } from '../StorageKnex'
import { WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'
import {
  SNAPSHOT_SYNC_CONTENT_RECEIPT_MIGRATION,
  SNAPSHOT_SYNC_CONTENT_RECEIPTS,
  verifySnapshotSyncContentReceiptSchema
} from '../schema/snapshotSyncReceiptMigration'
import {
  parseSnapshotSyncContentRevision,
  snapshotSyncContentPosition,
  snapshotSyncContentConfirms,
  snapshotSyncContentSourceKey,
  type SnapshotSyncContentRevision
} from './SnapshotSyncContentRevision'
import { snapshotSyncTables } from './SnapshotSync'
import { snapshotJournalRevision } from './journal/SnapshotJournalRevision'
import { snapshotJournalRevisionText } from './journal/SnapshotJournalRevisionSql'
import { readCurrentSnapshotJournalContentRevision } from './journal/SnapshotJournalCurrentContentRevision'
import { SnapshotResourceLimitError } from './SnapshotResourceLimitError'

/** Internal coordinates, never a transferable writer or authorization grant.
 * The destination invokes this helper only inside its original, locked writer. */
export interface SnapshotContentSession {
  userId: number
  identityKey: string
  sourceStorageIdentityKey: string
  sessionId: string
  snapshotId: string
  sequence: number
  tableIndex: number
  primaryEpoch: number
  activeStorage: string | null
}
interface Receipt {
  source: Readonly<SnapshotSyncContentRevision>
  destination?: Readonly<SnapshotSyncContentRevision>
  sessionId: string
  snapshotId: string
  primaryEpoch: string | null
  activeStorage: string | null
}
const fields = {
  sourceKey: 64,
  sourceStorageIdentityKey: 130,
  sessionId: 64,
  snapshotId: 64,
  sourceBinding: 64,
  sourceContent: 64,
  sourceMetadata: 64,
  sourceHighWater: 19,
  sourceFloor: 19,
  destinationBinding: 64,
  destinationContent: 64,
  destinationMetadata: 64,
  destinationHighWater: 19,
  destinationFloor: 19,
  primaryEpoch: 19,
  activeStorage: 130
} as const
function invalid(): never {
  throw new WERR_INVALID_OPERATION('Snapshot content receipt or current session changed')
}
function values(prefix: 'source' | 'destination', revision: SnapshotSyncContentRevision): Record<string, string> {
  return Object.fromEntries(
    ['binding', 'content', 'metadata', 'highWater', 'floor'].map(field => [
      prefix + field[0].toUpperCase() + field.slice(1),
      revision[field as keyof SnapshotSyncContentRevision] as string
    ])
  )
}
function revision(
  row: Record<string, unknown>,
  prefix: 'source' | 'destination'
): Readonly<SnapshotSyncContentRevision> {
  return parseSnapshotSyncContentRevision({
    version: 1,
    ...Object.fromEntries(
      ['binding', 'content', 'metadata', 'highWater', 'floor'].map(field => [
        field,
        row[prefix + field[0].toUpperCase() + field.slice(1)]
      ])
    )
  })
}
/** Auxiliary DATA store. It does not own a transaction, source view, session or
 * primary lease. The original destination still admits and commits every page. */
export class KnexSnapshotSyncContentReceipts {
  private readonly database: Knex
  constructor(private readonly storage: StorageKnex) {
    this.database = storage.knex
  }

  private current(k: Knex.Transaction): void {
    if (this.storage.knex !== this.database || !k.isTransaction || k.isCompleted()) invalid()
  }

  async supports(k: Knex = this.database): Promise<boolean> {
    if (this.storage.knex !== this.database) invalid()
    const table = this.database.client.config.migrations?.tableName ?? 'knex_migrations'
    if (!(await k.schema.hasTable(table))) return false
    if ((await k(table).where('name', SNAPSHOT_SYNC_CONTENT_RECEIPT_MIGRATION).select('name').limit(1)).length === 0)
      return false
    await verifySnapshotSyncContentReceiptSchema(k)
    if (this.storage.knex !== this.database) invalid()
    return true
  }

  private async session(k: Knex.Transaction, expected: SnapshotContentSession): Promise<void> {
    this.current(k)
    if (
      !Number.isSafeInteger(expected.userId) ||
      expected.userId < 1 ||
      !/^(02|03)[0-9a-fA-F]{64}$/.test(expected.identityKey) ||
      !/^[0-9a-f]{64}$/.test(expected.sessionId) ||
      !/^[0-9a-f]{64}$/.test(expected.snapshotId) ||
      !Number.isSafeInteger(expected.sequence) ||
      expected.sequence < 0 ||
      !Number.isSafeInteger(expected.tableIndex) ||
      expected.tableIndex < 0 ||
      expected.tableIndex > snapshotSyncTables.length ||
      !Number.isSafeInteger(expected.primaryEpoch) ||
      expected.primaryEpoch < 0
    )
      invalid()
    snapshotSyncContentSourceKey(expected.sourceStorageIdentityKey)
    if (expected.activeStorage !== null && expected.activeStorage !== '')
      snapshotSyncContentSourceKey(expected.activeStorage)
    const rows = await k('snapshot_sync_sessions')
      .where({ userId: expected.userId, sourceStorageIdentityKey: expected.sourceStorageIdentityKey })
      .select(
        'userId',
        'identityKey',
        'sourceStorageIdentityKey',
        'sessionId',
        'snapshotId',
        'sequence',
        'tableIndex',
        'primaryEpoch',
        'activeStorage'
      )
      .limit(2)
    if (
      rows.length !== 1 ||
      Object.keys(expected).some(
        key => Object.hasOwn(rows[0], key) && rows[0][key] !== expected[key as keyof SnapshotContentSession]
      )
    )
      invalid()
    const users = await k('users').where('userId', expected.userId).select('identityKey', 'activeStorage').limit(2)
    const epochs = await k('snapshot_sync_primary_epochs')
      .where('userId', expected.userId)
      .select({ epoch: snapshotJournalRevisionText(k, 'epoch') })
      .limit(2)
    if (
      users.length !== 1 ||
      users[0].identityKey !== expected.identityKey ||
      (users[0].activeStorage ?? null) !== expected.activeStorage ||
      epochs.length > 1 ||
      snapshotJournalRevision(epochs[0]?.epoch ?? '0') !== String(expected.primaryEpoch)
    )
      invalid()
    this.current(k)
  }

  private async read(k: Knex.Transaction, session: SnapshotContentSession): Promise<Receipt | undefined> {
    const sourceKey = snapshotSyncContentSourceKey(session.sourceStorageIdentityKey)
    const rows: Array<Record<string, unknown>> = await k(SNAPSHOT_SYNC_CONTENT_RECEIPTS)
      .where({ userId: session.userId, sourceKey })
      .select(
        'userId',
        'version',
        'complete',
        ...Object.entries(fields).map(([name, maximum]) => k.raw('substr(??,1,?) AS ??', [name, maximum + 1, name]))
      )
      .limit(2)
    if (rows.length === 0) return undefined
    const row = rows[0]
    if (
      rows.length !== 1 ||
      row.userId !== session.userId ||
      row.version !== 1 ||
      row.sourceKey !== sourceKey ||
      row.sourceStorageIdentityKey !== session.sourceStorageIdentityKey ||
      ![0, 1].includes(row.complete as number) ||
      Object.entries(fields).some(
        ([name, maximum]) => row[name] !== null && (typeof row[name] !== 'string' || row[name].length > maximum)
      ) ||
      !/^[0-9a-f]{64}$/.test(String(row.sessionId)) ||
      !/^[0-9a-f]{64}$/.test(String(row.snapshotId))
    )
      invalid()
    const complete = row.complete === 1
    const destinationFields = Object.keys(fields).filter(name => name.startsWith('destination'))
    if (
      destinationFields.some(name => (complete ? row[name] === null : row[name] !== null)) ||
      (!complete && (row.primaryEpoch !== null || row.activeStorage !== null)) ||
      (complete && row.primaryEpoch === null)
    )
      invalid()
    if (complete) snapshotJournalRevision(row.primaryEpoch)
    return {
      source: revision(row, 'source'),
      destination: complete ? revision(row, 'destination') : undefined,
      sessionId: row.sessionId as string,
      snapshotId: row.snapshotId as string,
      primaryEpoch: row.primaryEpoch as string | null,
      activeStorage: row.activeStorage as string | null
    }
  }

  /** Called with BEGIN's actual writer, after its original session upsert.
   * A past completed copy can never acquire a retroactive comparison stamp. */
  async stage(
    k: Knex.Transaction,
    inputSession: SnapshotContentSession,
    input: SnapshotSyncContentRevision,
    maximumSourceScopes?: number
  ): Promise<void> {
    const session = { ...inputSession },
      source = parseSnapshotSyncContentRevision(input)
    this.current(k)
    if (!(await this.supports(k))) throw new WERR_INVALID_OPERATION('Snapshot content receipts are not installed')
    await this.session(k, session)
    const old = await this.read(k, session)
    if (old?.sessionId === session.sessionId && old.snapshotId === session.snapshotId) {
      if (
        JSON.stringify(old.source) !==
        JSON.stringify(
          parseSnapshotSyncContentRevision({
            version: 1,
            binding: source.binding,
            content: source.content,
            metadata: source.metadata,
            highWater: source.highWater,
            floor: source.floor
          })
        )
      )
        invalid()
      return
    }
    if (session.tableIndex !== 0 || session.sequence !== 0) invalid()
    if (old === undefined && maximumSourceScopes !== undefined) {
      if (!Number.isSafeInteger(maximumSourceScopes) || maximumSourceScopes < 1 || maximumSourceScopes > 128) invalid()
      const retained = await k(SNAPSHOT_SYNC_CONTENT_RECEIPTS)
        .where('userId', session.userId)
        .select('sourceKey')
        .limit(maximumSourceScopes)
      if (retained.length >= maximumSourceScopes)
        throw new SnapshotResourceLimitError('Snapshot content receipt source-scope quota reached')
    }
    const row = {
      userId: session.userId,
      sourceKey: snapshotSyncContentSourceKey(session.sourceStorageIdentityKey),
      sourceStorageIdentityKey: session.sourceStorageIdentityKey,
      version: 1,
      sessionId: session.sessionId,
      snapshotId: session.snapshotId,
      ...values('source', source),
      destinationBinding: null,
      destinationContent: null,
      destinationMetadata: null,
      destinationHighWater: null,
      destinationFloor: null,
      primaryEpoch: null,
      activeStorage: null,
      complete: 0
    }
    await k(SNAPSHOT_SYNC_CONTENT_RECEIPTS).insert(row).onConflict(['userId', 'sourceKey']).merge(row)
    this.current(k)
  }

  /** Previous completed DATA offered for a fresh source observation. This is
   * not a current destination verdict; confirm repeats its writer checks. */
  async previous(
    k: Knex.Transaction,
    inputSession: SnapshotContentSession
  ): Promise<Readonly<SnapshotSyncContentRevision> | undefined> {
    const session = { ...inputSession }
    this.current(k)
    if (session.tableIndex !== snapshotSyncTables.length || !(await this.supports(k))) return undefined
    await this.session(k, session)
    const old = await this.read(k, session)
    if (
      old?.destination === undefined ||
      old.sessionId !== session.sessionId ||
      old.snapshotId !== session.snapshotId ||
      old.primaryEpoch !== String(session.primaryEpoch) ||
      old.activeStorage !== session.activeStorage
    )
      return undefined
    return old.source
  }

  /** Prepare before the final data effects; consume after that SAME writer
   * advances the original session. Closing/committing the transaction or using
   * the closure twice refuses. A later transaction cannot stamp a past ACK. */
  async prepareCompletion(
    k: Knex.Transaction,
    input: SnapshotContentSession
  ): Promise<((completed: SnapshotContentSession) => Promise<void>) | undefined> {
    const before = { ...input }
    this.current(k)
    if (before.tableIndex !== snapshotSyncTables.length - 1 || !(await this.supports(k))) return undefined
    await this.session(k, before)
    const pending = await this.read(k, before)
    if (pending === undefined || pending.sessionId !== before.sessionId || pending.snapshotId !== before.snapshotId)
      return undefined
    if (pending.destination !== undefined) invalid()
    let consumed = false
    return async inputCompleted => {
      const completed = { ...inputCompleted }
      if (consumed) invalid()
      consumed = true
      this.current(k)
      if (
        completed.sessionId !== before.sessionId ||
        completed.snapshotId !== before.snapshotId ||
        completed.userId !== before.userId ||
        completed.identityKey !== before.identityKey ||
        completed.sourceStorageIdentityKey !== before.sourceStorageIdentityKey ||
        completed.sequence !== before.sequence + 1 ||
        completed.tableIndex !== snapshotSyncTables.length
      )
        invalid()
      await this.session(k, completed)
      await verifySnapshotSyncContentReceiptSchema(k)
      const destination = await readCurrentSnapshotJournalContentRevision(this.storage, k, before.identityKey)
      if (destination === undefined) return
      const changed = await k(SNAPSHOT_SYNC_CONTENT_RECEIPTS)
        .where({
          userId: before.userId,
          sourceKey: snapshotSyncContentSourceKey(before.sourceStorageIdentityKey),
          sessionId: before.sessionId,
          snapshotId: before.snapshotId,
          complete: 0
        })
        .update({
          ...values('destination', destination),
          primaryEpoch: String(completed.primaryEpoch),
          activeStorage: completed.activeStorage,
          complete: 1
        })
      if (changed !== 1) invalid()
      this.current(k)
    }
  }

  /** Both current observations must confirm the previous durable copy; data
   * positions alone never authorize its user/session/primary or physical root. */
  async confirm(
    k: Knex.Transaction,
    inputSession: SnapshotContentSession,
    input: SnapshotSyncContentRevision
  ): Promise<boolean> {
    const session = { ...inputSession },
      source = parseSnapshotSyncContentRevision(input)
    this.current(k)
    if (session.tableIndex !== snapshotSyncTables.length || !(await this.supports(k))) return false
    await this.session(k, session)
    const old = await this.read(k, session)
    if (
      old?.destination === undefined ||
      old.sessionId !== session.sessionId ||
      old.snapshotId !== session.snapshotId ||
      old.primaryEpoch !== String(session.primaryEpoch) ||
      old.activeStorage !== session.activeStorage ||
      !snapshotSyncContentConfirms(old.source, source)
    )
      return false
    const destination = await readCurrentSnapshotJournalContentRevision(
      this.storage,
      k,
      session.identityKey,
      snapshotSyncContentPosition(old.destination)
    )
    if (destination === undefined || !snapshotSyncContentConfirms(old.destination, destination)) return false
    const changed = await k(SNAPSHOT_SYNC_CONTENT_RECEIPTS)
      .where({
        userId: session.userId,
        sourceKey: snapshotSyncContentSourceKey(session.sourceStorageIdentityKey),
        sessionId: session.sessionId,
        snapshotId: session.snapshotId,
        complete: 1
      })
      .update({ ...values('source', source), ...values('destination', destination) })
    if (changed !== 1) invalid()
    this.current(k)
    return true
  }
}
