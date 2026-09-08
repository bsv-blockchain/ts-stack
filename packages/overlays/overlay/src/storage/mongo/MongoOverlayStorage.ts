import { createHash } from 'node:crypto'
import type { Db, Document } from 'mongodb'
import type { Output } from '../../Output.js'
import type { AppliedTransaction, Storage } from '../Storage.js'
import type { AdmissionPayloadRef, HistoryFence, StorageScope } from '../AdmissionStorage.js'
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
    if (document === null) return { chainEpoch: '0', topicHistoryGeneration: '0' }
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
      byteLength: String(input.bytes.byteLength),
      txid: input.txid,
      bytes: (async function* () {
        yield input.bytes
      })()
    })
    return {
      kind: published.kind,
      digest: published.digest,
      byteLength: published.byteLength
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
  }

  async findOutput(
    txid: string,
    outputIndex: number,
    topic?: string,
    spent?: boolean
  ): Promise<Output | null> {
    const filter: Record<string, unknown> = {
      network: this.admissionScope.network,
      genesisHash: this.admissionScope.genesisHash,
      nodeId: this.admissionScope.nodeId,
      txid,
      outputIndex: encodeMongoOutputIndex(String(outputIndex))
    }
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
    return this.toOutput(document)
  }

  async findOutputsForTransaction(txid: string): Promise<Output[]> {
    const documents = await this.db
      .collection<IdDocument>(MongoCollectionNames.outputs)
      .find({
        network: this.admissionScope.network,
        genesisHash: this.admissionScope.genesisHash,
        nodeId: this.admissionScope.nodeId,
        txid
      })
      .toArray()
    return documents.map(document => this.toOutput(document))
  }

  async findUTXOsForTopic(topic: string, since?: number, limit?: number): Promise<Output[]> {
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
    return (await query.toArray()).map(document => this.toOutput(document))
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

  async markUTXOAsSpent(txid: string, outputIndex: number, topic: string): Promise<void> {
    await this.db
      .collection<IdDocument>(MongoCollectionNames.outputs)
      .updateOne(
        { _id: this.outputId(topic, txid, outputIndex), state: 'unspent' },
        { $set: { state: 'spent', updatedAt: new Date() } },
        { writeConcern: { w: 'majority', j: true } }
      )
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

  async updateTransactionBEEF(_txid: string, _beef: number[]): Promise<void> {}

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
    return Number(decodeMongoUint64(found.score as string))
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

  private toOutput(document: Record<string, unknown>): Output {
    return {
      txid: document.txid as string,
      outputIndex: Number(document.outputIndex),
      outputScript: [],
      satoshis: Number(decodeMongoUint64(document.satoshis as string)),
      topic: document.topic as string,
      spent: document.state === 'spent',
      outputsConsumed: [],
      consumedBy: [],
      score: Number(decodeMongoUint64(document.score as string))
    }
  }
}
