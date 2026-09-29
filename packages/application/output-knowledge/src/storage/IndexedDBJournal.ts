import { OutputProtocolError, outputString, outputU64, type OutputJSONObject } from '@bsv/sdk'
import type { CommitResult, Mutation } from '../ports.js'
import {
  checkJournalRead,
  cloneEntry,
  journalLimits,
  journalPayload,
  parseJournalPayload,
  planAppend,
  type JournalEntry,
  type JournalHead,
  type JournalLimits,
  type JournalStorage,
  type MutationLookup
} from './Journal.js'

interface StoredEntry extends JournalEntry {
  namespace: string
  position: string
  text: string
  bytes: number
}
interface StoredHead extends JournalHead {
  namespace: string
  format: 1
}
interface IndexedDBOptions {
  factory?: IDBFactory
  keyRange?: typeof IDBKeyRange
  limits?: Partial<JournalLimits>
  openTimeoutMs?: number
}
const position = (value: string): string => outputU64(value).toString(16).padStart(16, '0')

/**
 * Durable within the browser's storage guarantees. Applications should request
 * persistent storage and treat quota eviction or a missing database as a reset,
 * not as evidence that previously reported outputs were spent.
 */
export class IndexedDBJournal implements JournalStorage {
  readonly durability = 'durable' as const
  private closed = false

  private constructor(
    private readonly database: IDBDatabase,
    readonly namespace: string,
    private readonly limits: JournalLimits,
    private readonly keyRange: typeof IDBKeyRange
  ) {
    database.onversionchange = () => {
      database.close()
      this.closed = true
    }
  }

