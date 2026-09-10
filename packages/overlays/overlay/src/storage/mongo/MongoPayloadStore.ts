import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import {
  BSON,
  Binary,
  GridFSBucket,
  ObjectId,
  type ClientSession,
  type Collection,
  type Db,
  type Document
} from 'mongodb'
import {
  MongoCollectionNames,
  MongoGridFsBucketName,
  type MongoChainScope,
  mongoChainKey,
  mongoNodeKey,
  mongoRecordKey,
  encodeMongoUint64,
  decodeMongoUint64
} from './MongoSchema.js'

/** Content types intentionally do not encode a caller's ownership domain. */
export type MongoPayloadKind =
  'raw-transaction' | 'merkle-path' | 'beef-manifest' | 'locking-script' | 'outbox-data'

export type MongoPayloadReferenceOwnerKind =
  | 'transaction'
  | 'applied-history'
  | 'output'
  | 'gasp-graph'
  | 'gasp-node'
  | 'basm-job'
  | 'lookup-outbox'
  | 'propagation-outbox'
  | 'manifest'
  | 'pin'

export interface MongoPayloadInput {
  kind: MongoPayloadKind
  /** SHA-256 of the canonical bytes, provided before upload to obtain a fenced reservation. */
  digest: string
  bytes: AsyncIterable<Uint8Array>
  /** Canonical decimal uint64. The stream must contain exactly this many bytes. */
  byteLength: string
  /** Required when the caller has already derived the raw transaction identity. */
  txid?: string
  signal?: AbortSignal
}

export interface MongoPayloadRef {
  kind: MongoPayloadKind
  digest: string
  byteLength: string
  /** Bitcoin display-order txid, only for raw transaction payloads. */
  txid?: string
}

export interface MongoPayloadReference {
  scope: MongoChainScope & { nodeId: string }
  payload: Pick<MongoPayloadRef, 'kind' | 'digest'>
  ownerKind: MongoPayloadReferenceOwnerKind
  ownerId: string
  slot: string
  /** Explicit pins are the sole reference class permitted to expire. */
  expiresAt?: Date
}

/** A manifest is an ordered list of independent content-addressed components. */
export interface MongoManifestComponent {
  manifestId: string
  ordinal: string
  kind: MongoPayloadKind
  payload: Pick<MongoPayloadRef, 'kind' | 'digest'>
}

export interface MongoPayloadStoreOptions {
  /** Kept deliberately far below Mongo's document cap. */
  inlineCeilingBytes?: number
  /** A GridFS chunk must remain below the BSON document cap with ample overhead. */
  gridFsChunkBytes?: number
  uploadLeaseMs?: number
  /** Application-level byte bound; BSON/GridFS are not an admission resource limit. */
  maxPayloadBytes?: bigint
  now?: () => Date
  /** Narrow I/O seam used only to exercise crash boundaries. */
  hooks?: Partial<
    Record<
      'afterGridFsUploaded' | 'afterGridFsPublished' | 'beforeReadyCas' | 'afterDeleteClaim',
      () => Promise<void> | void
    >
  >
}

/** Per-operation cancellation/deadline controls supplied by the admission body. */
export interface MongoPayloadOperationOptions {
  timeoutMS?: number
  signal?: AbortSignal
}

type PayloadState = 'uploading' | 'ready' | 'deleting' | 'deleted'

interface PayloadDocument extends Document {
  _id: string
  network: string
  genesisHash: string
  kind: MongoPayloadKind
  digest: string
  byteLength: string
  state: PayloadState
  guard: string
  ownerNodeId: string
  ownerId: string
  fencingToken: string
  leaseUntil: Date
  createdAt: Date
  updatedAt: Date
  inlineData?: Binary
  fileId?: ObjectId
  retiredFileId?: ObjectId
  uploadId?: string
}

interface ReferenceDocument extends Document {
  _id: string
  payloadId: string
  ownerKind: MongoPayloadReferenceOwnerKind
  expiresAt?: Date
}

interface PayloadStream {
  hash: ReturnType<typeof createHash>
  length: bigint
  inline: Uint8Array[] | undefined
  upload: ReturnType<GridFSBucket['openUploadStreamWithId']> | undefined
  fileId: ObjectId | undefined
}

const MAX_UINT64 = (BigInt(1) << BigInt(64)) - BigInt(1)
const HEX_256 = /^[0-9a-f]{64}$/

function duplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000
}

/**
 * Content-addressed blob primitives for the Mongo adapter. The store deliberately
 * has no Engine/Storage methods: S03 combines its reference operations with the
 * owner record in an admission transaction.
 */
