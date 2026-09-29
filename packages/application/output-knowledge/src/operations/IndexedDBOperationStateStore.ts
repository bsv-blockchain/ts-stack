import { OutputProtocolError, outputString, type OutputJSONObject } from '@bsv/sdk'
import {
  OperationStateCodec,
  type OperationStateLimits,
  type OperationStateStore,
  type OperationStateSnapshot,
  type OperationStateResult,
  type StoredOperationState
} from './OperationStateStore.js'

export interface IndexedDBOperationStateOptions {
  factory?: IDBFactory
  openTimeoutMs?: number
  limits?: Partial<OperationStateLimits>
}
const table = 'operation-state'
interface StoredRow extends StoredOperationState {
  namespace: string
}

/**
 * One atomic local workflow cell. Use a dedicated database name, separate from
 * receipt journals. Durability is subject to browser quota/eviction guarantees.
 */
export class IndexedDBOperationStateStore implements OperationStateStore {
  readonly durability = 'durable' as const
  private closed = false

  private constructor(
    private readonly database: IDBDatabase,
    readonly namespace: string,
    private readonly codec: OperationStateCodec
  ) {
    database.onversionchange = () => {
      database.close()
      this.closed = true
    }
  }

  /** Initialization is idempotent for the exact binding and initial state. */
  static async create(
    name: string,
    namespace: string,
    binding: OutputJSONObject,
    initial: OutputJSONObject,
    options: IndexedDBOperationStateOptions = {}
  ): Promise<IndexedDBOperationStateStore> {
    const codec = new OperationStateCodec(namespace, binding, options.limits)
    const row = codec.initial(initial)
    return await this.connect(name, codec, options, row)
  }

  /** A missing database or namespace requires explicit recovery; it is never initialized here. */
  static async open(
    name: string,
    namespace: string,
    binding: OutputJSONObject,
    options: IndexedDBOperationStateOptions = {}
  ): Promise<IndexedDBOperationStateStore> {
    return await this.connect(
      name,
      new OperationStateCodec(namespace, binding, options.limits),
      options
    )
  }

  private static async connect(
    name: string,
    codec: OperationStateCodec,
    options: IndexedDBOperationStateOptions,
    initial?: StoredOperationState
  ): Promise<IndexedDBOperationStateStore> {
    outputString(name)
    const factory = options.factory ?? globalThis.indexedDB
    if (!factory) throw new OutputProtocolError('unsupported', 'IndexedDB is unavailable')
    const timeout = options.openTimeoutMs ?? 5000
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60000)
      throw new OutputProtocolError('invalid', 'Invalid IndexedDB open timeout')
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        settled = true
        reject(new OutputProtocolError('unavailable', 'Operation database open deadline', true))
      }, timeout)
      const request = factory.open(name, 1)
      request.onupgradeneeded = () => {
        if (settled || initial === undefined) request.transaction!.abort()
        else request.result.createObjectStore(table, { keyPath: 'namespace' })
      }
      request.onerror = () => {
        clearTimeout(timer)
        if (!settled) {
          settled = true
          reject(new OutputProtocolError('unavailable', 'Cannot open operation database', true))
        }
      }
      request.onsuccess = () => {
        clearTimeout(timer)
        if (settled) request.result.close()
        else {
          settled = true
          resolve(request.result)
        }
      }
    })
    const store = new IndexedDBOperationStateStore(database, codec.namespace, codec)
    try {
      await store.transact(
        initial === undefined ? 'readonly' : 'readwrite',
        (transaction, done, fail) => {
          const request: IDBRequest<StoredRow | undefined> = transaction
            .objectStore(table)
            .get(codec.namespace)
          request.onsuccess = () => {
            try {
              if (request.result === undefined && initial !== undefined) {
                transaction.objectStore(table).add({ ...initial, namespace: codec.namespace })
              } else {
                const saved = store.stored(request.result)
                if (initial !== undefined && saved.initialDigest !== initial.initialDigest)
                  throw new OutputProtocolError('conflict', 'Operation initialization changed')
              }
              done(undefined)
            } catch (error) {
              fail(error)
            }
          }
        }
      )
      return store
    } catch (error) {
      await store.close()
      throw error
    }
  }

  private transact<T>(
    mode: IDBTransactionMode,
    work: (
      transaction: IDBTransaction,
      done: (value: T) => void,
      fail: (error: unknown) => void
    ) => void
  ): Promise<T> {
    if (this.closed)
      return Promise.reject(
        new OutputProtocolError('unavailable', 'Operation state store is closed')
      )
    return new Promise((resolve, reject) => {
      const transaction = this.database.transaction(table, mode, { durability: 'strict' })
      let result: T,
        completed = false,
        failure: unknown
      transaction.oncomplete = () => {
        if (completed) resolve(result)
        else reject(new OutputProtocolError('unavailable', 'Operation transaction has no result'))
      }
      transaction.onabort = () =>
        reject(
          failure ??
            new OutputProtocolError(
              transaction.error?.name === 'QuotaExceededError' ? 'limited' : 'unavailable',
              'Operation transaction aborted',
              true
            )
        )
      const done = (value: T): void => {
        completed = true
        result = value
      }
      const fail = (error: unknown): void => {
        failure = error
        transaction.abort()
      }
      try {
        work(transaction, done, fail)
      } catch (error) {
        fail(error)
      }
    })
  }

  private stored(row: StoredRow | undefined): StoredOperationState {
    if (row === undefined)
      throw new OutputProtocolError('reset-required', 'Operation namespace is missing')
    if (row.namespace !== this.namespace)
      throw new OutputProtocolError('reset-required', 'Operation namespace changed')
    this.codec.snapshot(row)
    return row
  }
  get configuration(): OperationStateStore['configuration'] {
    return this.codec.configurationValue()
  }
  async read(): Promise<OperationStateSnapshot> {
    return await this.transact('readonly', (transaction, done, fail) => {
      const request: IDBRequest<StoredRow | undefined> = transaction
        .objectStore(table)
        .get(this.namespace)
      request.onsuccess = () => {
        try {
          done(this.codec.snapshot(this.stored(request.result)))
        } catch (error) {
          fail(error)
        }
      }
    })
  }
  async compareAndSwap(
    expectedRevision: string,
    value: OutputJSONObject
  ): Promise<OperationStateResult> {
    const encoded = this.codec.encode(value)
    return await this.transact('readwrite', (transaction, done, fail) => {
      const request: IDBRequest<StoredRow | undefined> = transaction
        .objectStore(table)
        .get(this.namespace)
      request.onsuccess = () => {
        try {
          const { result, next } = this.codec.plan(
            this.stored(request.result),
            expectedRevision,
            encoded
          )
          if (next) transaction.objectStore(table).put({ ...next, namespace: this.namespace })
          done(result)
        } catch (error) {
          fail(error)
        }
      }
    })
  }
  async close(): Promise<void> {
    this.database.close()
    this.closed = true
  }
}