  static async open(
    name: string,
    namespace: string,
    options: IndexedDBOptions = {}
  ): Promise<IndexedDBJournal> {
    outputString(name)
    outputString(namespace)
    const factory = options.factory ?? globalThis.indexedDB
    const keyRange = options.keyRange ?? globalThis.IDBKeyRange
    const timeout = options.openTimeoutMs ?? 5000
    if (!factory || !keyRange)
      throw new OutputProtocolError('unsupported', 'IndexedDB is unavailable')
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60000)
      throw new OutputProtocolError('invalid', 'Invalid IndexedDB open timeout')
    const limits = journalLimits(options.limits ?? {})
    return await new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        settled = true
        reject(new OutputProtocolError('unavailable', 'IndexedDB open deadline', true))
      }, timeout)
      const request = factory.open(name, 1)
      request.onupgradeneeded = () => {
        const database = request.result
        database.createObjectStore('meta', { keyPath: 'namespace' })
        const entries = database.createObjectStore('entries', {
          keyPath: ['namespace', 'position']
        })
        entries.createIndex('mutation', ['namespace', 'key'], { unique: true })
      }
      request.onerror = () => {
        clearTimeout(timer)
        if (!settled) {
          settled = true
          reject(new OutputProtocolError('unavailable', 'Cannot open IndexedDB journal', true))
        }
      }
      request.onsuccess = () => {
        clearTimeout(timer)
        if (settled) {
          request.result.close()
          return
        }
        settled = true
        resolve(new IndexedDBJournal(request.result, namespace, limits, keyRange))
      }
    })
  }

  private transact<T>(
    mode: IDBTransactionMode,
    operate: (
      transaction: IDBTransaction,
      complete: (result: T) => void,
      fail: (error: unknown) => void
    ) => void
  ): Promise<T> {
    if (this.closed)
      return Promise.reject(new OutputProtocolError('unavailable', 'Journal is closed'))
    return new Promise((resolve, reject) => {
      const transaction = this.database.transaction(['meta', 'entries'], mode, {
        durability: 'strict'
      })
      let result: T,
        completed = false,
        failure: unknown
      const fail = (error: unknown): void => {
        failure = error
        try {
          transaction.abort()
        } catch {
          reject(error)
        }
      }
      transaction.oncomplete = () => {
        if (completed) resolve(result)
        else reject(new OutputProtocolError('unavailable', 'Journal transaction has no result'))
      }
      transaction.onabort = () =>
        reject(
          failure ??
            new OutputProtocolError(
              transaction.error?.name === 'QuotaExceededError' ? 'limited' : 'unavailable',
              'IndexedDB journal transaction aborted',
              true
            )
        )
      try {
        operate(
          transaction,
          value => {
            result = value
            completed = true
          },
          fail
        )
      } catch (error) {
        fail(error)
      }
    })
  }

  private storedHead(value: StoredHead | undefined): JournalHead {
    if (value === undefined) return { received: '0', accepted: '0', bytes: 0, entries: 0 }
    if (
      value.format !== 1 ||
      value.namespace !== this.namespace ||
      !Number.isSafeInteger(value.bytes) ||
      value.bytes < 0 ||
      !Number.isSafeInteger(value.entries) ||
      value.entries < 0
    )
      throw new OutputProtocolError('unavailable', 'Corrupt IndexedDB journal metadata')
    outputU64(value.received)
    outputU64(value.accepted)
    return {
      received: value.received,
      accepted: value.accepted,
      bytes: value.bytes,
      entries: value.entries
    }
  }

  async head(): Promise<JournalHead> {
    return await this.transact('readonly', (transaction, complete, fail) => {
      const request: IDBRequest<StoredHead | undefined> = transaction
        .objectStore('meta')
        .get(this.namespace)
      request.onsuccess = () => {
        try {
          complete(this.storedHead(request.result))
        } catch (error) {
          fail(error)
        }
      }
    })
  }
  async getMutation(key: string): Promise<MutationLookup> {
    return await this.transact('readonly', (transaction, complete) => {
      const request: IDBRequest<StoredEntry | undefined> = transaction
        .objectStore('entries')
        .index('mutation')
        .get([this.namespace, key])
      request.onsuccess = () =>
        complete(
          request.result
            ? { status: 'committed', entry: cloneEntry(request.result) }
            : { status: 'absent' }
        )
    })
  }
  async append(
    expectedReceived: string,
    mutation: Mutation,
    local?: OutputJSONObject
  ): Promise<CommitResult> {
    const body = journalPayload(mutation, this.limits, local)
    // Freeze caller-owned bytes before opening a transaction or yielding.
    const frozen = { key: mutation.key, ...parseJournalPayload(body.text, this.limits.entryBytes) }
    return await this.transact('readwrite', (transaction, complete, fail) => {
      const entries = transaction.objectStore('entries')
      const existing: IDBRequest<StoredEntry | undefined> = entries
        .index('mutation')
        .get([this.namespace, frozen.key])
      existing.onsuccess = () => {
        try {
          if (existing.result) {
            complete(
              existing.result.text === body.bodyText
                ? { status: 'replayed', revision: { ...existing.result.revision } }
                : { status: 'equivocation', reason: 'Mutation key reused with different body' }
            )
            return
          }
          const meta = transaction.objectStore('meta')
          const saved: IDBRequest<StoredHead | undefined> = meta.get(this.namespace)
          saved.onsuccess = () => {
            try {
              const head = this.storedHead(saved.result)
              const result = planAppend(head, expectedReceived, frozen, body.bytes, this.limits)
              if (result.status !== 'committed') {
                complete(result)
                return
              }
              entries.add({
                namespace: this.namespace,
                position: position(result.revision.received),
                key: frozen.key,
                body: frozen.body,
                ...(frozen.local !== undefined
                  ? { local: frozen.local, localDigest: frozen.localDigest }
                  : {}),
                revision: result.revision,
                text: body.bodyText,
                bytes: body.bytes
              } satisfies StoredEntry)
              meta.put({
                namespace: this.namespace,
                format: 1,
                ...result.revision,
                bytes: head.bytes + body.bytes,
                entries: head.entries + 1
              } satisfies StoredHead)
              complete(result)
            } catch (error) {
              fail(error)
            }
          }
        } catch (error) {
          fail(error)
        }
      }
    })
  }
  async read(afterReceived: string, maximumEntries: number): Promise<JournalEntry[]> {
    checkJournalRead(afterReceived, maximumEntries)
    return await this.transact('readonly', (transaction, complete, fail) => {
      if (afterReceived === '18446744073709551615') {
        complete([])
        return
      }
      const range = this.keyRange.bound(
        [this.namespace, position(afterReceived)],
        [this.namespace, 'ffffffffffffffff'],
        true,
        false
      )
      const request = transaction.objectStore('entries').openCursor(range)
      const result: JournalEntry[] = []
      let bytes = 0
      request.onsuccess = () => {
        try {
          const cursor = request.result
          if (!cursor) {
            complete(result)
            return
          }
          const row = cursor.value as StoredEntry
          if (
            result.length >= maximumEntries ||
            (result.length > 0 && bytes + row.bytes > this.limits.entryBytes)
          ) {
            complete(result)
            return
          }
          bytes += row.bytes
          result.push(cloneEntry(row))
          cursor.continue()
        } catch (error) {
          fail(error)
        }
      }
    })
  }
  async close(): Promise<void> {
    if (!this.closed) {
      this.database.close()
      this.closed = true
    }
  }
}
