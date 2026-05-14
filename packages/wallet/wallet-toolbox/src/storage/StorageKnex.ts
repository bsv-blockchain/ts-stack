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
  TableTransactionNew,
  TableTxLabel,
  TableTxLabelMap,
  TableUser,
  transactionColumnsWithoutRawTx
} from './schema/tables'
import { KnexMigrations } from './schema/KnexMigrations'
import { Knex } from 'knex'
import { AdminStatsResult, StorageProvider, StorageProviderOptions } from './StorageProvider'
import { purgeData } from './methods/purgeData'
import { listActions } from './methods/listActionsKnex'
import { listOutputs } from './methods/listOutputsKnex'
import { DBType } from './StorageReader'
import { reviewStatus } from './methods/reviewStatus'
import { ServicesCallHistory } from '../sdk/WalletServices.interfaces'
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
  FindStaleMerkleRootsArgs,
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
import { WERR_INTERNAL, WERR_INVALID_PARAMETER, WERR_NOT_IMPLEMENTED, WERR_UNAUTHORIZED } from '../sdk/WERR_errors'
import { verifyId, verifyOne, verifyOneOrNone } from '../utility/utilityHelpers'

import { EntityTimeStamp, ProcessingStatus, TransactionStatus, transactionStatusToProcessing } from '../sdk/types'
import { TransactionService } from './schema/transactionService'

export interface StorageKnexOptions extends StorageProviderOptions {
  /**
   * Knex database interface initialized with valid connection configuration.
   */
  knex: Knex
}

export class StorageKnex extends StorageProvider implements WalletStorageProvider {
  knex: Knex
  private _postCutoverCache: boolean | undefined = undefined
  /**
   * Set by `disableForeignKeys()`, cleared by `enableForeignKeys()`.
   * Read by `transaction()` to emit a connection-scoped FK bypass on
   * Postgres (where `disableForeignKeys` cannot directly act on the
   * connection the upcoming transaction will acquire from the pool).
   */
  private _fkBypassPending: boolean = false

  constructor (options: StorageKnexOptions) {
    super(options)
    if (!options.knex) throw new WERR_INVALID_PARAMETER('options.knex', 'valid')
    this.knex = options.knex
  }

  override getTransactionService (): TransactionService | undefined {
    // The new-schema transaction service is only valid post-cutover. Pre-cutover,
    // the `transactions` table is the legacy schema and queries via this service
    // would return legacy ids that don't satisfy the `tx_audit.transactionId`
    // FK (which targets `transactions_new`). Callers gate on `undefined` and
    // fall back to the legacy storage path.
    if (this._postCutoverCache !== true) return undefined
    return new TransactionService(this.knex)
  }

  /**
   * Eagerly warm the `_postCutoverCache` so sync query builders such as
   * `findOutputsQuery` can branch on cutover state without an extra await.
   * Callers that have invoked `makeAvailable` are guaranteed the cache has
   * been populated.
   */
  override async makeAvailable (): Promise<TableSettings> {
    const settings = await super.makeAvailable()
    if (this._postCutoverCache === undefined) {
      this._postCutoverCache = await this.knex.schema.hasTable('transactions_legacy')
    }
    return settings
  }

  /**
   * Returns true when the database has been through `runSchemaCutover` (i.e.
   * `transactions_legacy` exists). Result is cached for the lifetime of this
   * StorageKnex instance.
   */
  private async isPostCutover (): Promise<boolean> {
    if (this._postCutoverCache === undefined) {
      this._postCutoverCache = await this.knex.schema.hasTable('transactions_legacy')
    }
    return this._postCutoverCache
  }

  /**
   * Maps legacy TransactionStatus values to their ProcessingStatus equivalents
   * for use in `outputs JOIN transactions` WHERE clauses post-cutover.
   */
  private legacyStatiToProcessing (stati: TransactionStatus[]): ProcessingStatus[] {
    const result = new Set<ProcessingStatus>()
    for (const s of stati) {
      result.add(transactionStatusToProcessing(s))
      if (s === 'unproven') {
        // 'sent','seen','seen_multi','unconfirmed' all map to legacy 'unproven'
        result.add('sent')
        result.add('seen')
        result.add('seen_multi')
        result.add('unconfirmed')
      }
    }
    return [...result]
  }

  /**
   * Returns the canonical name of the `proven_txs` table — `proven_txs_legacy`
   * post-cutover, `proven_txs` otherwise.
   *
   * Public so that helper modules (reviewStatus, purgeData) can resolve the
   * correct table name without duplicating the post-cutover detection logic.
   */
  async provenTxsTableName (): Promise<string> {
    return (await this.isPostCutover()) ? 'proven_txs_legacy' : 'proven_txs'
  }

  /**
   * Returns the canonical name of the `proven_tx_reqs` table —
   * `proven_tx_reqs_legacy` post-cutover, `proven_tx_reqs` otherwise.
   *
   * Public so that helper modules (reviewStatus, purgeData) can resolve the
   * correct table name without duplicating the post-cutover detection logic.
   */
  async provenTxReqsTableName (): Promise<string> {
    return (await this.isPostCutover()) ? 'proven_tx_reqs_legacy' : 'proven_tx_reqs'
  }

  /**
   * Insert a legacy-shaped transaction row into the correct table:
   * - Post-cutover: `transactions_legacy` (the renamed legacy schema table)
   * - Pre-cutover:     `transactions` (the standard table, same behaviour as `insertTransaction`)
   *
   * This allows `createAction` to store unsigned rows (txid unknown) without
   * conflicting with the new `transactions` table's NOT NULL txid constraint.
   * A new `transactions` row + `actions` row are created later by `processAction`
   * once the real txid is known.
   *
   * On SQLite, foreign key enforcement is temporarily disabled while inserting
   * into `transactions_legacy` because the referenced `proven_txs` table was
   * renamed to `proven_txs_legacy` during the the schema cutover. Since `provenTxId`
   * is always NULL for new unsigned transactions this is semantically safe.
   */
  override async insertLegacyTransaction (tx: TableTransaction, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(tx, trx)
    if (e.transactionId === 0) delete e.transactionId
    const hasLegacyTable = await this.knex.schema.hasTable('transactions_legacy')
    const tableName = hasLegacyTable ? 'transactions_legacy' : 'transactions'
    const isSqlite = this.dbtype === 'SQLite'
    // On SQLite post-cutover the `transactions_legacy` FK to `proven_txs` is dangling
    // (proven_txs was renamed to proven_txs_legacy). Temporarily disable FK checks for
    // this insert since provenTxId is always NULL for a brand-new unsigned transaction.
    if (isSqlite && hasLegacyTable) await this.knex.raw('PRAGMA foreign_keys = OFF')
    try {
      const [id] = await this.toDb(trx)<TableTransaction>(tableName).insert(e)
      tx.transactionId = id
      return tx.transactionId
    } finally {
      if (isSqlite && hasLegacyTable) await this.knex.raw('PRAGMA foreign_keys = ON')
    }
  }

  /**
   * Insert a `tx_labels_map` row for a legacy transaction that does not yet
   * have a `actions.actionId`. On post-cutover SQLite, temporarily disables
   * FK checks so that the legacy transactionId (which is not yet an actionId)
   * can be written. processAction will repoint it via repointLabelsToActionId.
   *
   * Note: bypasses `validateEntityForInsert` (and therefore `verifyReadyForDatabaseAccess`
   * which would re-enable FK checks) to ensure the PRAGMA=OFF persists across
   * the insert statement.
   */
  override async insertLegacyTxLabelMap (labelMap: TableTxLabelMap, trx?: TrxToken): Promise<void> {
    const isSqlite = this.dbtype === 'SQLite'
    const hasLegacyTable = isSqlite ? await this.knex.schema.hasTable('transactions_legacy') : false
    if (!isSqlite || !hasLegacyTable) {
      // Pre-cutover or non-SQLite: standard insert is safe (no dangling FK issue).
      await this.insertTxLabelMap(labelMap, trx)
      return
    }
    // Post-cutover SQLite: tx_labels_map.transactionId FK now points to actions.actionId.
    // We are writing a legacyTransactionId (no corresponding actions row yet).
    // Temporarily disable FK checks for this single insert.
    const now = new Date()
    const e = {
      created_at: now,
      updated_at: now,
      txLabelId: labelMap.txLabelId,
      transactionId: labelMap.transactionId,
      isDeleted: labelMap.isDeleted ? 1 : 0
    }
    // Use the raw knex handle (not toDb(trx)) to send the PRAGMA on the same connection.
    await this.knex.raw('PRAGMA foreign_keys = OFF')
    try {
      await this.knex('tx_labels_map').insert(e)
    } finally {
      await this.knex.raw('PRAGMA foreign_keys = ON')
    }
  }

  async readSettings (): Promise<TableSettings> {
    return this.validateEntity(verifyOne(await this.toDb(undefined)<TableSettings>('settings')))
  }

  /**
   * Synthesise a `ProvenOrRawTx` from a `TableTransactionNew` row.
   *
   * - If the new schema row carries a `merklePath` (i.e. processing is `proven`), build
   *   a `TableProvenTx`-shaped object so the BEEF assembly code can extract the
   *   merkle path and merge it into the Beef without hitting the legacy tables.
   * - If the new schema row only has `rawTx` (broadcast/queued state), return it as the
   *   raw-tx path.
   * - Returns `null` when the new schema row has neither rawTx nor merklePath.
   */
  private newTxToProvenOrRawTx (row: TableTransactionNew, txid: string): ProvenOrRawTx | null {
    // Only use the new-schema row as the primary source when it carries a *non-empty*
    // merklePath and a rawTx — both are required for `handleProvenTxBranch` to assemble
    // a valid BEEF.  An empty merklePath (e.g. a backfill race or a req whose proof was
    // never stored) must fall through to the legacy `proven_txs_legacy` path.
    // Raw-tx-only rows (no merklePath) are likewise forwarded to the legacy path so
    // that the legacy `inputBEEF` column is available for recursive BEEF assembly.
    if (row.merklePath != null && row.merklePath.length > 0 && row.rawTx != null && row.rawTx.length > 0) {
      // Full proof available — synthesise TableProvenTx shape
      const proven: TableProvenTx = {
        created_at: row.created_at,
        updated_at: row.updated_at,
        provenTxId: row.transactionId,
        txid,
        height: row.height ?? 0,
        index: row.merkleIndex ?? 0,
        merklePath: row.merklePath,
        rawTx: row.rawTx,
        blockHash: row.blockHash ?? '',
        merkleRoot: row.merkleRoot ?? ''
      }
      return { proven, rawTx: undefined, inputBEEF: undefined }
    }
    // No complete proof in new-schema row — let the caller fall through to legacy tables.
    return null
  }

  override async getProvenOrRawTx (txid: string, trx?: TrxToken): Promise<ProvenOrRawTx> {
    const k = this.toDb(trx)
    const r: ProvenOrRawTx = {
      proven: undefined,
      rawTx: undefined,
      inputBEEF: undefined
    }

    // Post-cutover: try new `transactions` table first. The new schema row is the single
    // source of truth for rawTx and merklePath; legacy tables are read-only
    // archives after cutover.
    if (await this.isPostCutover()) {
      try {
        const txSvc = this.getTransactionService()
        if (txSvc != null) {
          const newTx = await txSvc.findByTxid(txid)
          if (newTx != null) {
            const newTxResult = this.newTxToProvenOrRawTx(newTx, txid)
            if (newTxResult != null) return newTxResult
          }
        }
      } catch {
        // new table lookup failed (e.g. table not yet available) — fall through to legacy
      }
    }

    r.proven = verifyOneOrNone(await this.findProvenTxs({ partial: { txid } }))
    if (r.proven == null) {
      const reqTable = await this.provenTxReqsTableName()
      const reqRawTx = verifyOneOrNone(
        await k(reqTable)
          .where('txid', txid)
          .whereIn('status', ['unsent', 'unmined', 'unconfirmed', 'sending', 'nosend', 'completed'])
          .select('rawTx', 'inputBEEF')
      )
      if (reqRawTx) {
        r.rawTx = Array.from(reqRawTx.rawTx)
        r.inputBEEF = Array.from(reqRawTx.inputBEEF)
      }
    }
    return r
  }

  /**
   * Engine-agnostic FK bypass. SQLite uses `PRAGMA foreign_keys`, MySQL uses
   * `SET FOREIGN_KEY_CHECKS`, Postgres uses `SET session_replication_role`.
   * Callers pass `disable=true` to bypass FK checks, `false` to restore.
   *
   * Note: PRAGMA / SET statements run on the underlying connection; on SQLite
   * they are no-ops inside an open transaction, so callers that need bypass
   * during a transaction must call this BEFORE opening it.
   */
  async dbBypassFks (disable: boolean): Promise<void> {
    switch (this.dbtype) {
      case 'SQLite':
        await this.knex.raw(disable ? 'PRAGMA foreign_keys = OFF' : 'PRAGMA foreign_keys = ON')
        return
      case 'Postgres':
        await this.knex.raw(disable
          ? "SET session_replication_role = 'replica'"
          : "SET session_replication_role = 'origin'")
        return
      case 'MySQL':
        await this.knex.raw(disable ? 'SET FOREIGN_KEY_CHECKS=0' : 'SET FOREIGN_KEY_CHECKS=1')
        return
      default:
        // IndexedDB or unknown — no-op
    }
  }

