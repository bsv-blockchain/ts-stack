import type { ReliableReputationStorage } from './ReliableHostReputation.js'

function run(
  factory: IDBFactory,
  key: string,
  transform?: (current: string | null | undefined) => string
): Promise<string | null> {
  return new Promise<string | null>((resolve, reject) => {
    const request = factory.open(key)
    request.onerror = () =>
      reject(new Error('Reputation database unavailable', { cause: request.error }))
    request.onupgradeneeded = () => request.result.createObjectStore('state')
    request.onsuccess = () => {
      const database = request.result
      let transaction: IDBTransaction
      try {
        transaction = database.transaction(
          'state',
          transform === undefined ? 'readonly' : 'readwrite'
        )
      } catch (error) {
        database.close()
        reject(error)
        return
      }
      const state = transaction.objectStore('state')
      let result: string | null = null
      const finish = (event: Event): void => {
        database.close()
        if (event.type === 'complete') resolve(result)
        else reject(transaction.error ?? new Error('Reputation transaction aborted'))
      }
      transaction.oncomplete = finish
      transaction.onabort = finish
      const read = state.get(key)
      read.onsuccess = () => {
        result = typeof read.result === 'string' ? read.result : null
        try {
          if (transform !== undefined) {
            result = transform(result)
            state.put(result, key)
          }
        } catch {
          transaction.abort()
        }
      }
    }
  })
}

/** Transactional browser health storage; each update reads the committed state. */
export function indexedDBReputationStorage(factory: IDBFactory): ReliableReputationStorage {
  return {
    get: key => run(factory, key),
    update: (key, transform) => run(factory, key, transform).then(() => {})
  }
}
