import { ListActionsResult, ListOutputsResult, Validation } from '@bsv/sdk'
import {
  outputColumnsWithoutLockingScript,
  TableCertificate,
  TableCertificateField,
  TableCertificateX,
  TableCommission,
  TableMonitorEvent,
  TableOutput,
  TableOutputBasket,
  TableOutputTag,
  TableOutputTagMap,
  TableProvenTx,
  TableProvenTxReq,
  TableSettings,
  TableSyncState,
  TableTransaction,
  TableTxLabel,
  TableTxLabelMap,
  TableUser,
  transactionColumnsWithoutRawTx
} from './schema/tables'
import { SqliteMigrations } from './schema/SqliteMigrations'
import { StorageAdminStats, StorageProvider, StorageProviderOptions } from './StorageProvider'
import { DBType } from './StorageReader'
import {
  AuthId,
  FindCertificateFieldsArgs,
  FindCertificatesArgs,
  FindCommissionsArgs,
  FindForUserSincePagedArgs,
  FindMonitorEventsArgs,
  FindOutputBasketsArgs,
  FindOutputsArgs,
  FindOutputTagMapsArgs,
  FindOutputTagsArgs,
  FindPartialSincePagedArgs,
  FindProvenTxReqsArgs,
  FindProvenTxsArgs,
  FindSyncStatesArgs,
  FindTransactionsArgs,
  FindTxLabelMapsArgs,
  FindTxLabelsArgs,
  FindUsersArgs,
  ProvenOrRawTx,
  PurgeParams,
  PurgeResults,
  TrxToken,
  WalletStorageProvider
} from '../sdk/WalletStorage.interfaces'
import { WERR_INTERNAL, WERR_INVALID_PARAMETER, WERR_UNAUTHORIZED } from '../sdk/WERR_errors'
import { verifyOne, verifyOneOrNone, verifyTruthy } from '../utility/utilityHelpers'
import { EntityTimeStamp, TransactionStatus } from '../sdk/types'

// wa-sqlite imports - async build for IDBBatchAtomicVFS
import SQLiteESMFactory from 'wa-sqlite/dist/wa-sqlite-async.mjs'
import * as SQLite from 'wa-sqlite'
import { IDBBatchAtomicVFS } from 'wa-sqlite/src/examples/IDBBatchAtomicVFS.js'

// wa-sqlite declares these as ambient types, not module exports.
// Define locally to avoid build issues across different tsconfig setups.
type SqliteParam = number | string | Uint8Array | Array<number> | bigint | null

export interface StorageSqliteOptions extends StorageProviderOptions {
  /** Database name used for IDB-backed VFS storage. Defaults to `wallet-toolbox-{chain}net`. */
  dbName?: string
  /** If true, uses :memory: database (no IDB VFS). Useful for testing. */
  inMemory?: boolean
}

interface SqliteTrxToken {
  _sqliteTrx: true
  depth: number
}

function isSqliteTrx(trx: TrxToken | undefined): trx is SqliteTrxToken {
  return !!trx && typeof trx === 'object' && (trx as SqliteTrxToken)._sqliteTrx === true
}

export class StorageSqlite extends StorageProvider implements WalletStorageProvider {
  dbName: string
  inMemory: boolean

  private sqlite3?: any
  private db?: number

  constructor(options: StorageSqliteOptions) {
    super(options)
    this.dbName = options.dbName || `wallet-toolbox-${this.chain}net`
    this.inMemory = options.inMemory || false
  }

  // ─── Low-level SQL helpers ───────────────────────────────────────────

  ensureDb(): { sqlite3: any; db: number } {
    if (!this.sqlite3 || this.db === undefined) throw new WERR_INTERNAL('Database not initialized. Call migrate() first.')
    return { sqlite3: this.sqlite3, db: this.db }
  }

  /** Execute a statement that returns no rows (DDL, DML without results). */
  async exec(sql: string, params?: SqliteParam[]): Promise<void> {
    const { sqlite3, db } = this.ensureDb()
    if (params && params.length > 0) {
      await sqlite3.run(db, sql, params)
    } else {
      await sqlite3.exec(db, sql)
    }
    this.whenLastAccess = new Date()
  }

  /** Execute a query and return all result rows as objects. */
  async getAll<T = Record<string, unknown>>(
    sql: string,
    params?: SqliteParam[]
  ): Promise<T[]> {
    const { sqlite3, db } = this.ensureDb()
    const result = await sqlite3.execWithParams(db, sql, params || [])
    if (!result || !result.rows || result.rows.length === 0) return []
    const columns = result.columns
    return result.rows.map(row => {
      const obj: Record<string, unknown> = {}
      for (let i = 0; i < columns.length; i++) {
        obj[columns[i]] = row[i]
      }
      return obj as T
    })
  }

  /** Execute a query and return exactly one row as object, or undefined. */
  async getOne<T = Record<string, unknown>>(
    sql: string,
    params?: SqliteParam[]
  ): Promise<T | undefined> {
    const rows = await this.getAll<T>(sql, params)
    return rows.length > 0 ? rows[0] : undefined
  }

  /** Get the last inserted rowid. */
  lastInsertRowId(): number {
    const { sqlite3, db } = this.ensureDb()
    return Number(sqlite3.lastInsertRowId(db))
  }

  /** Get the number of rows changed by the last DML statement. */
  changes(): number {
    const { sqlite3, db } = this.ensureDb()
    return sqlite3.changes(db)
  }

  // ─── Initialization & Lifecycle ──────────────────────────────────────

  private async initDb(): Promise<void> {
    const module = await SQLiteESMFactory()
    this.sqlite3 = SQLite.Factory(module)

    if (!this.inMemory) {
      const vfs = new IDBBatchAtomicVFS(this.dbName)
      this.sqlite3.vfs_register(vfs, true)
    }

    const flags = SQLite.SQLITE_OPEN_CREATE | SQLite.SQLITE_OPEN_READWRITE
    const filename = this.inMemory ? ':memory:' : this.dbName
    this.db = await this.sqlite3.open_v2(filename, flags, this.inMemory ? undefined : this.dbName)

    await this.exec('PRAGMA journal_mode=WAL')
    await this.exec('PRAGMA foreign_keys=ON')
  }

  async migrate(storageName: string, storageIdentityKey: string): Promise<string> {
    if (!this.sqlite3 || this.db === undefined) {
      await this.initDb()
    }
    const migrations = new SqliteMigrations(this.chain, storageName, storageIdentityKey, 1024)

    for (const stmt of migrations.getCreateTableStatements()) {
      await this.exec(stmt)
    }
    for (const stmt of migrations.getCreateIndexStatements()) {
      await this.exec(stmt)
    }

    const existing = await this.getOne<{ storageIdentityKey: string }>('SELECT storageIdentityKey FROM settings LIMIT 1')
    if (!existing) {
      const insert = migrations.getInsertSettingsStatement()
      await this.exec(insert.sql, insert.params)
    }

    this._settings = await this.readSettingsInternal()
    this.whenLastAccess = new Date()
    return '1'
  }