export class MongoPayloadStore {
  private readonly inlineCeiling: number
  private readonly gridFsChunkBytes: number
  private readonly uploadLeaseMs: number
  private readonly maxPayloadBytes: bigint
  private readonly now: () => Date
  private readonly bucket: GridFSBucket
  private readonly scope: MongoChainScope & { nodeId: string }
  private readonly writeConcern = { w: 'majority' as const, j: true }

  public constructor(
    private readonly db: Db,
    scope: MongoChainScope & { nodeId: string },
    private readonly options: MongoPayloadStoreOptions = {}
  ) {
    this.scope = { network: scope.network, genesisHash: scope.genesisHash, nodeId: scope.nodeId }
    this.inlineCeiling = options.inlineCeilingBytes ?? 256 * 1024
    this.gridFsChunkBytes = options.gridFsChunkBytes ?? 255 * 1024
    this.uploadLeaseMs = options.uploadLeaseMs ?? 60_000
    this.maxPayloadBytes = options.maxPayloadBytes ?? BigInt(64 * 1024 * 1024)
    this.now = options.now ?? (() => new Date())
    if (
      !Number.isSafeInteger(this.inlineCeiling) ||
      this.inlineCeiling < 1 ||
      this.inlineCeiling > 1024 * 1024
    )
      throw new Error('Invalid Mongo payload inline ceiling')
    if (
      !Number.isSafeInteger(this.gridFsChunkBytes) ||
      this.gridFsChunkBytes < 1 ||
      this.gridFsChunkBytes > 255 * 1024
    )
      throw new Error('Invalid Mongo GridFS chunk size')
    if (!Number.isSafeInteger(this.uploadLeaseMs) || this.uploadLeaseMs < 1)
      throw new Error('Invalid Mongo upload lease')
    if (this.maxPayloadBytes < BigInt(1) || this.maxPayloadBytes > MAX_UINT64)
      throw new Error('Invalid Mongo payload byte bound')
    this.bucket = new GridFSBucket(db, {
      bucketName: MongoGridFsBucketName,
      chunkSizeBytes: this.gridFsChunkBytes,
      writeConcern: this.writeConcern
    })
  }

