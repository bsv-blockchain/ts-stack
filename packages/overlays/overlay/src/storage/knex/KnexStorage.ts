import {
  Storage,
  type AppliedTransaction,
  type AppliedTransactionProofUpdate,
  type StoredTransactionRecord,
  type UnprovenAppliedTransactionCandidate
} from '../Storage.js'
import { Knex } from 'knex'
import type { Output } from '../../Output.js'
import { Transaction } from '@bsv/sdk'
import {
  BASM_ZERO_HASH,
  type AdmittedTxRef,
  type RawTransactionRecord,
  type TopicAnchorTip,
  type TopicBlockAnchor,
  extractMerkleProofMetadata
} from '../../BASM.js'

const OUTPUT_SELECT_FIELDS = [
  'outputs.txid',
  'outputs.outputIndex',
  'outputs.outputScript',
  'outputs.topic',
  'outputs.satoshis',
  'outputs.outputsConsumed',
  'outputs.spent',
  'outputs.consumedBy',
  'outputs.blockHeight',
  'outputs.score'
] as const

export class KnexStorage implements Storage {
  knex: Knex

  constructor (knex: Knex) {
    this.knex = knex
  }

  private parseOutputRelations(
    value: string | Array<{ txid: string, outputIndex: number }>
  ): Array<{ txid: string, outputIndex: number }> {
    if (Array.isArray(value)) {
      return value
    }
    return JSON.parse(value)
  }

  private parseOutputRecord(
    row: any,
    includeBEEF: boolean,
    beefOverride?: number[]
  ): Output {
    return {
      ...row,
      outputScript: Array.from(row.outputScript),
      beef: (() => {
        if (!includeBEEF) return undefined
        if (beefOverride != null) return beefOverride
        return row.beef != null ? Array.from(row.beef) : undefined
      })(),
      spent: Boolean(row.spent),
      outputsConsumed: this.parseOutputRelations(row.outputsConsumed),
      consumedBy: this.parseOutputRelations(row.consumedBy)
    }
  }

  private binaryToNumberArray(value: any): number[] | undefined {
    if (value === undefined || value === null) {
      return undefined
    }
    return Array.from(Buffer.from(value))
  }

  private binaryToHex(value: any): string | undefined {
    const array = this.binaryToNumberArray(value)
    if (array === undefined) {
      return undefined
    }
    return Buffer.from(array).toString('hex')
  }

  private transactionRecordFromBEEF(txid: string, beef: number[]): StoredTransactionRecord {
    const tx = Transaction.fromBEEF(beef)
    const metadata = extractMerkleProofMetadata(txid, tx.merklePath)
    return {
      txid,
      beef: tx.merklePath !== undefined ? tx.toAtomicBEEF() : beef,
      rawTx: Array.from(tx.toBinary()),
      merklePath: tx.merklePath?.toBinary(),
      blockHeight: metadata?.blockHeight,
      blockIndex: metadata?.blockIndex,
      merkleRoot: metadata?.merkleRoot
    }
  }

  private async fetchTransactionBeefMap(txids: string[]): Promise<Map<string, number[]>> {
    if (txids.length === 0) {
      return new Map<string, number[]>()
    }

    const rows = await this.knex('transactions')
      .whereIn('txid', txids)
      .select(['txid', 'beef'])

    const beefByTxid = new Map<string, number[]>()
    for (const row of rows) {
      if (row.beef !== undefined && row.beef !== null) {
        beefByTxid.set(row.txid, Array.from(row.beef))
      }
    }
    return beefByTxid
  }

  async findOutput (txid: string, outputIndex: number, topic?: string, spent?: boolean, includeBEEF: boolean = false): Promise<Output | null> {
    const search: {
      'outputs.txid': string
      'outputs.outputIndex': number
      'outputs.topic'?: string
      'outputs.spent'?: boolean
    } = {
      'outputs.txid': txid,
      'outputs.outputIndex': outputIndex
    }
    if (topic !== undefined) search['outputs.topic'] = topic
    if (spent !== undefined) search['outputs.spent'] = spent

    const query = this.knex('outputs').where(search)
    const selectFields: string[] = [...OUTPUT_SELECT_FIELDS]

    if (includeBEEF) {
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      query.leftJoin('transactions', 'outputs.txid', 'transactions.txid')
      selectFields.push('transactions.beef')
    }

    const output = await query.select(selectFields).first()

    if (output === undefined || output === null) {
      return null
    }

    return this.parseOutputRecord(output, includeBEEF)
  }