  async destroy(): Promise<void> {
    if (this.sqlite3 && this.db !== undefined) {
      await this.sqlite3.close(this.db)
      this.db = undefined
    }
  }

  async dropAllData(): Promise<void> {
    const migrations = new SqliteMigrations('test', '', '', 1024)
    for (const stmt of migrations.getDropTableStatements()) {
      await this.exec(stmt)
    }
    this._settings = undefined
  }

  // ─── Settings ────────────────────────────────────────────────────────

  private async readSettingsInternal(): Promise<TableSettings> {
    const row = verifyOne(await this.getAll<any>('SELECT * FROM settings'))
    return this.validateEntity(row)
  }

  async readSettings(): Promise<TableSettings> {
    return this.readSettingsInternal()
  }

  // ─── Transactions (SQL) ──────────────────────────────────────────────

  async transaction<T>(scope: (trx: TrxToken) => Promise<T>, trx?: TrxToken): Promise<T> {
    if (isSqliteTrx(trx)) {
      const nested: SqliteTrxToken = { _sqliteTrx: true, depth: trx.depth + 1 }
      const sp = `sp_${nested.depth}`
      await this.exec(`SAVEPOINT ${sp}`)
      try {
        const result = await scope(nested as unknown as TrxToken)
        await this.exec(`RELEASE ${sp}`)
        return result
      } catch (e) {
        await this.exec(`ROLLBACK TO ${sp}`)
        throw e
      }
    }

    const token: SqliteTrxToken = { _sqliteTrx: true, depth: 0 }
    await this.exec('BEGIN IMMEDIATE')
    try {
      const result = await scope(token as unknown as TrxToken)
      await this.exec('COMMIT')
      return result
    } catch (e) {
      await this.exec('ROLLBACK')
      throw e
    }
  }

  // ─── Database Access Verification ────────────────────────────────────

  _verifiedReadyForDatabaseAccess: boolean = false

  async verifyReadyForDatabaseAccess(trx?: TrxToken): Promise<DBType> {
    if (!this._settings) {
      this._settings = await this.readSettings()
    }
    if (!this._verifiedReadyForDatabaseAccess) {
      await this.exec('PRAGMA foreign_keys = ON')
      this._verifiedReadyForDatabaseAccess = true
    }
    return this._settings.dbtype
  }

  // ─── Validate Helpers (Uint8Array for browser, like StorageIdb) ──────

  validateEntity<T extends EntityTimeStamp>(entity: T, dateFields?: string[], booleanFields?: string[]): T {
    entity.created_at = this.validateDate(entity.created_at)
    entity.updated_at = this.validateDate(entity.updated_at)
    if (dateFields) {
      for (const df of dateFields) {
        if (entity[df]) entity[df] = this.validateDate(entity[df])
      }
    }
    if (booleanFields) {
      for (const df of booleanFields) {
        if (entity[df] !== undefined) entity[df] = !!entity[df]
      }
    }
    for (const key of Object.keys(entity)) {
      const val = entity[key]
      if (val === null) {
        entity[key] = undefined
      } else if (val instanceof Uint8Array) {
        entity[key] = Array.from(val)
      }
    }
    return entity
  }

  validateEntities<T extends EntityTimeStamp>(entities: T[], dateFields?: string[], booleanFields?: string[]): T[] {
    for (let i = 0; i < entities.length; i++) {
      entities[i] = this.validateEntity(entities[i], dateFields, booleanFields)
    }
    return entities
  }

  validatePartialForUpdate<T extends EntityTimeStamp>(
    update: Partial<T>,
    dateFields?: string[],
    booleanFields?: string[]
  ): Partial<T> {
    if (!this.dbtype) throw new WERR_INTERNAL('must call verifyReadyForDatabaseAccess first')
    const v: any = { ...update }
    if (v.created_at) v.created_at = this.validateEntityDate(v.created_at)
    if (v.updated_at) v.updated_at = this.validateEntityDate(v.updated_at)
    if (!v.created_at) delete v.created_at
    if (!v.updated_at) v.updated_at = this.validateEntityDate(new Date())
    if (dateFields) {
      for (const df of dateFields) {
        if (v[df]) v[df] = this.validateOptionalEntityDate(v[df])
      }
    }
    if (booleanFields) {
      for (const df of booleanFields) {
        if (update[df] !== undefined) update[df] = !!update[df] ? 1 : 0
      }
    }
    for (const key of Object.keys(v)) {
      const val = v[key]
      if (Array.isArray(val) && (val.length === 0 || typeof val[0] === 'number')) {
        v[key] = Uint8Array.from(val)
      } else if (val === undefined) {
        v[key] = null
      }
    }
    this.isDirty = true
    return v
  }

  async validateEntityForInsert<T extends EntityTimeStamp>(
    entity: T,
    trx?: TrxToken,
    dateFields?: string[],
    booleanFields?: string[]
  ): Promise<any> {
    await this.verifyReadyForDatabaseAccess(trx)
    const v: any = { ...entity }
    v.created_at = this.validateOptionalEntityDate(v.created_at, true)!
    v.updated_at = this.validateOptionalEntityDate(v.updated_at, true)!
    if (!v.created_at) delete v.created_at
    if (!v.updated_at) delete v.updated_at
    if (dateFields) {
      for (const df of dateFields) {
        if (v[df]) v[df] = this.validateOptionalEntityDate(v[df])
      }
    }
    if (booleanFields) {
      for (const df of booleanFields) {
        if (entity[df] !== undefined) entity[df] = !!entity[df] ? 1 : 0
      }
    }
    for (const key of Object.keys(v)) {
      const val = v[key]
      if (Array.isArray(val) && (val.length === 0 || typeof val[0] === 'number')) {
        v[key] = Uint8Array.from(val)
      } else if (val === undefined) {
        v[key] = null
      }
    }
    this.isDirty = true
    return v
  }

  async validateRawTransaction(t: TableTransaction, trx?: TrxToken): Promise<void> {
    if (t.rawTx || !t.txid) return
    const rawTx = await this.getRawTxOfKnownValidTransaction(t.txid, undefined, undefined, trx)
    if (!rawTx) return
    t.rawTx = rawTx
  }

  // ─── Query Building Helpers ──────────────────────────────────────────

  private buildWhere(
    partial: Record<string, unknown>,
    extra?: { since?: Date; txStatus?: TransactionStatus[]; table?: string }
  ): { whereSql: string; params: SqliteParam[] } {
    const clauses: string[] = []
    const params: SqliteParam[] = []

    for (const [key, val] of Object.entries(partial)) {
      if (val === undefined) continue
      if (val === null) {
        clauses.push(`${key} IS NULL`)
      } else if (val instanceof Uint8Array) {
        clauses.push(`${key} = ?`)
        params.push(val)
      } else if (typeof val === 'boolean') {
        clauses.push(`${key} = ?`)
        params.push(val ? 1 : 0)
      } else if (val instanceof Date) {
        clauses.push(`${key} = ?`)
        params.push(val.toISOString())
      } else {
        clauses.push(`${key} = ?`)
        params.push(val as SqliteParam)
      }
    }

    if (extra?.since) {
      clauses.push(`updated_at >= ?`)
      params.push(this.validateDateForWhere(extra.since) as string)
    }

    if (extra?.txStatus && extra.txStatus.length > 0 && extra.table) {
      const placeholders = extra.txStatus.map(() => '?').join(',')
      clauses.push(
        `(SELECT status FROM transactions WHERE transactions.transactionId = ${extra.table}.transactionId) IN (${placeholders})`
      )
      params.push(...extra.txStatus)
    }

    const whereSql = clauses.length > 0 ? ' WHERE ' + clauses.join(' AND ') : ''
    return { whereSql, params }
  }

