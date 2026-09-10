import { randomUUID } from 'node:crypto'
import type { ClientSession, Db, Document } from 'mongodb'
import type { StorageScope } from '../AdmissionStorage.js'
import { MongoCollectionNames, mongoNodeKey, mongoRecordKey } from './MongoSchema.js'

const maxTimeoutMs = 30_000

export interface MongoReadGuard {
  scope: StorageScope
  /** A bounded logical-record identifier, never a dynamic BSON key. */
  key: string
  /** `null` is an actual absent-record predicate, represented by a sentinel row. */
  expectedVersion: string | null
}

export interface MongoReadGuardOperationOptions {
  timeoutMS?: number
  signal?: AbortSignal
}

interface ReadGuardDocument extends Document {
  _id: string
  schemaVersion: 1
  network: string
  genesisHash: string
  nodeId: string
  key: string
  version: string | null
  guard: string
  createdAt: Date
  updatedAt: Date
}

/** A semantic predicate conflict, as distinct from a transient Mongo transaction retry. */
export class MongoReadGuardConflictError extends Error {
  public readonly code = 'mongo-read-guard-conflict'

  public constructor(read: MongoReadGuard) {
    super(`Mongo read guard conflict for ${read.key}`)
    this.name = 'MongoReadGuardConflictError'
  }
}

/**
 * Durable optimistic read predicates for the Mongo admission transaction.
 * Call `initialize` before starting a transaction; `check` and `changeVersion`
 * intentionally require an active transaction and always write the sentinel.
 */
export class MongoReadGuards {
  public constructor(private readonly db: Db) {}

  /**
   * Creates a version-null sentinel with majority+journal durability. This must
   * run before the caller opens the admission transaction, so a negative read
   * has a real row to conflict with a concurrent writer.
   */
  public async initialize(
    scope: StorageScope,
    key: string,
    operation: MongoReadGuardOperationOptions = {}
  ): Promise<void> {
    this.assertOperation(operation)
    const id = this.idFor(scope, key)
    const now = new Date()
    const collection = this.collection()
    try {
      await collection.updateOne(
        { _id: id },
        {
          $setOnInsert: {
            _id: id,
            schemaVersion: 1,
            network: scope.network,
            genesisHash: scope.genesisHash,
            nodeId: scope.nodeId,
            key,
            version: null,
            guard: randomUUID(),
            createdAt: now,
            updatedAt: now
          }
        },
        {
          upsert: true,
          timeoutMS: operation.timeoutMS,
          writeConcern: { w: 'majority', j: true }
        }
      )
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error
    }
    this.assertOperation(operation)
    const sentinel = await collection.findOne(
      { _id: id },
      {
        timeoutMS: operation.timeoutMS,
        readConcern: { level: 'majority' }
      }
    )
    if (
      sentinel === null ||
      sentinel.network !== scope.network ||
      sentinel.genesisHash !== scope.genesisHash ||
      sentinel.nodeId !== scope.nodeId ||
      sentinel.key !== key
    ) {
      throw new Error('Incompatible Mongo read guard sentinel')
    }
  }

  /** Checks a persisted version predicate by updating its random guard inside the transaction. */
  public async check(
    session: ClientSession,
    read: MongoReadGuard,
    operation: MongoReadGuardOperationOptions = {}
  ): Promise<void> {
    this.assertTransaction(session)
    this.assertOperation(operation)
    const id = this.idFor(read.scope, read.key)
    this.validateVersion(read.expectedVersion)
    const result = await this.collection().updateOne(
      { _id: id, version: read.expectedVersion },
      { $set: { guard: randomUUID(), updatedAt: new Date() } },
      { session, timeoutMS: operation.timeoutMS }
    )
    if (result.matchedCount !== 1) throw new MongoReadGuardConflictError(read)
    this.assertOperation(operation)
  }

  /** Changes version and guard in one transactionally fenced row write. */
  public async changeVersion(
    session: ClientSession,
    read: MongoReadGuard,
    nextVersion: string | null,
    operation: MongoReadGuardOperationOptions = {}
  ): Promise<void> {
    this.assertTransaction(session)
    this.assertOperation(operation)
    const id = this.idFor(read.scope, read.key)
    this.validateVersion(read.expectedVersion)
    this.validateVersion(nextVersion)
    const result = await this.collection().updateOne(
      { _id: id, version: read.expectedVersion },
      { $set: { version: nextVersion, guard: randomUUID(), updatedAt: new Date() } },
      { session, timeoutMS: operation.timeoutMS }
    )
    if (result.matchedCount !== 1) throw new MongoReadGuardConflictError(read)
    this.assertOperation(operation)
  }

  private collection() {
    return this.db.collection<ReadGuardDocument>(MongoCollectionNames.readGuards)
  }

  private idFor(scope: StorageScope, key: string): string {
    mongoNodeKey(scope)
    this.validatePart(key, 1024, 'key')
    return mongoRecordKey(mongoNodeKey(scope), 'read-guard', key)
  }

  private validateVersion(version: string | null): void {
    if (version === null) return
    this.validatePart(version, 256, 'version')
  }

  private validatePart(value: string, maximumBytes: number, label: string): void {
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      Buffer.byteLength(value, 'utf8') > maximumBytes ||
      value.includes('\u0000') ||
      !value.isWellFormed()
    ) {
      throw new Error(`Invalid Mongo read guard ${label}`)
    }
  }

  private assertTransaction(session: ClientSession): void {
    if (!session.inTransaction()) throw new Error('Mongo read guards require an active transaction')
  }

  private assertOperation(operation: MongoReadGuardOperationOptions): void {
    if (operation.signal?.aborted)
      throw operation.signal.reason ?? new Error('Mongo read guard operation aborted')
    if (
      operation.timeoutMS !== undefined &&
      (!Number.isSafeInteger(operation.timeoutMS) ||
        operation.timeoutMS < 1 ||
        operation.timeoutMS > maxTimeoutMs)
    ) {
      throw new Error('Invalid Mongo read guard operation timeout')
    }
  }
}
