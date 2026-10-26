import { createHash } from 'node:crypto'
import type { Db, Document } from 'mongodb'
import { MerklePath, Transaction } from '@bsv/sdk'
import type { Output } from '../../Output.js'
import type { AppliedTransaction, Storage } from '../Storage.js'
import {
  asStorageUint64,
  parseStorageOutputIndex,
  parseStorageUint64,
  type AdmissionPayloadRef,
  type HistoryFence,
  type StorageScope
} from '../AdmissionStorage.js'
import {
  MongoAdmissionStorage,
  type MongoAdmissionStorageOptions
} from './MongoAdmissionStorage.js'
import { MongoPayloadStore, type MongoPayloadKind } from './MongoPayloadStore.js'
import {
  MongoCollectionNames,
  decodeMongoUint64,
  encodeMongoOutputIndex,
  encodeMongoUint64,
  mongoChainKey,
  mongoNodeKey,
  mongoRecordKey
} from './MongoSchema.js'

type IdDocument = Document & { _id: string }

const isPayloadKind = (value: string): value is MongoPayloadKind =>
  value === 'raw-transaction' ||
  value === 'merkle-path' ||
  value === 'beef-manifest' ||
  value === 'locking-script' ||
  value === 'outbox-data'

/**
 * Opt-in Mongo Storage adapter that advertises overlay-admission-v1 only because
 * commitAdmission actually honors majority ack, spends, history, and outbox.
 */
export class MongoOverlayStorage implements Storage {
  readonly admission: MongoAdmissionStorage
  readonly admissionScope: StorageScope
  private readonly payloads: MongoPayloadStore

  constructor(
    private readonly db: Db,
    scope: StorageScope,
    options: MongoAdmissionStorageOptions = {}
  ) {
    this.admissionScope = { ...scope }
    this.payloads = options.payloads ?? new MongoPayloadStore(db, this.admissionScope)
    this.admission = new MongoAdmissionStorage(db, this.admissionScope, {
      ...options,
      payloads: this.payloads
    })
  }

  enlistedIndexTargets(): readonly string[] {
    return this.admission.enlistedTargets()
  }

  async getHistoryFence(topic: string): Promise<HistoryFence> {
    const document = await this.admission.generations().findOne({
      _id: this.admission.generationId(topic)
    })
    if (document === null) {
      return { chainEpoch: asStorageUint64('0'), topicHistoryGeneration: asStorageUint64('0') }
    }
    return {
      chainEpoch: decodeMongoUint64(document.chainEpoch),
      topicHistoryGeneration: decodeMongoUint64(document.topicHistoryGeneration)
    }
  }

  async publishAdmissionPayload(input: {
    kind: AdmissionPayloadRef['kind']
    bytes: Uint8Array
    txid?: string
  }): Promise<AdmissionPayloadRef> {
    if (!isPayloadKind(input.kind)) throw new Error('Invalid Mongo admission payload kind')
    const digest = createHash('sha256').update(input.bytes).digest('hex')
    const published = await this.payloads.publish({
      kind: input.kind,
      digest,
      byteLength: asStorageUint64(String(input.bytes.byteLength)),
      txid: input.txid,
      bytes: (async function* () {
        yield input.bytes
      })()
    })
    return {
      kind: published.kind,
      digest: published.digest,
      byteLength: asStorageUint64(published.byteLength)
    }
  }

  async close(): Promise<void> {
    await this.admission.close()
  }