  private buildOrderAndPaging(
    table: string,
    orderDescending?: boolean,
    paged?: { limit: number; offset?: number }
  ): string {
    let sql = ''
    if (orderDescending) {
      const sortColumn = this.getSortColumn(table)
      if (sortColumn) sql += ` ORDER BY ${sortColumn} DESC`
    }
    if (paged) {
      sql += ` LIMIT ${paged.limit}`
      if (paged.offset) sql += ` OFFSET ${paged.offset}`
    }
    return sql
  }

  private getSortColumn(table: string): string {
    switch (table) {
      case 'certificates': return 'certificateId'
      case 'commissions': return 'commissionId'
      case 'output_baskets': return 'basketId'
      case 'outputs': return 'outputId'
      case 'output_tags': return 'outputTagId'
      case 'proven_tx_reqs': return 'provenTxReqId'
      case 'proven_txs': return 'provenTxId'
      case 'sync_states': return 'syncStateId'
      case 'transactions': return 'transactionId'
      case 'tx_labels': return 'txLabelId'
      case 'users': return 'userId'
      case 'monitor_events': return 'id'
      default: return ''
    }
  }

  private buildInsert(table: string, entity: Record<string, unknown>): { sql: string; params: SqliteParam[] } {
    const keys: string[] = []
    const params: SqliteParam[] = []
    for (const [key, val] of Object.entries(entity)) {
      if (val === undefined) continue
      keys.push(key === 'index' ? `"index"` : key)
      if (val instanceof Date) {
        params.push(val.toISOString())
      } else if (typeof val === 'boolean') {
        params.push(val ? 1 : 0)
      } else {
        params.push(val as SqliteParam)
      }
    }
    const placeholders = keys.map(() => '?').join(', ')
    return {
      sql: `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`,
      params
    }
  }

  private buildUpdate(
    table: string,
    where: Record<string, unknown>,
    update: Record<string, unknown>
  ): { sql: string; params: SqliteParam[] } {
    const setClauses: string[] = []
    const params: SqliteParam[] = []
    for (const [key, val] of Object.entries(update)) {
      if (val === undefined) continue
      setClauses.push(`${key} = ?`)
      if (val instanceof Date) {
        params.push(val.toISOString())
      } else if (typeof val === 'boolean') {
        params.push(val ? 1 : 0)
      } else {
        params.push(val as SqliteParam)
      }
    }
    const whereClauses: string[] = []
    for (const [key, val] of Object.entries(where)) {
      if (Array.isArray(val)) {
        const placeholders = val.map(() => '?').join(',')
        whereClauses.push(`${key} IN (${placeholders})`)
        params.push(...val)
      } else {
        whereClauses.push(`${key} = ?`)
        params.push(val as SqliteParam)
      }
    }
    return {
      sql: `UPDATE ${table} SET ${setClauses.join(', ')} WHERE ${whereClauses.join(' AND ')}`,
      params
    }
  }

  // ─── Generic find/count query execution ──────────────────────────────

  private async findRows<T extends EntityTimeStamp>(
    table: string,
    args: FindPartialSincePagedArgs<any>,
    extraWhereArgs?: {
      txStatus?: TransactionStatus[]
      certifiers?: string[]
      types?: string[]
      status?: string[]
      txids?: string[]
      tagIds?: number[]
      labelIds?: number[]
      noScript?: boolean
      noRawTx?: boolean
    }
  ): Promise<T[]> {
    const { whereSql, params } = this.buildWhere(args.partial, {
      since: args.since,
      txStatus: extraWhereArgs?.txStatus,
      table
    })

    let extraClauses = ''
    if (extraWhereArgs?.certifiers && extraWhereArgs.certifiers.length > 0) {
      const placeholders = extraWhereArgs.certifiers.map(() => '?').join(',')
      extraClauses += `${whereSql || extraClauses ? ' AND ' : ' WHERE '}certifier IN (${placeholders})`
      params.push(...extraWhereArgs.certifiers)
    }
    if (extraWhereArgs?.types && extraWhereArgs.types.length > 0) {
      const placeholders = extraWhereArgs.types.map(() => '?').join(',')
      extraClauses += `${whereSql || extraClauses ? ' AND ' : ' WHERE '}type IN (${placeholders})`
      params.push(...extraWhereArgs.types)
    }
    if (extraWhereArgs?.status && extraWhereArgs.status.length > 0) {
      const placeholders = extraWhereArgs.status.map(() => '?').join(',')
      extraClauses += `${whereSql || extraClauses ? ' AND ' : ' WHERE '}status IN (${placeholders})`
      params.push(...extraWhereArgs.status)
    }
    if (extraWhereArgs?.txids && extraWhereArgs.txids.length > 0) {
      const filtered = extraWhereArgs.txids.filter(t => t !== undefined)
      if (filtered.length > 0) {
        const placeholders = filtered.map(() => '?').join(',')
        extraClauses += `${whereSql || extraClauses ? ' AND ' : ' WHERE '}txid IN (${placeholders})`
        params.push(...filtered)
      }
    }
    if (extraWhereArgs?.tagIds && extraWhereArgs.tagIds.length > 0) {
      const placeholders = extraWhereArgs.tagIds.map(() => '?').join(',')
      extraClauses += `${whereSql || extraClauses ? ' AND ' : ' WHERE '}outputTagId IN (${placeholders})`
      params.push(...extraWhereArgs.tagIds)
    }
    if (extraWhereArgs?.labelIds && extraWhereArgs.labelIds.length > 0) {
      const placeholders = extraWhereArgs.labelIds.map(() => '?').join(',')
      extraClauses += `${whereSql || extraClauses ? ' AND ' : ' WHERE '}txLabelId IN (${placeholders})`
      params.push(...extraWhereArgs.labelIds)
    }

    let selectCols = '*'
    if (extraWhereArgs?.noScript && table === 'outputs') {
      selectCols = outputColumnsWithoutLockingScript.map(c => `outputs.${c}`).join(', ')
    }
    if (extraWhereArgs?.noRawTx && table === 'transactions') {
      selectCols = transactionColumnsWithoutRawTx.map(c => `transactions.${c}`).join(', ')
    }

    const orderPaging = this.buildOrderAndPaging(table, args.orderDescending, args.paged)
    const sql = `SELECT ${selectCols} FROM ${table}${whereSql}${extraClauses}${orderPaging}`
    return await this.getAll<T>(sql, params)
  }

