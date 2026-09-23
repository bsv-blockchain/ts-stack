import { GroupMessagingError } from '../../errors.js'
import { STORAGE_TABLES, type StorageBackend, type StorageTable } from '../backend.js'

export class IndexedDbUnavailableError extends GroupMessagingError {
  override name = 'IndexedDbUnavailableError'
  constructor() {
    super('IndexedDB is not available here. Pass a StorageBackend instead.')
  }
}

export const DEFAULT_DATABASE_NAME = 'bsv-group-messaging'

const promisify = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result)
    }
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB request failed'))
    }
  })

const abortError = (transaction: IDBTransaction, what: string): GroupMessagingError => {
  const message = `IndexedDB transaction ${what} before the write committed`
  return transaction.error === null
    ? new GroupMessagingError(message)
    : new GroupMessagingError(message, { cause: transaction.error })
}

/**
 * Open (or create) a database with the object stores this backend expects.
 *
 * Separate from the backend so an application already managing an
 * `IDBDatabase` can hand over its own.
 */
export const openDatabase = async (name: string = DEFAULT_DATABASE_NAME): Promise<IDBDatabase> => {
  const factory: IDBFactory | undefined = globalThis.indexedDB
  if (factory === undefined) throw new IndexedDbUnavailableError()

  const request = factory.open(name, 1)
  request.onupgradeneeded = () => {
    for (const table of STORAGE_TABLES) {
      if (!request.result.objectStoreNames.contains(table)) {
        request.result.createObjectStore(table)
      }
    }
  }
  return promisify(request)
}

/** A backend over IndexedDB, one object store per namespace. */
export class IndexedDbStorageBackend implements StorageBackend {
  constructor(private readonly database: IDBDatabase) {}

  async get(table: StorageTable, key: string): Promise<Uint8Array | undefined> {
    const value = await this.#run(table, 'readonly', store => store.get(key))
    return value === undefined ? undefined : toBytes(value)
  }

  async set(table: StorageTable, key: string, value: Uint8Array): Promise<void> {
    // Structured clone of a view keeps the whole underlying buffer alive, and
    // framed queues share buffers — so copy before handing it over.
    await this.#run(table, 'readwrite', store => store.put(value.slice(), key))
  }

  async delete(table: StorageTable, key: string): Promise<void> {
    await this.#run(table, 'readwrite', store => store.delete(key))
  }

  async keys(table: StorageTable): Promise<string[]> {
    const keys = await this.#run(table, 'readonly', store => store.getAllKeys())
    return (keys as IDBValidKey[]).map(String)
  }

  async close(): Promise<void> {
    this.database.close()
  }

  /**
   * Run one request, and for a write wait for its transaction to commit.
   *
   * `IDBRequest.onsuccess` fires while the transaction is still open, so a
   * request can succeed and then be rolled back by an abort — on a quota
   * failure at commit, or when the connection goes away. Resolving there would
   * report state as persisted that never lands, and the transport acknowledges
   * a message once its handlers return: the relay would drop the only copy of
   * something this client never stored.
   *
   * Reads are held to the request alone on purpose. They claim no persistence,
   * the value handed back is the one that was read, and `getGroup` runs on the
   * hot path of every inbound message.
   */
  async #run<T>(
    table: StorageTable,
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest<T>
  ): Promise<T> {
    const transaction = this.database.transaction(table, mode)
    if (mode === 'readonly') {
      return promisify(operation(transaction.objectStore(table)))
    }

    const committed = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => {
        resolve()
      }
      transaction.onabort = () => {
        reject(abortError(transaction, 'aborted'))
      }
      transaction.onerror = () => {
        reject(abortError(transaction, 'failed'))
      }
    })
    const result = await promisify(operation(transaction.objectStore(table)))
    await committed
    return result
  }
}

const toBytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  throw new GroupMessagingError('Stored value is not binary')
}