  async findOutputsByOutpoints (
    outpoints: Array<{ txid: string, outputIndex: number }>,
    includeBEEF: boolean = false
  ): Promise<Output[]> {
    if (outpoints.length === 0) {
      return []
    }

    const deduped = new Map<string, { txid: string, outputIndex: number }>()
    for (const outpoint of outpoints) {
      deduped.set(`${outpoint.txid}:${outpoint.outputIndex}`, outpoint)
    }

    const rows = await this.knex('outputs')
      .whereIn(
        ['outputs.txid', 'outputs.outputIndex'],
        Array.from(deduped.values()).map(outpoint => [outpoint.txid, outpoint.outputIndex])
      )
      .select([...OUTPUT_SELECT_FIELDS])

    if (rows === undefined || rows.length === 0) {
      return []
    }

    if (!includeBEEF) {
      return rows.map(row => this.parseOutputRecord(row, false))
    }

    const txids = Array.from(new Set(rows.map(row => row.txid)))
    const beefByTxid = await this.fetchTransactionBeefMap(txids)
    return rows.map(row => this.parseOutputRecord(row, true, beefByTxid.get(row.txid)))
  }

  async findOutputsForTransaction (txid: string, includeBEEF: boolean = false): Promise<Output[]> {
    const outputs = await this.knex('outputs')
      .where({ 'outputs.txid': txid })
      .select([...OUTPUT_SELECT_FIELDS])

    if (outputs === undefined || outputs.length === 0) {
      return []
    }

    if (!includeBEEF) {
      return outputs.map(output => this.parseOutputRecord(output, false))
    }

    const beefByTxid = await this.fetchTransactionBeefMap([txid])
    return outputs.map(output => this.parseOutputRecord(output, true, beefByTxid.get(output.txid)))
  }

  async findUTXOsForTopic (topic: string, since?: number, limit?: number, includeBEEF: boolean = false): Promise<Output[]> {
    // Base query to get outputs
    const query = this.knex('outputs').where({ 'outputs.topic': topic, 'outputs.spent': false })

    // If provided, additionally filters UTXOs by score
    if (since !== undefined && since > 0) {
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      query.andWhere('outputs.score', '>=', since)
    }

    // Sort by score
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    query.orderBy('outputs.score', 'asc')

    // Apply limit if specified
    if (limit !== undefined && limit > 0) {
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      query.limit(limit)
    }

    const outputs = await query.select([...OUTPUT_SELECT_FIELDS])

    if (outputs === undefined || outputs.length === 0) {
      return []
    }

    if (!includeBEEF) {
      return outputs.map(output => this.parseOutputRecord(output, false))
    }

    const txids = Array.from(new Set(outputs.map(output => output.txid)))
    const beefByTxid = await this.fetchTransactionBeefMap(txids)
    return outputs.map(output => this.parseOutputRecord(output, true, beefByTxid.get(output.txid)))
  }

  async deleteOutput (txid: string, outputIndex: number, topic: string): Promise<void> {
    await this.knex.transaction(async trx => {
      // Delete the specific output
      await trx('outputs').where({ txid, outputIndex, topic }).del()

      // Check how many outputs reference the same transaction
      const remainingOutputs = await trx('outputs').where({ txid }).count('* as count').first()

      if (remainingOutputs !== undefined && Number(remainingOutputs.count) === 0) {
        // If no more outputs reference the transaction, delete the beef
        await trx('transactions').where({ txid }).del()
      }
    })
  }