  private async countRows<T extends object>(
    table: string,
    args: FindPartialSincePagedArgs<any>,
    extraWhereArgs?: {
      txStatus?: TransactionStatus[]
      certifiers?: string[]
      types?: string[]
      status?: string[]
      txids?: string[]
      tagIds?: number[]
      labelIds?: number[]
    }
  ): Promise<number> {
    const { whereSql, params } = this.buildWhere(args.partial, {
      since: args.since,
      txStatus: extraWhereArgs?.txStatus,
      table
    })

    let extraClauses = ''
    if (extraWhereArgs?.certifiers && extraWhereArgs.certifiers.length > 0) {
      const placeholders = extraWhereArgs.certifiers.map(() => '?').join(',')
      extraClauses += `${whereSql || extraClauses ? ' AND ' : ' WHERE '}certifier IN (${placeholders})`
      params.push(...extraWhereArgs.certifiers)
    }
    if (extraWhereArgs?.types && extraWhereArgs.types.length > 0) {
      const placeholders = extraWhereArgs.types.map(() => '?').join(',')
      extraClauses += `${whereSql || extraClauses ? ' AND ' : ' WHERE '}type IN (${placeholders})`
      params.push(...extraWhereArgs.types)
    }
    if (extraWhereArgs?.status && extraWhereArgs.status.length > 0) {
      const placeholders = extraWhereArgs.status.map(() => '?').join(',')
      extraClauses += `${whereSql || extraClauses ? ' AND ' : ' WHERE '}status IN (${placeholders})`
      params.push(...extraWhereArgs.status)
    }
    if (extraWhereArgs?.txids && extraWhereArgs.txids.length > 0) {
      const filtered = extraWhereArgs.txids.filter(t => t !== undefined)
      if (filtered.length > 0) {
        const placeholders = filtered.map(() => '?').join(',')
        extraClauses += `${whereSql || extraClauses ? ' AND ' : ' WHERE '}txid IN (${placeholders})`
        params.push(...filtered)
      }
    }
    if (extraWhereArgs?.tagIds && extraWhereArgs.tagIds.length > 0) {
      const placeholders = extraWhereArgs.tagIds.map(() => '?').join(',')
      extraClauses += `${whereSql || extraClauses ? ' AND ' : ' WHERE '}outputTagId IN (${placeholders})`
      params.push(...extraWhereArgs.tagIds)
    }
    if (extraWhereArgs?.labelIds && extraWhereArgs.labelIds.length > 0) {
      const placeholders = extraWhereArgs.labelIds.map(() => '?').join(',')
      extraClauses += `${whereSql || extraClauses ? ' AND ' : ' WHERE '}txLabelId IN (${placeholders})`
      params.push(...extraWhereArgs.labelIds)
    }

    const sql = `SELECT COUNT(*) as cnt FROM ${table}${whereSql}${extraClauses}`
    const row = await this.getOne<{ cnt: number }>(sql, params)
    return row?.cnt || 0
  }

  // ─── Find Methods ────────────────────────────────────────────────────

  override async findCertificateFields(args: FindCertificateFieldsArgs): Promise<TableCertificateField[]> {
    return this.validateEntities(await this.findRows('certificate_fields', args))
  }

  override async findCertificates(args: FindCertificatesArgs): Promise<TableCertificateX[]> {
    let r: TableCertificateX[] = await this.findRows('certificates', args, {
      certifiers: args.certifiers,
      types: args.types
    })
    r = this.validateEntities(r, undefined, ['isDeleted'])
    if (args.includeFields) {
      for (const c of r) {
        c.fields = this.validateEntities(
          await this.findCertificateFields({
            partial: { certificateId: c.certificateId, userId: c.userId },
            trx: args.trx
          })
        )
      }
    }
    return r
  }

  override async findCommissions(args: FindCommissionsArgs): Promise<TableCommission[]> {
    if (args.partial.lockingScript)
      throw new WERR_INVALID_PARAMETER('partial.lockingScript', `undefined. Commissions may not be found by lockingScript value.`)
    return this.validateEntities(await this.findRows('commissions', args), undefined, ['isRedeemed'])
  }

  override async findOutputBaskets(args: FindOutputBasketsArgs): Promise<TableOutputBasket[]> {
    return this.validateEntities(await this.findRows('output_baskets', args), undefined, ['isDeleted'])
  }

  override async findOutputs(args: FindOutputsArgs): Promise<TableOutput[]> {
    if (args.partial.lockingScript)
      throw new WERR_INVALID_PARAMETER('args.partial.lockingScript', `undefined. Outputs may not be found by lockingScript value.`)
    const rows: TableOutput[] = await this.findRows('outputs', args, {
      txStatus: args.txStatus,
      noScript: args.noScript
    })
    if (!args.noScript) {
      for (const o of rows) {
        await this.validateOutputScript(o, args.trx)
      }
    }
    return this.validateEntities(rows, undefined, ['spendable', 'change'])
  }

  override async findOutputTagMaps(args: FindOutputTagMapsArgs): Promise<TableOutputTagMap[]> {
    return this.validateEntities(await this.findRows('output_tags_map', args, { tagIds: args.tagIds }), undefined, ['isDeleted'])
  }

  override async findOutputTags(args: FindOutputTagsArgs): Promise<TableOutputTag[]> {
    return this.validateEntities(await this.findRows('output_tags', args), undefined, ['isDeleted'])
  }

  override async findProvenTxReqs(args: FindProvenTxReqsArgs): Promise<TableProvenTxReq[]> {
    if (args.partial.rawTx)
      throw new WERR_INVALID_PARAMETER('args.partial.rawTx', `undefined. ProvenTxReqs may not be found by rawTx value.`)
    if (args.partial.inputBEEF)
      throw new WERR_INVALID_PARAMETER('args.partial.inputBEEF', `undefined. ProvenTxReqs may not be found by inputBEEF value.`)
    return this.validateEntities(
      await this.findRows('proven_tx_reqs', args, { status: args.status, txids: args.txids }),
      undefined,
      ['notified']
    )
  }

  override async findProvenTxs(args: FindProvenTxsArgs): Promise<TableProvenTx[]> {
    if (args.partial.rawTx)
      throw new WERR_INVALID_PARAMETER('args.partial.rawTx', `undefined. ProvenTxs may not be found by rawTx value.`)
    if (args.partial.merklePath)
      throw new WERR_INVALID_PARAMETER('args.partial.merklePath', `undefined. ProvenTxs may not be found by merklePath value.`)
    return this.validateEntities(await this.findRows('proven_txs', args))
  }

  override async findSyncStates(args: FindSyncStatesArgs): Promise<TableSyncState[]> {
    return this.validateEntities(await this.findRows('sync_states', args), ['when'], ['init'])
  }