  async insertOutput(utxo: Output): Promise<void> {
    const now = new Date()
    const script = Buffer.from(utxo.outputScript)
    const payload = await this.publishAdmissionPayload({
      kind: 'locking-script',
      bytes: script
    })
    await this.db.collection<IdDocument>(MongoCollectionNames.outputs).updateOne(
      {
        _id: this.outputId(utxo.topic, utxo.txid, utxo.outputIndex),
        network: this.admissionScope.network,
        genesisHash: this.admissionScope.genesisHash,
        nodeId: this.admissionScope.nodeId
      },
      {
        $setOnInsert: {
          _id: this.outputId(utxo.topic, utxo.txid, utxo.outputIndex),
          schemaVersion: 1,
          network: this.admissionScope.network,
          genesisHash: this.admissionScope.genesisHash,
          nodeId: this.admissionScope.nodeId,
          topic: utxo.topic,
          txid: utxo.txid,
          outputIndex: encodeMongoOutputIndex(String(utxo.outputIndex)),
          satoshis: encodeMongoUint64(String(utxo.satoshis)),
          score: encodeMongoUint64(String(utxo.score ?? 0)),
          scriptPayloadId: this.admission.payloadId(payload),
          scriptOffset: encodeMongoUint64('0'),
          scriptByteLength: encodeMongoUint64(payload.byteLength),
          state: utxo.spent ? 'spent' : 'unspent',
          version: '1',
          createdAt: now
        },
        $set: { updatedAt: now }
      },
      { upsert: true, writeConcern: { w: 'majority', j: true } }
    )
    if (utxo.beef !== undefined) await this.persistTransactionBeef(utxo.txid, utxo.beef)
  }

  private async persistTransactionBeef(txid: string, beef: number[]): Promise<void> {
    const tx = Transaction.fromBEEF(beef)
    const published = await this.publishAdmissionPayload({
      kind: 'raw-transaction',
      bytes: Buffer.from(tx.toBinary()),
      txid
    })
    const now = new Date()
    const id = mongoRecordKey(mongoChainKey(this.admissionScope), 'transaction', txid)
    await this.db.collection<IdDocument>(MongoCollectionNames.transactions).updateOne(
      { _id: id },
      {
        $setOnInsert: {
          _id: id,
          schemaVersion: 1,
          network: this.admissionScope.network,
          genesisHash: this.admissionScope.genesisHash,
          txid,
          createdAt: now
        },
        $set: { rawPayloadId: this.admission.payloadId(published), updatedAt: now }
      },
      { upsert: true, writeConcern: { w: 'majority', j: true } }
    )
  }

  async findOutput(
    txid: string,
    outputIndex: number,
    topic?: string,
    spent?: boolean,
    includeBEEF = false
  ): Promise<Output | null> {
    const filter: Record<string, unknown> = {
      network: this.admissionScope.network,
      genesisHash: this.admissionScope.genesisHash,
      nodeId: this.admissionScope.nodeId,
      txid,
      outputIndex: encodeMongoOutputIndex(String(outputIndex))
    }
    // Evicted outputs remain for audit/history but must never be exposed as
    // current overlay state.
    filter.state = { $ne: 'evicted' }
    if (topic !== undefined) filter.topic = topic
    if (spent === true) filter.state = 'spent'
    if (spent === false) filter.state = 'unspent'
    const document = await this.db
      .collection<IdDocument>(MongoCollectionNames.outputs)
      .findOne(filter, {
        readConcern: { level: 'majority' },
        readPreference: 'primary'
      })
    if (document === null) return null
    return await this.toOutput(document, includeBEEF)
  }

  async findOutputsForTransaction(txid: string, includeBEEF = false): Promise<Output[]> {
    const documents = await this.db
      .collection<IdDocument>(MongoCollectionNames.outputs)
      .find({
        network: this.admissionScope.network,
        genesisHash: this.admissionScope.genesisHash,
        nodeId: this.admissionScope.nodeId,
        txid,
        state: { $ne: 'evicted' }
      })
      .toArray()
    return await this.toOutputs(documents, includeBEEF)
  }

  async findUTXOsForTopic(
    topic: string,
    since?: number,
    limit?: number,
    includeBEEF = false
  ): Promise<Output[]> {
    const filter: Record<string, unknown> = {
      network: this.admissionScope.network,
      genesisHash: this.admissionScope.genesisHash,
      nodeId: this.admissionScope.nodeId,
      topic,
      state: 'unspent'
    }
    if (since !== undefined && since > 0) filter.score = { $gte: encodeMongoUint64(String(since)) }
    let query = this.db
      .collection<IdDocument>(MongoCollectionNames.outputs)
      .find(filter)
      .sort({ score: 1, _id: 1 })
    if (limit !== undefined && limit > 0) query = query.limit(limit)
    return await this.toOutputs(await query.toArray(), includeBEEF)
  }

