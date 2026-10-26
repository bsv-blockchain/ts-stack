import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import {
  IndexedDbStorageBackend,
  IndexedDbUnavailableError,
  openDatabase
} from '../backends/indexeddb.js'

/**
 * A write must not claim persistence before its transaction commits.
 *
 * `IDBRequest.onsuccess` fires while the transaction is still open, and an
 * aborted transaction rolls the request back. Resolving on the request alone
 * lets `putGroup` report success for state that is never written — and the
 * transport then acknowledges the message that produced it, so the relay
 * discards the only copy. `MessageBoxTransport` promises the opposite in as many
 * words: a crash before the durable write leaves the message in the box.
 *
 * The double below is deliberate rather than lazy. `fake-indexeddb` will not
 * abort a transaction after a request has already succeeded on request, and
 * that ordering is the entire bug, so the test drives the two events directly.
 */
interface Controls {
  succeed: (result?: unknown) => void
  fail: () => void
  complete: () => void
  abort: () => void
}

const stubDatabase = (): { database: IDBDatabase; controls: Controls } => {
  const request = {
    result: undefined as unknown,
    error: null as DOMException | null,
    onsuccess: null as null | (() => void),
    onerror: null as null | (() => void)
  }
  const store = {
    put: () => request,
    delete: () => request,
    get: () => request,
    getAllKeys: () => request
  }
  const transaction = {
    error: null as DOMException | null,
    oncomplete: null as null | (() => void),
    onabort: null as null | (() => void),
    onerror: null as null | (() => void),
    objectStore: () => store
  }

  return {
    database: { transaction: () => transaction } as unknown as IDBDatabase,
    controls: {
      succeed: (result?: unknown) => {
        request.result = result
        request.onsuccess?.()
      },
      fail: () => {
        request.error = new DOMException('Key already exists', 'ConstraintError')
        request.onerror?.()
      },
      complete: () => transaction.oncomplete?.(),
      abort: () => transaction.onabort?.()
    }
  }
}

/**
 * Whether a promise has settled, without awaiting it.
 *
 * A macrotask rather than a microtask race: racing against
 * `Promise.resolve()` depends on reaction ordering and reports a settled
 * promise as pending, which passes this file's central test for the wrong
 * reason.
 */
const settled = async (promise: Promise<unknown>): Promise<boolean> => {
  let done = false
  void promise.then(
    () => (done = true),
    () => (done = true)
  )
  await new Promise(resolve => setTimeout(resolve, 0))
  return done
}

describe('IndexedDbStorageBackend durability', () => {
  it('refuses a write whose transaction aborts after the request succeeded', async () => {
    const { database, controls } = stubDatabase()
    const backend = new IndexedDbStorageBackend(database)

    const write = backend.set('groups', 'g1', new Uint8Array([1, 2, 3]))
    controls.succeed()
    controls.abort()

    await expect(write).rejects.toThrow(/abort/i)
  })

  it('holds a write pending until the transaction commits', async () => {
    const { database, controls } = stubDatabase()
    const backend = new IndexedDbStorageBackend(database)

    const write = backend.set('groups', 'g1', new Uint8Array([1]))
    controls.succeed()
    expect(await settled(write)).toBe(false)

    controls.complete()
    await expect(write).resolves.toBeUndefined()
  })

  /**
   * A failed request aborts its transaction too, so both promises reject. The
   * write reports the request's error; the transaction's must still be
   * observed, or it surfaces as an unhandled rejection.
   */
  it('refuses a write whose request fails, without an unhandled abort', async () => {
    const { database, controls } = stubDatabase()
    const backend = new IndexedDbStorageBackend(database)

    const write = backend.set('groups', 'g1', new Uint8Array([1]))
    controls.fail()
    controls.abort()

    await expect(write).rejects.toThrow(/key already exists/i)
    await new Promise(resolve => setTimeout(resolve, 0))
  })

  it('refuses a delete whose transaction aborts', async () => {
    const { database, controls } = stubDatabase()
    const backend = new IndexedDbStorageBackend(database)

    const removal = backend.delete('groups', 'g1')
    controls.succeed()
    controls.abort()

    await expect(removal).rejects.toThrow(/abort/i)
  })

  /**
   * Reads are deliberately not held to the same rule. They claim no
   * persistence, the value handed back is the one that was read, and
   * `getGroup` sits on the hot path of every inbound message.
   */
  it('resolves a read on the request, without waiting for the transaction', async () => {
    const { database, controls } = stubDatabase()
    const backend = new IndexedDbStorageBackend(database)

    const read = backend.get('groups', 'g1')
    controls.succeed(new Uint8Array([7]))

    await expect(read).resolves.toEqual(new Uint8Array([7]))
  })

  it('survives a close and reopen with everything committed still there', async () => {
    const first = await openDatabase('durability-reopen')
    const backend = new IndexedDbStorageBackend(first)
    await backend.set('groups', 'g1', new Uint8Array([9, 9]))
    await backend.close()

    const second = await openDatabase('durability-reopen')
    const reopened = new IndexedDbStorageBackend(second)
    expect(await reopened.get('groups', 'g1')).toEqual(new Uint8Array([9, 9]))
    await reopened.close()
  })
})

describe('IndexedDB backend edges', () => {
  it('reports a missing IndexedDB as its own error', async () => {
    vi.stubGlobal('indexedDB', undefined)
    try {
      await expect(openDatabase('absent')).rejects.toThrow(IndexedDbUnavailableError)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('reads an ArrayBuffer back as bytes and refuses a value that is not binary', async () => {
    const database = await openDatabase('durability-raw-values')
    const raw = database.transaction('groups', 'readwrite')
    raw.objectStore('groups').put(new Uint8Array([4, 5]).buffer, 'buffer')
    raw.objectStore('groups').put('text', 'text')
    await new Promise(resolve => {
      raw.oncomplete = resolve
    })

    const backend = new IndexedDbStorageBackend(database)
    expect(await backend.get('groups', 'buffer')).toEqual(new Uint8Array([4, 5]))
    await expect(backend.get('groups', 'text')).rejects.toThrow('Stored value is not binary')
    await backend.close()
  })
})