  override async findTransactions(args: FindTransactionsArgs): Promise<TableTransaction[]> {
    if (args.partial.rawTx)
      throw new WERR_INVALID_PARAMETER('args.partial.rawTx', `undefined. Transactions may not be found by rawTx value.`)
    if (args.partial.inputBEEF)
      throw new WERR_INVALID_PARAMETER('args.partial.inputBEEF', `undefined. Transactions may not be found by inputBEEF value.`)
    const rows: TableTransaction[] = await this.findRows('transactions', args, {
      status: args.status,
      noRawTx: args.noRawTx
    })
    if (!args.noRawTx) {
      for (const t of rows) {
        await this.validateRawTransaction(t, args.trx)
      }
    }
    return this.validateEntities(rows, undefined, ['isOutgoing'])
  }

  override async findTxLabelMaps(args: FindTxLabelMapsArgs): Promise<TableTxLabelMap[]> {
    return this.validateEntities(await this.findRows('tx_labels_map', args, { labelIds: args.labelIds }), undefined, ['isDeleted'])
  }

  override async findTxLabels(args: FindTxLabelsArgs): Promise<TableTxLabel[]> {
    return this.validateEntities(await this.findRows('tx_labels', args), undefined, ['isDeleted'])
  }

  override async findUsers(args: FindUsersArgs): Promise<TableUser[]> {
    return this.validateEntities(await this.findRows('users', args))
  }

  override async findMonitorEvents(args: FindMonitorEventsArgs): Promise<TableMonitorEvent[]> {
    return this.validateEntities(await this.findRows('monitor_events', args), ['when'], undefined)
  }

  // ─── Count Methods ───────────────────────────────────────────────────

  override async countCertificateFields(args: FindCertificateFieldsArgs): Promise<number> {
    return this.countRows('certificate_fields', args)
  }
  override async countCertificates(args: FindCertificatesArgs): Promise<number> {
    return this.countRows('certificates', args, { certifiers: args.certifiers, types: args.types })
  }
  override async countCommissions(args: FindCommissionsArgs): Promise<number> {
    return this.countRows('commissions', args)
  }
  override async countOutputBaskets(args: FindOutputBasketsArgs): Promise<number> {
    return this.countRows('output_baskets', args)
  }
  override async countOutputs(args: FindOutputsArgs): Promise<number> {
    return this.countRows('outputs', args, { txStatus: args.txStatus })
  }
  override async countOutputTagMaps(args: FindOutputTagMapsArgs): Promise<number> {
    return this.countRows('output_tags_map', args, { tagIds: args.tagIds })
  }
  override async countOutputTags(args: FindOutputTagsArgs): Promise<number> {
    return this.countRows('output_tags', args)
  }
  override async countProvenTxReqs(args: FindProvenTxReqsArgs): Promise<number> {
    return this.countRows('proven_tx_reqs', args, { status: args.status, txids: args.txids })
  }
  override async countProvenTxs(args: FindProvenTxsArgs): Promise<number> {
    return this.countRows('proven_txs', args)
  }
  override async countSyncStates(args: FindSyncStatesArgs): Promise<number> {
    return this.countRows('sync_states', args)
  }
  override async countTransactions(args: FindTransactionsArgs): Promise<number> {
    return this.countRows('transactions', args, { status: args.status })
  }
  override async countTxLabelMaps(args: FindTxLabelMapsArgs): Promise<number> {
    return this.countRows('tx_labels_map', args, { labelIds: args.labelIds })
  }
  override async countTxLabels(args: FindTxLabelsArgs): Promise<number> {
    return this.countRows('tx_labels', args)
  }
  override async countUsers(args: FindUsersArgs): Promise<number> {
    return this.countRows('users', args)
  }
  override async countMonitorEvents(args: FindMonitorEventsArgs): Promise<number> {
    return this.countRows('monitor_events', args)
  }

  // ─── Insert Methods ──────────────────────────────────────────────────

  override async insertProvenTx(tx: TableProvenTx, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(tx, trx)
    if (e.provenTxId === 0) delete e.provenTxId
    const { sql, params } = this.buildInsert('proven_txs', e)
    await this.exec(sql, params)
    tx.provenTxId = this.lastInsertRowId()
    return tx.provenTxId
  }

  override async insertProvenTxReq(tx: TableProvenTxReq, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(tx, trx)
    if (e.provenTxReqId === 0) delete e.provenTxReqId
    const { sql, params } = this.buildInsert('proven_tx_reqs', e)
    await this.exec(sql, params)
    tx.provenTxReqId = this.lastInsertRowId()
    return tx.provenTxReqId
  }

  override async insertUser(user: TableUser, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(user, trx)
    if (e.userId === 0) delete e.userId
    const { sql, params } = this.buildInsert('users', e)
    await this.exec(sql, params)
    user.userId = this.lastInsertRowId()
    return user.userId
  }

  override async insertCertificateAuth(auth: AuthId, certificate: TableCertificateX): Promise<number> {
    if (!auth.userId || (certificate.userId && certificate.userId !== auth.userId)) throw new WERR_UNAUTHORIZED()
    certificate.userId = auth.userId
    return await this.insertCertificate(certificate)
  }

  override async insertCertificate(certificate: TableCertificateX, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(certificate, trx, undefined, ['isDeleted'])
    if (e.certificateId === 0) delete e.certificateId

    const fields = e.fields
    if (e.fields) delete e.fields
    if (e.logger) delete e.logger

    const { sql, params } = this.buildInsert('certificates', e)
    await this.exec(sql, params)
    certificate.certificateId = this.lastInsertRowId()

    if (fields) {
      for (const field of fields) {
        field.certificateId = certificate.certificateId
        field.userId = certificate.userId
        await this.insertCertificateField(field, trx)
      }
    }

    return certificate.certificateId
  }

  override async insertCertificateField(certificateField: TableCertificateField, trx?: TrxToken): Promise<void> {
    const e = await this.validateEntityForInsert(certificateField, trx)
    const { sql, params } = this.buildInsert('certificate_fields', e)
    await this.exec(sql, params)
  }

  override async insertOutputBasket(basket: TableOutputBasket, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(basket, trx, undefined, ['isDeleted'])
    if (e.basketId === 0) delete e.basketId
    const { sql, params } = this.buildInsert('output_baskets', e)
    await this.exec(sql, params)
    basket.basketId = this.lastInsertRowId()
    return basket.basketId
  }

  override async insertTransaction(tx: TableTransaction, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(tx, trx)
    if (e.transactionId === 0) delete e.transactionId
    const { sql, params } = this.buildInsert('transactions', e)
    await this.exec(sql, params)
    tx.transactionId = this.lastInsertRowId()
    return tx.transactionId
  }

  override async insertCommission(commission: TableCommission, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(commission, trx)
    if (e.commissionId === 0) delete e.commissionId
    const { sql, params } = this.buildInsert('commissions', e)
    await this.exec(sql, params)
    commission.commissionId = this.lastInsertRowId()
    return commission.commissionId
  }

  override async insertOutput(output: TableOutput, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(output, trx)
    if (e.outputId === 0) delete e.outputId
    const { sql, params } = this.buildInsert('outputs', e)
    await this.exec(sql, params)
    output.outputId = this.lastInsertRowId()
    return output.outputId
  }

