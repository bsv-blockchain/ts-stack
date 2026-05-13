import { deleteDB, IDBPDatabase, IDBPTransaction, openDB } from 'idb'
import {
  matchesCertificateFieldPartial,
  matchesCertificatePartial,
  matchesCommissionPartial,
  matchesMonitorEventPartial,
  matchesOutputBasketPartial,
  matchesOutputPartial,
  matchesOutputTagMapPartial,
  matchesOutputTagPartial,
  matchesProvenTxPartial,
  matchesProvenTxReqPartial,
  matchesSyncStatePartial,
  matchesTransactionPartial,
  matchesTxLabelMapPartial,
  matchesTxLabelPartial,
  upgradeAllStoresV1
} from './idbHelpers'
import { ListActionsResult, ListOutputsResult, Validation } from '@bsv/sdk'
import {
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
  TableUser
} from './schema/tables'
import { verifyOneOrNone } from '../utility/utilityHelpers'
import { StorageAdminStats, StorageProvider, StorageProviderOptions } from './StorageProvider'
import { StorageIdbSchema } from './schema/StorageIdbSchema'
import { DBType } from './StorageReader'
import { listActionsIdb } from './methods/listActionsIdb'
import { listOutputsIdb } from './methods/listOutputsIdb'
import { reviewStatusIdb } from './methods/reviewStatusIdb'
import { purgeDataIdb } from './methods/purgeDataIdb'
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
import { WERR_INTERNAL, WERR_INVALID_OPERATION, WERR_INVALID_PARAMETER, WERR_UNAUTHORIZED } from '../sdk/WERR_errors'
import { EntityTimeStamp, TransactionStatus } from '../sdk/types'

export interface StorageIdbOptions extends StorageProviderOptions {}

/**
 * Shared cursor-scan loop used by all `filterXxx` methods of StorageIdb.
 *
 * Walks `cursor` forward, applying `since`, a caller-supplied `matches`
 * predicate, paging (offset / limit), and an async `accept` callback for
 * records that pass all filters.  Returns the number of accepted records.
 *
 * Implemented as a module-level helper (not a class method) so that
 * profiling/instrumentation that wraps class-prototype methods cannot
 * intercept or mutate its `matches` / `accept` callbacks.
 */
async function scanCursor<T extends { updated_at: Date }> (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cursor: any,
  since: Date | undefined,
  offset: number,
  limit: number | undefined,
  matches: (r: T) => boolean | Promise<boolean>,
  accept: (r: T) => void
): Promise<number> {
  let skipped = 0
  let count = 0
  for (; cursor != null; cursor = await cursor.continue()) {
    const r: T = cursor.value
    if (since != null && since > r.updated_at) continue
    if (!await matches(r)) continue
    if (skipped < offset) { skipped++; continue }
    accept(r)
    count++
    if (limit && count >= limit) break
  }
  return count
}

/**
 * This class implements the `StorageProvider` interface using IndexedDB,
 * via the promises wrapper package `idb`.
 */
export class StorageIdb extends StorageProvider implements WalletStorageProvider {
  dbName: string
  db?: IDBPDatabase<StorageIdbSchema>

  constructor (options: StorageIdbOptions) {
    super(options)
    this.dbName = `wallet-toolbox-${this.chain}net`
  }

  // TODO(new-schema-idb): StorageIdb does not yet support the the new schema.
  // getTransactionService() inherits the default `return undefined` from StorageProvider.
  // A future implementation would wrap an IndexedDB-backed the transaction service here.

  /**
   * This method must be called at least once before any other method accesses the database,
   * and each time the schema may have updated.
   *
   * If the database has already been created in this context, `storageName` and `storageIdentityKey`
   * are ignored.
   *
   * @param storageName
   * @param storageIdentityKey
   * @returns
   */
  async migrate (storageName: string, storageIdentityKey: string): Promise<string> {
    const db = await this.verifyDB(storageName, storageIdentityKey)
    return db.version.toString()
  }

  /**
   * Following initial database initialization, this method verfies that db is ready for use.
   *
   * @throws `WERR_INVALID_OPERATION` if the database has not been initialized by a call to `migrate`.
   *
   * @param storageName
   * @param storageIdentityKey
   *
   * @returns
   */
  async verifyDB (storageName?: string, storageIdentityKey?: string): Promise<IDBPDatabase<StorageIdbSchema>> {
    if (this.db != null) return this.db
    this.db = await this.initDB(storageName, storageIdentityKey)
    this._settings = (await this.db.getAll('settings'))[0]
    this.whenLastAccess = new Date()
    return this.db
  }

  /**
   * Convert the standard optional `TrxToken` parameter into either a direct knex database instance,
   * or a Knex.Transaction as appropriate.
   */
  toDbTrx (
    stores: string[],
    mode: 'readonly' | 'readwrite',
    trx?: TrxToken
  ): IDBPTransaction<StorageIdbSchema, string[], 'readwrite' | 'readonly'> {
    if (trx != null) {
      const t = trx as IDBPTransaction<StorageIdbSchema, string[], 'readwrite' | 'readonly'>
      return t
    } else {
      if (this.db == null) throw new Error('not initialized')
      const db = this.db
      const trx = db.transaction(stores || this.allStores, mode || 'readwrite')
      this.whenLastAccess = new Date()
      return trx
    }
  }

  /**
   * Called by `makeAvailable` to return storage `TableSettings`.
   * Since this is the first async method that must be called by all clients,
   * it is where async initialization occurs.
   *
   * After initialization, cached settings are returned.
   *
   * @param trx
   */
  async readSettings (trx?: TrxToken): Promise<TableSettings> {
    await this.verifyDB()
    return this._settings!
  }

  async initDB (storageName?: string, storageIdentityKey?: string): Promise<IDBPDatabase<StorageIdbSchema>> {
    const chain = this.chain
    const maxOutputScript = 1024
    const db = await openDB<StorageIdbSchema>(this.dbName, 1, {
      upgrade (db) {
        upgradeAllStoresV1(db)
        if (!db.objectStoreNames.contains('settings')) {
          if (!storageName || !storageIdentityKey) {
            throw new WERR_INVALID_OPERATION('migrate must be called before first access')
          }
          const settings = db.createObjectStore('settings', { keyPath: 'storageIdentityKey' })
          const s: TableSettings = {
            created_at: new Date(),
            updated_at: new Date(),
            storageIdentityKey,
            storageName,
            chain,
            dbtype: 'IndexedDB',
            maxOutputScript
          }
          settings.put(s)
        }
      }
    })
    return db
  }

  //
  // StorageProvider abstract methods
  //

  async reviewStatus (args: { agedLimit: Date, trx?: TrxToken }): Promise<{ log: string }> {
    return await reviewStatusIdb(this, args)
  }

  async purgeData (params: PurgeParams, trx?: TrxToken): Promise<PurgeResults> {
    return await purgeDataIdb(this, params, trx)
  }

  /**
   * Proceeds in three stages:
   * 1. Find an output that exactly funds the transaction (if exactSatoshis is not undefined).
   * 2. Find an output that overfunds by the least amount (targetSatoshis).
   * 3. Find an output that comes as close to funding as possible (targetSatoshis).
   * 4. Return undefined if no output is found.
   *
   * Outputs must belong to userId and basketId and have spendable true.
   * Their corresponding transaction must have status of 'completed', 'unproven', or 'sending' (if excludeSending is false).
   *
   * @param userId
   * @param basketId
   * @param targetSatoshis
   * @param exactSatoshis
   * @param excludeSending
   * @param transactionId
   * @returns next funding output to add to transaction or undefined if there are none.
   */
  async allocateChangeInput (
    userId: number,
    basketId: number,
    targetSatoshis: number,
    exactSatoshis: number | undefined,
    excludeSending: boolean,
    transactionId: number
  ): Promise<TableOutput | undefined> {
    const dbTrx = this.toDbTrx(['outputs', 'transactions', 'proven_txs', 'proven_tx_reqs'], 'readwrite')
    try {
      const txStatus: TransactionStatus[] = ['completed', 'unproven']
      if (!excludeSending) txStatus.push('sending')
      const args: FindOutputsArgs = {
        partial: { userId, basketId, spendable: true },
        txStatus,
        // Skip per-output script hydration during the candidate scan — we only need
        // the locking script for the one we actually pick below. Matches Knex's
        // pattern: SELECT candidates cheaply, hydrate the chosen output explicitly.
        noScript: true,
        trx: dbTrx
      }
      const outputs = await this.findOutputs(args)
      let output: TableOutput | undefined
      let scores: Array<{ output: TableOutput, score: number }> = []
      for (const o of outputs) {
        if (exactSatoshis && o.satoshis === exactSatoshis) {
          output = o
          break
        }
        const score = o.satoshis - targetSatoshis
        scores.push({ output: o, score })
      }
      if (output == null) {
        // sort scores increasing by score property
        scores = scores.sort((a, b) => a.score - b.score)
        // find the first score that is greater than or equal to 0
        const o = scores.find(s => s.score >= 0)
        if (o != null) {
          // stage 2 satisfied (minimally funded)
          output = o.output
        } else if (scores.length > 0) {
          // stage 3 satisfied (minimally under-funded)
          output = scores.at(-1)!.output
        } else {
          // no available funding outputs
          output = undefined
        }
      }
      if (output != null) {
        // mark output as spent by transactionId
        await this.updateOutput(output.outputId, { spendable: false, spentBy: transactionId }, dbTrx)
        // Hydrate the locking script for the chosen output. Identical to Knex canon at
        // StorageKnex.allocateChangeInput: required when the script was offloaded into
        // rawTx storage due to exceeding maxOutputScript.
        await this.validateOutputScript(output, dbTrx)
      }
      return output
    } finally {
      await dbTrx.done
    }
  }