  async insertOutput (output: Output): Promise<void> {
    await this.knex.transaction(async trx => {
      const existing = await trx('outputs').where({
        txid: output.txid,
        outputIndex: Number(output.outputIndex),
        topic: output.topic
      }).first()

      if (existing === undefined || existing === null) {
        await trx('outputs').insert({
          txid: output.txid,
          outputIndex: Number(output.outputIndex),
          outputScript: Buffer.from(output.outputScript),
          topic: output.topic,
          satoshis: Number(output.satoshis),
          outputsConsumed: JSON.stringify(output.outputsConsumed),
          consumedBy: JSON.stringify(output.consumedBy),
          spent: output.spent,
          score: output.score,
          blockHeight: output.blockHeight
        })
      }

      if (output.beef !== undefined) {
        const record = this.transactionRecordFromBEEF(output.txid, output.beef)
        const transactionRecord: Record<string, any> = {
          txid: output.txid,
          updatedAt: new Date()
        }
        if (record.beef !== undefined) transactionRecord.beef = Buffer.from(record.beef)
        if (record.rawTx !== undefined) transactionRecord.rawTx = Buffer.from(record.rawTx)
        if (record.merklePath !== undefined) transactionRecord.merklePath = Buffer.from(record.merklePath)
        if (record.blockHeight !== undefined) transactionRecord.blockHeight = record.blockHeight
        if (record.blockIndex !== undefined) transactionRecord.blockIndex = record.blockIndex
        if (record.merkleRoot !== undefined) transactionRecord.merkleRoot = record.merkleRoot

        const mergeRecord = { ...transactionRecord }
        delete mergeRecord.txid
        await trx('transactions').insert(transactionRecord).onConflict('txid').merge(mergeRecord)
      }
    })
  }

  async markUTXOAsSpent (txid: string, outputIndex: number, topic?: string): Promise<void> {
    await this.knex('outputs').where({
      txid,
      outputIndex,
      topic
    }).update('spent', true)
  }

  async updateConsumedBy (txid: string, outputIndex: number, topic: string, consumedBy: Array<{ txid: string, outputIndex: number }>): Promise<void> {
    await this.knex('outputs').where({
      txid,
      outputIndex,
      topic
    }).update('consumedBy', JSON.stringify(consumedBy))
  }

  async updateTransactionBEEF (txid: string, beef: number[]): Promise<void> {
    await this.upsertTransactionRecord(this.transactionRecordFromBEEF(txid, beef))
  }

  async updateOutputBlockHeight (txid: string, outputIndex: number, topic: string, blockHeight: number): Promise<void> {
    await this.knex('outputs').where({
      txid,
      outputIndex,
      topic
    }).update('blockHeight', blockHeight)
  }

  async upsertTransactionRecord(record: StoredTransactionRecord): Promise<void> {
    const insert: Record<string, any> = {
      txid: record.txid,
      updatedAt: new Date()
    }
    if (record.beef !== undefined) insert.beef = Buffer.from(record.beef)
    if (record.rawTx !== undefined) insert.rawTx = Buffer.from(record.rawTx)
    if (record.merklePath !== undefined) insert.merklePath = Buffer.from(record.merklePath)
    if (record.blockHeight !== undefined) insert.blockHeight = record.blockHeight
    if (record.blockHash !== undefined) insert.blockHash = record.blockHash
    if (record.blockIndex !== undefined) insert.blockIndex = record.blockIndex
    if (record.merkleRoot !== undefined) insert.merkleRoot = record.merkleRoot

    const merge = { ...insert }
    delete merge.txid

    await this.knex('transactions')
      .insert(insert)
      .onConflict('txid')
      .merge(merge)
  }

  async updateAppliedTransactionProof(record: AppliedTransactionProofUpdate): Promise<void> {
    await this.knex('applied_transactions')
      .where({ txid: record.txid, topic: record.topic })
      .update({
        blockHeight: record.blockHeight,
        blockHash: record.blockHash,
        blockIndex: record.blockIndex,
        merkleRoot: record.merkleRoot,
        proven: true
      })

    if (record.blockHeight !== undefined) {
      await this.knex('outputs')
        .where({ txid: record.txid, topic: record.topic })
        .update({ blockHeight: record.blockHeight })
    }
  }

  async insertAppliedTransaction (tx: AppliedTransaction): Promise<void> {
    await this.knex('applied_transactions').insert({
      txid: tx.txid,
      topic: tx.topic,
      blockHeight: tx.blockHeight,
      blockHash: tx.blockHash,
      blockIndex: tx.blockIndex,
      merkleRoot: tx.merkleRoot,
      firstSeenHeight: tx.firstSeenHeight,
      proven: tx.proven ?? false
    })
  }

  async doesAppliedTransactionExist (tx: { txid: string, topic: string }): Promise<boolean> {
    const result = await this.knex('applied_transactions')
      .where({ txid: tx.txid, topic: tx.topic })
      .select(this.knex.raw('1'))
      .first()

    return !!result
  }

  async updateLastInteraction (host: string, topic: string, since: number): Promise<void> {
    await this.knex('host_sync_state')
      .insert({ host, topic, since })
      .onConflict(['host', 'topic'])
      .merge({ since })
  }