  override async insertOutputTag(tag: TableOutputTag, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(tag, trx, undefined, ['isDeleted'])
    if (e.outputTagId === 0) delete e.outputTagId
    const { sql, params } = this.buildInsert('output_tags', e)
    await this.exec(sql, params)
    tag.outputTagId = this.lastInsertRowId()
    return tag.outputTagId
  }

  override async insertOutputTagMap(tagMap: TableOutputTagMap, trx?: TrxToken): Promise<void> {
    const e = await this.validateEntityForInsert(tagMap, trx, undefined, ['isDeleted'])
    const { sql, params } = this.buildInsert('output_tags_map', e)
    await this.exec(sql, params)
  }

  override async insertTxLabel(label: TableTxLabel, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(label, trx, undefined, ['isDeleted'])
    if (e.txLabelId === 0) delete e.txLabelId
    const { sql, params } = this.buildInsert('tx_labels', e)
    await this.exec(sql, params)
    label.txLabelId = this.lastInsertRowId()
    return label.txLabelId
  }

  override async insertTxLabelMap(labelMap: TableTxLabelMap, trx?: TrxToken): Promise<void> {
    const e = await this.validateEntityForInsert(labelMap, trx, undefined, ['isDeleted'])
    const { sql, params } = this.buildInsert('tx_labels_map', e)
    await this.exec(sql, params)
  }

  override async insertMonitorEvent(event: TableMonitorEvent, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(event, trx)
    if (e.id === 0) delete e.id
    const { sql, params } = this.buildInsert('monitor_events', e)
    await this.exec(sql, params)
    event.id = this.lastInsertRowId()
    return event.id
  }

  override async insertSyncState(syncState: TableSyncState, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(syncState, trx, ['when'], ['init'])
    if (e.syncStateId === 0) delete e.syncStateId
    const { sql, params } = this.buildInsert('sync_states', e)
    await this.exec(sql, params)
    syncState.syncStateId = this.lastInsertRowId()
    return syncState.syncStateId
  }

  // ─── Update Methods ──────────────────────────────────────────────────

  override async updateCertificateField(
    certificateId: number,
    fieldName: string,
    update: Partial<TableCertificateField>,
    trx?: TrxToken
  ): Promise<number> {
    await this.verifyReadyForDatabaseAccess(trx)
    const validated = this.validatePartialForUpdate(update)
    const { sql, params } = this.buildUpdate('certificate_fields', { certificateId, fieldName }, validated)
    await this.exec(sql, params)
    return this.changes()
  }

  override async updateCertificate(id: number, update: Partial<TableCertificate>, trx?: TrxToken): Promise<number> {
    await this.verifyReadyForDatabaseAccess(trx)
    const validated = this.validatePartialForUpdate(update, undefined, ['isDeleted'])
    const { sql, params } = this.buildUpdate('certificates', { certificateId: id }, validated)
    await this.exec(sql, params)
    return this.changes()
  }

  override async updateCommission(id: number, update: Partial<TableCommission>, trx?: TrxToken): Promise<number> {
    await this.verifyReadyForDatabaseAccess(trx)
    const validated = this.validatePartialForUpdate(update)
    const { sql, params } = this.buildUpdate('commissions', { commissionId: id }, validated)
    await this.exec(sql, params)
    return this.changes()
  }

  override async updateOutputBasket(id: number, update: Partial<TableOutputBasket>, trx?: TrxToken): Promise<number> {
    await this.verifyReadyForDatabaseAccess(trx)
    const validated = this.validatePartialForUpdate(update, undefined, ['isDeleted'])
    const { sql, params } = this.buildUpdate('output_baskets', { basketId: id }, validated)
    await this.exec(sql, params)
    return this.changes()
  }

  override async updateOutput(id: number, update: Partial<TableOutput>, trx?: TrxToken): Promise<number> {
    await this.verifyReadyForDatabaseAccess(trx)
    const validated = this.validatePartialForUpdate(update)
    const { sql, params } = this.buildUpdate('outputs', { outputId: id }, validated)
    await this.exec(sql, params)
    return this.changes()
  }

  override async updateOutputTagMap(
    outputId: number,
    tagId: number,
    update: Partial<TableOutputTagMap>,
    trx?: TrxToken
  ): Promise<number> {
    await this.verifyReadyForDatabaseAccess(trx)
    const validated = this.validatePartialForUpdate(update, undefined, ['isDeleted'])
    const { sql, params } = this.buildUpdate('output_tags_map', { outputId, outputTagId: tagId }, validated)
    await this.exec(sql, params)
    return this.changes()
  }

  override async updateOutputTag(id: number, update: Partial<TableOutputTag>, trx?: TrxToken): Promise<number> {
    await this.verifyReadyForDatabaseAccess(trx)
    const validated = this.validatePartialForUpdate(update, undefined, ['isDeleted'])
    const { sql, params } = this.buildUpdate('output_tags', { outputTagId: id }, validated)
    await this.exec(sql, params)
    return this.changes()
  }

  override async updateProvenTxReq(id: number | number[], update: Partial<TableProvenTxReq>, trx?: TrxToken): Promise<number> {
    await this.verifyReadyForDatabaseAccess(trx)
    const validated = this.validatePartialForUpdate(update)
    if (Array.isArray(id)) {
      const { sql, params } = this.buildUpdate('proven_tx_reqs', { provenTxReqId: id }, validated)
      await this.exec(sql, params)
    } else if (Number.isInteger(id)) {
      const { sql, params } = this.buildUpdate('proven_tx_reqs', { provenTxReqId: id }, validated)
      await this.exec(sql, params)
    } else {
      throw new WERR_INVALID_PARAMETER('id', 'provenTxReqId or array of provenTxReqId')
    }
    return this.changes()
  }

  override async updateProvenTx(id: number, update: Partial<TableProvenTx>, trx?: TrxToken): Promise<number> {
    await this.verifyReadyForDatabaseAccess(trx)
    const validated = this.validatePartialForUpdate(update)
    const { sql, params } = this.buildUpdate('proven_txs', { provenTxId: id }, validated)
    await this.exec(sql, params)
    return this.changes()
  }

  override async updateSyncState(id: number, update: Partial<TableSyncState>, trx?: TrxToken): Promise<number> {
    await this.verifyReadyForDatabaseAccess(trx)
    const validated = this.validatePartialForUpdate(update, ['when'], ['init'])
    const { sql, params } = this.buildUpdate('sync_states', { syncStateId: id }, validated)
    await this.exec(sql, params)
    return this.changes()
  }

  override async updateTransaction(id: number | number[], update: Partial<TableTransaction>, trx?: TrxToken): Promise<number> {
    await this.verifyReadyForDatabaseAccess(trx)
    const validated = this.validatePartialForUpdate(update)
    if (Array.isArray(id)) {
      const { sql, params } = this.buildUpdate('transactions', { transactionId: id }, validated)
      await this.exec(sql, params)
    } else if (Number.isInteger(id)) {
      const { sql, params } = this.buildUpdate('transactions', { transactionId: id }, validated)
      await this.exec(sql, params)
    } else {
      throw new WERR_INVALID_PARAMETER('id', 'transactionId or array of transactionId')
    }
    return this.changes()
  }

