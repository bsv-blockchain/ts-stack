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

import { EntityTimeStamp, TransactionStatus } from '../sdk/types'

export interface StorageKnexOptions extends StorageProviderOptions {
  /**
   * Knex database interface initialized with valid connection configuration.
   */
  knex: Knex
}

export class StorageKnex extends StorageProvider implements WalletStorageProvider {
  knex: Knex

  constructor (options: StorageKnexOptions) {
    super(options)
    if (options.knex == null) throw new WERR_INVALID_PARAMETER('options.knex', 'valid')
    this.knex = options.knex
  }

  async readSettings (): Promise<TableSettings> {
    return this.validateEntity(verifyOne(await this.toDb(undefined)<TableSettings>('settings')))
  }

  override async getProvenOrRawTx (txid: string, trx?: TrxToken): Promise<ProvenOrRawTx> {
    const k = this.toDb(trx)
    const r: ProvenOrRawTx = {
      proven: undefined,
      rawTx: undefined,
      inputBEEF: undefined
    }

    r.proven = verifyOneOrNone(await this.findProvenTxs({ partial: { txid } }))
    if (r.proven == null) {
      const reqRawTx = verifyOneOrNone(
        await k('proven_tx_reqs')
          .where('txid', txid)
          .whereIn('status', ['unsent', 'unmined', 'unconfirmed', 'sending', 'nosend', 'completed'])
          .select('rawTx', 'inputBEEF')
      )
      if (reqRawTx != null) {
        r.rawTx = Array.from(reqRawTx.rawTx)
        r.inputBEEF = Array.from(reqRawTx.inputBEEF)
      }
    }
    return r
  }

  dbTypeSubstring (source: string, fromOffset: number, forLength?: number): string {
    if (this.dbtype === 'MySQL') return `substring(${source} from ${fromOffset} for ${String(forLength)})`
    return `substr(${source}, ${fromOffset}, ${String(forLength)})`
  }

  private normaliseKnexRawResult (rs: unknown): Array<{ rawTx: Buffer | null }> {
    if (this.dbtype === 'MySQL') return (rs as Array<Array<{ rawTx: Buffer | null }>>)[0]
    return rs as Array<{ rawTx: Buffer | null }>
  }

  private async getRawTxSlice (txid: string, offset: number, length: number, trx?: TrxToken): Promise<number[] | undefined> {
    const sub = this.dbTypeSubstring('rawTx', offset + 1, length)
    let rs = await this.toDb(trx).raw(`select ${sub} as rawTx from proven_txs where txid = '${txid}'`)
    const proven = verifyOneOrNone(this.normaliseKnexRawResult(rs))
    if (proven?.rawTx != null) return Array.from(proven.rawTx)
    rs = await this.toDb(trx).raw(
      `select ${sub} as rawTx from proven_tx_reqs where txid = '${txid}' and status in ('unsent', 'nosend', 'sending', 'unmined', 'completed', 'unfail')`
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
    if (txid == null || txid === '') return undefined
    if (!this.isAvailable()) await this.makeAvailable()
    if (Number.isInteger(offset) && Number.isInteger(length)) {
      return await this.getRawTxSlice(txid, offset as number, length as number, trx)
    }
    const r = await this.getProvenOrRawTx(txid, trx)
    return r.proven != null ? r.proven.rawTx : r.rawTx
  }

  getProvenTxsForUserQuery (args: FindForUserSincePagedArgs): Knex.QueryBuilder {
    const k = this.toDb(args.trx)
    let q = k('proven_txs').where(function () {
      void this.whereExists(
        k
          .select('*')
          .from('transactions')
          .whereRaw(`proven_txs.provenTxId = transactions.provenTxId and transactions.userId = ${args.userId}`)
      )
    })
    if (args.paged != null) {
      q = q.limit(args.paged.limit)
      q = q.offset(args.paged.offset ?? 0)
    }
    if (args.since != null) q = q.where('updated_at', '>=', this.validateDateForWhere(args.since))
    return q
  }

  override async getProvenTxsForUser (args: FindForUserSincePagedArgs): Promise<TableProvenTx[]> {
    const q = this.getProvenTxsForUserQuery(args)
    const rs = await q
    return this.validateEntities(rs)
  }

  getProvenTxReqsForUserQuery (args: FindForUserSincePagedArgs): Knex.QueryBuilder {
    const k = this.toDb(args.trx)
    let q = k('proven_tx_reqs').where(function () {
      void this.whereExists(
        k
          .select('*')
          .from('transactions')
          .whereRaw(`proven_tx_reqs.txid = transactions.txid and transactions.userId = ${args.userId}`)
      )
    })
    if (args.paged != null) {
      q = q.limit(args.paged.limit)
      q = q.offset(args.paged.offset ?? 0)
    }
    if (args.since != null) q = q.where('updated_at', '>=', this.validateDateForWhere(args.since))
    return q
  }

  override async getProvenTxReqsForUser (args: FindForUserSincePagedArgs): Promise<TableProvenTxReq[]> {
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
      q = q.offset(args.paged.offset ?? 0)
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
      q = q.offset(args.paged.offset ?? 0)
    }
    return q
  }