  async getLastInteraction (host: string, topic: string): Promise<number> {
    const result = await this.knex('host_sync_state')
      .where({ host, topic })
      .select('since')
      .first()

    return result ? result.since : 0
  }

  async findAdmittedTransactionsForBlock(topic: string, blockHeight: number, blockHash?: string): Promise<AdmittedTxRef[]> {
    const query = this.knex('applied_transactions')
      .where({ topic, blockHeight, proven: true })
      .whereNotNull('blockIndex')

    if (blockHash !== undefined) {
      void query.andWhere({ blockHash })
    }

    const rows = await query
      .select(['txid', 'blockIndex'])
      .orderBy('blockIndex', 'asc')

    return rows.map(row => ({
      txid: row.txid,
      blockIndex: Number(row.blockIndex)
    }))
  }

  async upsertTopicBlockAnchor(anchor: TopicBlockAnchor): Promise<void> {
    await this.knex('topic_block_anchors')
      .insert({
        topic: anchor.topic,
        blockHeight: anchor.blockHeight,
        blockHash: anchor.blockHash,
        basmRoot: anchor.basmRoot,
        admittedCount: anchor.admittedCount,
        tac: anchor.tac,
        updatedAt: new Date()
      })
      .onConflict(['topic', 'blockHeight'])
      .merge({
        blockHash: anchor.blockHash,
        basmRoot: anchor.basmRoot,
        admittedCount: anchor.admittedCount,
        tac: anchor.tac,
        updatedAt: new Date()
      })
  }

  async findTopicBlockAnchor(topic: string, blockHeight: number, blockHash?: string): Promise<TopicBlockAnchor | undefined> {
    const query = this.knex('topic_block_anchors').where({ topic, blockHeight })
    if (blockHash !== undefined) {
      void query.andWhere({ blockHash })
    }
    const row = await query.first()
    if (row === undefined) {
      return undefined
    }
    return {
      topic: row.topic,
      blockHeight: Number(row.blockHeight),
      blockHash: row.blockHash,
      basmRoot: row.basmRoot,
      admittedCount: Number(row.admittedCount),
      tac: row.tac
    }
  }

  async findTopicBlockAnchors(topic: string, fromHeight: number, toHeight: number): Promise<TopicBlockAnchor[]> {
    const rows = await this.knex('topic_block_anchors')
      .where({ topic })
      .andWhere('blockHeight', '>=', fromHeight)
      .andWhere('blockHeight', '<=', toHeight)
      .select(['topic', 'blockHeight', 'blockHash', 'basmRoot', 'admittedCount', 'tac'])
      .orderBy('blockHeight', 'asc')

    return rows.map(row => ({
      topic: row.topic,
      blockHeight: Number(row.blockHeight),
      blockHash: row.blockHash,
      basmRoot: row.basmRoot,
      admittedCount: Number(row.admittedCount),
      tac: row.tac
    }))
  }

  async findTopicAnchorTip(topic: string): Promise<TopicAnchorTip | undefined> {
    const row = await this.knex('topic_block_anchors')
      .where({ topic })
      .orderBy('blockHeight', 'desc')
      .first()

    if (row === undefined) {
      return {
        topic,
        blockHeight: -1,
        tac: BASM_ZERO_HASH
      }
    }

    return {
      topic: row.topic,
      blockHeight: Number(row.blockHeight),
      blockHash: row.blockHash,
      basmRoot: row.basmRoot,
      admittedCount: Number(row.admittedCount),
      tac: row.tac
    }
  }

  async findRawTransactions(txids: string[]): Promise<RawTransactionRecord[]> {
    if (txids.length === 0) return []
    const rows = await this.knex('transactions')
      .whereIn('txid', txids)
      .select(['txid', 'rawTx', 'beef'])

    const records: RawTransactionRecord[] = []
    for (const row of rows) {
      let rawTx = this.binaryToHex(row.rawTx)
      if (rawTx === undefined) {
        const beef = this.binaryToNumberArray(row.beef)
        if (beef !== undefined) {
          rawTx = Transaction.fromBEEF(beef, row.txid).toHex()
        }
      }
      if (rawTx !== undefined) {
        records.push({ txid: row.txid, rawTx })
      }
    }
    return records
  }