  override async updateTxLabelMap(
    transactionId: number,
    txLabelId: number,
    update: Partial<TableTxLabelMap>,
    trx?: TrxToken
  ): Promise<number> {
    await this.verifyReadyForDatabaseAccess(trx)
    const validated = this.validatePartialForUpdate(update, undefined, ['isDeleted'])
    const { sql, params } = this.buildUpdate('tx_labels_map', { transactionId, txLabelId }, validated)
    await this.exec(sql, params)
    return this.changes()
  }

  override async updateTxLabel(id: number, update: Partial<TableTxLabel>, trx?: TrxToken): Promise<number> {
    await this.verifyReadyForDatabaseAccess(trx)
    const validated = this.validatePartialForUpdate(update, undefined, ['isDeleted'])
    const { sql, params } = this.buildUpdate('tx_labels', { txLabelId: id }, validated)
    await this.exec(sql, params)
    return this.changes()
  }

  override async updateUser(id: number, update: Partial<TableUser>, trx?: TrxToken): Promise<number> {
    await this.verifyReadyForDatabaseAccess(trx)
    const validated = this.validatePartialForUpdate(update)
    const { sql, params } = this.buildUpdate('users', { userId: id }, validated)
    await this.exec(sql, params)
    return this.changes()
  }

  override async updateMonitorEvent(id: number, update: Partial<TableMonitorEvent>, trx?: TrxToken): Promise<number> {
    await this.verifyReadyForDatabaseAccess(trx)
    const validated = this.validatePartialForUpdate(update)
    const { sql, params } = this.buildUpdate('monitor_events', { id }, validated)
    await this.exec(sql, params)
    return this.changes()
  }

  // ─── ForUser Query Methods ───────────────────────────────────────────

  override async getProvenTxsForUser(args: FindForUserSincePagedArgs): Promise<TableProvenTx[]> {
    const params: SqliteParam[] = [args.userId]
    let sql = `SELECT pt.* FROM proven_txs pt WHERE EXISTS (
      SELECT 1 FROM transactions t WHERE t.provenTxId = pt.provenTxId AND t.userId = ?
    )`
    if (args.since) {
      sql += ` AND pt.updated_at >= ?`
      params.push(this.validateDateForWhere(args.since) as string)
    }
    if (args.paged) {
      sql += ` LIMIT ${args.paged.limit}`
      if (args.paged.offset) sql += ` OFFSET ${args.paged.offset}`
    }
    return this.validateEntities(await this.getAll<TableProvenTx>(sql, params))
  }

  override async getProvenTxReqsForUser(args: FindForUserSincePagedArgs): Promise<TableProvenTxReq[]> {
    const params: SqliteParam[] = [args.userId]
    let sql = `SELECT ptr.* FROM proven_tx_reqs ptr WHERE EXISTS (
      SELECT 1 FROM transactions t WHERE t.txid = ptr.txid AND t.userId = ?
    )`
    if (args.since) {
      sql += ` AND ptr.updated_at >= ?`
      params.push(this.validateDateForWhere(args.since) as string)
    }
    if (args.paged) {
      sql += ` LIMIT ${args.paged.limit}`
      if (args.paged.offset) sql += ` OFFSET ${args.paged.offset}`
    }
    return this.validateEntities(await this.getAll<TableProvenTxReq>(sql, params), undefined, ['notified'])
  }

  override async getTxLabelMapsForUser(args: FindForUserSincePagedArgs): Promise<TableTxLabelMap[]> {
    const params: SqliteParam[] = [args.userId]
    let sql = `SELECT tlm.* FROM tx_labels_map tlm WHERE EXISTS (
      SELECT 1 FROM tx_labels tl WHERE tl.txLabelId = tlm.txLabelId AND tl.userId = ?
    )`
    if (args.since) {
      sql += ` AND tlm.updated_at >= ?`
      params.push(this.validateDateForWhere(args.since) as string)
    }
    if (args.paged) {
      sql += ` LIMIT ${args.paged.limit}`
      if (args.paged.offset) sql += ` OFFSET ${args.paged.offset}`
    }
    return this.validateEntities(await this.getAll<TableTxLabelMap>(sql, params), undefined, ['isDeleted'])
  }

  override async getOutputTagMapsForUser(args: FindForUserSincePagedArgs): Promise<TableOutputTagMap[]> {
    const params: SqliteParam[] = [args.userId]
    let sql = `SELECT otm.* FROM output_tags_map otm WHERE EXISTS (
      SELECT 1 FROM output_tags ot WHERE ot.outputTagId = otm.outputTagId AND ot.userId = ?
    )`
    if (args.since) {
      sql += ` AND otm.updated_at >= ?`
      params.push(this.validateDateForWhere(args.since) as string)
    }
    if (args.paged) {
      sql += ` LIMIT ${args.paged.limit}`
      if (args.paged.offset) sql += ` OFFSET ${args.paged.offset}`
    }
    return this.validateEntities(await this.getAll<TableOutputTagMap>(sql, params), undefined, ['isDeleted'])
  }

  // ─── StorageProvider Abstract Method Overrides ───────────────────────

  override async getProvenOrRawTx(txid: string, trx?: TrxToken): Promise<ProvenOrRawTx> {
    const r: ProvenOrRawTx = { proven: undefined, rawTx: undefined, inputBEEF: undefined }
    r.proven = verifyOneOrNone(await this.findProvenTxs({ partial: { txid }, trx }))
    if (!r.proven) {
      const rows = await this.getAll<{ rawTx: Uint8Array; inputBEEF: Uint8Array }>(
        `SELECT rawTx, inputBEEF FROM proven_tx_reqs WHERE txid = ? AND status IN ('unsent','unmined','unconfirmed','sending','nosend','completed')`,
        [txid]
      )
      const reqRawTx = rows.length > 0 ? rows[0] : undefined
      if (reqRawTx) {
        r.rawTx = reqRawTx.rawTx ? Array.from(reqRawTx.rawTx) : undefined
        r.inputBEEF = reqRawTx.inputBEEF ? Array.from(reqRawTx.inputBEEF) : undefined
      }
    }
    return r
  }

  override async getRawTxOfKnownValidTransaction(
    txid?: string,
    offset?: number,
    length?: number,
    trx?: TrxToken
  ): Promise<number[] | undefined> {
    if (!txid) return undefined
    if (!this.isAvailable()) await this.makeAvailable()

    let rawTx: number[] | undefined = undefined

    if (Number.isInteger(offset) && Number.isInteger(length)) {
      const row = await this.getOne<{ rawTx: Uint8Array | null }>(
        `SELECT substr(rawTx, ?, ?) as rawTx FROM proven_txs WHERE txid = ?`,
        [offset! + 1, length!, txid]
      )
      if (row?.rawTx) {
        rawTx = Array.from(row.rawTx)
      } else {
        const row2 = await this.getOne<{ rawTx: Uint8Array | null }>(
          `SELECT substr(rawTx, ?, ?) as rawTx FROM proven_tx_reqs WHERE txid = ? AND status IN ('unsent','nosend','sending','unmined','completed','unfail')`,
          [offset! + 1, length!, txid]
        )
        if (row2?.rawTx) {
          rawTx = Array.from(row2.rawTx)
        }
      }
    } else {
      const r = await this.getProvenOrRawTx(txid, trx)
      if (r.proven) rawTx = r.proven.rawTx
      else rawTx = r.rawTx
    }
    return rawTx
  }