  override async getOutputTagMapsForUser (args: FindForUserSincePagedArgs): Promise<TableOutputTagMap[]> {
    const q = this.getOutputTagMapsForUserQuery(args)
    const rs = await q
    return this.validateEntities(rs, undefined, ['isDeleted'])
  }

  override async listActions (auth: AuthId, vargs: Validation.ValidListActionsArgs): Promise<ListActionsResult> {
    if (auth.userId == null) throw new WERR_UNAUTHORIZED()
    return await listActions(this, auth, vargs)
  }

  override async listOutputs (auth: AuthId, vargs: Validation.ValidListOutputsArgs): Promise<ListOutputsResult> {
    if (auth.userId == null) throw new WERR_UNAUTHORIZED()
    return await listOutputs(this, auth, vargs)
  }

  override async insertProvenTx (tx: TableProvenTx, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(tx, trx)
    if (e.provenTxId === 0) delete e.provenTxId
    const [id] = await this.toDb(trx)<TableProvenTx>('proven_txs').insert(e)
    tx.provenTxId = id
    return tx.provenTxId
  }

  override async insertProvenTxReq (tx: TableProvenTxReq, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(tx, trx)
    if (e.provenTxReqId === 0) delete e.provenTxReqId
    const [id] = await this.toDb(trx)<TableProvenTxReq>('proven_tx_reqs').insert(e)
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
    if (auth.userId == null || (certificate.userId != null && certificate.userId !== 0 && certificate.userId !== auth.userId)) throw new WERR_UNAUTHORIZED()
    certificate.userId = auth.userId
    return await this.insertCertificate(certificate)
  }

  override async insertCertificate (certificate: TableCertificateX, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(certificate, trx, undefined, ['isDeleted'])
    if (e.certificateId === 0) delete e.certificateId

    if (e.logger != null) delete e.logger

    const fields = e.fields
    if (e.fields != null) delete e.fields

    const [id] = await this.toDb(trx)<TableCertificate>('certificates').insert(e)
    certificate.certificateId = id

    if (fields != null) {
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
    const [id] = await this.toDb(trx)<TableTransaction>('transactions').insert(e)
    tx.transactionId = id
    return tx.transactionId
  }

  override async insertCommission (commission: TableCommission, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(commission, trx)
    if (e.commissionId === 0) delete e.commissionId
    const [id] = await this.toDb(trx)<TableCommission>('commissions').insert(e)
    commission.commissionId = id
    return commission.commissionId
  }

  override async insertOutput (output: TableOutput, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(output, trx)
    if (e.outputId === 0) delete e.outputId
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
    let r: number
    if (Array.isArray(id)) {
      r = await this.toDb(trx)<TableProvenTxReq>('proven_tx_reqs')
        .whereIn('provenTxReqId', id)
        .update(this.validatePartialForUpdate(update))
    } else if (Number.isInteger(id)) {
      r = await this.toDb(trx)<TableProvenTxReq>('proven_tx_reqs')
        .where({ provenTxReqId: id })
        .update(this.validatePartialForUpdate(update))
    } else {
      throw new WERR_INVALID_PARAMETER('id', 'transactionId or array of transactionId')
    }
    return r
  }

  override async updateProvenTx (id: number, update: Partial<TableProvenTx>, trx?: TrxToken): Promise<number> {
    await this.verifyReadyForDatabaseAccess(trx)
    return await this.toDb(trx)<TableProvenTx>('proven_txs')
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
    let r: number
    if (Array.isArray(id)) {
      r = await this.toDb(trx)<TableTransaction>('transactions')
        .whereIn('transactionId', id)
        .update(this.validatePartialForUpdate(update))
    } else if (Number.isInteger(id)) {
      r = await this.toDb(trx)<TableTransaction>('transactions')
        .where({ transactionId: id })
        .update(this.validatePartialForUpdate(update))
    } else {
      throw new WERR_INVALID_PARAMETER('id', 'transactionId or array of transactionId')
    }
    return r
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
    if (args.partial != null && Object.keys(args.partial).length > 0) void q.where(args.partial)
    if (args.since != null) void q.where('updated_at', '>=', this.validateDateForWhere(args.since))
    if (args.orderDescending === true) {
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
          sortColumn = 'provenTxReqId'
          break
        case 'proven_txs':
          sortColumn = 'provenTxId'
          break
        case 'sync_states':
          sortColumn = 'syncStateId'
          break
        case 'transactions':
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
        void q.orderBy(sortColumn, 'desc')
      }
    }
    if (args.paged != null) {
      void q.limit(args.paged.limit)
      void q.offset(args.paged.offset ?? 0)
    }
    return q
  }