  /**
   * Maps a batch of raw output documents to `Output`s, dropping any that
   * `toOutput` treats as non-serving (see its docstring). Every current
   * caller's query already excludes `state: 'evicted'`, so this filter is
   * defense in depth rather than the primary guard.
   */
  private async toOutputs(
    documents: Array<Record<string, unknown>>,
    includeBEEF: boolean
  ): Promise<Output[]> {
    const mapped = await Promise.all(
      documents.map(async document => await this.toOutput(document, includeBEEF))
    )
    return mapped.filter((output): output is Output => output !== null)
  }

  async deleteOutput(txid: string, outputIndex: number, topic: string): Promise<void> {
    await this.db
      .collection<IdDocument>(MongoCollectionNames.outputs)
      .updateOne(
        { _id: this.outputId(topic, txid, outputIndex) },
        { $set: { state: 'evicted', updatedAt: new Date() } },
        { writeConcern: { w: 'majority', j: true } }
      )
  }

  async markUTXOAsSpent(
    txid: string,
    outputIndex: number,
    topic: string,
    spendingTxid?: string
  ): Promise<void> {
    const id = this.outputId(topic, txid, outputIndex)
    const result = await this.db.collection<IdDocument>(MongoCollectionNames.outputs).updateOne(
      { _id: id, state: 'unspent' },
      {
        $set: {
          state: 'spent',
          ...(spendingTxid === undefined ? {} : { spender: spendingTxid }),
          updatedAt: new Date()
        }
      },
      { writeConcern: { w: 'majority', j: true } }
    )
    if (result.modifiedCount === 1) return
    const existing = await this.db
      .collection<IdDocument>(MongoCollectionNames.outputs)
      .findOne({ _id: id }, { projection: { state: 1, spender: 1 } })
    if (
      spendingTxid !== undefined &&
      existing?.state === 'spent' &&
      existing.spender === spendingTxid
    )
      return
    throw new Error('Unable to atomically mark an unspent topical output as spent')
  }

  async updateConsumedBy(
    txid: string,
    outputIndex: number,
    topic: string,
    consumedBy: Array<{ txid: string; outputIndex: number }>
  ): Promise<void> {
    const now = new Date()
    for (const consumer of consumedBy) {
      const id = mongoRecordKey(
        mongoNodeKey(this.admissionScope),
        'edge',
        topic,
        txid,
        encodeMongoOutputIndex(String(outputIndex)),
        consumer.txid,
        encodeMongoOutputIndex(String(consumer.outputIndex))
      )
      await this.db.collection<IdDocument>(MongoCollectionNames.consumptionEdges).updateOne(
        { _id: id },
        {
          $setOnInsert: {
            _id: id,
            schemaVersion: 1,
            network: this.admissionScope.network,
            genesisHash: this.admissionScope.genesisHash,
            nodeId: this.admissionScope.nodeId,
            topic,
            sourceTxid: txid,
            sourceOutputIndex: encodeMongoOutputIndex(String(outputIndex)),
            consumerTxid: consumer.txid,
            consumerOutputIndex: encodeMongoOutputIndex(String(consumer.outputIndex)),
            createdAt: now
          },
          $set: { updatedAt: now }
        },
        { upsert: true, writeConcern: { w: 'majority', j: true } }
      )
    }
  }

  async updateTransactionBEEF(txid: string, _beef: number[]): Promise<void> {
    throw new Error(`Mongo overlay storage does not implement updateTransactionBEEF for ${txid}`)
  }

  async insertAppliedTransaction(tx: AppliedTransaction): Promise<void> {
    const now = new Date()
    const id = mongoRecordKey(mongoNodeKey(this.admissionScope), 'applied', tx.topic, tx.txid)
    await this.db.collection<IdDocument>(MongoCollectionNames.appliedTransactions).updateOne(
      { _id: id },
      {
        $setOnInsert: {
          _id: id,
          schemaVersion: 1,
          network: this.admissionScope.network,
          genesisHash: this.admissionScope.genesisHash,
          nodeId: this.admissionScope.nodeId,
          topic: tx.topic,
          txid: tx.txid,
          state: tx.proven === true ? 'active' : 'unproven',
          admissionId: tx.txid,
          createdAt: now
        },
        $set: { updatedAt: now }
      },
      { upsert: true, writeConcern: { w: 'majority', j: true } }
    )
  }