  dbTypeSubstring (source: string, fromOffset: number, forLength?: number) {
    // MySQL + Postgres both support the SQL-standard `substring(col from N for L)`.
    // SQLite uses `substr(col, N, L)`.
    if (this.dbtype === 'MySQL' || this.dbtype === 'Postgres') {
      return `substring(${source} from ${fromOffset} for ${forLength!})`
    }
    return `substr(${source}, ${fromOffset}, ${forLength})`
  }

  private normaliseKnexRawResult (rs: unknown): Array<{ rawTx: Buffer | null }> {
    // mysql2 returns `[rows, fields]`; pg returns `{ rows }`; better-sqlite3
    // returns rows directly as an array.
    if (this.dbtype === 'MySQL') return (rs as Array<Array<{ rawTx: Buffer | null }>>)[0]
    if (this.dbtype === 'Postgres') return (rs as { rows: Array<{ rawTx: Buffer | null }> }).rows
    return rs as Array<{ rawTx: Buffer | null }>
  }

  private async getRawTxSlice (txid: string, offset: number, length: number, trx?: TrxToken): Promise<number[] | undefined> {
    // Post-cutover: try new transactions table first — the new table is the canonical store
    // for rawTx after the cutover. Apply the slice in JS to avoid raw SQL
    // column naming differences between the two schemas.
    if (await this.isPostCutover()) {
      try {
        const txSvc = this.getTransactionService()
        if (txSvc != null) {
          const newTx = await txSvc.findByTxid(txid)
          if (newTx?.rawTx != null) {
            return newTx.rawTx.slice(offset, offset + length)
          }
        }
      } catch {
        // new table lookup failed — fall through to legacy tables
      }
    }

    const sub = this.dbTypeSubstring('rawTx', offset + 1, length)
    const provenTable = await this.provenTxsTableName()
    const reqTable = await this.provenTxReqsTableName()
    let rs = await this.toDb(trx).raw(`select ${sub} as rawTx from ${provenTable} where txid = '${txid}'`)
    const proven = verifyOneOrNone(this.normaliseKnexRawResult(rs))
    if (proven?.rawTx != null) return Array.from(proven.rawTx)
    rs = await this.toDb(trx).raw(
      `select ${sub} as rawTx from ${reqTable} where txid = '${txid}' and status in ('unsent', 'nosend', 'sending', 'unmined', 'completed', 'unfail')`
    )
    const req = verifyOneOrNone(this.normaliseKnexRawResult(rs))
    return req?.rawTx != null ? Array.from(req.rawTx) : undefined
  }

  override async getRawTxOfKnownValidTransaction (
    txid?: string,
    offset?: number,
    length?: number,
    trx?: TrxToken
  ): Promise<number[] | undefined> {
    if (!txid) return undefined
    if (!this.isAvailable()) await this.makeAvailable()
    if (Number.isInteger(offset) && Number.isInteger(length)) {
      return await this.getRawTxSlice(txid, offset!, length!, trx)
    }
    const r = await this.getProvenOrRawTx(txid, trx)
    return r.proven != null ? r.proven.rawTx : r.rawTx
  }

  getProvenTxsForUserQuery (args: FindForUserSincePagedArgs): Knex.QueryBuilder {
    const k = this.toDb(args.trx)
    let q = k('proven_txs').where(function () {
      this.whereExists(
        k
          .select('*')
          .from('transactions')
          .whereRaw(`proven_txs.provenTxId = transactions.provenTxId and transactions.userId = ${args.userId}`)
      )
    })
    if (args.paged != null) {
      q = q.limit(args.paged.limit)
      q = q.offset(args.paged.offset || 0)
    }
    if (args.since != null) q = q.where('updated_at', '>=', this.validateDateForWhere(args.since))
    return q
  }

  override async getProvenTxsForUser (args: FindForUserSincePagedArgs): Promise<TableProvenTx[]> {
    const postCutover = await this.isPostCutover()
    if (postCutover) {
      // Post-cutover: proven_txs → proven_txs_legacy; transactions → transactions_legacy
      const k = this.toDb(args.trx)
      let q = k('proven_txs_legacy').where(function () {
        this.whereExists(
          k
            .select('*')
            .from('transactions_legacy')
            .whereRaw(`proven_txs_legacy.provenTxId = transactions_legacy.provenTxId and transactions_legacy.userId = ${args.userId}`)
        )
      })
      if (args.paged != null) {
        q = q.limit(args.paged.limit)
        q = q.offset(args.paged.offset || 0)
      }
      if (args.since != null) q = q.where('updated_at', '>=', this.validateDateForWhere(args.since))
      const rs = await q
      return this.validateEntities(rs)
    }
    const q = this.getProvenTxsForUserQuery(args)
    const rs = await q
    return this.validateEntities(rs)
  }

  getProvenTxReqsForUserQuery (args: FindForUserSincePagedArgs): Knex.QueryBuilder {
    const k = this.toDb(args.trx)
    let q = k('proven_tx_reqs').where(function () {
      this.whereExists(
        k
          .select('*')
          .from('transactions')
          .whereRaw(`proven_tx_reqs.txid = transactions.txid and transactions.userId = ${args.userId}`)
      )
    })
    if (args.paged != null) {
      q = q.limit(args.paged.limit)
      q = q.offset(args.paged.offset || 0)
    }
    if (args.since != null) q = q.where('updated_at', '>=', this.validateDateForWhere(args.since))
    return q
  }

  override async getProvenTxReqsForUser (args: FindForUserSincePagedArgs): Promise<TableProvenTxReq[]> {
    const postCutover = await this.isPostCutover()
    if (postCutover) {
      // Post-cutover: proven_tx_reqs → proven_tx_reqs_legacy; transactions → transactions_legacy
      const k = this.toDb(args.trx)
      let q = k('proven_tx_reqs_legacy').where(function () {
        this.whereExists(
          k
            .select('*')
            .from('transactions_legacy')
            .whereRaw(`proven_tx_reqs_legacy.txid = transactions_legacy.txid and transactions_legacy.userId = ${args.userId}`)
        )
      })
      if (args.paged != null) {
        q = q.limit(args.paged.limit)
        q = q.offset(args.paged.offset || 0)
      }
      if (args.since != null) q = q.where('updated_at', '>=', this.validateDateForWhere(args.since))
      const rs = await q
      return this.validateEntities(rs, undefined, ['notified'])
    }
    const q = this.getProvenTxReqsForUserQuery(args)
    const rs = await q
    return this.validateEntities(rs, undefined, ['notified'])
  }

  getTxLabelMapsForUserQuery (args: FindForUserSincePagedArgs): Knex.QueryBuilder {
    const k = this.toDb(args.trx)
    let q = k('tx_labels_map').whereExists(
      k
        .select('*')
        .from('tx_labels')
        .whereRaw(`tx_labels.txLabelId = tx_labels_map.txLabelId and tx_labels.userId = ${args.userId}`)
    )
    if (args.since != null) q = q.where('updated_at', '>=', this.validateDateForWhere(args.since))
    if (args.paged != null) {
      q = q.limit(args.paged.limit)
      q = q.offset(args.paged.offset || 0)
    }
    return q
  }

  override async getTxLabelMapsForUser (args: FindForUserSincePagedArgs): Promise<TableTxLabelMap[]> {
    const q = this.getTxLabelMapsForUserQuery(args)
    const rs = await q
    return this.validateEntities(rs, undefined, ['isDeleted'])
  }

  getOutputTagMapsForUserQuery (args: FindForUserSincePagedArgs): Knex.QueryBuilder {
    const k = this.toDb(args.trx)
    let q = k('output_tags_map').whereExists(
      k
        .select('*')
        .from('output_tags')
        .whereRaw(`output_tags.outputTagId = output_tags_map.outputTagId and output_tags.userId = ${args.userId}`)
    )
    if (args.since != null) q = q.where('updated_at', '>=', this.validateDateForWhere(args.since))
    if (args.paged != null) {
      q = q.limit(args.paged.limit)
      q = q.offset(args.paged.offset || 0)
    }
    return q
  }

  override async getOutputTagMapsForUser (args: FindForUserSincePagedArgs): Promise<TableOutputTagMap[]> {
    const q = this.getOutputTagMapsForUserQuery(args)
    const rs = await q
    return this.validateEntities(rs, undefined, ['isDeleted'])
  }

  override async listActions (auth: AuthId, vargs: Validation.ValidListActionsArgs): Promise<ListActionsResult> {
    if (!auth.userId) throw new WERR_UNAUTHORIZED()
    return await listActions(this, auth, vargs)
  }

  override async listOutputs (auth: AuthId, vargs: Validation.ValidListOutputsArgs): Promise<ListOutputsResult> {
    if (!auth.userId) throw new WERR_UNAUTHORIZED()
    return await listOutputs(this, auth, vargs)
  }

  override async insertProvenTx (tx: TableProvenTx, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(tx, trx)
    if (e.provenTxId === 0) delete e.provenTxId
    const tableName = await this.provenTxsTableName()
    const [id] = await this.toDb(trx)<TableProvenTx>(tableName).insert(e)
    tx.provenTxId = id
    return tx.provenTxId
  }

  override async insertProvenTxReq (tx: TableProvenTxReq, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(tx, trx)
    if (e.provenTxReqId === 0) delete e.provenTxReqId
    // Post-cutover: route to proven_tx_reqs_legacy.
    // FK bypass is handled by the caller (disableForeignKeys before any transaction).
    const reqTable = await this.provenTxReqsTableName()
    const [id] = await this.toDb(trx)<TableProvenTxReq>(reqTable).insert(e)
    tx.provenTxReqId = id
    return tx.provenTxReqId
  }

  override async insertUser (user: TableUser, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(user, trx)
    if (e.userId === 0) delete e.userId
    const [id] = await this.toDb(trx)<TableUser>('users').insert(e)
    user.userId = id
    return user.userId
  }

  override async insertCertificateAuth (auth: AuthId, certificate: TableCertificateX): Promise<number> {
    if (!auth.userId || (certificate.userId && certificate.userId !== auth.userId)) throw new WERR_UNAUTHORIZED()
    certificate.userId = auth.userId
    return await this.insertCertificate(certificate)
  }

  override async insertCertificate (certificate: TableCertificateX, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(certificate, trx, undefined, ['isDeleted'])
    if (e.certificateId === 0) delete e.certificateId

    if (e.logger) delete e.logger

    const fields = e.fields
    if (e.fields) delete e.fields

    const [id] = await this.toDb(trx)<TableCertificate>('certificates').insert(e)
    certificate.certificateId = id

    if (fields) {
      for (const field of fields) {
        field.certificateId = id
        field.userId = certificate.userId
        await this.insertCertificateField(field, trx)
      }
    }

    return certificate.certificateId
  }

  override async insertCertificateField (certificateField: TableCertificateField, trx?: TrxToken): Promise<void> {
    const e = await this.validateEntityForInsert(certificateField, trx)
    await this.toDb(trx)<TableCertificate>('certificate_fields').insert(e)
  }

  override async insertOutputBasket (basket: TableOutputBasket, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(basket, trx, undefined, ['isDeleted'])
    if (e.basketId === 0) delete e.basketId
    const [id] = await this.toDb(trx)<TableOutputBasket>('output_baskets').insert(e)
    basket.basketId = id
    return basket.basketId
  }

  override async insertTransaction (tx: TableTransaction, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(tx, trx)
    if (e.transactionId === 0) delete e.transactionId
    // Post-cutover the canonical `transactions` table is the new schema which
    // does not carry legacy columns (description, status, satoshis, version...).
    // Legacy-shaped insertions belong in `transactions_legacy`. We route there
    // automatically so existing callers that still speak the legacy shape keep
    // working without a code change at every call site. FK enforcement is
    // bypassed because the renamed legacy table still references the renamed
    // `proven_txs_legacy` via its original `proven_txs` FK column name.
    const isSqlite = this.dbtype === 'SQLite'
    const postCutover = await this.isPostCutover()
    if (postCutover) {
      // SQLite needs FK_OFF because `legacy_alter_table = ON` left the
      // renamed legacy FK references pointing at the bare string "proven_txs"
      // which now resolves to nothing. MySQL preserves FK constraints by
      // name across RENAME TABLE so no FK toggle is required.
      if (isSqlite) await this.knex.raw('PRAGMA foreign_keys = OFF')
      try {
        const [legacyId] = await this.toDb(trx)<TableTransaction>('transactions_legacy').insert(e)
        tx.transactionId = legacyId
      } finally {
        if (isSqlite) await this.knex.raw('PRAGMA foreign_keys = ON')
      }

      /*
       * Sync path bridge: `insertTransaction` is called by the sync entity
       * (EntityTransaction.mergeNew) for transactions that already have a
       * txid and a status. We MUST also create the canonical
       * `transactions` + `actions` rows so downstream reads (`listOutputs`,
       * `listActions`) that JOIN against the canonical table see the data.
       *
       * Without this, sync writes land only in `transactions_legacy`,
       * outputs.transactionId points at a legacy id, the canonical-table
       * JOIN returns zero rows, and balance / output listings report 0
       * despite outputs sitting in the DB.
       *
       * We then RETURN the canonical transactionId rather than the legacy
       * one so the caller's syncMap maps to canonical ids. EntityOutput
       * picks up that mapping at line 301 of EntityOutput.ts.
       */
      if (tx.txid != null && tx.userId != null) {
        const txService = this.getTransactionService()
        if (txService != null) {
          const processing = transactionStatusToProcessing(tx.status as TransactionStatus)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const rawTxArr: number[] | undefined = Array.isArray(tx.rawTx)
            ? (tx.rawTx as number[])
            : (tx.rawTx != null ? Array.from(tx.rawTx as unknown as Buffer) : undefined)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const inputBeefArr: number[] | undefined = Array.isArray(tx.inputBEEF)
            ? (tx.inputBEEF as number[])
            : (tx.inputBEEF != null ? Array.from(tx.inputBEEF as unknown as Buffer) : undefined)
          const { transaction: canonicalTx } = await txService.findOrCreateActionForTxid({
            userId: tx.userId,
            txid: tx.txid,
            isOutgoing: !!tx.isOutgoing,
            description: tx.description ?? '',
            satoshisDelta: tx.satoshis ?? 0,
            reference: tx.reference ?? '',
            rawTx: rawTxArr,
            inputBeef: inputBeefArr,
            processing
          })
          tx.transactionId = canonicalTx.transactionId
          return canonicalTx.transactionId
        }
      }
      return tx.transactionId
    }
    const [id] = await this.toDb(trx)<TableTransaction>('transactions').insert(e)
    tx.transactionId = id
    return tx.transactionId
  }

