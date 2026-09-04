import type { ReliableReputationStorage } from './ReliableHostReputation.js'

/** Transactional browser health storage. LocalStorage caches are not coherent across tabs. */
interface ReadCache {
  value: string | null
}

function run<T>(
  factory: IDBFactory,
  cache: ReadCache,
  key: string,
  action?: () => Promise<T>
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const request = factory.open(key)
    request.onerror = () =>
      reject(new Error('Reputation database unavailable', { cause: request.error }))
    request.onupgradeneeded = () => request.result.createObjectStore('state')
    request.onsuccess = () => {
      const database = request.result
      let transaction: IDBTransaction
      try {
        transaction = database.transaction('state', action === undefined ? 'readonly' : 'readwrite')
      } catch (error) {
        database.close()
        reject(error)
        return
      }
      const state = transaction.objectStore('state')
      let result: T
      const finish = (event: Event): void => {
        database.close()
        if (event.type === 'complete') resolve(result)
        else reject(transaction.error ?? new Error('Reputation transaction aborted'))
      }
      transaction.oncomplete = finish
      transaction.onabort = finish
      const read = state.get(key)
      read.onsuccess = () => {
        cache.value = read.result ?? null
        if (action !== undefined) {
          // The health update is synchronous; its resolved promise stays inside
          // this transaction's microtask checkpoint, before automatic commit.
          Promise.resolve()
            .then(action)
            .then(output => {
              result = output
              state.put(cache.value, key)
            })
            .catch(() => transaction.abort())
        }
      }
    }
  })
}

/** Transactional browser health storage; each update reads the committed state. */
export function indexedDBReputationStorage(factory: IDBFactory): ReliableReputationStorage {
  const cache: ReadCache = { value: null }

  return {
    get: () => cache.value,
    set: (_key, next) => {
      cache.value = next
    },
    load: key => run<void>(factory, cache, key),
    lock: (key, action) => run(factory, cache, key, action)
  }
}