  async getProvenOrRawTx (txid: string, trx?: TrxToken): Promise<ProvenOrRawTx> {
    const r: ProvenOrRawTx = {
      proven: undefined,
      rawTx: undefined,
      inputBEEF: undefined
    }

    r.proven = verifyOneOrNone(await this.findProvenTxs({ partial: { txid }, trx }))
    if (r.proven == null) {
      const req = verifyOneOrNone(await this.findProvenTxReqs({ partial: { txid }, trx }))
      if ((req != null) && ['unsent', 'unmined', 'unconfirmed', 'sending', 'nosend', 'completed'].includes(req.status)) {
        r.rawTx = req.rawTx
        r.inputBEEF = req.inputBEEF
      }
    }

    return r
  }

  async getRawTxOfKnownValidTransaction (
    txid?: string,
    offset?: number,
    length?: number,
    trx?: TrxToken
  ): Promise<number[] | undefined> {
    if (!txid) return undefined
    if (!this.isAvailable()) await this.makeAvailable()

    const sliceRequested =
      offset !== undefined && length !== undefined && Number.isInteger(offset) && Number.isInteger(length)
    // Slice path uses an extended status set that includes 'unfail' — matches Knex
    // canon at StorageKnex.ts:131. The non-slice path continues to delegate to
    // getProvenOrRawTx which uses the narrower set.
    const rawTx = sliceRequested
      ? await this.getRawTxForSlice(txid, trx)
      : await this.getRawTxFull(txid, trx)

    if (rawTx != null && sliceRequested) {
      return rawTx.slice(offset, (offset) + (length))
    }
    return rawTx
  }

  private async getRawTxForSlice (txid: string, trx?: TrxToken): Promise<number[] | undefined> {
    const proven = verifyOneOrNone(await this.findProvenTxs({ partial: { txid }, trx }))
    if (proven != null) return proven.rawTx
    const req = verifyOneOrNone(await this.findProvenTxReqs({ partial: { txid }, trx }))
    const validStatuses = ['unsent', 'nosend', 'sending', 'unmined', 'completed', 'unfail']
    if (req != null && validStatuses.includes(req.status)) return req.rawTx
    return undefined
  }

  private async getRawTxFull (txid: string, trx?: TrxToken): Promise<number[] | undefined> {
    const r = await this.getProvenOrRawTx(txid, trx)
    return r.proven != null ? r.proven.rawTx : r.rawTx
  }

  async getLabelsForTransactionId (transactionId?: number, trx?: TrxToken): Promise<TableTxLabel[]> {
    const maps = await this.findTxLabelMaps({ partial: { transactionId, isDeleted: false }, trx })
    const labelIds = maps.map(m => m.txLabelId)
    const labels: TableTxLabel[] = []
    for (const txLabelId of labelIds) {
      // verifyOneOrNone: a map row may reference a label that was later soft-deleted.
      // Knex/Bun drop it via JOIN; we must do the same silently or we'd break the whole
      // listActions response. Skip + log so persistent orphans still produce a signal.
      const label = verifyOneOrNone(await this.findTxLabels({ partial: { txLabelId, isDeleted: false }, trx }))
      if (label != null) labels.push(label)
      else {
        console.debug(
          `[StorageIdb] orphan tx_labels_map row skipped: transactionId=${transactionId} txLabelId=${txLabelId}`
        )
      }
    }
    return labels
  }

  async getTagsForOutputId (outputId: number, trx?: TrxToken): Promise<TableOutputTag[]> {
    const maps = await this.findOutputTagMaps({ partial: { outputId, isDeleted: false }, trx })
    const tagIds = maps.map(m => m.outputTagId)
    const tags: TableOutputTag[] = []
    for (const outputTagId of tagIds) {
      const tag = verifyOneOrNone(await this.findOutputTags({ partial: { outputTagId, isDeleted: false }, trx }))
      if (tag != null) tags.push(tag)
      else {
        console.debug(
          `[StorageIdb] orphan output_tags_map row skipped: outputId=${outputId} outputTagId=${outputTagId}`
        )
      }
    }
    return tags
  }

  async listActions (auth: AuthId, vargs: Validation.ValidListActionsArgs): Promise<ListActionsResult> {
    if (!auth.userId) throw new WERR_UNAUTHORIZED()
    return await listActionsIdb(this, auth, vargs)
  }

  async listOutputs (auth: AuthId, vargs: Validation.ValidListOutputsArgs): Promise<ListOutputsResult> {
    if (!auth.userId) throw new WERR_UNAUTHORIZED()
    return await listOutputsIdb(this, auth, vargs)
  }

  async countChangeInputs (userId: number, basketId: number, excludeSending: boolean): Promise<number> {
    const txStatus: TransactionStatus[] = ['completed', 'unproven']
    if (!excludeSending) txStatus.push('sending')
    const args: FindOutputsArgs = { partial: { userId, basketId }, txStatus }
    let count = 0
    await this.filterOutputs(args, r => {
      count++
    })
    return count
  }

  async findCertificatesAuth (auth: AuthId, args: FindCertificatesArgs): Promise<TableCertificateX[]> {
    if (!auth.userId || (args.partial.userId && args.partial.userId !== auth.userId)) throw new WERR_UNAUTHORIZED()
    args.partial.userId = auth.userId
    return await this.findCertificates(args)
  }

  async findOutputBasketsAuth (auth: AuthId, args: FindOutputBasketsArgs): Promise<TableOutputBasket[]> {
    if (!auth.userId || (args.partial.userId && args.partial.userId !== auth.userId)) throw new WERR_UNAUTHORIZED()
    args.partial.userId = auth.userId
    return await this.findOutputBaskets(args)
  }

  async findOutputsAuth (auth: AuthId, args: FindOutputsArgs): Promise<TableOutput[]> {
    if (!auth.userId || (args.partial.userId && args.partial.userId !== auth.userId)) throw new WERR_UNAUTHORIZED()
    args.partial.userId = auth.userId
    return await this.findOutputs(args)
  }

  async insertCertificateAuth (auth: AuthId, certificate: TableCertificateX): Promise<number> {
    if (!auth.userId || (certificate.userId && certificate.userId !== auth.userId)) throw new WERR_UNAUTHORIZED()
    certificate.userId = auth.userId
    return await this.insertCertificate(certificate)
  }

  //
  // StorageReaderWriter abstract methods
  //

  async dropAllData (): Promise<void> {
    await deleteDB(this.dbName)
  }

  /**
   * Reject undefined values in a `partial` filter argument. Matches
   * Knex behavior (which throws `Undefined binding(s) detected`) so that
   * callers can't pass an unmapped idMap lookup through as a silent
   * match-anything. Omit the key to skip filtering on it; pass null if
   * you need IS NULL semantics (only meaningful for nullable columns).
   */
  private assertNoUndefinedInPartial (partial: Record<string, unknown> | undefined): void {
    if (partial == null) return
    for (const k of Object.keys(partial)) {
      if (partial[k] === undefined) {
        throw new WERR_INVALID_PARAMETER(
          `args.partial.${k}`,
          'not undefined. Passing undefined as a filter value is not supported — omit the key to skip filtering. Matches Knex semantics.'
        )
      }
    }
  }

