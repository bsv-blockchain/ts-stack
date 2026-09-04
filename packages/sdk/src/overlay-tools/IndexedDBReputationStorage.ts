import type { ReliableReputationStorage } from './ReliableHostReputation.js'

/** Transactional browser health storage. LocalStorage caches are not coherent across tabs. */
export function indexedDBReputationStorage(factory: IDBFactory): ReliableReputationStorage {
  let value: string | null = null
  const run = <T>(key: string, action?: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const request = factory.open('bsvsdk_overlay_host_reputation_v4')
      request.onerror = () => reject(request.error)
      request.onupgradeneeded = () => request.result.createObjectStore('state')
      request.onsuccess = () => {
        const database = request.result
        let transaction: IDBTransaction
        try {
          transaction = database.transaction(
            'state',
            action === undefined ? 'readonly' : 'readwrite'
          )
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
          value = read.result ?? null
          if (action !== undefined) {
            // The health update is synchronous; its resolved promise stays inside
            // this transaction's microtask checkpoint, before automatic commit.
            Promise.resolve()
              .then(action)
              .then(output => {
                result = output
                state.put(value, key)
              })
              .catch(() => transaction.abort())
          }
        }
      }
    })
  return {
    get: () => value,
    set: (_key, next) => {
      value = next
    },
    load: key => run<void>(key),
    lock: (key, action) => run(key, action)
  }
}