  findCertificateFieldsQuery (args: FindCertificateFieldsArgs): Knex.QueryBuilder {
    return this.setupQuery('certificate_fields', args)
  }

  findCertificatesQuery (args: FindCertificatesArgs): Knex.QueryBuilder {
    const q = this.setupQuery('certificates', args)
    if ((args.certifiers != null) && args.certifiers.length > 0) void q.whereIn('certifier', args.certifiers)
    if ((args.types != null) && args.types.length > 0) void q.whereIn('type', args.types)
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
      void q.whereRaw(
        `(select status from transactions where transactions.transactionId = outputs.transactionId) in (${args.txStatus.map(s => "'" + s + "'").join(',')})`
      )
    }
    if ((args.noScript === true) && count !== true) {
      const columns = outputColumnsWithoutLockingScript.map(c => `outputs.${c}`)
      void q.select(columns)
    }
    return q
  }

  findOutputTagMapsQuery (args: FindOutputTagMapsArgs): Knex.QueryBuilder {
    const q = this.setupQuery('output_tags_map', args)
    if ((args.tagIds != null) && args.tagIds.length > 0) void q.whereIn('outputTagId', args.tagIds)
    return q
  }

  findOutputTagsQuery (args: FindOutputTagsArgs): Knex.QueryBuilder {
    return this.setupQuery('output_tags', args)
  }

  findProvenTxReqsQuery (args: FindProvenTxReqsArgs): Knex.QueryBuilder {
    if (args.partial.rawTx != null) { throw new WERR_INVALID_PARAMETER('args.partial.rawTx', 'undefined. ProvenTxReqs may not be found by rawTx value.') }
    if (args.partial.inputBEEF != null) {
      throw new WERR_INVALID_PARAMETER(
        'args.partial.inputBEEF',
        'undefined. ProvenTxReqs may not be found by inputBEEF value.'
      )
    }
    const q = this.setupQuery('proven_tx_reqs', args)
    if ((args.status != null) && args.status.length > 0) void q.whereIn('status', args.status)
    if (args.txids != null) {
      const txids = args.txids.filter(txid => txid !== undefined)
      if (txids.length > 0) void q.whereIn('txid', txids)
    }
    return q
  }

  findProvenTxsQuery (args: FindProvenTxsArgs): Knex.QueryBuilder {
    if (args.partial.rawTx != null) { throw new WERR_INVALID_PARAMETER('args.partial.rawTx', 'undefined. ProvenTxs may not be found by rawTx value.') }
    if (args.partial.merklePath != null) {
      throw new WERR_INVALID_PARAMETER(
        'args.partial.merklePath',
        'undefined. ProvenTxs may not be found by merklePath value.'
      )
    }
    return this.setupQuery('proven_txs', args)
  }

  findStaleMerkleRootsQuery (args: FindStaleMerkleRootsArgs): Knex.QueryBuilder {
    const q = this.toDb(args.trx)('proven_txs')
    void q.where('height', '=', args.height)
    void q.where('merkleRoot', '!=', args.merkleRoot)
    void q.select('merkleRoot')
    void q.distinct('merkleRoot')
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
    const q = this.setupQuery('transactions', args)
    if ((args.status != null) && args.status.length > 0) void q.whereIn('status', args.status)
    if (args.from != null) void q.where('created_at', '>=', this.validateDateForWhere(args.from))
    if (args.to != null) void q.where('created_at', '<', this.validateDateForWhere(args.to))
    if ((args.noRawTx === true) && count !== true) {
      const columns = transactionColumnsWithoutRawTx.map(c => `transactions.${c}`)
      void q.select(columns)
    }
    return q
  }

  findTxLabelMapsQuery (args: FindTxLabelMapsArgs): Knex.QueryBuilder {
    const q = this.setupQuery('tx_labels_map', args)
    if ((args.labelIds != null) && args.labelIds.length > 0) void q.whereIn('txLabelId', args.labelIds)
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
    if (auth.userId == null || (args.partial.userId != null && args.partial.userId !== 0 && args.partial.userId !== auth.userId)) throw new WERR_UNAUTHORIZED()
    args.partial.userId = auth.userId
    return await this.findCertificates(args)
  }

  override async findOutputBasketsAuth (auth: AuthId, args: FindOutputBasketsArgs): Promise<TableOutputBasket[]> {
    if (auth.userId == null || (args.partial.userId != null && args.partial.userId !== 0 && args.partial.userId !== auth.userId)) throw new WERR_UNAUTHORIZED()
    args.partial.userId = auth.userId
    return await this.findOutputBaskets(args)
  }

  override async findOutputsAuth (auth: AuthId, args: FindOutputsArgs): Promise<TableOutput[]> {
    if (auth.userId == null || (args.partial.userId != null && args.partial.userId !== 0 && args.partial.userId !== auth.userId)) throw new WERR_UNAUTHORIZED()
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
    if (args.includeFields === true) {
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
    if (args.noScript !== true) {
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
    const q = this.findProvenTxReqsQuery(args)
    const r = await q
    return this.validateEntities(r, undefined, ['notified', 'wasBroadcast'])
  }

  override async findProvenTxs (args: FindProvenTxsArgs): Promise<TableProvenTx[]> {
    const q = this.findProvenTxsQuery(args)
    const r = await q
    return this.validateEntities(r)
  }

  override async findStaleMerkleRoots (args: FindStaleMerkleRootsArgs): Promise<string[]> {
    const q = this.findStaleMerkleRootsQuery(args)
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
    if (args.noRawTx !== true) {
      for (const t of r) {
        await this.validateRawTransaction(t, args.trx)
      }
    }
    return this.validateEntities(r, undefined, ['isOutgoing'])
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
    void q.count()
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
    return await this.getCount(this.findProvenTxReqsQuery(args))
  }

  override async countProvenTxs (args: FindProvenTxsArgs): Promise<number> {
    return await this.getCount(this.findProvenTxsQuery(args))
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
    const clientName = (this.knex.client as { config?: { client?: string } }).config?.client ?? ''
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
    const clientName = (this.knex.client as { config?: { client?: string } }).config?.client ?? ''
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
        if (r == null) {
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

    return await this.knex.transaction<T>(async knextrx => {
      const trx = knextrx as TrxToken
      return await scope(trx)
    })
  }

  /**
   * Convert the standard optional `TrxToken` parameter into either a direct knex database instance,
   * or a Knex.Transaction as appropriate.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  toDb (trx?: TrxToken): Knex | Knex.Transaction<any, any[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (trx == null) ? this.knex : trx as Knex.Transaction<any, any[]>
    this.whenLastAccess = new Date()
    return db
  }

  async validateRawTransaction (t: TableTransaction, trx?: TrxToken): Promise<void> {
    // if there is no txid or there is a rawTransaction return what we have.
    if (t.rawTx != null || t.txid == null || t.txid === '') return

    // rawTransaction is missing, see if we moved it ...

    const rawTx = await this.getRawTxOfKnownValidTransaction(t.txid, undefined, undefined, trx)
    if (rawTx == null) return
    t.rawTx = rawTx
  }

  _verifiedReadyForDatabaseAccess: boolean = false

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
      if (v[df] != null) v[df] = this.validateOptionalEntityDate(v[df])
    }
  }

  /** Apply optional boolean-field coercion list in-place. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private coerceBooleanFields (v: any, booleanFields?: string[]): void {
    if (booleanFields == null) return
    for (const df of booleanFields) {
      if (v[df] !== undefined) v[df] = (v[df] as unknown) != null && (v[df] as unknown) !== false ? 1 : 0
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
    if (this.dbtype == null) throw new WERR_INTERNAL('must call verifyReadyForDatabaseAccess first')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const v: any = update
    if (v.created_at != null) v.created_at = this.validateEntityDate(v.created_at)
    if (v.updated_at != null) v.updated_at = this.validateEntityDate(v.updated_at)
    if (v.created_at == null) delete v.created_at
    if (v.updated_at == null) v.updated_at = this.validateEntityDate(new Date())
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
    v.created_at = this.validateOptionalEntityDate(v.created_at, true) ?? new Date()
    v.updated_at = this.validateOptionalEntityDate(v.updated_at, true) ?? new Date()
    if (v.created_at == null) delete v.created_at
    if (v.updated_at == null) delete v.updated_at
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
    const status: TransactionStatus[] = ['completed', 'unproven']
    if (!excludeSending) status.push('sending')
    const q = this.knex<TableOutput>('outputs as o')
      .join('transactions as t', 'o.transactionId', 't.transactionId')
      .where({ 'o.userId': userId, 'o.spendable': true, 'o.basketId': basketId })
      .whereIn('t.status', status)
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
    const filteredRows = rows.filter(r => outpointSet.has(`${String(r.txid)}.${String(r.vout)}`))
    const vrows = this.validateEntities(filteredRows, undefined, ['spendable', 'change'])
    for (const row of vrows) {
      await this.validateOutputScript(row, trx)
      byOutpoint[`${String(row.txid)}.${String(row.vout)}`] = row
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
      if (byName[name] == null) byName[name] = await this.findOrInsertOutputBasket(userId, name, trx)
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
      if (byTag[tag] == null) byTag[tag] = await this.findOrInsertOutputTag(userId, tag, trx)
    }
    return byTag
  }

  override async sumSpendableSatoshisInBasket (
    userId: number,
    basketId: number,
    excludeSending: boolean,
    trx?: TrxToken
  ): Promise<number> {
    const status: TransactionStatus[] = ['completed', 'unproven']
    if (!excludeSending) status.push('sending')
    const row = await this.toDb(trx)<TableOutput>('outputs as o')
      .join('transactions as t', 'o.transactionId', 't.transactionId')
      .where({ 'o.userId': userId, 'o.spendable': true, 'o.basketId': basketId })
      .whereIn('t.status', status)
      .sum({ totalSatoshis: 'o.satoshis' })
      .first()
    const total = (row != null) ? (row as Record<string, unknown>).totalSatoshis : undefined
    return Number(total ?? 0)
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
    const status: TransactionStatus[] = ['completed', 'unproven']
    if (!excludeSending) status.push('sending')

    const r: TableOutput | undefined = await this.knex.transaction(async trx => {
      const baseQuery = (): Knex.QueryBuilder<TableOutput, TableOutput[]> =>
        trx<TableOutput>('outputs as o')
          .join('transactions as t', 'o.transactionId', 't.transactionId')
          .where('o.userId', userId)
          .where('o.spendable', true)
          .where('o.basketId', basketId)
          .whereIn('t.status', status)
          .select('o.*')

      let output: TableOutput | undefined

      if (exactSatoshis !== undefined) {
        output = await baseQuery().where('o.satoshis', exactSatoshis).orderBy('o.outputId', 'asc').first()
      }

      output ??= await baseQuery()
        .where('o.satoshis', '>=', targetSatoshis)
        .orderBy('o.satoshis', 'asc')
        .orderBy('o.outputId', 'asc')
        .first()

      output ??= await baseQuery()
        .where('o.satoshis', '<', targetSatoshis)
        .orderBy('o.satoshis', 'desc')
        .orderBy('o.outputId', 'desc')
        .first()

      if (output == null) return undefined

      await this.updateOutput(
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
      return output
    })

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
        if ((entity as any)[df] != null) (entity as any)[df] = this.validateDate((entity as any)[df])
      }
    }
    if (booleanFields != null) {
      for (const df of booleanFields) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((entity as any)[df] !== undefined) (entity as any)[df] = (entity as any)[df] !== 0 && (entity as any)[df] != null && (entity as any)[df] !== false
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
    const monitorStats: ServicesCallHistory | undefined = (monitorEvent != null) ? JSON.parse(monitorEvent.details as string) : undefined
    const servicesStats = this.getServices().getServicesCallHistory(true)

    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const oneMonthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

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
    (select count(*) from users where created_at > '${oneDayAgo}') as usersDay,
    (select count(*) from users where created_at > '${oneWeekAgo}') as usersWeek,
    (select count(*) from users where created_at > '${oneMonthAgo}') as usersMonth,
    (select count(*) from users) as usersTotal,
    (select count(*) from transactions where created_at > '${oneDayAgo}') as transactionsDay,
    (select count(*) from transactions where created_at > '${oneWeekAgo}') as transactionsWeek,
    (select count(*) from transactions where created_at > '${oneMonthAgo}') as transactionsMonth,
    (select count(*) from transactions) as transactionsTotal,
    (select count(*) from transactions where status = 'completed' and created_at > '${oneDayAgo}') as txCompletedDay,
    (select count(*) from transactions where status = 'completed' and created_at > '${oneWeekAgo}') as txCompletedWeek,
    (select count(*) from transactions where status = 'completed' and created_at > '${oneMonthAgo}') as txCompletedMonth,
    (select count(*) from transactions where status = 'completed') as txCompletedTotal,
    (select count(*) from transactions where status = 'failed' and not txid is null and created_at > '${oneDayAgo}') as txFailedDay,
    (select count(*) from transactions where status = 'failed' and not txid is null and created_at > '${oneWeekAgo}') as txFailedWeek,
    (select count(*) from transactions where status = 'failed' and not txid is null and created_at > '${oneMonthAgo}') as txFailedMonth,
    (select count(*) from transactions where status = 'failed' and not txid is null) as txFailedTotal,
    (select count(*) from transactions where status = 'failed' and txid is null and created_at > '${oneDayAgo}') as txAbandonedDay,
    (select count(*) from transactions where status = 'failed' and txid is null and created_at > '${oneWeekAgo}') as txAbandonedWeek,
    (select count(*) from transactions where status = 'failed' and txid is null and created_at > '${oneMonthAgo}') as txAbandonedMonth,
    (select count(*) from transactions where status = 'failed' and txid is null) as txAbandonedTotal,
    (select count(*) from transactions where status = 'unprocessed' and created_at > '${oneDayAgo}') as txUnprocessedDay,
    (select count(*) from transactions where status = 'unprocessed' and created_at > '${oneWeekAgo}') as txUnprocessedWeek,
    (select count(*) from transactions where status = 'unprocessed' and created_at > '${oneMonthAgo}') as txUnprocessedMonth,
    (select count(*) from transactions where status = 'unprocessed') as txUnprocessedTotal,
    (select count(*) from transactions where status = 'sending' and created_at > '${oneDayAgo}') as txSendingDay,
    (select count(*) from transactions where status = 'sending' and created_at > '${oneWeekAgo}') as txSendingWeek,
    (select count(*) from transactions where status = 'sending' and created_at > '${oneMonthAgo}') as txSendingMonth,
    (select count(*) from transactions where status = 'sending') as txSendingTotal,
    (select count(*) from transactions where status = 'unproven' and created_at > '${oneDayAgo}') as txUnprovenDay,
    (select count(*) from transactions where status = 'unproven' and created_at > '${oneWeekAgo}') as txUnprovenWeek,
    (select count(*) from transactions where status = 'unproven' and created_at > '${oneMonthAgo}') as txUnprovenMonth,
    (select count(*) from transactions where status = 'unproven') as txUnprovenTotal,
    (select count(*) from transactions where status = 'unsigned' and created_at > '${oneDayAgo}') as txUnsignedDay,
    (select count(*) from transactions where status = 'unsigned' and created_at > '${oneWeekAgo}') as txUnsignedWeek,
    (select count(*) from transactions where status = 'unsigned' and created_at > '${oneMonthAgo}') as txUnsignedMonth,
    (select count(*) from transactions where status = 'unsigned') as txUnsignedTotal,
    (select count(*) from transactions where status = 'nosend' and created_at > '${oneDayAgo}') as txNosendDay,
    (select count(*) from transactions where status = 'nosend' and created_at > '${oneWeekAgo}') as txNosendWeek,
    (select count(*) from transactions where status = 'nosend' and created_at > '${oneMonthAgo}') as txNosendMonth,
    (select count(*) from transactions where status = 'nosend') as txNosendTotal,
    (select count(*) from transactions where status = 'nonfinal' and created_at > '${oneDayAgo}') as txNonfinalDay,
    (select count(*) from transactions where status = 'nonfinal' and created_at > '${oneWeekAgo}') as txNonfinalWeek,
    (select count(*) from transactions where status = 'nonfinal' and created_at > '${oneMonthAgo}') as txNonfinalMonth,
    (select count(*) from transactions where status = 'nonfinal') as txNonfinalTotal,
    (select count(*) from transactions where status = 'unfail' and created_at > '${oneDayAgo}') as txUnfailDay,
    (select count(*) from transactions where status = 'unfail' and created_at > '${oneWeekAgo}') as txUnfailWeek,
    (select count(*) from transactions where status = 'unfail' and created_at > '${oneMonthAgo}') as txUnfailMonth,
    (select count(*) from transactions where status = 'unfail') as txUnfailTotal,
    (select sum(o.satoshis) from outputs o, transactions t where o.transactionId = t.transactionId and t.status = 'completed' and o.spendable = 1 and o.change = 1 and o.created_at > '${oneDayAgo}') as satoshisDefaultDay,
    (select sum(o.satoshis) from outputs o, transactions t where o.transactionId = t.transactionId and t.status = 'completed' and o.spendable = 1 and o.change = 1 and o.created_at > '${oneWeekAgo}') as satoshisDefaultWeek,
    (select sum(o.satoshis) from outputs o, transactions t where o.transactionId = t.transactionId and t.status = 'completed' and o.spendable = 1 and o.change = 1 and o.created_at > '${oneMonthAgo}') as satoshisDefaultMonth,
    (select sum(o.satoshis) from outputs o, transactions t where o.transactionId = t.transactionId and t.status = 'completed' and o.spendable = 1 and o.change = 1) as satoshisDefaultTotal,
    (select sum(o.satoshis) from outputs o, transactions t where o.transactionId = t.transactionId and t.status = 'completed' and o.spendable = 1 and o.change = 0 and not o.basketId is null and o.created_at > '${oneDayAgo}') as satoshisOtherDay,
    (select sum(o.satoshis) from outputs o, transactions t where o.transactionId = t.transactionId and t.status = 'completed' and o.spendable = 1 and o.change = 0 and not o.basketId is null and o.created_at > '${oneWeekAgo}') as satoshisOtherWeek,
    (select sum(o.satoshis) from outputs o, transactions t where o.transactionId = t.transactionId and t.status = 'completed' and o.spendable = 1 and o.change = 0 and not o.basketId is null and o.created_at > '${oneMonthAgo}') as satoshisOtherMonth,
    (select sum(o.satoshis) from outputs o, transactions t where o.transactionId = t.transactionId and t.status = 'completed' and o.spendable = 1 and o.change = 0 and not o.basketId is null) as satoshisOtherTotal,
    (select count(*) from output_baskets where created_at > '${oneDayAgo}') as basketsDay,
    (select count(*) from output_baskets where created_at > '${oneWeekAgo}') as basketsWeek,
    (select count(*) from output_baskets where created_at > '${oneMonthAgo}') as basketsMonth,
    (select count(*) from output_baskets) as basketsTotal,
    (select count(*) from tx_labels where created_at > '${oneDayAgo}') as labelsDay,
    (select count(*) from tx_labels where created_at > '${oneWeekAgo}') as labelsWeek,
    (select count(*) from tx_labels where created_at > '${oneMonthAgo}') as labelsMonth,
    (select count(*) from tx_labels) as labelsTotal,
    (select count(*) from output_tags where created_at > '${oneDayAgo}') as tagsDay,
    (select count(*) from output_tags where created_at > '${oneWeekAgo}') as tagsWeek,
    (select count(*) from output_tags where created_at > '${oneMonthAgo}') as tagsMonth,
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
