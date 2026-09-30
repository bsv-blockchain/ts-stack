import { createHash } from 'node:crypto'
import { Beef, Transaction } from '@bsv/sdk'
import type { StorageCreateActionResult, TrxToken } from '../../sdk/WalletStorage.interfaces'
import { WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'
import { StorageKnex } from '../StorageKnex'
import {
  ACTION_RECOVERY_RECORD_BYTES,
  actionRecoveryJSON,
  decodeActionRecoveryPlan,
  decodeActionRecoveryResult,
  encodeActionRecoveryBytes,
  encodeActionRecoveryPlan,
  encodeActionRecoveryResult
} from './ActionRecoveryCodec'
import type { ActionRecoveryConstruction, ActionRecoveryPlan, RetainedActionRecoveryPlan } from './ActionRecoveryPlan'

const recordsTable = 'wallet_action_recovery_v1'
const metadataTable = 'wallet_action_recovery_metadata_v1'
const defaults = Object.freeze({ records: 4096, bytes: 64 * 1024 * 1024 })

export interface ActionRecoveryBinding {
  userId: number
  walletIdentity: string
  storageIdentity: string
  chain: string
  originator: string
  operationId: string
  /** Owned canonical create-action request, retained before any allocation. */
  requestJSON: string
}

interface Metadata {
  id: number
  version: number
  maximumRecords: number
  maximumBytes: number
  usedRecords: number
  usedBytes: number
  guard: number
}

interface Row {
  operationKey: string
  binding: string
  plan: string | null
  completed: string | null
  preparedBeef: string | null
  finalRequestDigest: string | null
  finalBeef: string | null
  processed: number
  byteLength: number
}

function requireStore(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new WERR_INVALID_OPERATION(reason)
}

/**
 * Explicit auxiliary local SQLite state in the SAME database as wallet funding.
 * Install while opening the local wallet; it is not replicated or exported by
 * legacy wallet backup/sync. Recovery requires this database and the wallet keys.
 */
export class SQLiteActionRecoveryStore {
  private constructor(readonly storage: StorageKnex) {}

  static async open(storage: StorageKnex): Promise<SQLiteActionRecoveryStore> {
    requireStore(storage.getSettings().dbtype === 'SQLite', 'Action recovery requires local SQLite storage')
    const store = new SQLiteActionRecoveryStore(storage)
    await storage.transaction(async trx => {
      const metadata = await store.metadata(trx)
      const totals = await storage.toDb(trx)(recordsTable).count({ records: '*' }).sum({ bytes: 'byteLength' }).first()
      requireStore(Number(totals?.records) === metadata.usedRecords && Number(totals?.bytes ?? 0) === metadata.usedBytes, 'Action recovery accounting does not match retained records')
    })
    return store
  }

  static async install(
    storage: StorageKnex,
    limits: { records: number; bytes: number } = defaults
  ): Promise<SQLiteActionRecoveryStore> {
    limits = { records: limits.records, bytes: limits.bytes }
    requireStore(storage.getSettings().dbtype === 'SQLite', 'Action recovery requires local SQLite storage')
    requireStore(
      Number.isSafeInteger(limits.records) && limits.records > 0 && limits.records <= defaults.records &&
      Number.isSafeInteger(limits.bytes) && limits.bytes > 0 && limits.bytes <= defaults.bytes,
      'Invalid action recovery capacity'
    )
    await storage.transaction(async trx => {
      const db = storage.toDb(trx)
      const hasMetadata = await db.schema.hasTable(metadataTable), hasRecords = await db.schema.hasTable(recordsTable)
      requireStore(hasMetadata === hasRecords, 'Incomplete action recovery schema')
      if (!hasMetadata) {
        await db.schema.createTable(metadataTable, table => {
          table.integer('id').primary()
          for (const name of ['version', 'maximumRecords', 'maximumBytes', 'usedRecords', 'usedBytes', 'guard']) table.integer(name).notNullable()
        })
        await db.schema.createTable(recordsTable, table => {
          table.string('operationKey', 64).primary()
          table.text('binding').notNullable()
          for (const name of ['plan', 'completed', 'preparedBeef', 'finalRequestDigest', 'finalBeef']) table.text(name).nullable()
          table.integer('processed').notNullable()
          table.integer('byteLength').notNullable()
        })
        await db(metadataTable).insert({ id: 1, version: 1, maximumRecords: limits.records, maximumBytes: limits.bytes, usedRecords: 0, usedBytes: 0, guard: 0 })
      }
      const metadata = await new SQLiteActionRecoveryStore(storage).metadata(trx)
      requireStore(metadata.maximumRecords === limits.records && metadata.maximumBytes === limits.bytes, 'Action recovery capacity differs from installed configuration')
    })
    return await SQLiteActionRecoveryStore.open(storage)
  }

  async operation(binding: ActionRecoveryBinding): Promise<SQLiteActionRecoveryOperation> {
    binding = JSON.parse(actionRecoveryJSON(binding)) as ActionRecoveryBinding
    requireStore(Object.keys(binding).length === 7 && ['userId', 'walletIdentity', 'storageIdentity', 'chain', 'originator', 'operationId', 'requestJSON'].every(key => Object.hasOwn(binding, key)), 'Invalid action recovery binding')
    const settings = this.storage.getSettings()
    requireStore(binding.storageIdentity === settings.storageIdentityKey && binding.chain === settings.chain, 'Action recovery storage binding mismatch')
    requireStore(Number.isSafeInteger(binding.userId) && binding.userId > 0, 'Invalid action recovery user')
    requireStore(typeof binding.operationId === 'string' && /^[a-zA-Z0-9._-]{1,128}$/.test(binding.operationId), 'Invalid action recovery operation ID')
    requireStore(typeof binding.originator === 'string' && binding.originator.length > 0 && binding.originator.length <= 250, 'Invalid action recovery originator')
    const users = await this.storage.findUsers({ partial: { userId: binding.userId, identityKey: binding.walletIdentity } })
    requireStore(users.length === 1, 'Action recovery wallet binding mismatch')
    requireStore(actionRecoveryJSON(JSON.parse(binding.requestJSON)) === binding.requestJSON, 'Noncanonical action recovery request')
    const owned = actionRecoveryJSON(binding)
    const { requestJSON: _request, ...identity } = binding
    const key = createHash('sha256').update(actionRecoveryJSON(identity)).digest('hex')
    return new SQLiteActionRecoveryOperation(this, key, owned)
  }

  async metadata(trx?: TrxToken): Promise<Metadata> {
    const row: Metadata | undefined = await this.storage.toDb(trx)(metadataTable).where({ id: 1 }).first()
    requireStore(row?.version === 1, 'Missing or incompatible action recovery store')
    for (const value of Object.values(row)) requireStore(Number.isSafeInteger(value) && value >= 0, 'Corrupt action recovery accounting')
    requireStore(row.maximumRecords > 0 && row.maximumRecords <= defaults.records && row.maximumBytes > 0 && row.maximumBytes <= defaults.bytes && row.usedRecords <= row.maximumRecords && row.usedBytes <= row.maximumBytes, 'Corrupt action recovery capacity')
    return row
  }

  async lock(trx: TrxToken): Promise<Metadata> {
    const db = this.transaction(trx)
    const updated = await db(metadataTable).where({ id: 1 }).where('guard', '<', Number.MAX_SAFE_INTEGER).increment('guard', 1)
    requireStore(updated === 1, 'Action recovery store unavailable')
    return await this.metadata(trx)
  }

  async read(key: string, binding: string, trx?: TrxToken): Promise<Row | undefined> {
    const row: Row | undefined = await this.storage.toDb(trx)(recordsTable).where({ operationKey: key }).first()
    if (row != null) {
      validateRow(row)
      requireStore(row.binding === binding && row.byteLength === rowBytes(row), 'Action recovery operation conflicts with retained request')
    }
    return row
  }

  async insert(row: Row, trx: TrxToken): Promise<void> {
    const metadata = await this.metadata(trx)
    requireStore(metadata.usedRecords < metadata.maximumRecords, 'Action recovery record capacity exhausted')
    requireStore(metadata.usedBytes + row.byteLength <= metadata.maximumBytes, 'Action recovery byte capacity exhausted')
    const db = this.transaction(trx)
    await db(recordsTable).insert(row)
    await db(metadataTable).where({ id: 1 }).update({ usedRecords: metadata.usedRecords + 1, usedBytes: metadata.usedBytes + row.byteLength })
  }

  async replace(previous: Row, next: Row, trx: TrxToken): Promise<void> {
    next.byteLength = rowBytes(next)
    const metadata = await this.metadata(trx)
    const bytes = metadata.usedBytes - previous.byteLength + next.byteLength
    requireStore(bytes >= 0 && bytes <= metadata.maximumBytes, 'Action recovery byte capacity exhausted')
    const db = this.transaction(trx)
    requireStore(await db(recordsTable).where({ operationKey: previous.operationKey, binding: previous.binding }).update(next) === 1, 'Action recovery record disappeared')
    await db(metadataTable).where({ id: 1 }).update({ usedBytes: bytes })
  }

  private transaction(trx: TrxToken) {
    const db = this.storage.toDb(trx)
    requireStore(db.isTransaction === true, 'Action recovery requires an active allocation transaction')
    requireStore(db.client.config.connection.filename === this.storage.knex.client.config.connection.filename, 'Action recovery transaction belongs to another database')
    return db
  }
}

function validateRow(row: Row): void {
  requireStore(typeof row.operationKey === 'string' && /^[0-9a-f]{64}$/.test(row.operationKey) && typeof row.binding === 'string', 'Corrupt action recovery identity')
  for (const field of ['plan', 'completed', 'preparedBeef', 'finalRequestDigest', 'finalBeef'] as const)
    requireStore(row[field] === null || typeof row[field] === 'string', 'Corrupt action recovery record')
  requireStore(Number.isSafeInteger(row.byteLength) && row.byteLength > 0 && (row.processed === 0 || row.processed === 1), 'Corrupt action recovery accounting')
  requireStore(row.completed === null || row.plan !== null, 'Incomplete action recovery allocation')
  requireStore(row.preparedBeef === null || row.completed !== null, 'Incomplete action recovery preparation')
  requireStore((row.finalBeef === null) === (row.finalRequestDigest === null), 'Incomplete action recovery finalization')
  requireStore(row.finalBeef === null || row.preparedBeef !== null, 'Incomplete action recovery finalization')
  requireStore(row.finalRequestDigest === null || /^[0-9a-f]{64}$/.test(row.finalRequestDigest), 'Corrupt action recovery signing digest')
  requireStore(row.processed === 0 || row.finalBeef !== null, 'Incomplete action recovery processing')
}

function rowBytes(row: Row): number {
  const bytes = [row.binding, row.plan, row.completed, row.preparedBeef, row.finalRequestDigest, row.finalBeef]
    .reduce<number>((total, value) => total + (value === null ? 0 : Buffer.byteLength(value, 'utf8')), 0)
  requireStore(bytes <= ACTION_RECOVERY_RECORD_BYTES, 'Action recovery record is too large')
  return bytes
}

function retained(row: Row): RetainedActionRecoveryPlan {
  requireStore(row.plan !== null, 'Action recovery allocation is incomplete')
  return { plan: decodeActionRecoveryPlan(row.plan), ...(row.completed === null ? {} : { completed: decodeActionRecoveryResult(row.completed) }) }
}

export class SQLiteActionRecoveryOperation implements ActionRecoveryConstruction {
  readonly protocol = 'wallet-action-recovery-v1' as const

  constructor(private readonly store: SQLiteActionRecoveryStore, private readonly key: string, private readonly binding: string) {}

  async read(): Promise<RetainedActionRecoveryPlan | undefined> {
    const row = await this.store.read(this.key, this.binding)
    return row === undefined ? undefined : retained(row)
  }

  async claim(trx: TrxToken): Promise<RetainedActionRecoveryPlan | undefined> {
    await this.store.lock(trx)
    const existing = await this.store.read(this.key, this.binding, trx)
    if (existing !== undefined) return retained(existing)
    const row: Row = { operationKey: this.key, binding: this.binding, plan: null, completed: null, preparedBeef: null, finalRequestDigest: null, finalBeef: null, processed: 0, byteLength: 0 }
    row.byteLength = rowBytes(row)
    await this.store.insert(row, trx)
    return undefined
  }

  async retain(plan: ActionRecoveryPlan, trx: TrxToken): Promise<void> {
    const row = await this.store.read(this.key, this.binding, trx)
    requireStore(row?.plan === null, 'Action recovery allocation is not newly claimed')
    await this.store.replace(row, { ...row, plan: encodeActionRecoveryPlan(plan) }, trx)
  }

  async complete(result: StorageCreateActionResult): Promise<StorageCreateActionResult> {
    const encoded = encodeActionRecoveryResult(result)
    return await this.store.storage.transaction(async trx => {
      await this.store.lock(trx)
      const row = await this.store.read(this.key, this.binding, trx)
      requireStore(row != null, 'Action recovery allocation is absent')
      const stored = retained(row)
      const withoutEvidence = (value: StorageCreateActionResult) => encodeActionRecoveryResult({ ...value, inputBeef: stored.plan.result.inputBeef })
      requireStore(withoutEvidence(result) === withoutEvidence(stored.plan.result), 'Action recovery completion changed funding plan')
      if (stored.completed !== undefined) return stored.completed
      await this.store.replace(row, { ...row, completed: encoded }, trx)
      return decodeActionRecoveryResult(encoded)
    })
  }

  async signingState(): Promise<ActionRecoverySigningState> {
    const row = await this.store.read(this.key, this.binding)
    requireStore(row != null && row.completed !== null, 'Action recovery funding is not complete')
    return {
      ...(row.preparedBeef === null ? {} : { prepared: decodeAtomic(row.preparedBeef) }),
      ...(row.finalBeef === null ? {} : { final: { digest: row.finalRequestDigest!, beef: decodeAtomic(row.finalBeef) } }),
      processed: row.processed === 1
    }
  }

  async retainPrepared(bytes: number[]): Promise<number[]> {
    const encoded = encodeAtomic(bytes)
    return await this.store.storage.transaction(async trx => {
      await this.store.lock(trx)
      const row = await this.store.read(this.key, this.binding, trx)
      requireStore(row != null && row.completed !== null, 'Action recovery funding is not complete')
      if (row.preparedBeef !== null) {
        requireStore(Transaction.fromAtomicBEEF(decodeAtomic(row.preparedBeef)).toHex() === Transaction.fromAtomicBEEF(bytes).toHex(), 'Recovered signable transaction changed')
        return decodeAtomic(row.preparedBeef)
      }
      await this.store.replace(row, { ...row, preparedBeef: encoded }, trx)
      return decodeAtomic(encoded)
    })
  }

  async retainFinal(digest: string, bytes: number[]): Promise<number[]> {
    requireStore(/^[0-9a-f]{64}$/.test(digest), 'Invalid action recovery signing digest')
    const encoded = encodeAtomic(bytes)
    return await this.store.storage.transaction(async trx => {
      await this.store.lock(trx)
      const row = await this.store.read(this.key, this.binding, trx)
      requireStore(row != null && row.preparedBeef !== null, 'Action recovery signable transaction is absent')
      requireStore(sameRecoveryLayout(Transaction.fromAtomicBEEF(decodeAtomic(row.preparedBeef)), Transaction.fromAtomicBEEF(bytes)), 'Final action changed funded layout')
      if (row.finalBeef !== null) {
        requireStore(row.finalRequestDigest === digest, 'Action recovery signing request conflicts')
        return decodeAtomic(row.finalBeef)
      }
      await this.store.replace(row, { ...row, finalRequestDigest: digest, finalBeef: encoded }, trx)
      return decodeAtomic(encoded)
    })
  }

  async markProcessed(digest: string): Promise<void> {
    await this.store.storage.transaction(async trx => {
      await this.store.lock(trx)
      const row = await this.store.read(this.key, this.binding, trx)
      requireStore(row != null && row.finalBeef !== null && row.finalRequestDigest === digest, 'Action recovery final transaction is absent')
      await this.store.replace(row, { ...row, processed: 1 }, trx)
    })
  }
}

export interface ActionRecoverySigningState {
  prepared?: number[]
  final?: { digest: string; beef: number[] }
  processed: boolean
}

function encodeAtomic(bytes: number[]): string {
  requireStore(Array.isArray(bytes), 'Invalid action recovery transaction bytes')
  const encoded = encodeActionRecoveryBytes(bytes)
  decodeAtomic(encoded)
  return encoded
}

function decodeAtomic(encoded: string): number[] {
  requireStore(typeof encoded === 'string' && encoded.length <= ACTION_RECOVERY_RECORD_BYTES, 'Oversized action recovery transaction')
  const bytes = Buffer.from(encoded, 'base64')
  requireStore(bytes.toString('base64') === encoded, 'Invalid action recovery transaction encoding')
  const beef = Beef.fromBinaryStrict(bytes)
  requireStore(beef.atomicTxid !== undefined && beef.findTxid(beef.atomicTxid)?.tx !== undefined, 'Action recovery requires exact atomic target bytes')
  return Array.from(bytes)
}

/** Only unlocking scripts may differ after the funded layout is retained. */
export function sameRecoveryLayout(before: Transaction, after: Transaction): boolean {
  return before.version === after.version && before.lockTime === after.lockTime &&
    before.inputs.length === after.inputs.length && before.outputs.length === after.outputs.length &&
    before.inputs.every((input, index) => input.sourceTXID === after.inputs[index].sourceTXID && input.sourceOutputIndex === after.inputs[index].sourceOutputIndex && input.sequence === after.inputs[index].sequence) &&
    before.outputs.every((output, index) => output.satoshis === after.outputs[index].satoshis && output.lockingScript.toHex() === after.outputs[index].lockingScript.toHex())
}