  async findTransactionMerklePaths(txids: string[]): Promise<Array<{
    txid: string
    merklePath: string
    blockHeight?: number
    blockHash?: string
    blockIndex?: number
    merkleRoot?: string
  }>> {
    if (txids.length === 0) return []
    const rows = await this.knex('transactions')
      .whereIn('txid', txids)
      .select(['txid', 'merklePath', 'blockHeight', 'blockHash', 'blockIndex', 'merkleRoot', 'beef'])

    const records: Array<{
      txid: string
      merklePath: string
      blockHeight?: number
      blockHash?: string
      blockIndex?: number
      merkleRoot?: string
    }> = []

    for (const row of rows) {
      let merklePath = this.binaryToHex(row.merklePath)
      if (merklePath === undefined) {
        const beef = this.binaryToNumberArray(row.beef)
        if (beef !== undefined) {
          merklePath = Transaction.fromBEEF(beef, row.txid).merklePath?.toHex()
        }
      }
      if (merklePath !== undefined) {
        records.push({
          txid: row.txid,
          merklePath,
          blockHeight: row.blockHeight === undefined || row.blockHeight === null ? undefined : Number(row.blockHeight),
          blockHash: row.blockHash,
          blockIndex: row.blockIndex === undefined || row.blockIndex === null ? undefined : Number(row.blockIndex),
          merkleRoot: row.merkleRoot
        })
      }
    }

    return records
  }

  async findUnprovenAppliedTransactions(cutoffHeight: number, topic?: string): Promise<UnprovenAppliedTransactionCandidate[]> {
    const query = this.knex('applied_transactions')
      .where(builder => {
        builder.where({ proven: false }).orWhereNull('proven')
      })
      .whereNotNull('firstSeenHeight')
      .andWhere('firstSeenHeight', '<=', cutoffHeight)
      .select(['txid', 'topic', 'firstSeenHeight'])

    if (topic !== undefined) {
      void query.andWhere({ topic })
    }

    const rows = await query
    const candidates: UnprovenAppliedTransactionCandidate[] = []

    for (const row of rows) {
      const outputs = await this.knex('outputs')
        .where({ txid: row.txid, topic: row.topic })
        .select(['txid', 'outputIndex'])

      candidates.push({
        txid: row.txid,
        topic: row.topic,
        firstSeenHeight: row.firstSeenHeight === undefined || row.firstSeenHeight === null ? undefined : Number(row.firstSeenHeight),
        outputs: outputs.map(output => ({
          txid: output.txid,
          outputIndex: Number(output.outputIndex)
        }))
      })
    }

    return candidates
  }

  async deleteAppliedTransaction(txid: string, topic: string): Promise<void> {
    await this.knex('applied_transactions').where({ txid, topic }).del()
  }

  async findProvenAppliedTransactionsByBlockHash(blockHash: string): Promise<Array<{ txid: string, topic: string, blockHeight: number }>> {
    const rows = await this.knex('applied_transactions')
      .where({ blockHash, proven: true })
      .whereNotNull('blockHeight')
      .select(['txid', 'topic', 'blockHeight'])

    return rows.map(row => ({
      txid: row.txid,
      topic: row.topic,
      blockHeight: Number(row.blockHeight)
    }))
  }

  async findProvenAppliedTransactionsInRange(fromHeight: number, toHeight: number, topic?: string): Promise<Array<{ txid: string, topic: string, blockHeight: number, blockHash?: string, merkleRoot?: string }>> {
    const query = this.knex('applied_transactions')
      .where({ proven: true })
      .andWhere('blockHeight', '>=', fromHeight)
      .andWhere('blockHeight', '<=', toHeight)

    if (topic !== undefined) {
      void query.andWhere({ topic })
    }

    const rows = await query.select(['txid', 'topic', 'blockHeight', 'blockHash', 'merkleRoot'])

    return rows.map(row => ({
      txid: row.txid,
      topic: row.topic,
      blockHeight: Number(row.blockHeight),
      blockHash: row.blockHash ?? undefined,
      merkleRoot: row.merkleRoot ?? undefined
    }))
  }

  async demoteAppliedTransactionToUnproven(txid: string, topic: string): Promise<void> {
    await this.knex('applied_transactions')
      .where({ txid, topic })
      .update({
        blockHeight: null,
        blockHash: null,
        blockIndex: null,
        merkleRoot: null,
        proven: false
      })

    await this.knex('outputs')
      .where({ txid, topic })
      .update({ blockHeight: null })
  }
}