  async filterOutputTagMaps (
    args: FindOutputTagMapsArgs,
    filtered: (v: TableOutputTagMap) => void,
    userId?: number
  ): Promise<void> {
    this.assertNoUndefinedInPartial(args.partial)
    const dbTrx = this.toDbTrx(['output_tags_map', 'output_tags'], 'readonly', args.trx)
    const store = dbTrx.objectStore('output_tags_map')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let cursor: any
    if (args.partial?.outputTagId !== undefined) {
      cursor = await store.index('outputTagId').openCursor(args.partial.outputTagId)
    } else if (args.partial?.outputId !== undefined) {
      cursor = await store.index('outputId').openCursor(args.partial.outputId)
    } else {
      cursor = await store.openCursor()
    }
    await scanCursor<TableOutputTagMap>(
      cursor,
      args.since,
      args.paged?.offset || 0,
      args.paged?.limit,
      async r => {
        if (args.tagIds != null && !args.tagIds.includes(r.outputTagId)) return false
        if (!matchesOutputTagMapPartial(r, args.partial)) return false
        if (userId !== undefined) {
          const tagsForUser = await this.countOutputTags({ partial: { userId, outputTagId: r.outputTagId }, trx: dbTrx })
          if (tagsForUser === 0) return false
        }
        return true
      },
      filtered
    )
    if (args.trx == null) await dbTrx.done
  }