  public async read(
    payload: Pick<MongoPayloadRef, 'kind' | 'digest'>,
    range?: { offset: string; byteLength: string }
  ): Promise<Uint8Array> {
    const payloadId = this.payloadId(this.scope, payload)
    const record = await this.db
      .collection<PayloadDocument>(MongoCollectionNames.payloads)
      .findOne({
        _id: payloadId,
        state: 'ready'
      })
    if (record === null) throw new Error('Mongo payload is not ready')
    const total = BigInt(decodeMongoUint64(record.byteLength))
    const offset = range === undefined ? BigInt(0) : BigInt(range.offset)
    const length = range === undefined ? total : BigInt(range.byteLength)
    if (offset < BigInt(0) || length < BigInt(0) || offset + length > total)
      throw new Error('Mongo payload range is invalid')
    if (offset + length > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error('Mongo payload range exceeds safe integer')
    const bytes = await this.readBytes(record)
    return bytes.subarray(Number(offset), Number(offset + length))
  }

  public async publish(input: MongoPayloadInput): Promise<MongoPayloadRef> {
    input = { ...input }
    this.validateInput(input)
    const payloadId = mongoRecordKey(mongoChainKey(this.scope), input.kind, input.digest)
    const payloads = this.db.collection<PayloadDocument>(MongoCollectionNames.payloads)
    const reserved = await this.reserveUpload(payloads, payloadId, input)
    if (reserved.ready) return this.refFor(input, reserved.record)
    return await this.completeUpload(payloads, input, payloadId, reserved.record)
  }

  /** Must be called in the same transaction that creates the referenced owner record. */
  public async addReference(
    session: ClientSession,
    reference: MongoPayloadReference,
    operation: MongoPayloadOperationOptions = {}
  ): Promise<void> {
    this.assertOperation(operation)
    this.assertTransaction(session)
    this.validateReference(reference)
    const payloadId = this.payloadId(reference.scope, reference.payload)
    const refs = this.db.collection<ReferenceDocument>(MongoCollectionNames.payloadReferences)
    const payloads = this.db.collection<PayloadDocument>(MongoCollectionNames.payloads)
    const refId = mongoRecordKey(
      mongoNodeKey(reference.scope),
      reference.ownerKind,
      reference.ownerId,
      reference.slot
    )
    const existing = await refs.findOne({ _id: refId }, { session, timeoutMS: operation.timeoutMS })
    if (existing !== null) {
      if (existing.payloadId !== payloadId)
        throw new Error('Mongo payload reference slot already names different content')
      return
    }
    // This conditional write is the guard; a snapshot read followed by an insert is unsafe.
    const guarded = await payloads.updateOne(
      { _id: payloadId, state: 'ready' },
      { $set: { updatedAt: this.now() } },
      { session, timeoutMS: operation.timeoutMS }
    )
    if (guarded.matchedCount !== 1) throw new Error('Mongo payload is not ready for reference')
    await refs.insertOne(
      {
        _id: refId,
        schemaVersion: 1,
        network: reference.scope.network,
        genesisHash: reference.scope.genesisHash,
        nodeId: reference.scope.nodeId,
        payloadId,
        ownerKind: reference.ownerKind,
        ownerId: reference.ownerId,
        slot: reference.slot,
        createdAt: this.now(),
        updatedAt: this.now(),
        ...(reference.expiresAt === undefined ? {} : { expiresAt: reference.expiresAt })
      },
      { session, timeoutMS: operation.timeoutMS }
    )
  }

  /** Must be called in the transaction that releases the owner record's payload obligation. */
  public async releaseReference(
    session: ClientSession,
    reference: MongoPayloadReference,
    operation: MongoPayloadOperationOptions = {}
  ): Promise<void> {
    this.assertOperation(operation)
    this.assertTransaction(session)
    this.validateReference(reference)
    const refId = mongoRecordKey(
      mongoNodeKey(reference.scope),
      reference.ownerKind,
      reference.ownerId,
      reference.slot
    )
    const payloadId = this.payloadId(reference.scope, reference.payload)
    const deleted = await this.db
      .collection<ReferenceDocument>(MongoCollectionNames.payloadReferences)
      .deleteOne({ _id: refId, payloadId }, { session, timeoutMS: operation.timeoutMS })
    if (deleted.deletedCount !== 1) throw new Error('Mongo payload reference does not exist')
  }

  /**
   * Creates one bounded manifest component and its durable pin in one caller
   * transaction. S03 can combine this with its manifest owner record; this
   * method does not parse or reconstruct BEEF.
   */
  public async addManifestComponent(
    session: ClientSession,
    component: MongoManifestComponent
  ): Promise<void> {
    this.assertTransaction(session)
    if (!this.isUint64(component.ordinal) || component.manifestId.length === 0)
      throw new Error('Invalid Mongo manifest component')
    if (component.kind !== component.payload.kind)
      throw new Error('Mongo manifest component kind mismatch')
    const scope = this.scope
    const ownerId = component.manifestId
    const slot = component.ordinal
    await this.addReference(session, {
      scope,
      payload: component.payload,
      ownerKind: 'manifest',
      ownerId,
      slot
    })
    const payloadId = this.payloadId(scope, component.payload)
    const id = mongoRecordKey(mongoNodeKey(scope), component.manifestId, component.ordinal)
    const existing = await this.db
      .collection<Document & { _id: string; payloadId: string; kind: string }>(
        MongoCollectionNames.manifestComponents
      )
      .findOne({ _id: id }, { session })
    if (existing !== null) {
      if (existing.payloadId !== payloadId || existing.kind !== component.kind)
        throw new Error('Mongo manifest ordinal already names different content')
      return
    }
    const now = this.now()
    await this.db
      .collection<Document & { _id: string }>(MongoCollectionNames.manifestComponents)
      .insertOne(
        {
          _id: id,
          schemaVersion: 1,
          network: scope.network,
          genesisHash: scope.genesisHash,
          nodeId: scope.nodeId,
          manifestId: component.manifestId,
          ordinal: encodeMongoUint64(component.ordinal),
          payloadId,
          kind: component.kind,
          createdAt: now,
          updatedAt: now
        },
        { session }
      )
  }

  /** Claims logical deletion inside a caller transaction; physical deletion resumes outside it. */
  public async claimGarbage(
    session: ClientSession,
    payload: Pick<MongoPayloadRef, 'kind' | 'digest'>,
    operation: MongoPayloadOperationOptions = {}
  ): Promise<boolean> {
    this.assertOperation(operation)
    this.assertTransaction(session)
    const payloadId = this.payloadId(this.scope, payload)
    const refs = this.db.collection<ReferenceDocument>(MongoCollectionNames.payloadReferences)
    const liveReferences = await refs.countDocuments(
      {
        payloadId,
        $or: [{ ownerKind: { $ne: 'pin' } }, { $expr: { $gt: ['$expiresAt', '$$NOW'] } }]
      },
      { session, timeoutMS: operation.timeoutMS }
    )
    if (liveReferences !== 0) return false
    const claimed = await this.db
      .collection<PayloadDocument>(MongoCollectionNames.payloads)
      .findOneAndUpdate(
        { _id: payloadId, state: 'ready' },
        [
          {
            $set: {
              state: 'deleting',
              guard: randomUUID(),
              updatedAt: '$$NOW',
              leaseUntil: {
                $dateAdd: { startDate: '$$NOW', unit: 'millisecond', amount: this.uploadLeaseMs }
              }
            }
          }
        ],
        { session, timeoutMS: operation.timeoutMS, returnDocument: 'after' }
      )
    if (claimed === null) return false
    await this.options.hooks?.afterDeleteClaim?.()
    return true
  }

  /** Safe to retry after process death. It only deletes the file named by the deleting record. */
  public async finishGarbage(payload: Pick<MongoPayloadRef, 'kind' | 'digest'>): Promise<boolean> {
    const payloadId = this.payloadId(this.scope, payload)
    const payloads = this.db.collection<PayloadDocument>(MongoCollectionNames.payloads)
    const record = await payloads.findOne({ _id: payloadId, state: 'deleting' })
    if (record === null) return false
    if (record.fileId !== undefined) {
      const owned = await this.db.collection(`${MongoGridFsBucketName}.files`).findOne({
        _id: record.fileId,
        'metadata.ownerId': record.ownerId,
        'metadata.fencingToken': record.fencingToken
      })
      if (owned !== null) {
        await this.bucket.delete(record.fileId).catch(error => {
          if (!(error instanceof Error) || !/FileNotFound/.test(error.message)) throw error
        })
      }
    }
    const result = await payloads.updateOne(
      { _id: payloadId, state: 'deleting', guard: record.guard },
      {
        $set: {
          state: 'deleted',
          updatedAt: this.now(),
          ...(record.fileId === undefined ? {} : { retiredFileId: record.fileId })
        },
        $unset: { inlineData: '', fileId: '' }
      },
      { writeConcern: this.writeConcern }
    )
    return result.modifiedCount === 1
  }

  /** Recovery may retain content; it never guesses that a missing external owner is disposable. */
  public async recoverUploads(): Promise<void> {
    const payloads = this.db.collection<PayloadDocument>(MongoCollectionNames.payloads)
    const stale = await payloads
      .find({
        network: this.scope.network,
        genesisHash: this.scope.genesisHash,
        state: 'uploading',
        $expr: { $lte: ['$leaseUntil', '$$NOW'] }
      })
      .toArray()
    for (const record of stale) await this.recoverStaleUpload(payloads, record)
    const deleting = await payloads
      .find({ network: this.scope.network, genesisHash: this.scope.genesisHash, state: 'deleting' })
      .toArray()
    for (const record of deleting)
      await this.finishGarbage({ kind: record.kind, digest: record.digest })
  }

  private async completeUpload(
    payloads: Collection<PayloadDocument>,
    input: MongoPayloadInput,
    payloadId: string,
    reserved: PayloadDocument
  ): Promise<MongoPayloadRef> {
    const ownerId = reserved.ownerId
    const fence = reserved.fencingToken
    let fileId: ObjectId | undefined
    try {
      const streamed = await this.streamInput(input, payloadId, ownerId, fence)
      this.throwIfAborted(input.signal)
      fileId = streamed.fileId
      this.assertStreamedPayload(input, streamed)
      const binary =
        streamed.inline === undefined ? undefined : new Binary(Buffer.concat(streamed.inline))
      if (binary !== undefined && !this.fitsInline(payloadId, input, binary, this.now()))
        throw new Error('Mongo payload inline BSON document exceeds safety ceiling')
      if (fileId !== undefined)
        await this.stageGridFsUpload(payloads, input, payloadId, ownerId, fence, fileId)
      await this.options.hooks?.beforeReadyCas?.()
      this.throwIfAborted(input.signal)
      const ready = await payloads.findOneAndUpdate(
        {
          _id: payloadId,
          state: 'uploading',
          ownerId,
          guard: ownerId,
          $expr: { $gt: ['$leaseUntil', '$$NOW'] }
        },
        {
          $set: {
            state: 'ready',
            updatedAt: this.now(),
            ...(fileId === undefined ? { inlineData: binary } : { fileId })
          },
          $unset: { uploadId: '' }
        },
        { returnDocument: 'after', writeConcern: this.writeConcern }
      )
      if (ready === null)
        throw new Error('Mongo payload upload lease was fenced before publication')
      return this.refFor(input, ready)
    } catch (error) {
      await this.abandonUpload(payloads, payloadId, ownerId, fence, fileId, error)
      throw error
    }
  }

  private assertStreamedPayload(
    input: MongoPayloadInput,
    streamed: { digest: string; length: bigint; txid?: string }
  ): void {
    if (streamed.digest !== input.digest || streamed.length !== BigInt(input.byteLength))
      throw new Error('Mongo payload digest or declared length mismatch')
    if (input.kind === 'raw-transaction' && input.txid !== undefined && input.txid !== streamed.txid)
      throw new Error('Mongo raw transaction id does not match bytes')
  }

  private async stageGridFsUpload(
    payloads: Collection<PayloadDocument>,
    input: MongoPayloadInput,
    payloadId: string,
    ownerId: string,
    fence: string,
    fileId: ObjectId
  ): Promise<void> {
    const staged = await payloads.updateOne(
      { _id: payloadId, state: 'uploading', ownerId, guard: ownerId },
      { $set: { fileId, updatedAt: this.now() } },
      { writeConcern: this.writeConcern }
    )
    if (staged.matchedCount !== 1)
      throw new Error('Mongo payload upload lease was fenced before staging')
    await this.verifyGridFs(fileId, input, input.signal)
    this.throwIfAborted(input.signal)
    await this.options.hooks?.afterGridFsUploaded?.()
    this.throwIfAborted(input.signal)
    const published = await this.db.collection(`${MongoGridFsBucketName}.files`).updateOne(
      {
        _id: fileId,
        'metadata.ownerId': ownerId,
        'metadata.fencingToken': fence,
        'metadata.state': 'staged'
      },
      { $set: { 'metadata.state': 'published' } },
      { writeConcern: this.writeConcern }
    )
    if (published.matchedCount !== 1) throw new Error('Mongo GridFS staged file was lost')
    await this.options.hooks?.afterGridFsPublished?.()
  }

  private async abandonUpload(
    payloads: Collection<PayloadDocument>,
    payloadId: string,
    ownerId: string,
    fence: string,
    fileId: ObjectId | undefined,
    error: unknown
  ): Promise<void> {
    // Never remove a file by payload identity: a newer fenced owner may have published it.
    if (fileId !== undefined) {
      const published = await this.db.collection(`${MongoGridFsBucketName}.files`).findOne({
        _id: fileId,
        'metadata.ownerId': ownerId,
        'metadata.fencingToken': fence,
        'metadata.state': 'published'
      })
      if (published !== null) throw error
      await this.retireOwnedFile(fileId, ownerId)
    }
    await payloads.updateOne(
      { _id: payloadId, state: 'uploading', ownerId, guard: ownerId },
      {
        $set: {
          state: 'deleted',
          updatedAt: this.now(),
          ...(fileId === undefined ? {} : { retiredFileId: fileId })
        },
        $unset: { inlineData: '', fileId: '' }
      },
      { writeConcern: this.writeConcern }
    )
  }

  private async recoverStaleUpload(
    payloads: Collection<PayloadDocument>,
    record: PayloadDocument
  ): Promise<void> {
    if (record.fileId !== undefined) {
      try {
        await this.verifyGridFs(record.fileId, {
          digest: record.digest,
          byteLength: BigInt(record.byteLength).toString()
        })
        await this.db.collection(`${MongoGridFsBucketName}.files`).updateOne(
          {
            _id: record.fileId,
            'metadata.ownerId': record.ownerId,
            'metadata.fencingToken': record.fencingToken
          },
          { $set: { 'metadata.state': 'published' } },
          { writeConcern: this.writeConcern }
        )
        const recovered = await payloads.updateOne(
          { _id: record._id, state: 'uploading', ownerId: record.ownerId, guard: record.guard },
          { $set: { state: 'ready', updatedAt: this.now() }, $unset: { uploadId: '' } },
          { writeConcern: this.writeConcern }
        )
        if (recovered.modifiedCount === 1) return
      } catch {
        /* an incomplete upload is retired below */
      }
    }
    const current = await payloads.findOne({ _id: record._id })
    if (
      current === null ||
      current.state !== 'uploading' ||
      current.ownerId !== record.ownerId ||
      current.guard !== record.guard
    ) {
      return
    }
    if (record.fileId !== undefined)
      await this.retireOwnedFile(record.fileId, record.ownerId, record.fencingToken)
    await payloads.updateOne(
      { _id: record._id, state: 'uploading', ownerId: record.ownerId, guard: record.guard },
      {
        $set: {
          state: 'deleted',
          updatedAt: this.now(),
          ...(record.fileId === undefined ? {} : { retiredFileId: record.fileId })
        },
        $unset: { inlineData: '', fileId: '' }
      },
      { writeConcern: this.writeConcern }
    )
  }

  private async reserveUpload(
    payloads: Collection<PayloadDocument>,
    payloadId: string,
    input: MongoPayloadInput
  ): Promise<{ ready: true; record: PayloadDocument } | { ready: false; record: PayloadDocument }> {
    const deadline = Date.now() + this.uploadLeaseMs
    while (true) {
      this.throwIfAborted(input.signal)
      const observed = await payloads.findOne({ _id: payloadId })
      if (observed?.state === 'ready') return { ready: true, record: observed }
      const claimed = await this.tryClaimUpload(payloads, payloadId, input, observed)
      if (claimed !== undefined) return claimed
      const ready = await payloads.findOne({ _id: payloadId, state: 'ready' })
      if (ready !== null) return { ready: true, record: ready }
      if (Date.now() > deadline) throw new Error('Mongo payload upload reservation was lost')
      await delay(50)
    }
  }

  private async tryClaimUpload(
    payloads: Collection<PayloadDocument>,
    payloadId: string,
    input: MongoPayloadInput,
    observed: PayloadDocument | null
  ): Promise<{ ready: false; record: PayloadDocument } | undefined> {
    const ownerId = randomUUID()
    const fence = encodeMongoUint64(
      (BigInt(observed?.fencingToken ?? '00000000000000000000') + BigInt(1)).toString()
    )
    try {
      const claimed = await payloads.findOneAndUpdate(
        observed === null
          ? { _id: payloadId, state: { $exists: false } }
          : {
              _id: payloadId,
              state: observed.state,
              guard: observed.guard,
              fencingToken: observed.fencingToken,
              $or: [{ state: 'deleted' }, { $expr: { $lte: ['$leaseUntil', '$$NOW'] } }]
            },
        [
          {
            $set: {
              schemaVersion: { $ifNull: ['$schemaVersion', 1] },
              network: { $ifNull: ['$network', this.scope.network] },
              genesisHash: { $ifNull: ['$genesisHash', this.scope.genesisHash] },
              kind: { $ifNull: ['$kind', input.kind] },
              digest: { $ifNull: ['$digest', input.digest] },
              byteLength: { $ifNull: ['$byteLength', encodeMongoUint64(input.byteLength)] },
              createdAt: { $ifNull: ['$createdAt', '$$NOW'] },
              state: 'uploading',
              guard: ownerId,
              ownerNodeId: this.scope.nodeId,
              ownerId,
              fencingToken: fence,
              leaseUntil: {
                $dateAdd: { startDate: '$$NOW', unit: 'millisecond', amount: this.uploadLeaseMs }
              },
              updatedAt: '$$NOW',
              uploadId: ownerId
            }
          },
          { $unset: ['inlineData', 'fileId'] }
        ],
        { upsert: observed === null, returnDocument: 'after', writeConcern: this.writeConcern }
      )
      if (claimed !== null && claimed.ownerId === ownerId && claimed.guard === ownerId) {
        if (observed?.fileId !== undefined)
          await this.retireOwnedFile(observed.fileId, observed.ownerId, observed.fencingToken)
        return { ready: false, record: claimed }
      }
    } catch (error) {
      if (!duplicateKey(error)) throw error
    }
    return undefined
  }

  private async streamInput(
    input: MongoPayloadInput,
    payloadId: string,
    ownerId: string,
    fencingToken: string
  ): Promise<{
    digest: string
    length: bigint
    txid?: string
    inline?: Uint8Array[]
    fileId?: ObjectId
  }> {
    const stream: PayloadStream = {
      hash: createHash('sha256'),
      length: BigInt(0),
      inline: [],
      upload: undefined,
      fileId: undefined
    }
    const iterator = input.bytes[Symbol.asyncIterator]()
    try {
      while (true) {
        const next = await this.nextWithAbort(iterator, input.signal)
        if (next.done) break
        await this.consumePayloadChunk(input, payloadId, ownerId, fencingToken, next.value, stream)
      }
      await this.finishPayloadUpload(stream.upload, input.signal)
    } catch (error) {
      stream.upload?.destroy(
        error instanceof Error ? error : new Error('Mongo payload stream failed')
      )
      await iterator.return?.().catch(() => undefined)
      throw error
    }
    const digest = stream.hash.digest()
    const result: {
      digest: string
      length: bigint
      txid?: string
      inline?: Uint8Array[]
      fileId?: ObjectId
    } = {
      digest: digest.toString('hex'),
      length: stream.length,
      inline: stream.inline,
      fileId: stream.fileId
    }
    if (input.kind === 'raw-transaction')
      result.txid = createHash('sha256').update(digest).digest().reverse().toString('hex')
    return result
  }

  private async consumePayloadChunk(
    input: MongoPayloadInput,
    payloadId: string,
    ownerId: string,
    fencingToken: string,
    chunk: unknown,
    stream: PayloadStream
  ): Promise<void> {
    if (input.signal?.aborted)
      throw input.signal.reason ?? new Error('Mongo payload upload aborted')
    if (!(chunk instanceof Uint8Array))
      throw new Error('Mongo payload stream yielded a non-byte chunk')
    stream.length += BigInt(chunk.byteLength)
    if (stream.length > BigInt(input.byteLength))
      throw new Error('Mongo payload stream exceeds declared length')
    if (stream.length > this.maxPayloadBytes)
      throw new Error('Mongo payload stream exceeds configured byte bound')
    stream.hash.update(chunk)
    if (stream.inline !== undefined) {
      stream.inline.push(chunk)
      if (stream.length > BigInt(this.inlineCeiling))
        await this.spillInlineToGridFs(input, payloadId, ownerId, fencingToken, stream)
      return
    }
    if (stream.upload === undefined) throw new Error('Mongo payload stream writer missing')
    if (!stream.upload.write(Buffer.from(chunk)))
      await this.awaitAbort(once(stream.upload, 'drain'), input.signal)
  }

  private async spillInlineToGridFs(
    input: MongoPayloadInput,
    payloadId: string,
    ownerId: string,
    fencingToken: string,
    stream: PayloadStream
  ): Promise<void> {
    const buffered = stream.inline
    if (buffered === undefined) throw new Error('Mongo payload stream writer missing')
    stream.fileId = new ObjectId()
    stream.upload = this.bucket.openUploadStreamWithId(stream.fileId, payloadId, {
      chunkSizeBytes: this.gridFsChunkBytes,
      metadata: {
        state: 'staged',
        payloadId,
        kind: input.kind,
        digest: input.digest,
        byteLength: encodeMongoUint64(input.byteLength),
        ownerId,
        fencingToken
      }
    })
    stream.inline = undefined
    for (const item of buffered)
      if (!stream.upload.write(Buffer.from(item)))
        await this.awaitAbort(once(stream.upload, 'drain'), input.signal)
  }

  private async finishPayloadUpload(
    upload: ReturnType<GridFSBucket['openUploadStreamWithId']> | undefined,
    signal?: AbortSignal
  ): Promise<void> {
    if (upload === undefined) return
    upload.end()
    await this.awaitAbort(once(upload, 'finish'), signal)
  }

  private fitsInline(
    payloadId: string,
    input: MongoPayloadInput,
    data: Binary,
    now: Date
  ): boolean {
    const candidate = {
      _id: payloadId,
      schemaVersion: 1,
      network: this.scope.network,
      genesisHash: this.scope.genesisHash,
      kind: input.kind,
      digest: input.digest,
      byteLength: encodeMongoUint64(input.byteLength),
      state: 'ready',
      guard: '0'.repeat(36),
      ownerNodeId: this.scope.nodeId,
      ownerId: '0'.repeat(36),
      fencingToken: encodeMongoUint64('1'),
      leaseUntil: now,
      createdAt: now,
      updatedAt: now,
      inlineData: data
    }
    return BSON.serialize(candidate).byteLength < 1024 * 1024
  }

  private async retireOwnedFile(
    fileId: ObjectId,
    ownerId: string,
    fencingToken?: string
  ): Promise<void> {
    const file = await this.db.collection(`${MongoGridFsBucketName}.files`).findOne({
      _id: fileId,
      'metadata.ownerId': ownerId,
      ...(fencingToken === undefined ? {} : { 'metadata.fencingToken': fencingToken })
    })
    if (file !== null) await this.bucket.delete(fileId).catch(() => undefined)
  }

  private async readBytes(record: PayloadDocument): Promise<Buffer> {
    if (record.inlineData !== undefined) return Buffer.from(record.inlineData.buffer)
    if (record.fileId === undefined) throw new Error('Mongo ready payload has no bytes')
    const chunks: Buffer[] = []
    const download = this.bucket.openDownloadStream(record.fileId)
    const iterator = download[Symbol.asyncIterator]()
    try {
      while (true) {
        const next = await iterator.next()
        if (next.done) break
        const chunk = next.value
        if (!(chunk instanceof Uint8Array))
          throw new Error('Mongo GridFS returned a non-byte chunk')
        chunks.push(Buffer.from(chunk))
      }
    } catch (error) {
      download.destroy(error instanceof Error ? error : new Error('Mongo payload read failed'))
      throw error
    }
    return Buffer.concat(chunks)
  }

  private async verifyGridFs(
    fileId: ObjectId,
    input: Pick<MongoPayloadInput, 'digest' | 'byteLength'>,
    signal?: AbortSignal
  ): Promise<void> {
    const hash = createHash('sha256')
    let length = BigInt(0)
    const download = this.bucket.openDownloadStream(fileId)
    const iterator = download[Symbol.asyncIterator]()
    try {
      while (true) {
        const next = await this.nextWithAbort(iterator, signal)
        if (next.done) break
        const chunk = next.value
        if (!(chunk instanceof Uint8Array))
          throw new Error('Mongo GridFS returned a non-byte chunk')
        length += BigInt(chunk.byteLength)
        hash.update(chunk)
      }
    } catch (error) {
      download.destroy(
        error instanceof Error ? error : new Error('Mongo GridFS verification failed')
      )
      throw error
    }
    if (length !== BigInt(input.byteLength) || hash.digest('hex') !== input.digest)
      throw new Error('Mongo GridFS staged payload verification failed')
  }

  private refFor(input: MongoPayloadInput, record?: PayloadDocument): MongoPayloadRef {
    if (record !== undefined && decodeMongoUint64(record.byteLength) !== input.byteLength)
      throw new Error('Mongo payload byte length does not match ready content')
    const ref: MongoPayloadRef = {
      kind: input.kind,
      digest: input.digest,
      byteLength: input.byteLength
    }
    if (input.kind === 'raw-transaction') {
      ref.txid = createHash('sha256')
        .update(Buffer.from(input.digest, 'hex'))
        .digest()
        .reverse()
        .toString('hex')
      if (input.txid !== undefined && input.txid !== ref.txid)
        throw new Error('Mongo raw transaction id does not match bytes')
    }
    return ref
  }

  private payloadId(
    scope: MongoChainScope,
    payload: Pick<MongoPayloadRef, 'kind' | 'digest'>
  ): string {
    if (!HEX_256.test(payload.digest)) throw new Error('Invalid Mongo payload digest')
    return mongoRecordKey(mongoChainKey(scope), payload.kind, payload.digest)
  }

  private validateInput(input: MongoPayloadInput): void {
    this.payloadId(this.scope, input)
    if (!this.isUint64(input.byteLength)) throw new Error('Invalid Mongo payload byte length')
    if (BigInt(input.byteLength) > this.maxPayloadBytes)
      throw new Error('Mongo payload exceeds configured byte bound')
    if (input.txid !== undefined && (input.kind !== 'raw-transaction' || !HEX_256.test(input.txid)))
      throw new Error('Invalid Mongo raw transaction id')
  }

  private validateReference(reference: MongoPayloadReference): void {
    this.payloadId(reference.scope, reference.payload)
    if (
      reference.scope.network !== this.scope.network ||
      reference.scope.genesisHash !== this.scope.genesisHash ||
      reference.scope.nodeId !== this.scope.nodeId
    )
      throw new Error('Mongo payload reference scope does not match this store')
    if (reference.ownerId.length === 0 || reference.slot.length === 0)
      throw new Error('Invalid Mongo payload reference owner')
    if ((reference.ownerKind === 'pin') !== (reference.expiresAt !== undefined))
      throw new Error('Mongo payload expiry is valid only for explicit pins')
    if (reference.expiresAt !== undefined && reference.expiresAt <= this.now())
      throw new Error('Mongo payload pin must be unexpired')
  }

  private assertTransaction(session: ClientSession): void {
    if (!session.inTransaction())
      throw new Error('Mongo payload reference changes require an active transaction')
  }

  private assertOperation(operation: MongoPayloadOperationOptions): void {
    if (operation.signal?.aborted)
      throw operation.signal.reason ?? new Error('Mongo payload operation aborted')
    if (
      operation.timeoutMS !== undefined &&
      (!Number.isSafeInteger(operation.timeoutMS) || operation.timeoutMS < 1)
    )
      throw new Error('Invalid Mongo payload operation timeout')
  }

  private async nextWithAbort<T>(
    iterator: AsyncIterator<T>,
    signal?: AbortSignal
  ): Promise<IteratorResult<T>> {
    if (signal === undefined) return await iterator.next()
    if (signal.aborted) throw signal.reason ?? new Error('Mongo payload upload aborted')
    return await this.raceAbort(iterator.next(), signal)
  }

  private async awaitAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal === undefined) return await promise
    if (signal.aborted) throw signal.reason ?? new Error('Mongo payload upload aborted')
    return await this.raceAbort(promise, signal)
  }

  private async raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      const abort = () => {
        cleanup()
        reject(signal.reason ?? new Error('Mongo payload upload aborted'))
      }
      const cleanup = () => signal.removeEventListener('abort', abort)
      signal.addEventListener('abort', abort, { once: true })
      promise.then(
        value => {
          cleanup()
          resolve(value)
        },
        error => {
          cleanup()
          reject(error)
        }
      )
    })
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw signal.reason ?? new Error('Mongo payload upload aborted')
  }

  private isUint64(value: string): boolean {
    return /^(0|[1-9]\d{0,19})$/.test(value) && BigInt(value) <= MAX_UINT64
  }
}