  override async getLabelsForTransactionId(transactionId?: number, trx?: TrxToken): Promise<TableTxLabel[]> {
    if (transactionId === undefined) return []
    const rows = await this.getAll<TableTxLabel>(
      `SELECT tl.* FROM tx_labels tl
       JOIN tx_labels_map tlm ON tlm.txLabelId = tl.txLabelId
       WHERE tlm.transactionId = ? AND tlm.isDeleted != 1 AND tl.isDeleted != 1`,
      [transactionId]
    )
    return this.validateEntities(rows, undefined, ['isDeleted'])
  }

  override async getTagsForOutputId(outputId: number, trx?: TrxToken): Promise<TableOutputTag[]> {
    const rows = await this.getAll<TableOutputTag>(
      `SELECT ot.* FROM output_tags ot
       JOIN output_tags_map otm ON otm.outputTagId = ot.outputTagId
       WHERE otm.outputId = ? AND otm.isDeleted != 1 AND ot.isDeleted != 1`,
      [outputId]
    )
    return this.validateEntities(rows, undefined, ['isDeleted'])
  }

  override async listActions(auth: AuthId, vargs: Validation.ValidListActionsArgs): Promise<ListActionsResult> {
    if (!auth.userId) throw new WERR_UNAUTHORIZED()
    // Delegate to dedicated method file (to be implemented in Phase 4)
    const { listActionsSqlite } = await import('./methods/listActionsSqlite')
    return await listActionsSqlite(this, auth, vargs)
  }

  override async listOutputs(auth: AuthId, vargs: Validation.ValidListOutputsArgs): Promise<ListOutputsResult> {
    if (!auth.userId) throw new WERR_UNAUTHORIZED()
    const { listOutputsSqlite } = await import('./methods/listOutputsSqlite')
    return await listOutputsSqlite(this, auth, vargs)
  }

  override async reviewStatus(args: { agedLimit: Date; trx?: TrxToken }): Promise<{ log: string }> {
    const { reviewStatusSqlite } = await import('./methods/reviewStatusSqlite')
    return await reviewStatusSqlite(this, args)
  }

  override async purgeData(params: PurgeParams, trx?: TrxToken): Promise<PurgeResults> {
    const { purgeDataSqlite } = await import('./methods/purgeDataSqlite')
    return await purgeDataSqlite(this, params, trx)
  }

  override async countChangeInputs(userId: number, basketId: number, excludeSending: boolean): Promise<number> {
    const status: TransactionStatus[] = ['completed', 'unproven']
    if (!excludeSending) status.push('sending')
    const placeholders = status.map(() => '?').join(',')
    const sql = `SELECT COUNT(*) as cnt FROM outputs
      WHERE userId = ? AND spendable = 1 AND basketId = ?
      AND (SELECT status FROM transactions WHERE outputs.transactionId = transactions.transactionId) IN (${placeholders})`
    const row = await this.getOne<{ cnt: number }>(sql, [userId, basketId, ...status])
    return row?.cnt || 0
  }

  override async allocateChangeInput(
    userId: number,
    basketId: number,
    targetSatoshis: number,
    exactSatoshis: number | undefined,
    excludeSending: boolean,
    transactionId: number
  ): Promise<TableOutput | undefined> {
    const status: TransactionStatus[] = ['completed', 'unproven']
    if (!excludeSending) status.push('sending')
    const statusPlaceholders = status.map(() => '?').join(',')
    const txStatusCondition = `AND (SELECT status FROM transactions WHERE outputs.transactionId = transactions.transactionId) IN (${statusPlaceholders})`

    return await this.transaction(async trx => {
      let outputId: number | undefined

      if (exactSatoshis !== undefined) {
        const row = await this.getOne<{ outputId: number }>(
          `SELECT outputId FROM outputs WHERE userId = ? AND spendable = 1 AND basketId = ? ${txStatusCondition} AND satoshis = ? LIMIT 1`,
          [userId, basketId, ...status, exactSatoshis]
        )
        outputId = row?.outputId
      }

      if (outputId === undefined) {
        const row = await this.getOne<{ outputId: number }>(
          `SELECT outputId FROM outputs WHERE userId = ? AND spendable = 1 AND basketId = ? ${txStatusCondition}
           AND satoshis - ? = (
             SELECT MIN(satoshis - ?) FROM outputs WHERE userId = ? AND spendable = 1 AND basketId = ? ${txStatusCondition} AND satoshis - ? >= 0
           ) LIMIT 1`,
          [userId, basketId, ...status, targetSatoshis, targetSatoshis, userId, basketId, ...status, targetSatoshis]
        )
        outputId = row?.outputId
      }

      if (outputId === undefined) {
        const row = await this.getOne<{ outputId: number }>(
          `SELECT outputId FROM outputs WHERE userId = ? AND spendable = 1 AND basketId = ? ${txStatusCondition}
           AND satoshis - ? = (
             SELECT MAX(satoshis - ?) FROM outputs WHERE userId = ? AND spendable = 1 AND basketId = ? ${txStatusCondition} AND satoshis - ? < 0
           ) LIMIT 1`,
          [userId, basketId, ...status, targetSatoshis, targetSatoshis, userId, basketId, ...status, targetSatoshis]
        )
        outputId = row?.outputId
      }

      if (outputId === undefined) return undefined

      await this.updateOutput(outputId, { spendable: false, spentBy: transactionId }, trx)
      return verifyTruthy(await this.findOutputById(outputId, trx))
    })
  }

  override async findCertificatesAuth(auth: AuthId, args: FindCertificatesArgs): Promise<TableCertificateX[]> {
    if (!auth.userId || (args.partial.userId && args.partial.userId !== auth.userId)) throw new WERR_UNAUTHORIZED()
    args.partial.userId = auth.userId
    return await this.findCertificates(args)
  }

  override async findOutputBasketsAuth(auth: AuthId, args: FindOutputBasketsArgs): Promise<TableOutputBasket[]> {
    if (!auth.userId || (args.partial.userId && args.partial.userId !== auth.userId)) throw new WERR_UNAUTHORIZED()
    args.partial.userId = auth.userId
    return await this.findOutputBaskets(args)
  }

  override async findOutputsAuth(auth: AuthId, args: FindOutputsArgs): Promise<TableOutput[]> {
    if (!auth.userId || (args.partial.userId && args.partial.userId !== auth.userId)) throw new WERR_UNAUTHORIZED()
    args.partial.userId = auth.userId
    return await this.findOutputs(args)
  }

  override async adminStats(adminIdentityKey: string): Promise<StorageAdminStats> {
    throw new Error('Method intentionally not implemented for personal storage.')
  }
}