  async doesAppliedTransactionExist(tx: AppliedTransaction): Promise<boolean> {
    const found = await this.db
      .collection<IdDocument>(MongoCollectionNames.appliedTransactions)
      .findOne(
        {
          network: this.admissionScope.network,
          genesisHash: this.admissionScope.genesisHash,
          nodeId: this.admissionScope.nodeId,
          topic: tx.topic,
          txid: tx.txid
        },
        { readConcern: { level: 'majority' }, readPreference: 'primary' }
      )
    return found !== null
  }

  async updateLastInteraction(host: string, topic: string, since: number): Promise<void> {
    const now = new Date()
    const id = mongoRecordKey(mongoNodeKey(this.admissionScope), 'cursor', host, topic)
    await this.db.collection<IdDocument>(MongoCollectionNames.gaspCursors).updateOne(
      { _id: id },
      {
        $setOnInsert: {
          _id: id,
          schemaVersion: 1,
          network: this.admissionScope.network,
          genesisHash: this.admissionScope.genesisHash,
          nodeId: this.admissionScope.nodeId,
          remoteHost: host,
          topic,
          createdAt: now
        },
        $set: {
          state: 'ready',
          score: encodeMongoUint64(String(since)),
          updatedAt: now
        }
      },
      { upsert: true, writeConcern: { w: 'majority', j: true } }
    )
  }

  async getLastInteraction(host: string, topic: string): Promise<number> {
    const found = await this.db.collection<IdDocument>(MongoCollectionNames.gaspCursors).findOne({
      network: this.admissionScope.network,
      genesisHash: this.admissionScope.genesisHash,
      nodeId: this.admissionScope.nodeId,
      remoteHost: host,
      topic
    })
    if (found?.score === undefined) return 0
    return this.toSafeNumber(decodeMongoUint64(found.score as string), 'GASP cursor')
  }

  private outputId(topic: string, txid: string, outputIndex: number): string {
    return mongoRecordKey(
      mongoNodeKey(this.admissionScope),
      'output',
      topic,
      txid,
      encodeMongoOutputIndex(String(outputIndex))
    )
  }