  override async insertCommission (commission: TableCommission, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(commission, trx)
    if (e.commissionId === 0) delete e.commissionId
    // Post-cutover bridge-period: commissions.transactionId FKs new transactions.
    // During createAction the transactionId references transactions_legacy, so bypass FK.
    const postCutover = await this.isPostCutover()
    if (postCutover && this.dbtype === 'SQLite') {
      await this.knex.raw('PRAGMA foreign_keys = OFF')
      try {
        const [id] = await this.toDb(trx)<TableCommission>('commissions').insert(e)
        commission.commissionId = id
        return commission.commissionId
      } finally {
        await this.knex.raw('PRAGMA foreign_keys = ON')
      }
    }
    if (postCutover && this.dbtype === 'Postgres' && trx == null) {
      // No outer transaction — open one so `SET LOCAL session_replication_role`
      // (emitted by `transaction()`) covers the insert on the same connection.
      let id = 0
      await this.transaction(async (t) => {
        const [rowId] = await this.toDb(t)<TableCommission>('commissions').insert(e)
        id = rowId
      })
      commission.commissionId = id
      return commission.commissionId
    }
    const [id] = await this.toDb(trx)<TableCommission>('commissions').insert(e)
    commission.commissionId = id
    return commission.commissionId
  }

  override async insertOutput (output: TableOutput, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(output, trx)
    if (e.outputId === 0) delete e.outputId
    // Post-cutover bridge-period: outputs.transactionId FKs new transactions,
    // but new unsigned outputs reference transactions_legacy (bridge-period rows).
    // Engine-specific FK bypass: SQLite uses PRAGMA on the bare connection,
    // Postgres scopes the bypass to a fresh transaction (so the SET LOCAL emitted
    // by `transaction()` covers the insert on the same connection).
    const postCutover = await this.isPostCutover()
    if (postCutover && this.dbtype === 'SQLite') {
      await this.knex.raw('PRAGMA foreign_keys = OFF')
      try {
        const [id] = await this.toDb(trx)<TableOutput>('outputs').insert(e)
        output.outputId = id
        return output.outputId
      } finally {
        await this.knex.raw('PRAGMA foreign_keys = ON')
      }
    }
    if (postCutover && this.dbtype === 'Postgres' && trx == null) {
      let id = 0
      await this.transaction(async (t) => {
        const [rowId] = await this.toDb(t)<TableOutput>('outputs').insert(e)
        id = rowId
      })
      output.outputId = id
      return output.outputId
    }
    if (postCutover && this.dbtype === 'MySQL') {
      // MySQL bridge bypass — outputs.transactionId FK targets canonical
      // transactions but the value is a transactions_legacy id during the
      // bridge period. Session-scope FOREIGN_KEY_CHECKS for the insert.
      const runInTrx = async (t: Knex.Transaction): Promise<number> => {
        await t.raw('SET FOREIGN_KEY_CHECKS=0')
        try {
          const [rowId] = await t<TableOutput>('outputs').insert(e)
          return rowId
        } finally {
          await t.raw('SET FOREIGN_KEY_CHECKS=1')
        }
      }
      let id: number
      if (trx != null) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        id = await runInTrx(trx as unknown as Knex.Transaction<any, any[]>)
      } else {
        id = await this.knex.transaction(runInTrx)
      }
      output.outputId = id
      return output.outputId
    }
    const [id] = await this.toDb(trx)<TableOutput>('outputs').insert(e)
    output.outputId = id
    return output.outputId
  }

  override async insertOutputTag (tag: TableOutputTag, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(tag, trx, undefined, ['isDeleted'])
    if (e.outputTagId === 0) delete e.outputTagId
    const [id] = await this.toDb(trx)<TableOutputTag>('output_tags').insert(e)
    tag.outputTagId = id
    return tag.outputTagId
  }

  override async insertOutputTagMap (tagMap: TableOutputTagMap, trx?: TrxToken): Promise<void> {
    const e = await this.validateEntityForInsert(tagMap, trx, undefined, ['isDeleted'])
    await this.toDb(trx)<TableOutputTagMap>('output_tags_map').insert(e)
  }

  override async insertTxLabel (label: TableTxLabel, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(label, trx, undefined, ['isDeleted'])
    if (e.txLabelId === 0) delete e.txLabelId
    const [id] = await this.toDb(trx)<TableTxLabel>('tx_labels').insert(e)
    label.txLabelId = id
    return label.txLabelId
  }

  override async insertTxLabelMap (labelMap: TableTxLabelMap, trx?: TrxToken): Promise<void> {
    const e = await this.validateEntityForInsert(labelMap, trx, undefined, ['isDeleted'])
    // Post-cutover: tx_labels_map.transactionId references actions.actionId
    // (rebuilt during schema cutover). Sync paths that import legacy rows still
    // carry the legacy transactionId until repointLabelsToActionId remaps them.
    // Bypass FK on engines that enforce it for bridge writes.
    const postCutover = await this.isPostCutover()
    if (postCutover && this.dbtype === 'SQLite') {
      await this.dbBypassFks(true)
      try {
        await this.toDb(trx)<TableTxLabelMap>('tx_labels_map').insert(e)
      } finally {
        await this.dbBypassFks(false)
      }
      return
    }
    if (postCutover && this.dbtype === 'Postgres' && trx == null) {
      // Open a transaction so the `SET LOCAL session_replication_role`
      // emitted by `transaction()` and the insert share a connection.
      await this.transaction(async (t) => {
        await this.toDb(t)<TableTxLabelMap>('tx_labels_map').insert(e)
      })
      return
    }
    if (postCutover && this.dbtype === 'MySQL') {
      /*
       * MySQL post-cutover: `tx_labels_map.transactionId` FK now references
       * `actions.actionId` (rebuilt by `rebuildTxLabelsMap` during cutover).
       * createAction writes the map with the LEGACY transactionId of the
       * unsigned draft transaction in `transactions_legacy`. The action row
       * does not exist yet (processAction creates it later via
       * `repointLabelsToActionId`). Bypass FK for this single insert.
       *
       * `SET FOREIGN_KEY_CHECKS=0` is a session var. To make the bypass
       * cover the insert reliably even on a pooled connection, scope it to
       * a transaction whose connection runs both statements.
       */
      const runInTrx = async (t: Knex.Transaction): Promise<void> => {
        await t.raw('SET FOREIGN_KEY_CHECKS=0')
        try {
          await t<TableTxLabelMap>('tx_labels_map').insert(e)
        } finally {
          await t.raw('SET FOREIGN_KEY_CHECKS=1')
        }
      }
      if (trx != null) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await runInTrx(trx as unknown as Knex.Transaction<any, any[]>)
      } else {
        await this.knex.transaction(runInTrx)
      }
      return
    }
    await this.toDb(trx)<TableTxLabelMap>('tx_labels_map').insert(e)
  }

  override async insertMonitorEvent (event: TableMonitorEvent, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(event, trx)
    if (e.id === 0) delete e.id
    const [id] = await this.toDb(trx)<TableMonitorEvent>('monitor_events').insert(e)
    event.id = id
    return event.id
  }

  override async insertSyncState (syncState: TableSyncState, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(syncState, trx, ['when'], ['init'])
    if (e.syncStateId === 0) delete e.syncStateId
    const [id] = await this.toDb(trx)<TableSyncState>('sync_states').insert(e)
    syncState.syncStateId = id
    return syncState.syncStateId
  }

  override async updateCertificateField (
    certificateId: number,
    fieldName: string,
    update: Partial<TableCertificateField>,
    trx?: TrxToken
  ): Promise<number> {
    await this.verifyReadyForDatabaseAccess(trx)
    return await this.toDb(trx)<TableCertificateField>('certificate_fields')
      .where({ certificateId, fieldName })
      .update(this.validatePartialForUpdate(update))
  }

  override async updateCertificate (id: number, update: Partial<TableCertificate>, trx?: TrxToken): Promise<number> {
    await this.verifyReadyForDatabaseAccess(trx)
    return await this.toDb(trx)<TableCertificate>('certificates')
      .where({ certificateId: id })
      .update(this.validatePartialForUpdate(update, undefined, ['isDeleted']))
  }

  override async updateCommission (id: number, update: Partial<TableCommission>, trx?: TrxToken): Promise<number> {
    await this.verifyReadyForDatabaseAccess(trx)
    // Post-cutover: commissions.transactionId FK references the new-schema
    // `transactions` table. Legacy callers carry transactionId values that
    // still point at transactions_legacy. Bypass FK on engines that enforce
    // it; MySQL preserves FK metadata across cutover RENAME (no bypass).
    const postCutover = await this.isPostCutover()
    if (postCutover && this.dbtype === 'SQLite') {
      await this.knex.raw('PRAGMA foreign_keys = OFF')
      try {
        return await this.toDb(trx)<TableCommission>('commissions')
          .where({ commissionId: id })
          .update(this.validatePartialForUpdate(update))
      } finally {
        await this.knex.raw('PRAGMA foreign_keys = ON')
      }
    }
    if (postCutover && this.dbtype === 'Postgres' && trx == null) {
      let n = 0
      await this.transaction(async (t) => {
        n = await this.toDb(t)<TableCommission>('commissions')
          .where({ commissionId: id })
          .update(this.validatePartialForUpdate(update))
      })
      return n
    }
    return await this.toDb(trx)<TableCommission>('commissions')
      .where({ commissionId: id })
      .update(this.validatePartialForUpdate(update))
  }

  override async updateOutputBasket (id: number, update: Partial<TableOutputBasket>, trx?: TrxToken): Promise<number> {
    await this.verifyReadyForDatabaseAccess(trx)
    return await this.toDb(trx)<TableOutputBasket>('output_baskets')
      .where({ basketId: id })
      .update(this.validatePartialForUpdate(update, undefined, ['isDeleted']))
  }

  override async updateOutput (id: number, update: Partial<TableOutput>, trx?: TrxToken): Promise<number> {
    await this.verifyReadyForDatabaseAccess(trx)
    return await this.toDb(trx)<TableOutput>('outputs')
      .where({ outputId: id })
      .update(this.validatePartialForUpdate(update))
  }

  /**
   * Bulk-update many outputs in a single SQL statement (per shape group),
   * replacing N round-trips with at most a handful regardless of N.
   *
   * Updates are grouped by the set of columns whose values are constant across
   * the group. Per-row columns become `CASE outputId WHEN id THEN value ... END`
   * expressions. Works on both SQLite and MySQL.
   *
   * Falls back to per-row updates when the group is small enough that the CASE
   * overhead would dominate (currently: ≤ 2 rows).
   */
  async bulkUpdateOutputs (
    updates: Array<{ id: number, update: Partial<TableOutput> }>,
    trx?: TrxToken
  ): Promise<number> {
    if (updates.length === 0) return 0
    await this.verifyReadyForDatabaseAccess(trx)

    // Fast path for tiny lists.
    if (updates.length <= 2) {
      let n = 0
      for (const u of updates) n += await this.updateOutput(u.id, u.update, trx)
      return n
    }

    const k = this.toDb(trx)
    const knexRaw = this.knex

    // Group by the *shape* (which columns appear, and constant-vs-variable).
    // For commitNewTxToStorage shape we expect at most 2 groups: with/without
    // lockingScript cleared.
    type Group = {
      keyCols: string[]
      perRow: Map<string, Map<number, unknown>> // col → outputId → value
      ids: number[]
    }
    const groups = new Map<string, Group>()
    for (const { id, update } of updates) {
      const validated = this.validatePartialForUpdate({ ...update })
      const cols = Object.keys(validated).filter(c => c !== 'updated_at').sort()
      const key = cols.join('|')
      let g = groups.get(key)
      if (g == null) {
        g = { keyCols: cols, perRow: new Map(), ids: [] }
        for (const c of cols) g.perRow.set(c, new Map())
        groups.set(key, g)
      }
      g.ids.push(id)
      for (const c of cols) {
        g.perRow.get(c)!.set(id, (validated as Record<string, unknown>)[c])
      }
    }

    let totalUpdated = 0
    for (const g of groups.values()) {
      if (g.ids.length === 1) {
        const id = g.ids[0]
        const row: Record<string, unknown> = {}
        for (const c of g.keyCols) row[c] = g.perRow.get(c)!.get(id)
        row.updated_at = this.validateEntityDate(new Date())
        totalUpdated += await k<TableOutput>('outputs').where({ outputId: id }).update(row)
        continue
      }

      const set: Record<string, unknown> = {}
      for (const c of g.keyCols) {
        const values = g.perRow.get(c)!
        // If every row has the same value, emit a scalar update.
        const distinct = new Set<unknown>()
        for (const v of values.values()) distinct.add(v === undefined ? null : v)
        if (distinct.size === 1) {
          set[c] = [...distinct][0]
          continue
        }
        // CASE WHEN outputId = ? THEN ? ... ELSE c END
        const bindings: unknown[] = []
        const whens: string[] = []
        for (const [id, v] of values.entries()) {
          whens.push('WHEN ? THEN ?')
          bindings.push(id, v === undefined ? null : v)
        }
        set[c] = knexRaw.raw(`CASE outputId ${whens.join(' ')} ELSE ?? END`, [...bindings, c])
      }
      set.updated_at = this.validateEntityDate(new Date())
      totalUpdated += await k<TableOutput>('outputs').whereIn('outputId', g.ids).update(set)
    }

    return totalUpdated
  }

  override async updateOutputTagMap (
    outputId: number,
    tagId: number,
    update: Partial<TableOutputTagMap>,
    trx?: TrxToken
  ): Promise<number> {
    await this.verifyReadyForDatabaseAccess(trx)
    return await this.toDb(trx)<TableOutputTagMap>('output_tags_map')
      .where({ outputId, outputTagId: tagId })
      .update(this.validatePartialForUpdate(update, undefined, ['isDeleted']))
  }

  override async updateOutputTag (id: number, update: Partial<TableOutputTag>, trx?: TrxToken): Promise<number> {
    await this.verifyReadyForDatabaseAccess(trx)
    return await this.toDb(trx)<TableOutputTag>('output_tags')
      .where({ outputTagId: id })
      .update(this.validatePartialForUpdate(update, undefined, ['isDeleted']))
  }

  override async updateProvenTxReq (
    id: number | number[],
    update: Partial<TableProvenTxReq>,
    trx?: TrxToken
  ): Promise<number> {
    await this.verifyReadyForDatabaseAccess(trx)
    const reqTable = await this.provenTxReqsTableName()
    let r: number
    if (Array.isArray(id)) {
      r = await this.toDb(trx)<TableProvenTxReq>(reqTable)
        .whereIn('provenTxReqId', id)
        .update(this.validatePartialForUpdate(update))
    } else if (Number.isInteger(id)) {
      r = await this.toDb(trx)<TableProvenTxReq>(reqTable)
        .where({ provenTxReqId: id })
        .update(this.validatePartialForUpdate(update))
    } else {
      throw new WERR_INVALID_PARAMETER('id', 'transactionId or array of transactionId')
    }
    return r
  }

  override async updateProvenTx (id: number, update: Partial<TableProvenTx>, trx?: TrxToken): Promise<number> {
    await this.verifyReadyForDatabaseAccess(trx)
    const tableName = await this.provenTxsTableName()
    return await this.toDb(trx)<TableProvenTx>(tableName)
      .where({ provenTxId: id })
      .update(this.validatePartialForUpdate(update))
  }

  override async updateSyncState (id: number, update: Partial<TableSyncState>, trx?: TrxToken): Promise<number> {
    await this.verifyReadyForDatabaseAccess(trx)
    return await this.toDb(trx)<TableSyncState>('sync_states')
      .where({ syncStateId: id })
      .update(this.validatePartialForUpdate(update, ['when'], ['init']))
  }

  override async updateTransaction (
    id: number | number[],
    update: Partial<TableTransaction>,
    trx?: TrxToken
  ): Promise<number> {
    await this.verifyReadyForDatabaseAccess(trx)
    // Post-cutover the canonical `transactions` table is the new schema which
    // lacks legacy columns (userId, status, description, satoshis, version, ...).
    // Legacy-shaped updates belong in `transactions_legacy`, matching the
    // routing performed by `insertTransaction`.
    const isSqlite = this.dbtype === 'SQLite'
    const postCutover = await this.isPostCutover()
    const tableName = postCutover ? 'transactions_legacy' : 'transactions'
    if (postCutover && isSqlite) await this.knex.raw('PRAGMA foreign_keys = OFF')
    try {
      let r: number
      if (Array.isArray(id)) {
        r = await this.toDb(trx)<TableTransaction>(tableName)
          .whereIn('transactionId', id)
          .update(this.validatePartialForUpdate(update))
      } else if (Number.isInteger(id)) {
        r = await this.toDb(trx)<TableTransaction>(tableName)
          .where({ transactionId: id })
          .update(this.validatePartialForUpdate(update))
      } else {
        throw new WERR_INVALID_PARAMETER('id', 'transactionId or array of transactionId')
      }
      return r
    } finally {
      if (postCutover && isSqlite) await this.knex.raw('PRAGMA foreign_keys = ON')
    }
  }

  override async updateTxLabelMap (
    transactionId: number,
    txLabelId: number,
    update: Partial<TableTxLabelMap>,
    trx?: TrxToken
  ): Promise<number> {
    await this.verifyReadyForDatabaseAccess(trx)
    return await this.toDb(trx)<TableTxLabelMap>('tx_labels_map')
      .where({ transactionId, txLabelId })
      .update(this.validatePartialForUpdate(update, undefined, ['isDeleted']))
  }

  override async updateTxLabel (id: number, update: Partial<TableTxLabel>, trx?: TrxToken): Promise<number> {
    await this.verifyReadyForDatabaseAccess(trx)
    return await this.toDb(trx)<TableTxLabel>('tx_labels')
      .where({ txLabelId: id })
      .update(this.validatePartialForUpdate(update, undefined, ['isDeleted']))
  }

  override async updateUser (id: number, update: Partial<TableUser>, trx?: TrxToken): Promise<number> {
    await this.verifyReadyForDatabaseAccess(trx)
    return await this.toDb(trx)<TableUser>('users').where({ userId: id }).update(this.validatePartialForUpdate(update))
  }

  override async updateMonitorEvent (id: number, update: Partial<TableMonitorEvent>, trx?: TrxToken): Promise<number> {
    await this.verifyReadyForDatabaseAccess(trx)
    return await this.toDb(trx)<TableMonitorEvent>('monitor_events')
      .where({ id })
      .update(this.validatePartialForUpdate(update))
  }

  setupQuery<T extends object>(table: string, args: FindPartialSincePagedArgs<T>): Knex.QueryBuilder {
    const q = this.toDb(args.trx)<T>(table)
    if (args.partial && Object.keys(args.partial).length > 0) q.where(args.partial)
    if (args.since != null) q.where('updated_at', '>=', this.validateDateForWhere(args.since))
    if (args.orderDescending) {
      let sortColumn = ''
      switch (table) {
        case 'certificates':
          sortColumn = 'certificateId'
          break
        case 'commissions':
          sortColumn = 'commissionId'
          break
        case 'output_baskets':
          sortColumn = 'basketId'
          break
        case 'outputs':
          sortColumn = 'outputId'
          break
        case 'output_tags':
          sortColumn = 'outputTagId'
          break
        case 'proven_tx_reqs':
        case 'proven_tx_reqs_legacy':
          sortColumn = 'provenTxReqId'
          break
        case 'proven_txs':
        case 'proven_txs_legacy':
          sortColumn = 'provenTxId'
          break
        case 'sync_states':
          sortColumn = 'syncStateId'
          break
        case 'transactions':
        case 'transactions_legacy':
          sortColumn = 'transactionId'
          break
        case 'tx_labels':
          sortColumn = 'txLabelId'
          break
        case 'users':
          sortColumn = 'userId'
          break
        case 'monitor_events':
          sortColumn = 'id'
          break
        default:
          break
      }
      if (sortColumn !== '') {
        q.orderBy(sortColumn, 'desc')
      }
    }
    if (args.paged != null) {
      q.limit(args.paged.limit)
      q.offset(args.paged.offset || 0)
    }
    return q
  }

  findCertificateFieldsQuery (args: FindCertificateFieldsArgs): Knex.QueryBuilder {
    return this.setupQuery('certificate_fields', args)
  }

  findCertificatesQuery (args: FindCertificatesArgs): Knex.QueryBuilder {
    const q = this.setupQuery('certificates', args)
    if ((args.certifiers != null) && args.certifiers.length > 0) q.whereIn('certifier', args.certifiers)
    if ((args.types != null) && args.types.length > 0) q.whereIn('type', args.types)
    return q
  }

  findCommissionsQuery (args: FindCommissionsArgs): Knex.QueryBuilder {
    if (args.partial.lockingScript != null) {
      throw new WERR_INVALID_PARAMETER(
        'partial.lockingScript',
        'undefined. Commissions may not be found by lockingScript value.'
      )
    }
    return this.setupQuery('commissions', args)
  }

  findOutputBasketsQuery (args: FindOutputBasketsArgs): Knex.QueryBuilder {
    return this.setupQuery('output_baskets', args)
  }

  findOutputsQuery (args: FindOutputsArgs, count?: boolean): Knex.QueryBuilder {
    if (args.partial.lockingScript != null) {
      throw new WERR_INVALID_PARAMETER(
        'args.partial.lockingScript',
        'undefined. Outputs may not be found by lockingScript value.'
      )
    }
    const q = this.setupQuery('outputs', args)
    if ((args.txStatus != null) && args.txStatus.length > 0) {
      // Post-cutover the `transactions` table carries `processing`
      // (ProcessingStatus), not the legacy `status` column. We translate
      // the requested legacy status set to its ProcessingStatus equivalents
      // when the cutover has been applied; pre-cutover the original `status`
      // column lookup remains correct.
      if (this._postCutoverCache === true) {
        const processingFilter = this.legacyStatiToProcessing(args.txStatus)
        const filterList = processingFilter.map(s => "'" + s + "'").join(',')
        q.whereRaw(
          `(select processing from transactions where transactions.transactionId = outputs.transactionId) in (${filterList})`
        )
      } else {
        q.whereRaw(
          `(select status from transactions where transactions.transactionId = outputs.transactionId) in (${args.txStatus.map(s => "'" + s + "'").join(',')})`
        )
      }
    }
    if (args.noScript && !count) {
      const columns = outputColumnsWithoutLockingScript.map(c => `outputs.${c}`)
      q.select(columns)
    }
    return q
  }

  findOutputTagMapsQuery (args: FindOutputTagMapsArgs): Knex.QueryBuilder {
    const q = this.setupQuery('output_tags_map', args)
    if ((args.tagIds != null) && args.tagIds.length > 0) q.whereIn('outputTagId', args.tagIds)
    return q
  }

  findOutputTagsQuery (args: FindOutputTagsArgs): Knex.QueryBuilder {
    return this.setupQuery('output_tags', args)
  }

  findProvenTxReqsQuery (args: FindProvenTxReqsArgs, tableName = 'proven_tx_reqs'): Knex.QueryBuilder {
    if (args.partial.rawTx != null) { throw new WERR_INVALID_PARAMETER('args.partial.rawTx', 'undefined. ProvenTxReqs may not be found by rawTx value.') }
    if (args.partial.inputBEEF != null) {
      throw new WERR_INVALID_PARAMETER(
        'args.partial.inputBEEF',
        'undefined. ProvenTxReqs may not be found by inputBEEF value.'
      )
    }
    const q = this.setupQuery(tableName, args)
    if ((args.status != null) && args.status.length > 0) q.whereIn('status', args.status)
    if (args.txids != null) {
      const txids = args.txids.filter(txid => txid !== undefined)
      if (txids.length > 0) q.whereIn('txid', txids)
    }
    return q
  }

  findProvenTxsQuery (args: FindProvenTxsArgs, tableName = 'proven_txs'): Knex.QueryBuilder {
    if (args.partial.rawTx != null) { throw new WERR_INVALID_PARAMETER('args.partial.rawTx', 'undefined. ProvenTxs may not be found by rawTx value.') }
    if (args.partial.merklePath != null) {
      throw new WERR_INVALID_PARAMETER(
        'args.partial.merklePath',
        'undefined. ProvenTxs may not be found by merklePath value.'
      )
    }
    return this.setupQuery(tableName, args)
  }

  findStaleMerkleRootsQuery (args: FindStaleMerkleRootsArgs, tableName = 'proven_txs'): Knex.QueryBuilder {
    const q = this.toDb(args.trx)(tableName)
    q.where('height', '=', args.height)
    q.where('merkleRoot', '!=', args.merkleRoot)
    q.select('merkleRoot')
    q.distinct('merkleRoot')
    return q
  }

  findSyncStatesQuery (args: FindSyncStatesArgs): Knex.QueryBuilder {
    return this.setupQuery('sync_states', args)
  }

  findTransactionsQuery (args: FindTransactionsArgs, count?: boolean): Knex.QueryBuilder {
    if (args.partial.rawTx != null) { throw new WERR_INVALID_PARAMETER('args.partial.rawTx', 'undefined. Transactions may not be found by rawTx value.') }
    if (args.partial.inputBEEF != null) {
      throw new WERR_INVALID_PARAMETER(
        'args.partial.inputBEEF',
        'undefined. Transactions may not be found by inputBEEF value.'
      )
    }
    // Post-cutover the original per-user `transactions` table has been
    // renamed to `transactions_legacy`. `findTransactions` returns the
    // legacy shape (status / userId / satoshis / description / etc.) so it
    // must route at the renamed table to preserve the legacy read surface
    // through the bridge period. New-canonical per-txid reads go through
    // TransactionService.
    const tableName = this._postCutoverCache === true
      ? 'transactions_legacy'
      : 'transactions'
    const q = this.setupQuery(tableName, args)
    if ((args.status != null) && args.status.length > 0) q.whereIn('status', args.status)
    if (args.from != null) q.where('created_at', '>=', this.validateDateForWhere(args.from))
    if (args.to != null) q.where('created_at', '<', this.validateDateForWhere(args.to))
    if (args.noRawTx && !count) {
      const columns = transactionColumnsWithoutRawTx.map(c => `${tableName}.${c}`)
      q.select(columns)
    }
    return q
  }

  findTxLabelMapsQuery (args: FindTxLabelMapsArgs): Knex.QueryBuilder {
    const q = this.setupQuery('tx_labels_map', args)
    if ((args.labelIds != null) && args.labelIds.length > 0) q.whereIn('txLabelId', args.labelIds)
    return q
  }

  findTxLabelsQuery (args: FindTxLabelsArgs): Knex.QueryBuilder {
    return this.setupQuery('tx_labels', args)
  }

  findUsersQuery (args: FindUsersArgs): Knex.QueryBuilder {
    return this.setupQuery('users', args)
  }

  findMonitorEventsQuery (args: FindMonitorEventsArgs): Knex.QueryBuilder {
    return this.setupQuery('monitor_events', args)
  }

  override async findCertificatesAuth (auth: AuthId, args: FindCertificatesArgs): Promise<TableCertificateX[]> {
    if (!auth.userId || (args.partial.userId && args.partial.userId !== auth.userId)) throw new WERR_UNAUTHORIZED()
    args.partial.userId = auth.userId
    return await this.findCertificates(args)
  }

  override async findOutputBasketsAuth (auth: AuthId, args: FindOutputBasketsArgs): Promise<TableOutputBasket[]> {
    if (!auth.userId || (args.partial.userId && args.partial.userId !== auth.userId)) throw new WERR_UNAUTHORIZED()
    args.partial.userId = auth.userId
    return await this.findOutputBaskets(args)
  }

  override async findOutputsAuth (auth: AuthId, args: FindOutputsArgs): Promise<TableOutput[]> {
    if (!auth.userId || (args.partial.userId && args.partial.userId !== auth.userId)) throw new WERR_UNAUTHORIZED()
    args.partial.userId = auth.userId
    return await this.findOutputs(args)
  }

  override async findCertificateFields (args: FindCertificateFieldsArgs): Promise<TableCertificateField[]> {
    return this.validateEntities(await this.findCertificateFieldsQuery(args))
  }

  override async findCertificates (args: FindCertificatesArgs): Promise<TableCertificateX[]> {
    const q = this.findCertificatesQuery(args)
    let r: TableCertificateX[] = await q
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

  override async findCommissions (args: FindCommissionsArgs): Promise<TableCommission[]> {
    const q = this.findCommissionsQuery(args)
    const r = await q
    return this.validateEntities(r, undefined, ['isRedeemed'])
  }

  override async findOutputBaskets (args: FindOutputBasketsArgs): Promise<TableOutputBasket[]> {
    const q = this.findOutputBasketsQuery(args)
    const r = await q
    return this.validateEntities(r, undefined, ['isDeleted'])
  }

  override async findOutputs (args: FindOutputsArgs): Promise<TableOutput[]> {
    const q = this.findOutputsQuery(args)
    const r = await q
    if (!args.noScript) {
      for (const o of r) {
        await this.validateOutputScript(o, args.trx)
      }
    }
    return this.validateEntities(r, undefined, ['spendable', 'change'])
  }

  override async findOutputTagMaps (args: FindOutputTagMapsArgs): Promise<TableOutputTagMap[]> {
    const q = this.findOutputTagMapsQuery(args)
    const r = await q
    return this.validateEntities(r, undefined, ['isDeleted'])
  }

  override async findOutputTags (args: FindOutputTagsArgs): Promise<TableOutputTag[]> {
    const q = this.findOutputTagsQuery(args)
    const r = await q
    return this.validateEntities(r, undefined, ['isDeleted'])
  }

  override async findProvenTxReqs (args: FindProvenTxReqsArgs): Promise<TableProvenTxReq[]> {
    const reqTable = await this.provenTxReqsTableName()
    const q = this.findProvenTxReqsQuery(args, reqTable)
    const r = await q
    return this.validateEntities(r, undefined, ['notified', 'wasBroadcast'])
  }

  override async findProvenTxs (args: FindProvenTxsArgs): Promise<TableProvenTx[]> {
    const tableName = await this.provenTxsTableName()
    const q = this.findProvenTxsQuery(args, tableName)
    const r = await q
    return this.validateEntities(r)
  }

  override async findStaleMerkleRoots (args: FindStaleMerkleRootsArgs): Promise<string[]> {
    const tableName = await this.provenTxsTableName()
    const q = this.findStaleMerkleRootsQuery(args, tableName)
    const r = await q
    return r.map((row: { merkleRoot: string }) => row.merkleRoot)
  }

  override async findSyncStates (args: FindSyncStatesArgs): Promise<TableSyncState[]> {
    const q = this.findSyncStatesQuery(args)
    const r = await q
    return this.validateEntities(r, ['when'], ['init'])
  }

  override async findTransactions (args: FindTransactionsArgs): Promise<TableTransaction[]> {
    const q = this.findTransactionsQuery(args)
    const r = await q
    if (!args.noRawTx) {
      for (const t of r) {
        await this.validateRawTransaction(t, args.trx)
      }
    }
    return this.validateEntities(r, undefined, ['isOutgoing'])
  }

  /**
   * Post-cutover: queries `transactions_legacy` for unsigned/pending rows
   * created by `createAction` (which have no real txid yet and therefore have no
   * new-schema counterpart).  Falls back to the standard `findTransactions` pre-cutover.
   *
   * Used by `processAction.validateCommitNewTxToStorageArgs` to locate the
   * unsigned transaction row by `{userId, reference}`.
   *
   * Mapping §2: legacy `unsigned` / `unprocessed` → these rows only exist in
   * `transactions_legacy` post-cutover; new `transactions` has `processing` not
   * `status` and no unsigned-state rows.
   */
  override async findLegacyTransactions (args: FindTransactionsArgs): Promise<TableTransaction[]> {
    const postCutover = await this.isPostCutover()
    if (!postCutover) {
      // Pre-cutover: standard transactions table
      return await this.findTransactions(args)
    }
    // Post-cutover: unsigned/unprocessed rows live in transactions_legacy
    const q = this.setupQuery('transactions_legacy', args)
    if ((args.status != null) && args.status.length > 0) q.whereIn('status', args.status)
    if (args.from != null) q.where('created_at', '>=', this.validateDateForWhere(args.from))
    if (args.to != null) q.where('created_at', '<', this.validateDateForWhere(args.to))
    if (args.noRawTx) {
      const columns = transactionColumnsWithoutRawTx.map(c => `transactions_legacy.${c}`)
      q.select(columns)
    }
    const r = await q
    if (!args.noRawTx) {
      for (const t of r) {
        await this.validateRawTransaction(t, args.trx)
      }
    }
    return this.validateEntities(r, undefined, ['isOutgoing'])
  }

  /**
   * Post-cutover: updates `transactions_legacy` (where unsigned rows live).
   * Pre-cutover: delegates to `updateTransaction`.
   *
   * Used by `processAction.commitNewTxToStorage` to write back the real txid
   * and status to the legacy row that was created by `createAction`.
   *
   * Mapping §2: legacy `unsigned` → `unprocessed` transition and txid write-back
   * must go to `transactions_legacy` post-cutover, not new `transactions`.
   */
  override async updateLegacyTransaction (id: number | number[], update: Partial<TableTransaction>, trx?: TrxToken): Promise<number> {
    const postCutover = await this.isPostCutover()
    if (!postCutover) {
      return await this.updateTransaction(id, update, trx)
    }
    // Post-cutover: unsigned rows are in transactions_legacy
    await this.verifyReadyForDatabaseAccess(trx)
    let r: number
    if (Array.isArray(id)) {
      r = await this.toDb(trx)<TableTransaction>('transactions_legacy')
        .whereIn('transactionId', id)
        .update(this.validatePartialForUpdate(update))
    } else if (Number.isInteger(id)) {
      r = await this.toDb(trx)<TableTransaction>('transactions_legacy')
        .where({ transactionId: id })
        .update(this.validatePartialForUpdate(update))
    } else {
      throw new WERR_INVALID_PARAMETER('id', 'transactionId or array of transactionId')
    }
    return r
  }

  /**
   * Post-cutover SQLite: temporarily disable FK enforcement around the
   * `outputs.spentBy = legacyTransactionId` UPDATE. The `outputs.spentBy` FK
   * references `transactions.transactionId` after cutover, but unsigned
   * transactions from `createAction` live in `transactions_legacy` (their new-schema
   * counterpart is created later by `processAction`).
   *
   * IMPORTANT: We bypass `updateOutput` (and therefore `verifyReadyForDatabaseAccess`)
   * because `verifyReadyForDatabaseAccess` always re-enables FK with
   * `PRAGMA foreign_keys = ON`, which would undo our bypass. Instead we
   * directly run the UPDATE via the raw knex handle.
   *
   * Pre-cutover or MySQL: delegates to `updateOutput` unchanged.
   *
   * Mapping §2: bridge-period spentBy references transactions_legacy during
   * createAction; FK bypass covers this until processAction wires the new-schema.
   */
  override async markOutputAsSpentBy (
    outputId: number,
    update: Partial<TableOutput>,
    trx?: TrxToken
  ): Promise<void> {
    const postCutover = await this.isPostCutover()
    const isSqlite = this.dbtype === 'SQLite'
    if (postCutover && isSqlite) {
      // Build the UPDATE payload the same way validatePartialForUpdate does,
      // but WITHOUT calling verifyReadyForDatabaseAccess (which always issues
      // PRAGMA foreign_keys = ON, undoing our bypass).
      const now = new Date().toISOString()
      const payload: Record<string, unknown> = { updated_at: now }
      for (const [k, v] of Object.entries(update)) {
        if (v === undefined) {
          payload[k] = null
        } else if (Array.isArray(v) && (v.length === 0 || typeof v[0] === 'number')) {
          payload[k] = Buffer.from(v)
        } else {
          payload[k] = v
        }
      }
      // Strategy: FK is a connection-level setting in SQLite. PRAGMA changes
      // inside a Knex transaction are no-ops (SQLite restriction), but PRAGMA
      // changes OUTSIDE a transaction persist.
      //
      // When called with trx (inside a transaction): the caller is expected to have
      // already disabled FK before opening the transaction. We run the UPDATE via
      // the transaction handle (no PRAGMA calls needed here — they'd be no-ops or
      // pool-exhausting anyway).
      //
      // When called without trx (outside a transaction): disable FK, run UPDATE,
      // re-enable FK.
      if (trx != null) {
        // Inside caller's transaction — FK was disabled before the transaction.
        // Just run the UPDATE; do NOT try to PRAGMA here (no-op or timeout).
        this.whenLastAccess = new Date()
        await (this.toDb(trx))<TableOutput>('outputs')
          .where({ outputId })
          .update(payload)
      } else {
        // Outside any transaction — we can safely toggle FK on the bare connection.
        await this.knex.raw('PRAGMA foreign_keys = OFF')
        try {
          this.whenLastAccess = new Date()
          await this.knex('outputs').where({ outputId }).update(payload)
        } finally {
          await this.knex.raw('PRAGMA foreign_keys = ON')
        }
      }
    } else {
      await this.updateOutput(outputId, update, trx)
    }
  }

  /**
   * Post-cutover bridge-period FK bypass. Called before opening a transaction
   * that contains bridge inserts (legacy-table rows whose FKs reference
   * renamed tables).
   *
   * SQLite: PRAGMA foreign_keys=OFF on the bare connection (PRAGMA inside
   * a Knex transaction is a no-op on SQLite, so the call must precede the
   * `knex.transaction()`).
   * Postgres: session_replication_role=replica skips FK + trigger enforcement
   * for the duration of the connection's session.
   * MySQL: pre-cutover FK semantics already accommodate the bridge inserts
   * via the rebuild pattern; no-op here.
   */
  override async disableForeignKeys (): Promise<void> {
    const postCutover = await this.isPostCutover()
    if (!postCutover) return
    if (this.dbtype === 'SQLite') {
      // better-sqlite3 is single-connection — PRAGMA on the bare connection
      // carries into the subsequent transaction.
      await this.dbBypassFks(true)
      return
    }
    if (this.dbtype === 'Postgres') {
      // Pg has a real connection pool. Defer the actual `SET LOCAL` to the
      // transaction body (see `transaction()`), since this method has no way
      // to know which connection the upcoming transaction will acquire.
      this._fkBypassPending = true
    }
  }

  /**
   * Re-enable FK after the transaction opened via `disableForeignKeys()` completes.
   * Mirrors `disableForeignKeys` engine handling.
   */
  override async enableForeignKeys (): Promise<void> {
    const postCutover = await this.isPostCutover()
    if (!postCutover) return
    if (this.dbtype === 'SQLite') {
      await this.dbBypassFks(false)
      return
    }
    if (this.dbtype === 'Postgres') {
      // Postgres bypass auto-reverts on COMMIT/ROLLBACK via SET LOCAL.
      this._fkBypassPending = false
    }
  }

  override async findTxLabelMaps (args: FindTxLabelMapsArgs): Promise<TableTxLabelMap[]> {
    const q = this.findTxLabelMapsQuery(args)
    const r = await q
    return this.validateEntities(r, undefined, ['isDeleted'])
  }

  override async findTxLabels (args: FindTxLabelsArgs): Promise<TableTxLabel[]> {
    const q = this.findTxLabelsQuery(args)
    const r = await q
    return this.validateEntities(r, undefined, ['isDeleted'])
  }

  override async findUsers (args: FindUsersArgs): Promise<TableUser[]> {
    const q = this.findUsersQuery(args)
    const r = await q
    return this.validateEntities(r)
  }

  override async recentlyActiveUsers (limit = 50, trx?: TrxToken): Promise<TableUser[]> {
    await this.verifyReadyForDatabaseAccess(trx)
    const latestOutputs = this.toDb(trx)('outputs as o')
      .select('o.userId')
      .max({ lastOutputCreatedAt: 'o.created_at' })
      .groupBy('o.userId')
      .as('latest_outputs')

    const rows = await this.toDb(trx)('users as u')
      .join(latestOutputs, 'u.userId', 'latest_outputs.userId')
      .select('u.*')
      .orderBy('latest_outputs.lastOutputCreatedAt', 'desc')
      .limit(limit)

    return this.validateEntities(rows as TableUser[])
  }

  override async findMonitorEvents (args: FindMonitorEventsArgs): Promise<TableMonitorEvent[]> {
    const q = this.findMonitorEventsQuery(args)
    const r = await q
    return this.validateEntities(r, ['when'], undefined)
  }

  async getCount<T extends object>(q: Knex.QueryBuilder<T, T[]>): Promise<number> {
    q.count()
    const r = await q
    return r[0]['count(*)']
  }

  override async countCertificateFields (args: FindCertificateFieldsArgs): Promise<number> {
    return await this.getCount(this.findCertificateFieldsQuery(args))
  }

  override async countCertificates (args: FindCertificatesArgs): Promise<number> {
    return await this.getCount(this.findCertificatesQuery(args))
  }

  override async countCommissions (args: FindCommissionsArgs): Promise<number> {
    return await this.getCount(this.findCommissionsQuery(args))
  }

  override async countOutputBaskets (args: FindOutputBasketsArgs): Promise<number> {
    return await this.getCount(this.findOutputBasketsQuery(args))
  }

  override async countOutputs (args: FindOutputsArgs): Promise<number> {
    return await this.getCount(this.findOutputsQuery(args, true))
  }

  override async countOutputTagMaps (args: FindOutputTagMapsArgs): Promise<number> {
    return await this.getCount(this.findOutputTagMapsQuery(args))
  }

  override async countOutputTags (args: FindOutputTagsArgs): Promise<number> {
    return await this.getCount(this.findOutputTagsQuery(args))
  }

  override async countProvenTxReqs (args: FindProvenTxReqsArgs): Promise<number> {
    const reqTable = await this.provenTxReqsTableName()
    return await this.getCount(this.findProvenTxReqsQuery(args, reqTable))
  }

  override async countProvenTxs (args: FindProvenTxsArgs): Promise<number> {
    const tableName = await this.provenTxsTableName()
    return await this.getCount(this.findProvenTxsQuery(args, tableName))
  }

  override async countSyncStates (args: FindSyncStatesArgs): Promise<number> {
    return await this.getCount(this.findSyncStatesQuery(args))
  }

  override async countTransactions (args: FindTransactionsArgs): Promise<number> {
    return await this.getCount(this.findTransactionsQuery(args, true))
  }

  override async countTxLabelMaps (args: FindTxLabelMapsArgs): Promise<number> {
    return await this.getCount(this.findTxLabelMapsQuery(args))
  }

  override async countTxLabels (args: FindTxLabelsArgs): Promise<number> {
    return await this.getCount(this.findTxLabelsQuery(args))
  }

  override async countUsers (args: FindUsersArgs): Promise<number> {
    return await this.getCount(this.findUsersQuery(args))
  }

  override async countMonitorEvents (args: FindMonitorEventsArgs): Promise<number> {
    return await this.getCount(this.findMonitorEventsQuery(args))
  }

  override async destroy (): Promise<void> {
    await this.knex?.destroy()
  }

  override async migrate (storageName: string, storageIdentityKey: string): Promise<string> {
    // Check if this is a SQLite database by looking at the Knex client config
    const clientName = (this.knex.client as { config?: { client?: string } }).config?.client || ''
    const isSQLite = clientName.includes('sqlite')

    // For SQLite, disable transactions during migrations and turn off foreign keys.
    // PRAGMA foreign_keys is silently ignored inside transactions, so we must
    // disable transactions for the migration to allow the PRAGMA to take effect.
    // See: https://github.com/knex/knex/issues/4155
    if (isSQLite) {
      await this.knex.raw('PRAGMA foreign_keys = OFF;')
    }

    const config = {
      migrationSource: new KnexMigrations(this.chain, storageName, storageIdentityKey, 1024),
      disableTransactions: isSQLite
    }
    await this.knex.migrate.latest(config)
    const version = await this.knex.migrate.currentVersion(config)

    // Re-enable foreign key checks for SQLite
    if (isSQLite) {
      await this.knex.raw('PRAGMA foreign_keys = ON;')
    }

    return version
  }

  override async dropAllData (): Promise<void> {
    // Only using migrations to migrate down, don't need valid properties for settings table.
    const migrationSource = new KnexMigrations('test', '', '', 1024)

    // Check if this is a SQLite database by looking at the Knex client config
    const clientName = (this.knex.client as { config?: { client?: string } }).config?.client || ''
    const isSQLite = clientName.includes('sqlite')

    // For SQLite, disable transactions during migrations and turn off foreign keys.
    // PRAGMA foreign_keys is silently ignored inside transactions, so we must
    // disable transactions for the migration to allow the PRAGMA to take effect.
    // See: https://github.com/knex/knex/issues/4155
    const config = {
      migrationSource,
      disableTransactions: isSQLite
    }
    const count = Object.keys(migrationSource.migrations).length

    // Disable foreign key checks for SQLite before dropping tables
    // This is necessary for better-sqlite3 which enforces FK constraints by default
    if (isSQLite) {
      await this.knex.raw('PRAGMA foreign_keys = OFF;')
    }

    for (let i = 0; i < count; i++) {
      try {
        const r = await this.knex.migrate.down(config)
        if (!r) {
          console.error('Migration returned falsy result await this.knex.migrate.down(config)')
          break
        }
      } catch (migrationError: unknown) {
        // migrate.down throws when there are no more migrations to roll back — this is
        // the expected terminal condition, so we stop iterating rather than propagating.
        console.debug('migrate.down stopped (no more migrations or error):', migrationError)
        break
      }
    }

    // Re-enable foreign key checks for SQLite
    if (isSQLite) {
      await this.knex.raw('PRAGMA foreign_keys = ON;')
    }
  }

  override async transaction<T>(scope: (trx: TrxToken) => Promise<T>, trx?: TrxToken): Promise<T> {
    if (trx != null) return await scope(trx)

    /*
     * Post-cutover bridge-period FK bypass.
     *
     * Postgres: emit `SET LOCAL session_replication_role = 'replica'` as the
     * FIRST statement inside every transaction post-cutover. Connection-scoped
     * and auto-reverts on COMMIT/ROLLBACK. Necessary because pg uses a real
     * connection pool, so a `disableForeignKeys()` call BEFORE the transaction
     * would land on a different connection.
     *
     * MySQL: emit `SET FOREIGN_KEY_CHECKS=0` as the first statement and
     * `SET FOREIGN_KEY_CHECKS=1` as the last (before COMMIT) so the bypass
     * stays scoped to this transaction's connection. The cutover rebuild
     * re-targets outputs/commissions FKs to canonical `transactions`, so the
     * bridge inserts (whose values point at `transactions_legacy`) need this
     * bypass during the createAction → processAction window.
     *
     * SQLite: PRAGMA on the bare connection before the transaction opens
     * (better-sqlite3 is single-connection so the setting carries in).
     * Handled by `disableForeignKeys`.
     *
     * The bypass is harmless on non-bridge writes (FK invariants are still
     * enforced by the schema at later checkpoints).
     */
    const postCutover = this._postCutoverCache === true
    const pgBypass = postCutover && this.dbtype === 'Postgres'
    const mysqlBypass = postCutover && this.dbtype === 'MySQL'

    return await this.knex.transaction<T>(async knextrx => {
      if (pgBypass) {
        await knextrx.raw("SET LOCAL session_replication_role = 'replica'")
      }
      if (mysqlBypass) {
        await knextrx.raw('SET FOREIGN_KEY_CHECKS=0')
      }
      try {
        const trx = knextrx as TrxToken
        return await scope(trx)
      } finally {
        if (mysqlBypass) {
          // Restore default before COMMIT so the connection returns to the
          // pool with FK enforcement on.
          try { await knextrx.raw('SET FOREIGN_KEY_CHECKS=1') } catch { /* trx may be rolling back */ }
        }
      }
    })
  }

  /**
   * Convert the standard optional `TrxToken` parameter into either a direct knex database instance,
   * or a Knex.Transaction as appropriate.
   */
  toDb (trx?: TrxToken) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (trx == null) ? this.knex : trx as Knex.Transaction<any, any[]>
    this.whenLastAccess = new Date()
    return db
  }

  async validateRawTransaction (t: TableTransaction, trx?: TrxToken): Promise<void> {
    // if there is no txid or there is a rawTransaction return what we have.
    if (t.rawTx || !t.txid) return

    // rawTransaction is missing, see if we moved it ...

    const rawTx = await this.getRawTxOfKnownValidTransaction(t.txid, undefined, undefined, trx)
    if (rawTx == null) return
    t.rawTx = rawTx
  }

  _verifiedReadyForDatabaseAccess = false

  /**
   * Make sure database is ready for access:
   *
   * - dateScheme is known
   * - foreign key constraints are enabled
   *
   * @param trx
   */
  async verifyReadyForDatabaseAccess (trx?: TrxToken): Promise<DBType> {
    this._settings ??= await this.readSettings()

    // Always run the PRAGMA for SQLite to ensure foreign key constraints are enabled.
    // This is necessary because PRAGMA foreign_keys is a per-connection setting,
    // and connection pools may create new connections that don't have it set.
    // The performance impact is minimal as SQLite handles this efficiently.
    if (this._settings.dbtype === 'SQLite') {
      await this.toDb(trx).raw('PRAGMA foreign_keys = ON;')
    }

    this._verifiedReadyForDatabaseAccess = true

    return this._settings.dbtype
  }

  /** Convert every number-array value to a Buffer and every undefined to null on an arbitrary object. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private serialiseForKnex (v: any): void {
    for (const key of Object.keys(v)) {
      const val = v[key]
      if (Array.isArray(val) && (val.length === 0 || typeof val[0] === 'number')) {
        v[key] = Buffer.from(val)
      } else if (val === undefined) {
        v[key] = null
      }
    }
  }

  /** Apply optional date-field coercion list in-place. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private coerceDateFields (v: any, dateFields?: string[]): void {
    if (dateFields == null) return
    for (const df of dateFields) {
      if (v[df]) v[df] = this.validateOptionalEntityDate(v[df])
    }
  }

  /** Apply optional boolean-field coercion list in-place. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private coerceBooleanFields (v: any, booleanFields?: string[]): void {
    if (booleanFields == null) return
    for (const df of booleanFields) {
      if (v[df] !== undefined) v[df] = v[df] ? 1 : 0
    }
  }

  /**
   * Helper to force uniform behavior across database engines.
   * Use to process the update template for entities being updated.
   */
  validatePartialForUpdate<T extends EntityTimeStamp>(
    update: Partial<T>,
    dateFields?: string[],
    booleanFields?: string[]
  ): Partial<T> {
    if (!this.dbtype) throw new WERR_INTERNAL('must call verifyReadyForDatabaseAccess first')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const v: any = update
    if (v.created_at) v.created_at = this.validateEntityDate(v.created_at)
    if (v.updated_at) v.updated_at = this.validateEntityDate(v.updated_at)
    if (!v.created_at) delete v.created_at
    if (!v.updated_at) v.updated_at = this.validateEntityDate(new Date())
    this.coerceDateFields(v, dateFields)
    this.coerceBooleanFields(update, booleanFields)
    this.serialiseForKnex(v)
    this.isDirty = true
    return v
  }

  /**
   * Helper to force uniform behavior across database engines.
   * Use to process new entities being inserted into the database.
   */
  async validateEntityForInsert<T extends EntityTimeStamp>(
    entity: T,
    trx?: TrxToken,
    dateFields?: string[],
    booleanFields?: string[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    await this.verifyReadyForDatabaseAccess(trx)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const v: any = { ...entity }
    v.created_at = this.validateOptionalEntityDate(v.created_at, true)!
    v.updated_at = this.validateOptionalEntityDate(v.updated_at, true)!
    if (!v.created_at) delete v.created_at
    if (!v.updated_at) delete v.updated_at
    this.coerceDateFields(v, dateFields)
    this.coerceBooleanFields(entity, booleanFields)
    this.serialiseForKnex(v)
    this.isDirty = true
    return v
  }

  override async getLabelsForTransactionId (transactionId?: number, trx?: TrxToken): Promise<TableTxLabel[]> {
    if (transactionId === undefined) return []
    const labels = await this.toDb(trx)<TableTxLabel>('tx_labels')
      .join('tx_labels_map', 'tx_labels_map.txLabelId', 'tx_labels.txLabelId')
      .where('tx_labels_map.transactionId', transactionId)
      .whereNot('tx_labels_map.isDeleted', true)
      .whereNot('tx_labels.isDeleted', true)
    return this.validateEntities(labels, undefined, ['isDeleted'])
  }

  override async getTagsForOutputId (outputId: number, trx?: TrxToken): Promise<TableOutputTag[]> {
    const tags = await this.toDb(trx)<TableOutputTag>('output_tags')
      .join('output_tags_map', 'output_tags_map.outputTagId', 'output_tags.outputTagId')
      .where('output_tags_map.outputId', outputId)
      .whereNot('output_tags_map.isDeleted', true)
      .whereNot('output_tags.isDeleted', true)
    return this.validateEntities(tags, undefined, ['isDeleted'])
  }

  override async purgeData (params: PurgeParams, trx?: TrxToken): Promise<PurgeResults> {
    return await purgeData(this, params, trx)
  }

  override async reviewStatus (args: { agedLimit: Date, trx?: TrxToken }): Promise<{ log: string }> {
    return await reviewStatus(this, args)
  }

  /**
   * Counts the outputs for userId in basketId that are spendable: true
   * AND whose transaction status is one of:
   * - completed
   * - unproven
   * - sending (if excludeSending is false)
   */
  async countChangeInputs (userId: number, basketId: number, excludeSending: boolean): Promise<number> {
    const legacyStatus: TransactionStatus[] = ['completed', 'unproven']
    if (!excludeSending) legacyStatus.push('sending')
    const postCutover = await this.isPostCutover()
    const q = this.knex<TableOutput>('outputs as o')
      .join('transactions as t', 'o.transactionId', 't.transactionId')
      .where({ 'o.userId': userId, 'o.spendable': true, 'o.basketId': basketId })
    if (postCutover) {
      q.whereIn('t.processing', this.legacyStatiToProcessing(legacyStatus))
    } else {
      q.whereIn('t.status', legacyStatus)
    }
    const count = await this.getCount(q)
    return count
  }

  override async findOutputsByIds (outputIds: number[], trx?: TrxToken): Promise<Record<number, TableOutput>> {
    const byId: Record<number, TableOutput> = {}
    if (outputIds.length < 1) return byId
    const rows = await this.toDb(trx)<TableOutput>('outputs').whereIn('outputId', outputIds).select('*')
    for (const o of rows) {
      await this.validateOutputScript(o, trx)
    }
    const vrows = this.validateEntities(rows, undefined, ['spendable', 'change'])
    for (const row of vrows) {
      if (row.outputId !== undefined) byId[row.outputId] = row
    }
    return byId
  }

  override async findOutputsByOutpoints (
    userId: number,
    outpoints: Array<{ txid: string, vout: number }>,
    trx?: TrxToken
  ): Promise<Record<string, TableOutput>> {
    const byOutpoint: Record<string, TableOutput> = {}
    if (outpoints.length < 1) return byOutpoint
    const outpointSet = new Set(outpoints.map(o => `${o.txid}.${o.vout}`))
    const txids = [...new Set(outpoints.map(o => o.txid))]
    const vouts = [...new Set(outpoints.map(o => o.vout))]
    const rows = await this.toDb(trx)<TableOutput>('outputs')
      .where('userId', userId)
      .whereIn('txid', txids)
      .whereIn('vout', vouts)
      .select('*')
    // Only return requested outpoints, vouts of one txid may end up matching another txid that was not requested.
    const filteredRows = rows.filter(r => outpointSet.has(`${r.txid}.${r.vout}`))
    const vrows = this.validateEntities(filteredRows, undefined, ['spendable', 'change'])
    for (const row of vrows) {
      await this.validateOutputScript(row, trx)
      byOutpoint[`${row.txid}.${row.vout}`] = row
    }
    return byOutpoint
  }

  override async findOrInsertOutputBasketsBulk (
    userId: number,
    names: string[],
    trx?: TrxToken
  ): Promise<Record<string, TableOutputBasket>> {
    const byName: Record<string, TableOutputBasket> = {}
    if (names.length < 1) return byName
    const uniqueNames = [...new Set(names)]
    const existing = await this.toDb(trx)<TableOutputBasket>('output_baskets')
      .where('userId', userId)
      .whereIn('name', uniqueNames)
      .select('*')
    for (const basket of existing) {
      if (basket.isDeleted) await this.updateOutputBasket(verifyId(basket.basketId), { isDeleted: false }, trx)
      byName[basket.name] = basket
    }
    for (const name of uniqueNames) {
      if (!byName[name]) byName[name] = await this.findOrInsertOutputBasket(userId, name, trx)
    }
    return byName
  }

  override async findOrInsertOutputTagsBulk (
    userId: number,
    tags: string[],
    trx?: TrxToken
  ): Promise<Record<string, TableOutputTag>> {
    const byTag: Record<string, TableOutputTag> = {}
    if (tags.length < 1) return byTag
    const uniqueTags = [...new Set(tags)]
    const existing = await this.toDb(trx)<TableOutputTag>('output_tags')
      .where('userId', userId)
      .whereIn('tag', uniqueTags)
      .select('*')
    for (const outputTag of existing) {
      if (outputTag.isDeleted) await this.updateOutputTag(verifyId(outputTag.outputTagId), { isDeleted: false }, trx)
      byTag[outputTag.tag] = outputTag
    }
    for (const tag of uniqueTags) {
      if (!byTag[tag]) byTag[tag] = await this.findOrInsertOutputTag(userId, tag, trx)
    }
    return byTag
  }

  override async sumSpendableSatoshisInBasket (
    userId: number,
    basketId: number,
    excludeSending: boolean,
    trx?: TrxToken
  ): Promise<number> {
    const legacyStatus: TransactionStatus[] = ['completed', 'unproven']
    if (!excludeSending) legacyStatus.push('sending')
    const postCutover = await this.isPostCutover()
    const q = this.toDb(trx)<TableOutput>('outputs as o')
      .join('transactions as t', 'o.transactionId', 't.transactionId')
      .where({ 'o.userId': userId, 'o.spendable': true, 'o.basketId': basketId })
    if (postCutover) {
      q.whereIn('t.processing', this.legacyStatiToProcessing(legacyStatus))
    } else {
      q.whereIn('t.status', legacyStatus)
    }
    const row = await q.sum({ totalSatoshis: 'o.satoshis' }).first()
    return Number(((row != null) && (row as Record<string, unknown>).totalSatoshis) || 0)
  }

  /**
   *  Finds closest matching available change output to use as input for new transaction.
   *
   * Transactionally allocate the output such that
   */
  async allocateChangeInput (
    userId: number,
    basketId: number,
    targetSatoshis: number,
    exactSatoshis: number | undefined,
    excludeSending: boolean,
    transactionId: number
  ): Promise<TableOutput | undefined> {
    const legacyStatus: TransactionStatus[] = ['completed', 'unproven']
    if (!excludeSending) legacyStatus.push('sending')
    const postCutover = await this.isPostCutover()
    const processingFilter = postCutover ? this.legacyStatiToProcessing(legacyStatus) : undefined

    /*
     * Post-cutover bridge-period: `transactionId` here is a legacy row in
     * `transactions_legacy` (new unsigned tx created by createAction). The
     * `outputs.spentBy` FK now references `transactions.transactionId`, so
     * setting spentBy to a transactions_legacy ID would violate the constraint.
     *
     * Engines that enforce FK at COMMIT-or-statement time (SQLite, Postgres)
     * need FK bypass active for the duration of the change-input transaction
     * so the bridge-period spentBy → transactions_legacy value lands. MySQL
     * preserves FK metadata across the cutover RENAME via information_schema
     * rewrite, so its bridge writes do not need a bypass.
     *
     * Engine notes:
     *   SQLite — PRAGMA foreign_keys is silently ignored inside transactions,
     *            so we toggle FK on the bare connection BEFORE opening the
     *            transaction. better-sqlite3 is single-connection, so the
     *            bypass holds for the subsequent transaction.
     *   Postgres — `SET LOCAL session_replication_role = 'replica'` inside the
     *              transaction scopes the bypass to the same connection's
     *              session. We acquire the connection via knex.transaction
     *              then issue SET LOCAL as the first statement; the setting
     *              auto-reverts on COMMIT/ROLLBACK.
     */
    const isSqlite = this.dbtype === 'SQLite'
    const isPostgres = this.dbtype === 'Postgres'
    const isMysql = this.dbtype === 'MySQL'
    const bridgeBypass = postCutover && (isSqlite || isPostgres || isMysql)
    if (bridgeBypass && isSqlite) {
      await this.dbBypassFks(true)
    }

    let r: TableOutput | undefined
    try {
      r = await this.knex.transaction(async trx => {
        if (bridgeBypass && isPostgres) {
          await trx.raw("SET LOCAL session_replication_role = 'replica'")
        }
        if (bridgeBypass && isMysql) {
          // Session-scoped FK bypass for the transaction's connection.
          // MySQL post-cutover: outputs.spentBy FK now targets canonical
          // transactions, but the bridge value points at transactions_legacy.
          await trx.raw('SET FOREIGN_KEY_CHECKS=0')
        }
        /*
         * Single-query coin selection — semantically identical to the prior
         * three-step ladder (exact → smallest-over → largest-under) but with
         * one round-trip instead of up to three.
         *
         * Bucket priority (ORDER BY first key, ASC):
         *   0 — satoshis = exactSatoshis  (only when exactSatoshis is set)
         *   1 — satoshis ≥ targetSatoshis (smallest-over preferred)
         *   2 — satoshis < targetSatoshis (largest-under fallback)
         *
         * Within bucket 1 sort satoshis ASC, outputId ASC.
         * Within bucket 2 sort satoshis DESC, outputId DESC.
         * Bucket 0 sort outputId ASC for determinism.
         *
         * Note: passing `exactSatoshis = null` makes `satoshis = ?` evaluate to
         * UNKNOWN in SQL — the CASE then falls through and bucket 0 is never
         * picked, matching the JS-side `if (exactSatoshis !== undefined)` gate.
         */
        const k = trx
        const q = k<TableOutput>('outputs as o')
          .join('transactions as t', 'o.transactionId', 't.transactionId')
          .where('o.userId', userId)
          .where('o.spendable', true)
          .where('o.basketId', basketId)
          .select('o.*')
        if (processingFilter != null) {
          q.whereIn('t.processing', processingFilter)
        } else {
          q.whereIn('t.status', legacyStatus)
        }
        const exactBind = exactSatoshis ?? null
        q.orderByRaw(
          'CASE WHEN o.satoshis = ? THEN 0 WHEN o.satoshis >= ? THEN 1 ELSE 2 END ASC, ' +
          'CASE WHEN o.satoshis >= ? THEN o.satoshis END ASC, ' +
          'CASE WHEN o.satoshis < ? THEN o.satoshis END DESC, ' +
          'CASE WHEN o.satoshis >= ? THEN o.outputId END ASC, ' +
          'CASE WHEN o.satoshis < ? THEN o.outputId END DESC',
          [exactBind, targetSatoshis, targetSatoshis, targetSatoshis, targetSatoshis, targetSatoshis]
        )
        const output: TableOutput | undefined = await q.first()

        if (output == null) return undefined

        // Post-cutover: transactionId is in transactions_legacy; FK would fail.
        // markOutputAsSpentBy disables FK via raw knex handle, bypassing
        // verifyReadyForDatabaseAccess that would re-enable it.
        // Mapping §2: bridge-period spentBy → transactions_legacy during createAction.
        await this.markOutputAsSpentBy(
          output.outputId,
          {
            spendable: false,
            spentBy: transactionId
          },
          trx
        )

        // Keep behavior identical to the pre-optimization path: ensure lockingScript
        // is present even when it was offloaded from outputs into rawTx storage.
        await this.validateOutputScript(output, trx)

        output.spendable = false
        output.spentBy = transactionId
        if (bridgeBypass && isMysql) {
          // Restore FK enforcement before COMMIT so subsequent statements
          // on this connection (after pool return) get default behaviour.
          await trx.raw('SET FOREIGN_KEY_CHECKS=1')
        }
        return output
      })
    } finally {
      if (bridgeBypass && isSqlite) {
        await this.dbBypassFks(false)
      }
      // Postgres bypass auto-reverts on COMMIT/ROLLBACK via SET LOCAL.
    }

    return r
  }

  /** Convert null→undefined and Buffer→number[] on a retrieved entity in-place. */
  private deserialiseFromKnex<T>(entity: T): void {
    for (const key of Object.keys(entity as object)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const val = (entity as any)[key]
      if (val === null) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(entity as any)[key] = undefined
      } else if (Buffer.isBuffer(val)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(entity as any)[key] = Array.from(val)
      }
    }
  }

  /**
   * Helper to force uniform behavior across database engines.
   * Use to process all individual records with time stamps retreived from database.
   */
  validateEntity<T extends EntityTimeStamp>(entity: T, dateFields?: string[], booleanFields?: string[]): T {
    entity.created_at = this.validateDate(entity.created_at)
    entity.updated_at = this.validateDate(entity.updated_at)
    if (dateFields != null) {
      for (const df of dateFields) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((entity as any)[df]) (entity as any)[df] = this.validateDate((entity as any)[df])
      }
    }
    if (booleanFields != null) {
      for (const df of booleanFields) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((entity as any)[df] !== undefined) (entity as any)[df] = !!(entity as any)[df]
      }
    }
    this.deserialiseFromKnex(entity)
    return entity
  }

  /**
   * Helper to force uniform behavior across database engines.
   * Use to process all arrays of records with time stamps retreived from database.
   * @returns input `entities` array with contained values validated.
   */
  validateEntities<T extends EntityTimeStamp>(entities: T[], dateFields?: string[], booleanFields?: string[]): T[] {
    for (let i = 0; i < entities.length; i++) {
      entities[i] = this.validateEntity(entities[i], dateFields, booleanFields)
    }
    return entities
  }

  async adminStats (adminIdentityKey: string): Promise<AdminStatsResult> {
    if (this.dbtype !== 'MySQL') throw new WERR_NOT_IMPLEMENTED('adminStats, only MySQL is supported')

    const monitorEvent = verifyOneOrNone(
      await this.findMonitorEvents({
        partial: { event: 'MonitorCallHistory' },
        orderDescending: true,
        paged: { limit: 1 }
      })
    )
    const monitorStats: ServicesCallHistory | undefined = (monitorEvent != null) ? JSON.parse(monitorEvent.details!) : undefined
    const servicesStats = this.getServices().getServicesCallHistory(true)

    const one_day_ago = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const one_week_ago = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const one_month_ago = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

    const [
      [
        {
          usersDay,
          usersMonth,
          usersWeek,
          usersTotal,
          transactionsDay,
          transactionsMonth,
          transactionsWeek,
          transactionsTotal,
          txCompletedDay,
          txCompletedMonth,
          txCompletedWeek,
          txCompletedTotal,
          txFailedDay,
          txFailedMonth,
          txFailedWeek,
          txFailedTotal,
          txAbandonedDay,
          txAbandonedMonth,
          txAbandonedWeek,
          txAbandonedTotal,
          txUnprocessedDay,
          txUnprocessedMonth,
          txUnprocessedWeek,
          txUnprocessedTotal,
          txSendingDay,
          txSendingMonth,
          txSendingWeek,
          txSendingTotal,
          txUnprovenDay,
          txUnprovenMonth,
          txUnprovenWeek,
          txUnprovenTotal,
          txUnsignedDay,
          txUnsignedMonth,
          txUnsignedWeek,
          txUnsignedTotal,
          txNosendDay,
          txNosendMonth,
          txNosendWeek,
          txNosendTotal,
          txNonfinalDay,
          txNonfinalMonth,
          txNonfinalWeek,
          txNonfinalTotal,
          txUnfailDay,
          txUnfailMonth,
          txUnfailWeek,
          txUnfailTotal,
          satoshisDefaultDay,
          satoshisDefaultMonth,
          satoshisDefaultWeek,
          satoshisDefaultTotal,
          satoshisOtherDay,
          satoshisOtherMonth,
          satoshisOtherWeek,
          satoshisOtherTotal,
          basketsDay,
          basketsMonth,
          basketsWeek,
          basketsTotal,
          labelsDay,
          labelsMonth,
          labelsWeek,
          labelsTotal,
          tagsDay,
          tagsMonth,
          tagsWeek,
          tagsTotal
        }
      ]
    ] = await this.knex.raw(`
select
    (select count(*) from users where created_at > '${one_day_ago}') as usersDay,
    (select count(*) from users where created_at > '${one_week_ago}') as usersWeek,
    (select count(*) from users where created_at > '${one_month_ago}') as usersMonth,
	  (select count(*) from users) as usersTotal,
    (select count(*) from transactions where created_at > '${one_day_ago}') as transactionsDay,
    (select count(*) from transactions where created_at > '${one_week_ago}') as transactionsWeek,
    (select count(*) from transactions where created_at > '${one_month_ago}') as transactionsMonth,
	  (select count(*) from transactions) as transactionsTotal,
    (select count(*) from transactions where status = 'completed' and created_at > '${one_day_ago}') as txCompletedDay,
    (select count(*) from transactions where status = 'completed' and created_at > '${one_week_ago}') as txCompletedWeek,
    (select count(*) from transactions where status = 'completed' and created_at > '${one_month_ago}') as txCompletedMonth,
	  (select count(*) from transactions where status = 'completed') as txCompletedTotal,
    (select count(*) from transactions where status = 'failed' and not txid is null and created_at > '${one_day_ago}') as txFailedDay,
    (select count(*) from transactions where status = 'failed' and not txid is null and created_at > '${one_week_ago}') as txFailedWeek,
    (select count(*) from transactions where status = 'failed' and not txid is null and created_at > '${one_month_ago}') as txFailedMonth,
	  (select count(*) from transactions where status = 'failed' and not txid is null) as txFailedTotal,
    (select count(*) from transactions where status = 'failed' and txid is null and created_at > '${one_day_ago}') as txAbandonedDay,
    (select count(*) from transactions where status = 'failed' and txid is null and created_at > '${one_week_ago}') as txAbandonedWeek,
    (select count(*) from transactions where status = 'failed' and txid is null and created_at > '${one_month_ago}') as txAbandonedMonth,
	  (select count(*) from transactions where status = 'failed' and txid is null) as txAbandonedTotal,
    (select count(*) from transactions where status = 'unprocessed' and created_at > '${one_day_ago}') as txUnprocessedDay,
    (select count(*) from transactions where status = 'unprocessed' and created_at > '${one_week_ago}') as txUnprocessedWeek,
    (select count(*) from transactions where status = 'unprocessed' and created_at > '${one_month_ago}') as txUnprocessedMonth,
	  (select count(*) from transactions where status = 'unprocessed') as txUnprocessedTotal,
    (select count(*) from transactions where status = 'sending' and created_at > '${one_day_ago}') as txSendingDay,
    (select count(*) from transactions where status = 'sending' and created_at > '${one_week_ago}') as txSendingWeek,
    (select count(*) from transactions where status = 'sending' and created_at > '${one_month_ago}') as txSendingMonth,
	  (select count(*) from transactions where status = 'sending') as txSendingTotal,
    (select count(*) from transactions where status = 'unproven' and created_at > '${one_day_ago}') as txUnprovenDay,
    (select count(*) from transactions where status = 'unproven' and created_at > '${one_week_ago}') as txUnprovenWeek,
    (select count(*) from transactions where status = 'unproven' and created_at > '${one_month_ago}') as txUnprovenMonth,
	  (select count(*) from transactions where status = 'unproven') as txUnprovenTotal,
    (select count(*) from transactions where status = 'unsigned' and created_at > '${one_day_ago}') as txUnsignedDay,
    (select count(*) from transactions where status = 'unsigned' and created_at > '${one_week_ago}') as txUnsignedWeek,
    (select count(*) from transactions where status = 'unsigned' and created_at > '${one_month_ago}') as txUnsignedMonth,
	  (select count(*) from transactions where status = 'unsigned') as txUnsignedTotal,
    (select count(*) from transactions where status = 'nosend' and created_at > '${one_day_ago}') as txNosendDay,
    (select count(*) from transactions where status = 'nosend' and created_at > '${one_week_ago}') as txNosendWeek,
    (select count(*) from transactions where status = 'nosend' and created_at > '${one_month_ago}') as txNosendMonth,
	  (select count(*) from transactions where status = 'nosend') as txNosendTotal,
    (select count(*) from transactions where status = 'nonfinal' and created_at > '${one_day_ago}') as txNonfinalDay,
    (select count(*) from transactions where status = 'nonfinal' and created_at > '${one_week_ago}') as txNonfinalWeek,
    (select count(*) from transactions where status = 'nonfinal' and created_at > '${one_month_ago}') as txNonfinalMonth,
	  (select count(*) from transactions where status = 'nonfinal') as txNonfinalTotal,
    (select count(*) from transactions where status = 'unfail' and created_at > '${one_day_ago}') as txUnfailDay,
    (select count(*) from transactions where status = 'unfail' and created_at > '${one_week_ago}') as txUnfailWeek,
    (select count(*) from transactions where status = 'unfail' and created_at > '${one_month_ago}') as txUnfailMonth,
	  (select count(*) from transactions where status = 'unfail') as txUnfailTotal,
    (select sum(o.satoshis) from outputs o, transactions t where o.transactionId = t.transactionId and t.status = 'completed' and o.spendable = 1 and o.change = 1 and o.created_at > '${one_day_ago}') as satoshisDefaultDay,
    (select sum(o.satoshis) from outputs o, transactions t where o.transactionId = t.transactionId and t.status = 'completed' and o.spendable = 1 and o.change = 1 and o.created_at > '${one_week_ago}') as satoshisDefaultWeek,
    (select sum(o.satoshis) from outputs o, transactions t where o.transactionId = t.transactionId and t.status = 'completed' and o.spendable = 1 and o.change = 1 and o.created_at > '${one_month_ago}') as satoshisDefaultMonth,
	  (select sum(o.satoshis) from outputs o, transactions t where o.transactionId = t.transactionId and t.status = 'completed' and o.spendable = 1 and o.change = 1) as satoshisDefaultTotal,
    (select sum(o.satoshis) from outputs o, transactions t where o.transactionId = t.transactionId and t.status = 'completed' and o.spendable = 1 and o.change = 0 and not o.basketId is null and o.created_at > '${one_day_ago}') as satoshisOtherDay,
    (select sum(o.satoshis) from outputs o, transactions t where o.transactionId = t.transactionId and t.status = 'completed' and o.spendable = 1 and o.change = 0 and not o.basketId is null and o.created_at > '${one_week_ago}') as satoshisOtherWeek,
    (select sum(o.satoshis) from outputs o, transactions t where o.transactionId = t.transactionId and t.status = 'completed' and o.spendable = 1 and o.change = 0 and not o.basketId is null and o.created_at > '${one_month_ago}') as satoshisOtherMonth,
	  (select sum(o.satoshis) from outputs o, transactions t where o.transactionId = t.transactionId and t.status = 'completed' and o.spendable = 1 and o.change = 0 and not o.basketId is null) as satoshisOtherTotal,
    (select count(*) from output_baskets where created_at > '${one_day_ago}') as basketsDay,
    (select count(*) from output_baskets where created_at > '${one_week_ago}') as basketsWeek,
    (select count(*) from output_baskets where created_at > '${one_month_ago}') as basketsMonth,
	  (select count(*) from output_baskets) as basketsTotal,
    (select count(*) from tx_labels where created_at > '${one_day_ago}') as labelsDay,
    (select count(*) from tx_labels where created_at > '${one_week_ago}') as labelsWeek,
    (select count(*) from tx_labels where created_at > '${one_month_ago}') as labelsMonth,
	  (select count(*) from tx_labels) as labelsTotal,
    (select count(*) from output_tags where created_at > '${one_day_ago}') as tagsDay,
    (select count(*) from output_tags where created_at > '${one_week_ago}') as tagsWeek,
    (select count(*) from output_tags where created_at > '${one_month_ago}') as tagsMonth,
	  (select count(*) from output_tags) as tagsTotal
      `)
    const r: AdminStatsResult = {
      monitorStats,
      servicesStats,
      requestedBy: adminIdentityKey,
      when: new Date().toISOString(),
      usersDay,
      usersWeek,
      usersMonth,
      usersTotal,
      transactionsDay,
      transactionsWeek,
      transactionsMonth,
      transactionsTotal,
      txCompletedDay,
      txCompletedWeek,
      txCompletedMonth,
      txCompletedTotal,
      txFailedDay,
      txFailedWeek,
      txFailedMonth,
      txFailedTotal,
      txAbandonedDay,
      txAbandonedWeek,
      txAbandonedMonth,
      txAbandonedTotal,
      txUnprocessedDay,
      txUnprocessedWeek,
      txUnprocessedMonth,
      txUnprocessedTotal,
      txSendingDay,
      txSendingWeek,
      txSendingMonth,
      txSendingTotal,
      txUnprovenDay,
      txUnprovenWeek,
      txUnprovenMonth,
      txUnprovenTotal,
      txUnsignedDay,
      txUnsignedWeek,
      txUnsignedMonth,
      txUnsignedTotal,
      txNosendDay,
      txNosendWeek,
      txNosendMonth,
      txNosendTotal,
      txNonfinalDay,
      txNonfinalWeek,
      txNonfinalMonth,
      txNonfinalTotal,
      txUnfailDay,
      txUnfailWeek,
      txUnfailMonth,
      txUnfailTotal,
      satoshisDefaultDay: Number(satoshisDefaultDay),
      satoshisDefaultWeek: Number(satoshisDefaultWeek),
      satoshisDefaultMonth: Number(satoshisDefaultMonth),
      satoshisDefaultTotal: Number(satoshisDefaultTotal),
      satoshisOtherDay: Number(satoshisOtherDay),
      satoshisOtherWeek: Number(satoshisOtherWeek),
      satoshisOtherMonth: Number(satoshisOtherMonth),
      satoshisOtherTotal: Number(satoshisOtherTotal),
      basketsDay,
      basketsWeek,
      basketsMonth,
      basketsTotal,
      labelsDay,
      labelsWeek,
      labelsMonth,
      labelsTotal,
      tagsDay,
      tagsWeek,
      tagsMonth,
      tagsTotal
    }
    return r
  }
}
