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

  async #run<T>(
    table: StorageTable,
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest<T>
  ): Promise<T> {
    const transaction = this.database.transaction(table, mode)
    return promisify(operation(transaction.objectStore(table)))
  }
}

const toBytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  throw new GroupMessagingError('Stored value is not binary')
}