  private toSafeNumber(value: string, label: string): number {
    const parsed = parseStorageUint64(value)
    if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`Mongo ${label} exceeds a safe JavaScript integer`)
    }
    return Number(parsed)
  }

  /**
   * Maps a raw output document to an `Output`, or `null` when the document
   * is not currently serving as overlay state. An admission eviction leaves
   * its row in place (state: 'evicted') for audit/history, and it must never
   * be reported as a live, unspent output — every caller that reaches here
   * must treat a `null` result the same as "not found", regardless of
   * whether its own query already excluded `evicted` rows.
   */
  private async toOutput(
    document: Record<string, unknown>,
    includeBEEF: boolean
  ): Promise<Output | null> {
    if (document.state === 'evicted') return null
    const topic = document.topic as string
    const txid = document.txid as string
    const outputIndex = String(document.outputIndex)
    const [outputsConsumed, consumedBy] = await Promise.all([
      this.readConsumptionEdges(
        topic,
        { consumerTxid: txid, consumerOutputIndex: outputIndex },
        'source'
      ),
      this.readConsumptionEdges(
        topic,
        { sourceTxid: txid, sourceOutputIndex: outputIndex },
        'consumer'
      )
    ])
    const output: Output = {
      txid,
      outputIndex: parseStorageOutputIndex(outputIndex),
      outputScript: await this.readScript(document),
      satoshis: this.toSafeNumber(decodeMongoUint64(document.satoshis as string), 'satoshis'),
      topic,
      spent: document.state === 'spent',
      outputsConsumed,
      consumedBy,
      score: this.toSafeNumber(decodeMongoUint64(document.score as string), 'score')
    }
    if (includeBEEF) {
      const beef = await this.readBeef(output.txid)
      if (beef !== undefined) output.beef = beef
    }
    return output
  }

  /**
   * Reads consumption edges persisted for this output (by either
   * MongoAdmissionStorage.insertEdge during a commit, or
   * MongoOverlayStorage.updateConsumedBy on the classic storage path) and
   * returns the opposite endpoint of each matching edge: querying by the
   * consumer side returns `outputsConsumed` (what this output's transaction
   * spent), and querying by the source side returns `consumedBy` (what has
   * since spent this output).
   */
  private async readConsumptionEdges(
    topic: string,
    match:
      | { sourceTxid: string; sourceOutputIndex: string }
      | { consumerTxid: string; consumerOutputIndex: string },
    side: 'source' | 'consumer'
  ): Promise<Array<{ txid: string; outputIndex: number }>> {
    const edges = await this.db
      .collection<IdDocument>(MongoCollectionNames.consumptionEdges)
      .find({
        network: this.admissionScope.network,
        genesisHash: this.admissionScope.genesisHash,
        nodeId: this.admissionScope.nodeId,
        topic,
        ...match
      })
      .toArray()
    return edges.map(edge => ({
      txid: (side === 'source' ? edge.sourceTxid : edge.consumerTxid) as string,
      outputIndex: parseStorageOutputIndex(
        String(side === 'source' ? edge.sourceOutputIndex : edge.consumerOutputIndex)
      )
    }))
  }

  private async readScript(document: Record<string, unknown>): Promise<number[]> {
    const payloadId = document.scriptPayloadId
    if (typeof payloadId !== 'string') return []
    const payload = await this.db.collection<IdDocument>(MongoCollectionNames.payloads).findOne({
      _id: payloadId,
      state: 'ready'
    })
    if (
      payload === null ||
      typeof payload.kind !== 'string' ||
      typeof payload.digest !== 'string' ||
      !isPayloadKind(payload.kind)
    ) {
      throw new Error('Mongo output script payload is not ready')
    }
    const bytes = await this.payloads.read(
      { kind: payload.kind, digest: payload.digest },
      {
        offset: decodeMongoUint64(document.scriptOffset as string),
        byteLength: decodeMongoUint64(document.scriptByteLength as string)
      }
    )
    return Array.from(bytes)
  }

  private async readBeef(txid: string): Promise<number[] | undefined> {
    const transaction = await this.db
      .collection<IdDocument>(MongoCollectionNames.transactions)
      .findOne({
        network: this.admissionScope.network,
        genesisHash: this.admissionScope.genesisHash,
        txid
      })
    const rawPayloadId = transaction?.rawPayloadId
    if (typeof rawPayloadId !== 'string') return undefined
    const rawPayload = await this.db.collection<IdDocument>(MongoCollectionNames.payloads).findOne({
      _id: rawPayloadId,
      state: 'ready'
    })
    if (
      rawPayload === null ||
      typeof rawPayload.kind !== 'string' ||
      typeof rawPayload.digest !== 'string' ||
      !isPayloadKind(rawPayload.kind)
    ) {
      return undefined
    }
    const raw = await this.payloads.read({ kind: rawPayload.kind, digest: rawPayload.digest })
    const tx = Transaction.fromBinary(Array.from(raw))
    const merkle = await this.db
      .collection<IdDocument>(MongoCollectionNames.payloadReferences)
      .findOne({
        network: this.admissionScope.network,
        genesisHash: this.admissionScope.genesisHash,
        nodeId: this.admissionScope.nodeId,
        ownerKind: 'transaction',
        ownerId: txid,
        slot: { $regex: '^merkle-path:' }
      })
    if (merkle !== null && typeof merkle.payloadId === 'string') {
      const merklePayload = await this.db
        .collection<IdDocument>(MongoCollectionNames.payloads)
        .findOne({
          _id: merkle.payloadId,
          state: 'ready'
        })
      if (
        merklePayload !== null &&
        typeof merklePayload.kind === 'string' &&
        typeof merklePayload.digest === 'string' &&
        isPayloadKind(merklePayload.kind)
      ) {
        const path = await this.payloads.read({
          kind: merklePayload.kind,
          digest: merklePayload.digest
        })
        tx.merklePath = MerklePath.fromBinary(Array.from(path))
      }
    }
    return tx.merklePath === undefined ? tx.toBEEF() : tx.toAtomicBEEF()
  }
}