  async findOutputTagMaps (args: FindOutputTagMapsArgs): Promise<TableOutputTagMap[]> {
    const results: TableOutputTagMap[] = []
    await this.filterOutputTagMaps(args, r => {
      results.push(this.validateEntity(r))
    })
    return results
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async openProvenTxReqsCursor (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    partial: Partial<any>,
    direction: IDBCursorDirection
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    if (partial?.provenTxReqId) return store.openCursor(partial.provenTxReqId, direction)
    if (partial?.provenTxId !== undefined) return store.index('provenTxId').openCursor(partial.provenTxId, direction)
    if (partial?.txid !== undefined) return store.index('txid').openCursor(partial.txid, direction)
    if (partial?.status !== undefined) return store.index('status').openCursor(partial.status, direction)
    if (partial?.batch !== undefined) return store.index('batch').openCursor(partial.batch, direction)
    return store.openCursor(null, direction)
  }

  async filterProvenTxReqs (
    args: FindProvenTxReqsArgs,
    filtered: (v: TableProvenTxReq) => void,
    userId?: number
  ): Promise<void> {
    this.assertNoUndefinedInPartial(args.partial)
    if (args.partial.rawTx != null) { throw new WERR_INVALID_PARAMETER('args.partial.rawTx', 'undefined. ProvenTxReqs may not be found by rawTx value.') }
    if (args.partial.inputBEEF != null) {
      throw new WERR_INVALID_PARAMETER(
        'args.partial.inputBEEF',
        'undefined. ProvenTxReqs may not be found by inputBEEF value.'
      )
    }
    const dbTrx = this.toDbTrx(['proven_tx_reqs', 'transactions'], 'readonly', args.trx)
    const direction: IDBCursorDirection = args.orderDescending ? 'prev' : 'next'
    const store = dbTrx.objectStore('proven_tx_reqs')
    const cursor = await this.openProvenTxReqsCursor(store, args.partial, direction)
    await scanCursor<TableProvenTxReq>(
      cursor,
      args.since,
      args.paged?.offset || 0,
      args.paged?.limit,
      async r => {
        if (!matchesProvenTxReqPartial(r, args.partial)) return false
        if (args.status != null && args.status.length > 0 && !args.status.includes(r.status)) return false
        if (args.txids != null && args.txids.length > 0 && !args.txids.includes(r.txid)) return false
        if (userId !== undefined) {
          const txsForUser = await this.countTransactions({ partial: { userId, txid: r.txid }, trx: dbTrx })
          if (txsForUser === 0) return false
        }
        return true
      },
      filtered
    )
    if (args.trx == null) await dbTrx.done
  }

  async findProvenTxReqs (args: FindProvenTxReqsArgs): Promise<TableProvenTxReq[]> {
    const results: TableProvenTxReq[] = []
    await this.filterProvenTxReqs(args, r => {
      results.push(this.validateEntity(r))
    })
    return results
  }

  async filterProvenTxs (args: FindProvenTxsArgs, filtered: (v: TableProvenTx) => void, userId?: number): Promise<void> {
    this.assertNoUndefinedInPartial(args.partial)
    if (args.partial.rawTx != null) { throw new WERR_INVALID_PARAMETER('args.partial.rawTx', 'undefined. ProvenTxs may not be found by rawTx value.') }
    if (args.partial.merklePath != null) {
      throw new WERR_INVALID_PARAMETER(
        'args.partial.merklePath',
        'undefined. ProvenTxs may not be found by merklePath value.'
      )
    }
    const dbTrx = this.toDbTrx(['proven_txs', 'transactions'], 'readonly', args.trx)
    const direction: IDBCursorDirection = args.orderDescending ? 'prev' : 'next'
    const store = dbTrx.objectStore('proven_txs')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let cursor: any
    if (args.partial?.provenTxId) {
      cursor = await store.openCursor(args.partial.provenTxId, direction)
    } else if (args.partial?.txid !== undefined) {
      cursor = await store.index('txid').openCursor(args.partial.txid, direction)
    } else {
      cursor = await store.openCursor(null, direction)
    }
    await scanCursor<TableProvenTx>(
      cursor,
      args.since,
      args.paged?.offset || 0,
      args.paged?.limit,
      async r => {
        if (!matchesProvenTxPartial(r, args.partial)) return false
        if (userId !== undefined) {
          const txCount = await this.countTransactions({ partial: { userId, provenTxId: r.provenTxId }, trx: dbTrx })
          if (txCount === 0) return false
        }
        return true
      },
      filtered
    )
    if (args.trx == null) await dbTrx.done
  }

  async findProvenTxs (args: FindProvenTxsArgs): Promise<TableProvenTx[]> {
    const results: TableProvenTx[] = []
    await this.filterProvenTxs(args, r => {
      results.push(this.validateEntity(r))
    })
    return results
  }

  async filterTxLabelMaps (
    args: FindTxLabelMapsArgs,
    filtered: (v: TableTxLabelMap) => void,
    userId?: number
  ): Promise<void> {
    this.assertNoUndefinedInPartial(args.partial)
    const dbTrx = this.toDbTrx(['tx_labels_map', 'tx_labels'], 'readonly', args.trx)
    const store = dbTrx.objectStore('tx_labels_map')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let cursor: any
    if (args.partial?.transactionId !== undefined) {
      cursor = await store.index('transactionId').openCursor(args.partial.transactionId)
    } else if (args.partial?.txLabelId !== undefined) {
      cursor = await store.index('txLabelId').openCursor(args.partial.txLabelId)
    } else {
      cursor = await store.openCursor()
    }
    await scanCursor<TableTxLabelMap>(
      cursor,
      args.since,
      args.paged?.offset || 0,
      args.paged?.limit,
      async r => {
        if (!matchesTxLabelMapPartial(r, args.partial)) return false
        if (userId !== undefined) {
          const labelCount = await this.countTxLabels({ partial: { userId, txLabelId: r.txLabelId }, trx: dbTrx })
          if (labelCount === 0) return false
        }
        return true
      },
      filtered
    )
    if (args.trx == null) await dbTrx.done
  }

  async findTxLabelMaps (args: FindTxLabelMapsArgs): Promise<TableTxLabelMap[]> {
    const results: TableTxLabelMap[] = []
    await this.filterTxLabelMaps(args, r => {
      results.push(this.validateEntity(r))
    })
    return results
  }

  async countOutputTagMaps (args: FindOutputTagMapsArgs): Promise<number> {
    let count = 0
    await this.filterOutputTagMaps(args, () => {
      count++
    })
    return count
  }

  async countProvenTxReqs (args: FindProvenTxReqsArgs): Promise<number> {
    let count = 0
    await this.filterProvenTxReqs(args, () => {
      count++
    })
    return count
  }

  async countProvenTxs (args: FindProvenTxsArgs): Promise<number> {
    let count = 0
    await this.filterProvenTxs(args, () => {
      count++
    })
    return count
  }

  async countTxLabelMaps (args: FindTxLabelMapsArgs): Promise<number> {
    let count = 0
    await this.filterTxLabelMaps(args, () => {
      count++
    })
    return count
  }

  async insertCertificate (certificate: TableCertificateX, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(certificate, trx, undefined, ['isDeleted'])
    // Strip non-schema runtime fields before insert. Matches Knex canon.
    if (e.logger) delete e.logger
    const fields = e.fields
    if (e.fields) delete e.fields
    if (e.certificateId === 0) delete e.certificateId

    const dbTrx = this.toDbTrx(['certificates', 'certificate_fields'], 'readwrite', trx)
    const store = dbTrx.objectStore('certificates')
    try {
      const id = Number(await store.add!(e))
      certificate.certificateId = id

      if (fields) {
        for (const field of fields) {
          field.certificateId = certificate.certificateId
          field.userId = certificate.userId
          await this.insertCertificateField(field, dbTrx)
        }
      }
    } finally {
      if (trx == null) await dbTrx.done
    }
    return certificate.certificateId
  }

  async insertCertificateField (certificateField: TableCertificateField, trx?: TrxToken): Promise<void> {
    const e = await this.validateEntityForInsert(certificateField, trx)
    const dbTrx = this.toDbTrx(['certificate_fields'], 'readwrite', trx)
    const store = dbTrx.objectStore('certificate_fields')
    try {
      await store.add!(e)
    } finally {
      if (trx == null) await dbTrx.done
    }
  }

  async insertCommission (commission: TableCommission, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(commission, trx)
    if (e.commissionId === 0) delete e.commissionId
    const dbTrx = this.toDbTrx(['commissions'], 'readwrite', trx)
    const store = dbTrx.objectStore('commissions')
    try {
      const id = Number(await store.add!(e))
      commission.commissionId = id
    } finally {
      if (trx == null) await dbTrx.done
    }
    return commission.commissionId
  }

  async insertMonitorEvent (event: TableMonitorEvent, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(event, trx)
    if (e.id === 0) delete e.id
    const dbTrx = this.toDbTrx(['monitor_events'], 'readwrite', trx)
    const store = dbTrx.objectStore('monitor_events')
    try {
      const id = Number(await store.add!(e))
      event.id = id
    } finally {
      if (trx == null) await dbTrx.done
    }
    return event.id
  }

  async insertOutput (output: TableOutput, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(output, trx)
    if (e.outputId === 0) delete e.outputId
    const dbTrx = this.toDbTrx(['outputs'], 'readwrite', trx)
    const store = dbTrx.objectStore('outputs')
    try {
      const id = Number(await store.add!(e))
      output.outputId = id
    } finally {
      if (trx == null) await dbTrx.done
    }
    return output.outputId
  }

  async insertOutputBasket (basket: TableOutputBasket, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(basket, trx, undefined, ['isDeleted'])
    if (e.basketId === 0) delete e.basketId
    const dbTrx = this.toDbTrx(['output_baskets'], 'readwrite', trx)
    const store = dbTrx.objectStore('output_baskets')
    try {
      const id = Number(await store.add!(e))
      basket.basketId = id
    } finally {
      if (trx == null) await dbTrx.done
    }
    return basket.basketId
  }

  async insertOutputTag (tag: TableOutputTag, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(tag, trx, undefined, ['isDeleted'])
    if (e.outputTagId === 0) delete e.outputTagId
    const dbTrx = this.toDbTrx(['output_tags'], 'readwrite', trx)
    const store = dbTrx.objectStore('output_tags')
    try {
      const id = Number(await store.add!(e))
      tag.outputTagId = id
    } finally {
      if (trx == null) await dbTrx.done
    }
    return tag.outputTagId
  }

  async insertOutputTagMap (tagMap: TableOutputTagMap, trx?: TrxToken): Promise<void> {
    const e = await this.validateEntityForInsert(tagMap, trx, undefined, ['isDeleted'])
    const dbTrx = this.toDbTrx(['output_tags_map'], 'readwrite', trx)
    const store = dbTrx.objectStore('output_tags_map')
    try {
      await store.add!(e)
    } finally {
      if (trx == null) await dbTrx.done
    }
  }

  async insertProvenTx (tx: TableProvenTx, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(tx, trx)
    if (e.provenTxId === 0) delete e.provenTxId
    const dbTrx = this.toDbTrx(['proven_txs'], 'readwrite', trx)
    const store = dbTrx.objectStore('proven_txs')
    try {
      const id = Number(await store.add!(e))
      tx.provenTxId = id
    } finally {
      if (trx == null) await dbTrx.done
    }
    return tx.provenTxId
  }

  async insertProvenTxReq (tx: TableProvenTxReq, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(tx, trx)
    if (e.provenTxReqId === 0) delete e.provenTxReqId
    const dbTrx = this.toDbTrx(['proven_tx_reqs'], 'readwrite', trx)
    const store = dbTrx.objectStore('proven_tx_reqs')
    try {
      const id = Number(await store.add!(e))
      tx.provenTxReqId = id
    } finally {
      if (trx == null) await dbTrx.done
    }
    return tx.provenTxReqId
  }

  async insertSyncState (syncState: TableSyncState, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(syncState, trx, ['when'], ['init'])
    if (e.syncStateId === 0) delete e.syncStateId
    const dbTrx = this.toDbTrx(['sync_states'], 'readwrite', trx)
    const store = dbTrx.objectStore('sync_states')
    try {
      const id = Number(await store.add!(e))
      syncState.syncStateId = id
    } finally {
      if (trx == null) await dbTrx.done
    }
    return syncState.syncStateId
  }

  async insertTransaction (tx: TableTransaction, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(tx, trx)
    if (e.transactionId === 0) delete e.transactionId
    const dbTrx = this.toDbTrx(['transactions'], 'readwrite', trx)
    const store = dbTrx.objectStore('transactions')
    try {
      const id = Number(await store.add!(e))
      tx.transactionId = id
    } finally {
      if (trx == null) await dbTrx.done
    }
    return tx.transactionId
  }

  async insertTxLabel (label: TableTxLabel, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(label, trx, undefined, ['isDeleted'])
    if (e.txLabelId === 0) delete e.txLabelId
    const dbTrx = this.toDbTrx(['tx_labels'], 'readwrite', trx)
    const store = dbTrx.objectStore('tx_labels')
    try {
      const id = Number(await store.add!(e))
      label.txLabelId = id
    } finally {
      if (trx == null) await dbTrx.done
    }
    return label.txLabelId
  }

  async insertTxLabelMap (labelMap: TableTxLabelMap, trx?: TrxToken): Promise<void> {
    const e = await this.validateEntityForInsert(labelMap, trx, undefined, ['isDeleted'])
    const dbTrx = this.toDbTrx(['tx_labels_map'], 'readwrite', trx)
    const store = dbTrx.objectStore('tx_labels_map')
    try {
      await store.add!(e)
    } finally {
      if (trx == null) await dbTrx.done
    }
  }

  async insertUser (user: TableUser, trx?: TrxToken): Promise<number> {
    const e = await this.validateEntityForInsert(user, trx)
    if (e.userId === 0) delete e.userId
    const dbTrx = this.toDbTrx(['users'], 'readwrite', trx)
    const store = dbTrx.objectStore('users')
    try {
      const id = Number(await store.add!(e))
      user.userId = id
    } finally {
      if (trx == null) await dbTrx.done
    }
    return user.userId
  }

  async updateIdb<T>(
    id: number | number[],
    update: Partial<T>,
    keyProp: string,
    storeName: string,
    trx?: TrxToken
  ): Promise<number> {
    if (update[keyProp] !== undefined && (Array.isArray(id) || update[keyProp] !== id)) {
      throw new WERR_INVALID_PARAMETER(`update.${keyProp}`, 'undefined')
    }
    const u = this.validatePartialForUpdate(update)
    const dbTrx = this.toDbTrx([storeName], 'readwrite', trx)
    const store = dbTrx.objectStore(storeName)
    const ids = Array.isArray(id) ? id : [id]
    let updated = 0
    try {
      for (const i of ids) {
        const e = await store.get(i)
        // Match Knex/Bun semantics: missing rows produce a 0-row result, not an error.
        // Caller receives the true updated count and can decide how to react.
        if (!e) continue
        const v: T = {
          ...e,
          ...u
        }
        const uid = await store.put!(v)
        if (uid !== i) throw new WERR_INTERNAL(`updated id ${String(uid)} does not match original ${String(id)}`)
        updated++
      }
    } finally {
      if (trx == null) await dbTrx.done
    }
    return updated
  }

  async updateIdbKey<T>(
    key: Array<number | string>,
    update: Partial<T>,
    keyProps: string[],
    storeName: string,
    trx?: TrxToken
  ): Promise<number> {
    if (key.length !== keyProps.length) { throw new WERR_INTERNAL(`key.length ${key.length} !== keyProps.length ${keyProps.length}`) }
    for (let i = 0; i < key.length; i++) {
      if (update[keyProps[i]] !== undefined && update[keyProps[i]] !== key[i]) {
        throw new WERR_INVALID_PARAMETER(`update.${keyProps[i]}`, 'undefined')
      }
    }
    const u = this.validatePartialForUpdate(update)
    const dbTrx = this.toDbTrx([storeName], 'readwrite', trx)
    const store = dbTrx.objectStore(storeName)
    try {
      const e = await store.get(key)
      if (!e) {
        throw new WERR_INVALID_PARAMETER(
          'key',
          `an existing record to update ${keyProps.join(',')} ${key.join(',')} not found`
        )
      }
      const v: T = {
        ...e,
        ...u
      }
      const uid = await store.put!(v)
      for (let i = 0; i < key.length; i++) {
        if (uid[i] !== key[i]) throw new WERR_INTERNAL(`updated key ${uid[i]} does not match original ${key[i]}`)
      }
    } finally {
      if (trx == null) await dbTrx.done
    }

    return 1
  }

  async updateCertificate (id: number, update: Partial<TableCertificate>, trx?: TrxToken): Promise<number> {
    return await this.updateIdb(id, update, 'certificateId', 'certificates', trx)
  }

  async updateCertificateField (
    certificateId: number,
    fieldName: string,
    update: Partial<TableCertificateField>,
    trx?: TrxToken
  ): Promise<number> {
    return await this.updateIdbKey(
      [certificateId, fieldName],
      update,
      ['certificateId', 'fieldName'],
      'certificate_fields',
      trx
    )
  }

  async updateCommission (id: number, update: Partial<TableCommission>, trx?: TrxToken): Promise<number> {
    return await this.updateIdb(id, update, 'commissionId', 'commissions', trx)
  }

  async updateMonitorEvent (id: number, update: Partial<TableMonitorEvent>, trx?: TrxToken): Promise<number> {
    return await this.updateIdb(id, update, 'id', 'monitor_events', trx)
  }

  async updateOutput (id: number, update: Partial<TableOutput>, trx?: TrxToken): Promise<number> {
    return await this.updateIdb(id, update, 'outputId', 'outputs', trx)
  }

  async updateOutputBasket (id: number, update: Partial<TableOutputBasket>, trx?: TrxToken): Promise<number> {
    return await this.updateIdb(id, update, 'basketId', 'output_baskets', trx)
  }

  async updateOutputTag (id: number, update: Partial<TableOutputTag>, trx?: TrxToken): Promise<number> {
    return await this.updateIdb(id, update, 'outputTagId', 'output_tags', trx)
  }

  async updateProvenTx (id: number, update: Partial<TableProvenTx>, trx?: TrxToken): Promise<number> {
    return await this.updateIdb(id, update, 'provenTxId', 'proven_txs', trx)
  }

  async updateProvenTxReq (id: number | number[], update: Partial<TableProvenTxReq>, trx?: TrxToken): Promise<number> {
    return await this.updateIdb(id, update, 'provenTxReqId', 'proven_tx_reqs', trx)
  }

  async updateSyncState (id: number, update: Partial<TableSyncState>, trx?: TrxToken): Promise<number> {
    return await this.updateIdb(id, update, 'syncStateId', 'sync_states', trx)
  }

  async updateTransaction (id: number | number[], update: Partial<TableTransaction>, trx?: TrxToken): Promise<number> {
    return await this.updateIdb(id, update, 'transactionId', 'transactions', trx)
  }

  async updateTxLabel (id: number, update: Partial<TableTxLabel>, trx?: TrxToken): Promise<number> {
    return await this.updateIdb(id, update, 'txLabelId', 'tx_labels', trx)
  }

  async updateUser (id: number, update: Partial<TableUser>, trx?: TrxToken): Promise<number> {
    return await this.updateIdb(id, update, 'userId', 'users', trx)
  }

  async updateOutputTagMap (
    outputId: number,
    tagId: number,
    update: Partial<TableOutputTagMap>,
    trx?: TrxToken
  ): Promise<number> {
    return await this.updateIdbKey([tagId, outputId], update, ['outputTagId', 'outputId'], 'output_tags_map', trx)
  }

  async updateTxLabelMap (
    transactionId: number,
    txLabelId: number,
    update: Partial<TableTxLabelMap>,
    trx?: TrxToken
  ): Promise<number> {
    return await this.updateIdbKey([txLabelId, transactionId], update, ['txLabelId', 'transactionId'], 'tx_labels_map', trx)
  }

  //
  // StorageReader abstract methods
  //

  async destroy (): Promise<void> {
    if (this.db != null) {
      this.db.close()
    }
    this.db = undefined
    this._settings = undefined
  }

  allStores: string[] = [
    'certificates',
    'certificate_fields',
    'commissions',
    'monitor_events',
    'outputs',
    'output_baskets',
    'output_tags',
    'output_tags_map',
    'proven_txs',
    'proven_tx_reqs',
    'sync_states',
    'transactions',
    'tx_labels',
    'tx_labels_map',
    'users'
  ]

  /**
   * @param scope
   * @param trx
   * @returns
   */
  async transaction<T>(scope: (trx: TrxToken) => Promise<T>, trx?: TrxToken): Promise<T> {
    if (trx != null) return await scope(trx)

    const stores = this.allStores

    const db = await this.verifyDB()
    const tx = db.transaction(stores, 'readwrite')

    try {
      const r = await scope(tx as TrxToken)
      await tx.done
      return r
    } catch (err) {
      tx.abort()
      await tx.done
      throw err
    }
  }

  async filterCertificateFields (
    args: FindCertificateFieldsArgs,
    filtered: (v: TableCertificateField) => void
  ): Promise<void> {
    this.assertNoUndefinedInPartial(args.partial)
    const dbTrx = this.toDbTrx(['certificate_fields'], 'readonly', args.trx)
    const store = dbTrx.objectStore('certificate_fields')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let cursor: any
    if (args.partial?.certificateId !== undefined) {
      cursor = await store.index('certificateId').openCursor(args.partial.certificateId)
    } else if (args.partial?.userId !== undefined) {
      cursor = await store.index('userId').openCursor(args.partial.userId)
    } else {
      cursor = await store.openCursor()
    }
    await scanCursor<TableCertificateField>(
      cursor, args.since, args.paged?.offset || 0, args.paged?.limit,
      r => matchesCertificateFieldPartial(r, args.partial),
      filtered
    )
    if (args.trx == null) await dbTrx.done
  }

  async findCertificateFields (args: FindCertificateFieldsArgs): Promise<TableCertificateField[]> {
    const result: TableCertificateField[] = []
    await this.filterCertificateFields(args, r => {
      result.push(this.validateEntity(r))
    })
    return result
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async openCertificatesCursor (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    partial: Partial<any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    if (partial?.certificateId) return store.openCursor(partial.certificateId)
    if (partial?.userId !== undefined) {
      if (partial?.type && partial?.certifier && partial?.serialNumber) {
        return store
          .index('userId_type_certifier_serialNumber')
          .openCursor([partial.userId, partial.type, partial.certifier, partial.serialNumber])
      }
      return store.index('userId').openCursor(partial.userId)
    }
    return store.openCursor()
  }

  async filterCertificates (args: FindCertificatesArgs, filtered: (v: TableCertificateX) => void): Promise<void> {
    this.assertNoUndefinedInPartial(args.partial)
    const dbTrx = this.toDbTrx(['certificates'], 'readonly', args.trx)
    const store = dbTrx.objectStore('certificates')
    const cursor = await this.openCertificatesCursor(store, args.partial)
    await scanCursor<TableCertificateX>(
      cursor,
      args.since,
      args.paged?.offset || 0,
      args.paged?.limit,
      r => {
        if (args.certifiers != null && !args.certifiers.includes(r.certifier)) return false
        if (args.types != null && !args.types.includes(r.type)) return false
        return matchesCertificatePartial(r, args.partial)
      },
      filtered
    )
    if (args.trx == null) await dbTrx.done
  }

  async findCertificates (args: FindCertificatesArgs): Promise<TableCertificateX[]> {
    const result: TableCertificateX[] = []
    await this.filterCertificates(args, r => {
      result.push(this.validateEntity(r))
    })
    if (args.includeFields) {
      for (const c of result) {
        const fields = await this.findCertificateFields({ partial: { certificateId: c.certificateId }, trx: args.trx })
        c.fields = fields
      }
    }
    return result
  }

  async filterCommissions (args: FindCommissionsArgs, filtered: (v: TableCommission) => void): Promise<void> {
    this.assertNoUndefinedInPartial(args.partial)
    if (args.partial.lockingScript != null) {
      throw new WERR_INVALID_PARAMETER(
        'partial.lockingScript',
        'undefined. Commissions may not be found by lockingScript value.'
      )
    }
    const dbTrx = this.toDbTrx(['commissions'], 'readonly', args.trx)
    const store = dbTrx.objectStore('commissions')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let cursor: any
    if (args.partial?.commissionId) {
      cursor = await store.openCursor(args.partial.commissionId)
    } else if (args.partial?.userId !== undefined) {
      cursor = await store.index('userId').openCursor(args.partial.userId)
    } else if (args.partial?.transactionId !== undefined) {
      cursor = await store.index('transactionId').openCursor(args.partial.transactionId)
    } else {
      cursor = await store.openCursor()
    }
    await scanCursor<TableCommission>(
      cursor, args.since, args.paged?.offset || 0, args.paged?.limit,
      r => matchesCommissionPartial(r, args.partial),
      filtered
    )
    if (args.trx == null) await dbTrx.done
  }

  async findCommissions (args: FindCommissionsArgs): Promise<TableCommission[]> {
    const result: TableCommission[] = []
    await this.filterCommissions(args, r => {
      result.push(this.validateEntity(r))
    })
    return result
  }

  async filterMonitorEvents (args: FindMonitorEventsArgs, filtered: (v: TableMonitorEvent) => void): Promise<void> {
    this.assertNoUndefinedInPartial(args.partial)
    const dbTrx = this.toDbTrx(['monitor_events'], 'readonly', args.trx)
    const store = dbTrx.objectStore('monitor_events')
    const cursor = args.partial?.id ? await store.openCursor(args.partial.id) : await store.openCursor()
    await scanCursor<TableMonitorEvent>(
      cursor, args.since, args.paged?.offset || 0, args.paged?.limit,
      r => matchesMonitorEventPartial(r, args.partial),
      filtered
    )
    if (args.trx == null) await dbTrx.done
  }

  async findMonitorEvents (args: FindMonitorEventsArgs): Promise<TableMonitorEvent[]> {
    const result: TableMonitorEvent[] = []
    await this.filterMonitorEvents(args, r => {
      result.push(this.validateEntity(r))
    })
    return result
  }

  async filterOutputBaskets (args: FindOutputBasketsArgs, filtered: (v: TableOutputBasket) => void): Promise<void> {
    this.assertNoUndefinedInPartial(args.partial)
    const dbTrx = this.toDbTrx(['output_baskets'], 'readonly', args.trx)
    const store = dbTrx.objectStore('output_baskets')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let cursor: any
    if (args.partial?.basketId) {
      cursor = await store.openCursor(args.partial.basketId)
    } else if (args.partial?.userId !== undefined && args.partial?.name !== undefined) {
      cursor = await store.index('name_userId').openCursor([args.partial.name, args.partial.userId])
    } else if (args.partial?.userId !== undefined) {
      cursor = await store.index('userId').openCursor(args.partial.userId)
    } else {
      cursor = await store.openCursor()
    }
    await scanCursor<TableOutputBasket>(
      cursor, args.since, args.paged?.offset || 0, args.paged?.limit,
      r => matchesOutputBasketPartial(r, args.partial),
      filtered
    )
    if (args.trx == null) await dbTrx.done
  }

  async findOutputBaskets (args: FindOutputBasketsArgs): Promise<TableOutputBasket[]> {
    const result: TableOutputBasket[] = []
    await this.filterOutputBaskets(args, r => {
      result.push(this.validateEntity(r))
    })
    return result
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async openOutputsCursor (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    partial: Partial<any>,
    direction: IDBCursorDirection
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    if (partial?.outputId) return store.openCursor(partial.outputId, direction)
    if (partial?.userId !== undefined) {
      if (partial?.transactionId && partial?.vout !== undefined) {
        return store.index('transactionId_vout_userId').openCursor(
          [partial.transactionId, partial.vout, partial.userId],
          direction
        )
      }
      return store.index('userId').openCursor(partial.userId, direction)
    }
    if (partial?.transactionId !== undefined) return store.index('transactionId').openCursor(partial.transactionId, direction)
    if (partial?.basketId !== undefined) return store.index('basketId').openCursor(partial.basketId, direction)
    if (partial?.spentBy !== undefined) return store.index('spentBy').openCursor(partial.spentBy, direction)
    return store.openCursor(null, direction)
  }

  async filterOutputs (
    args: FindOutputsArgs,
    filtered: (v: TableOutput) => void,
    tagIds?: number[],
    isQueryModeAll?: boolean
  ): Promise<void> {
    this.assertNoUndefinedInPartial(args.partial)
    if (args.partial.lockingScript != null) {
      throw new WERR_INVALID_PARAMETER(
        'args.partial.lockingScript',
        'undefined. Outputs may not be found by lockingScript value.'
      )
    }
    const stores = ['outputs']
    if (tagIds != null && tagIds.length > 0) stores.push('output_tags_map')
    if (args.txStatus != null) stores.push('transactions')
    const dbTrx = this.toDbTrx(stores, 'readonly', args.trx)
    const direction: IDBCursorDirection = args.orderDescending ? 'prev' : 'next'
    const store = dbTrx.objectStore('outputs')
    const cursor = await this.openOutputsCursor(store, args.partial, direction)
    await scanCursor<TableOutput>(
      cursor,
      args.since,
      args.paged?.offset || 0,
      args.paged?.limit,
      async r => {
        if (!matchesOutputPartial(r, args.partial)) return false
        if (args.txStatus !== undefined) {
          const txCount = await this.countTransactions({
            partial: { transactionId: r.transactionId },
            status: args.txStatus,
            trx: dbTrx
          })
          if (txCount === 0) return false
        }
        if (tagIds != null && tagIds.length > 0 && !await this.outputMatchesTags(r.outputId, tagIds, isQueryModeAll, dbTrx)) return false
        return true
      },
      r => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (args.noScript === true) (r as any).script = undefined
        filtered(r)
      }
    )
    if (args.trx == null) await dbTrx.done
  }

  private async outputMatchesTags (
    outputId: number,
    tagIds: number[],
    isQueryModeAll: boolean | undefined,
    dbTrx: IDBPTransaction<StorageIdbSchema, string[], 'readwrite' | 'readonly'>
  ): Promise<boolean> {
    let ids = [...tagIds]
    await this.filterOutputTagMaps({ partial: { outputId }, trx: dbTrx }, tm => {
      if (ids.length > 0) {
        const i = ids.indexOf(tm.outputTagId)
        if (i >= 0) {
          if (isQueryModeAll) {
            ids.splice(i, 1)
          } else {
            ids = []
          }
        }
      }
    })
    return ids.length === 0
  }

  async findOutputs (args: FindOutputsArgs, tagIds?: number[], isQueryModeAll?: boolean): Promise<TableOutput[]> {
    const results: TableOutput[] = []
    await this.filterOutputs(
      args,
      r => {
        results.push(this.validateEntity(r))
      },
      tagIds,
      isQueryModeAll
    )
    for (const o of results) {
      if (args.noScript) {
        o.lockingScript = undefined
      } else {
        await this.validateOutputScript(o, args.trx)
      }
    }
    return results
  }

  async filterOutputTags (args: FindOutputTagsArgs, filtered: (v: TableOutputTag) => void): Promise<void> {
    const dbTrx = this.toDbTrx(['output_tags'], 'readonly', args.trx)
    const store = dbTrx.objectStore('output_tags')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let cursor: any
    if (args.partial?.outputTagId) {
      cursor = await store.openCursor(args.partial.outputTagId)
    } else if (args.partial?.userId !== undefined && args.partial?.tag !== undefined) {
      cursor = await store.index('tag_userId').openCursor([args.partial.tag, args.partial.userId])
    } else if (args.partial?.userId !== undefined) {
      cursor = await store.index('userId').openCursor(args.partial.userId)
    } else {
      cursor = await store.openCursor()
    }
    await scanCursor<TableOutputTag>(
      cursor, args.since, args.paged?.offset || 0, args.paged?.limit,
      r => matchesOutputTagPartial(r, args.partial),
      filtered
    )
    if (args.trx == null) await dbTrx.done
  }

  async findOutputTags (args: FindOutputTagsArgs): Promise<TableOutputTag[]> {
    const result: TableOutputTag[] = []
    await this.filterOutputTags(args, r => {
      result.push(this.validateEntity(r))
    })
    return result
  }

  async filterSyncStates (args: FindSyncStatesArgs, filtered: (v: TableSyncState) => void): Promise<void> {
    if (args.partial.syncMap) {
      throw new WERR_INVALID_PARAMETER(
        'args.partial.syncMap',
        'undefined. SyncStates may not be found by syncMap value.'
      )
    }
    const dbTrx = this.toDbTrx(['sync_states'], 'readonly', args.trx)
    const store = dbTrx.objectStore('sync_states')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let cursor: any
    if (args.partial?.syncStateId) {
      cursor = await store.openCursor(args.partial.syncStateId)
    } else if (args.partial?.userId !== undefined) {
      cursor = await store.index('userId').openCursor(args.partial.userId)
    } else if (args.partial?.refNum !== undefined) {
      cursor = await store.index('refNum').openCursor(args.partial.refNum)
    } else if (args.partial?.status !== undefined) {
      cursor = await store.index('status').openCursor(args.partial.status)
    } else {
      cursor = await store.openCursor()
    }
    await scanCursor<TableSyncState>(
      cursor, args.since, args.paged?.offset || 0, args.paged?.limit,
      r => matchesSyncStatePartial(r, args.partial),
      filtered
    )
    if (args.trx == null) await dbTrx.done
  }

  async findSyncStates (args: FindSyncStatesArgs): Promise<TableSyncState[]> {
    const result: TableSyncState[] = []
    await this.filterSyncStates(args, r => {
      result.push(this.validateEntity(r))
    })
    return result
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async openTransactionsCursor (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    partial: Partial<any>,
    direction: IDBCursorDirection
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    if (partial?.transactionId) return store.openCursor(partial.transactionId, direction)
    if (partial?.userId !== undefined) {
      if (partial?.status !== undefined) {
        return store.index('status_userId').openCursor([partial.status, partial.userId], direction)
      }
      return store.index('userId').openCursor(partial.userId, direction)
    }
    if (partial?.status !== undefined) return store.index('status').openCursor(partial.status, direction)
    if (partial?.provenTxId !== undefined) return store.index('provenTxId').openCursor(partial.provenTxId, direction)
    if (partial?.reference !== undefined) return store.index('reference').openCursor(partial.reference, direction)
    return store.openCursor(null, direction)
  }

  async filterTransactions (
    args: FindTransactionsArgs,
    filtered: (v: TableTransaction) => void,
    labelIds?: number[],
    isQueryModeAll?: boolean
  ): Promise<void> {
    if (args.partial.rawTx != null) { throw new WERR_INVALID_PARAMETER('args.partial.rawTx', 'undefined. Transactions may not be found by rawTx value.') }
    if (args.partial.inputBEEF != null) {
      throw new WERR_INVALID_PARAMETER(
        'args.partial.inputBEEF',
        'undefined. Transactions may not be found by inputBEEF value.'
      )
    }
    const stores = ['transactions']
    if (labelIds != null && labelIds.length > 0) stores.push('tx_labels_map')
    const dbTrx = this.toDbTrx(stores, 'readonly', args.trx)
    const direction: IDBCursorDirection = args.orderDescending ? 'prev' : 'next'
    const store = dbTrx.objectStore('transactions')
    const cursor = await this.openTransactionsCursor(store, args.partial, direction)
    await scanCursor<TableTransaction>(
      cursor,
      args.since,
      args.paged?.offset || 0,
      args.paged?.limit,
      async r => {
        if (args.from != null && r.created_at.getTime() < args.from.getTime()) return false
        if (args.to != null && r.created_at.getTime() >= args.to.getTime()) return false
        if (args.status != null && !args.status.includes(r.status)) return false
        if (!matchesTransactionPartial(r, args.partial)) return false
        if (labelIds != null && labelIds.length > 0 && !await this.transactionMatchesLabels(r.transactionId, labelIds, isQueryModeAll, dbTrx)) return false
        return true
      },
      filtered
    )
    if (args.trx == null) await dbTrx.done
  }

  private async transactionMatchesLabels (
    transactionId: number,
    labelIds: number[],
    isQueryModeAll: boolean | undefined,
    dbTrx: IDBPTransaction<StorageIdbSchema, string[], 'readwrite' | 'readonly'>
  ): Promise<boolean> {
    let ids = [...labelIds]
    await this.filterTxLabelMaps({ partial: { transactionId }, trx: dbTrx }, lm => {
      if (ids.length > 0) {
        const i = ids.indexOf(lm.txLabelId)
        if (i >= 0) {
          if (isQueryModeAll) {
            ids.splice(i, 1)
          } else {
            ids = []
          }
        }
      }
    })
    return ids.length === 0
  }

  async findTransactions (
    args: FindTransactionsArgs,
    labelIds?: number[],
    isQueryModeAll?: boolean
  ): Promise<TableTransaction[]> {
    const results: TableTransaction[] = []
    await this.filterTransactions(
      args,
      r => {
        results.push(this.validateEntity(r))
      },
      labelIds,
      isQueryModeAll
    )
    for (const t of results) {
      if (args.noRawTx) {
        t.rawTx = undefined
        t.inputBEEF = undefined
      } else {
        await this.validateRawTransaction(t, args.trx)
      }
    }
    return results
  }

  async filterTxLabels (args: FindTxLabelsArgs, filtered: (v: TableTxLabel) => void): Promise<void> {
    const dbTrx = this.toDbTrx(['tx_labels'], 'readonly', args.trx)
    const store = dbTrx.objectStore('tx_labels')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let cursor: any
    if (args.partial?.txLabelId) {
      cursor = await store.openCursor(args.partial.txLabelId)
    } else if (args.partial?.userId !== undefined && args.partial?.label !== undefined) {
      cursor = await store.index('label_userId').openCursor([args.partial.label, args.partial.userId])
    } else if (args.partial?.userId !== undefined) {
      cursor = await store.index('userId').openCursor(args.partial.userId)
    } else {
      cursor = await store.openCursor()
    }
    await scanCursor<TableTxLabel>(
      cursor, args.since, args.paged?.offset || 0, args.paged?.limit,
      r => matchesTxLabelPartial(r, args.partial),
      filtered
    )
    if (args.trx == null) await dbTrx.done
  }

  async findTxLabels (args: FindTxLabelsArgs): Promise<TableTxLabel[]> {
    const result: TableTxLabel[] = []
    await this.filterTxLabels(args, r => {
      result.push(this.validateEntity(r))
    })
    return result
  }

  private matchesUserPartial (r: TableUser, partial: FindUsersArgs['partial']): boolean {
    if (!partial) return true
    if (partial.userId && r.userId !== partial.userId) return false
    if ((partial.created_at != null) && r.created_at.getTime() !== partial.created_at.getTime()) return false
    if ((partial.updated_at != null) && r.updated_at.getTime() !== partial.updated_at.getTime()) return false
    if (partial.identityKey && r.identityKey !== partial.identityKey) return false
    if (partial.activeStorage && r.activeStorage !== partial.activeStorage) return false
    return true
  }

  async filterUsers (args: FindUsersArgs, filtered: (v: TableUser) => void): Promise<void> {
    const dbTrx = this.toDbTrx(['users'], 'readonly', args.trx)
    const cursor = await dbTrx.objectStore('users').openCursor()
    await scanCursor<TableUser>(
      cursor,
      args.since,
      args.paged?.offset || 0,
      args.paged?.limit,
      r => this.matchesUserPartial(r, args.partial),
      filtered
    )
    if (args.trx == null) await dbTrx.done
  }

  async findUsers (args: FindUsersArgs): Promise<TableUser[]> {
    const result: TableUser[] = []
    await this.filterUsers(args, r => {
      result.push(this.validateEntity(r))
    })
    return result
  }

  async countCertificateFields (args: FindCertificateFieldsArgs): Promise<number> {
    let count = 0
    await this.filterCertificateFields(args, () => {
      count++
    })
    return count
  }

  async countCertificates (args: FindCertificatesArgs): Promise<number> {
    let count = 0
    await this.filterCertificates(args, () => {
      count++
    })
    return count
  }

  async countCommissions (args: FindCommissionsArgs): Promise<number> {
    let count = 0
    await this.filterCommissions(args, () => {
      count++
    })
    return count
  }

  async countMonitorEvents (args: FindMonitorEventsArgs): Promise<number> {
    let count = 0
    await this.filterMonitorEvents(args, () => {
      count++
    })
    return count
  }

  async countOutputBaskets (args: FindOutputBasketsArgs): Promise<number> {
    let count = 0
    await this.filterOutputBaskets(args, () => {
      count++
    })
    return count
  }

  async countOutputs (args: FindOutputsArgs, tagIds?: number[], isQueryModeAll?: boolean): Promise<number> {
    let count = 0
    await this.filterOutputs(
      { ...args, noScript: true },
      () => {
        count++
      },
      tagIds,
      isQueryModeAll
    )
    return count
  }

  async countOutputTags (args: FindOutputTagsArgs): Promise<number> {
    let count = 0
    await this.filterOutputTags(args, () => {
      count++
    })
    return count
  }

  async countSyncStates (args: FindSyncStatesArgs): Promise<number> {
    let count = 0
    await this.filterSyncStates(args, () => {
      count++
    })
    return count
  }

  async countTransactions (args: FindTransactionsArgs, labelIds?: number[], isQueryModeAll?: boolean): Promise<number> {
    let count = 0
    await this.filterTransactions(
      { ...args, noRawTx: true },
      () => {
        count++
      },
      labelIds,
      isQueryModeAll
    )
    return count
  }

  async countTxLabels (args: FindTxLabelsArgs): Promise<number> {
    let count = 0
    await this.filterTxLabels(args, () => {
      count++
    })
    return count
  }

  async countUsers (args: FindUsersArgs): Promise<number> {
    let count = 0
    await this.filterUsers(args, () => {
      count++
    })
    return count
  }

  async getProvenTxsForUser (args: FindForUserSincePagedArgs): Promise<TableProvenTx[]> {
    const results: TableProvenTx[] = []
    const fargs: FindProvenTxsArgs = {
      partial: {},
      since: args.since,
      paged: args.paged,
      trx: args.trx
    }
    await this.filterProvenTxs(
      fargs,
      r => {
        results.push(this.validateEntity(r))
      },
      args.userId
    )
    return results
  }

  async getProvenTxReqsForUser (args: FindForUserSincePagedArgs): Promise<TableProvenTxReq[]> {
    const results: TableProvenTxReq[] = []
    const fargs: FindProvenTxReqsArgs = {
      partial: {},
      since: args.since,
      paged: args.paged,
      trx: args.trx
    }
    await this.filterProvenTxReqs(
      fargs,
      r => {
        results.push(this.validateEntity(r))
      },
      args.userId
    )
    return results
  }

  async getTxLabelMapsForUser (args: FindForUserSincePagedArgs): Promise<TableTxLabelMap[]> {
    const results: TableTxLabelMap[] = []
    const fargs: FindTxLabelMapsArgs = {
      partial: {},
      since: args.since,
      paged: args.paged,
      trx: args.trx
    }
    await this.filterTxLabelMaps(
      fargs,
      r => {
        results.push(this.validateEntity(r))
      },
      args.userId
    )
    return results
  }

  async getOutputTagMapsForUser (args: FindForUserSincePagedArgs): Promise<TableOutputTagMap[]> {
    const results: TableOutputTagMap[] = []
    const fargs: FindOutputTagMapsArgs = {
      partial: {},
      since: args.since,
      paged: args.paged,
      trx: args.trx
    }
    await this.filterOutputTagMaps(
      fargs,
      r => {
        results.push(this.validateEntity(r))
      },
      args.userId
    )
    return results
  }

  async verifyReadyForDatabaseAccess (trx?: TrxToken): Promise<DBType> {
    this._settings ??= await this.readSettings()
    return this._settings.dbtype
  }

  /**
   * Helper to force uniform behavior across database engines.
   * Use to process all individual records with time stamps or number[] retreived from database.
   */
  validateEntity<T extends EntityTimeStamp>(entity: T, dateFields?: string[], booleanFields?: string[]): T {
    entity.created_at = this.validateDate(entity.created_at)
    entity.updated_at = this.validateDate(entity.updated_at)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const e = entity as any as Record<string, unknown>
    this.applyDateFields(e, dateFields)
    this.applyBooleanFields(e, booleanFields)
    this.normalizeEntityValues(e)
    return entity
  }

  private applyDateFields (entity: Record<string, unknown>, dateFields?: string[]): void {
    if (dateFields == null) return
    for (const df of dateFields) {
      if (entity[df]) entity[df] = this.validateDate(entity[df] as Date)
    }
  }

  private applyBooleanFields (entity: Record<string, unknown>, booleanFields?: string[]): void {
    if (booleanFields == null) return
    for (const df of booleanFields) {
      if (entity[df] !== undefined) entity[df] = Boolean(entity[df])
    }
  }

  private normalizeEntityValues (entity: Record<string, unknown>): void {
    for (const key of Object.keys(entity)) {
      const val = entity[key]
      if (val === null) {
        entity[key] = undefined
      } else if (val instanceof Uint8Array) {
        entity[key] = Array.from(val)
      }
    }
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
    const v: any = { ...update }
    v.created_at = v.created_at ? this.validateEntityDate(v.created_at) : undefined
    if (!v.created_at) delete v.created_at
    v.updated_at = v.updated_at ? this.validateEntityDate(v.updated_at) : this.validateEntityDate(new Date())
    this.applyOptionalDateFields(v, dateFields)
    this.applyIntegerBooleanFields(update, booleanFields)
    this.normalizeForStorage(v)
    this.isDirty = true
    return v
  }

  private applyOptionalDateFields (v: any, dateFields?: string[]): void {
    if (dateFields == null) return
    for (const df of dateFields) {
      if (v[df]) v[df] = this.validateOptionalEntityDate(v[df])
    }
  }

  private applyIntegerBooleanFields<T> (update: Partial<T>, booleanFields?: string[]): void {
    if (booleanFields == null) return
    for (const df of booleanFields) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const u = update as any
      if (u[df] !== undefined) u[df] = u[df] ? 1 : 0
    }
  }

  private normalizeForStorage (v: Record<string, unknown>): void {
    for (const key of Object.keys(v)) {
      const val = v[key]
      if (Array.isArray(val) && (val.length === 0 || Number.isInteger(val[0]))) {
        v[key] = Uint8Array.from(val as number[])
      } else if (val === null) {
        v[key] = undefined
      }
    }
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
  ): Promise<any> {
    await this.verifyReadyForDatabaseAccess(trx)
    const v: any = { ...entity }
    v.created_at = this.validateOptionalEntityDate(v.created_at, true)!
    v.updated_at = this.validateOptionalEntityDate(v.updated_at, true)!
    if (!v.created_at) delete v.created_at
    if (!v.updated_at) delete v.updated_at
    this.applyOptionalDateFields(v, dateFields)
    this.applyIntegerBooleanFields(entity, booleanFields)
    this.normalizeForStorage(v)
    this.isDirty = true
    return v
  }

  async validateRawTransaction (t: TableTransaction, trx?: TrxToken): Promise<void> {
    // if there is no txid or there is a rawTransaction return what we have.
    if (t.rawTx || !t.txid) return

    // rawTransaction is missing, see if we moved it ...

    const rawTx = await this.getRawTxOfKnownValidTransaction(t.txid, undefined, undefined, trx)
    if (rawTx == null) return
    t.rawTx = rawTx
  }

  async adminStats (adminIdentityKey: string): Promise<StorageAdminStats> {
    throw new Error('Method intentionally not implemented for personal storage.')
  }
}
