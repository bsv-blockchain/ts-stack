import {
  canonicalOutputJSON,
  outputAssert,
  outputString,
  OutputProtocolError,
  type OutputJSONObject
} from '@bsv/sdk'
import type { ProtectedOperationPayload } from './ProtectedOperationPayload.js'
import {
  ProtectedOperationObjectPlan,
  OPERATION_OBJECT_HEADER_BYTES,
  type OperationObjectHeader
} from './ProtectedOperationObjectPlan.js'
import {
  ProtectedOperationObjectCipher,
  OPERATION_OBJECT_HEAD,
  type OperationObjectEnvelope,
  type OperationObjectInventory
} from './ProtectedOperationObjectCipher.js'
import type {
  ProtectedOperationObjectConfiguration,
  ProtectedOperationObjectReceipt,
  ProtectedOperationObjectReservation,
  ProtectedOperationObjectStatus,
  ProtectedOperationObjectStore
} from './ProtectedOperationObjectStore.js'

const TABLE = 'protected-operation-objects'
export interface IndexedDBProtectedOperationObjectOptions {
  factory?: IDBFactory
  openTimeoutMs?: number
}
interface ConnectionOptions {
  factory: IDBFactory
  open: IDBFactory['open']
  timeout: number
}
function connectionOptions(options: IndexedDBProtectedOperationObjectOptions): ConnectionOptions {
  const factory = options.factory ?? globalThis.indexedDB,
    timeout = options.openTimeoutMs ?? 5000
  outputAssert(
    factory !== undefined && typeof factory.open === 'function',
    'IndexedDB is unavailable',
    'unsupported'
  )
  outputAssert(
    Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 60000,
    'Invalid protected object open deadline'
  )
  return { factory, open: factory.open, timeout }
}
interface RawSnapshot {
  head: OperationObjectEnvelope
  rows: (OperationObjectEnvelope | undefined)[]
  keys: IDBValidKey[]
}
interface Snapshot extends RawSnapshot {
  inventory: OperationObjectInventory
  header?: OperationObjectHeader
  bytes?: Uint8Array | null
}
/**
 * Explicit browser-local immutable object custody. Encryption happens outside
 * transactions; strict-durability atomic writes compare the exact original head
 * and requested rows. Reservations are logical limits, not browser quota or
 * eviction promises. Whole-store rollback requires an external continuity anchor.
 */
export class IndexedDBProtectedOperationObjectStore implements ProtectedOperationObjectStore {
  readonly durability = 'durable' as const
  private closed = false
  private constructor(
    private readonly database: IDBDatabase,
    private readonly cipher: ProtectedOperationObjectCipher
  ) {
    database.onversionchange = () => {
      database.close()
      this.closed = true
    }
  }
  get configuration(): ProtectedOperationObjectConfiguration {
    return this.cipher.plan.configuration
  }
  /** Idempotent only for the same original installation; never repairs a missing head. */
  static async create(
    name: string,
    configuration: ProtectedOperationObjectConfiguration,
    codec: ProtectedOperationPayload,
    options: IndexedDBProtectedOperationObjectOptions = {}
  ): Promise<IndexedDBProtectedOperationObjectStore> {
    const connection = connectionOptions(options)
    const cipher = new ProtectedOperationObjectCipher(
      new ProtectedOperationObjectPlan(configuration),
      codec
    )
    const initial = await cipher.sealInventory({ revision: '0', entries: [] })
    cipher.current()
    return await this.connect(name, cipher, connection, initial)
  }
  /** Missing database, custody, schema or inventory requires recovery of the original installation. */
  static async open(
    name: string,
    configuration: ProtectedOperationObjectConfiguration,
    codec: ProtectedOperationPayload,
    options: IndexedDBProtectedOperationObjectOptions = {}
  ): Promise<IndexedDBProtectedOperationObjectStore> {
    return await this.connect(
      name,
      new ProtectedOperationObjectCipher(new ProtectedOperationObjectPlan(configuration), codec),
      connectionOptions(options)
    )
  }
  private static async connect(
    name: string,
    cipher: ProtectedOperationObjectCipher,
    options: ConnectionOptions,
    initial?: OperationObjectEnvelope
  ): Promise<IndexedDBProtectedOperationObjectStore> {
    outputString(name)
    const { factory, open, timeout } = options
    outputAssert(
      factory.open === open,
      'Protected object database capability changed',
      'context-changed'
    )
    cipher.current()
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        settled = true
        reject(new OutputProtocolError('unavailable', 'Protected object open deadline', true))
      }, timeout)
      let request: IDBOpenDBRequest
      try {
        request = open.call(factory, name, 1)
      } catch (error) {
        clearTimeout(timer)
        reject(error)
        return
      }
      request.onupgradeneeded = () => {
        if (settled || initial === undefined) request.transaction!.abort()
        else request.result.createObjectStore(TABLE, { keyPath: 'key' }).add(initial)
      }
      request.onerror = () => {
        clearTimeout(timer)
        if (!settled) {
          settled = true
          reject(
            new OutputProtocolError(
              'unavailable',
              'Cannot open original protected object database',
              true
            )
          )
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
    const owner = new IndexedDBProtectedOperationObjectStore(database, cipher)
    try {
      owner.current()
      outputAssert(
        database.objectStoreNames.length === 1 && database.objectStoreNames.contains(TABLE),
        'Protected object schema differs',
        'unavailable'
      )
      const raw = await owner.raw([])
      await cipher.inventory(raw.head, raw.keys)
      owner.current()
      return owner
    } catch (error) {
      await owner.close()
      throw error
    }
  }
  private current(): void {
    outputAssert(!this.closed, 'Protected operation object store is closed', 'unavailable')
    this.cipher.current()
  }
  private transact<T>(
    mode: IDBTransactionMode,
    work: (table: IDBObjectStore, done: (value: T) => void, fail: (error: unknown) => void) => void
  ): Promise<T> {
    this.current()
    return new Promise((resolve, reject) => {
      const transaction = this.database.transaction(TABLE, mode, { durability: 'strict' })
      let completed = false,
        result: T,
        failure: unknown
      transaction.oncomplete = () =>
        completed
          ? resolve(result)
          : reject(
              new OutputProtocolError('unavailable', 'Protected object transaction has no result')
            )
      transaction.onabort = () => {
        if (
          failure !== null &&
          typeof failure === 'object' &&
          'name' in failure &&
          failure.name === 'QuotaExceededError'
        ) {
          reject(
            new OutputProtocolError('limited', 'Protected object browser quota exhausted', true)
          )
          return
        }
        if (failure !== null && failure !== undefined) {
          reject(
            failure instanceof Error
              ? failure
              : new Error('Protected object transaction failed', { cause: failure })
          )
          return
        }
        reject(
          new OutputProtocolError(
            transaction.error?.name === 'QuotaExceededError' ? 'limited' : 'unavailable',
            'Protected object transaction aborted',
            true
          )
        )
      }
      const fail = (error: unknown): void => {
        failure = error
        transaction.abort()
      }
      try {
        const table = transaction.objectStore(TABLE)
        outputAssert(
          table.keyPath === 'key' && !table.autoIncrement && table.indexNames.length === 0,
          'Protected object table schema differs',
          'unavailable'
        )
        work(
          table,
          value => {
            completed = true
            result = value
          },
          fail
        )
      } catch (error) {
        fail(error)
      }
    })
  }
  private raw(addresses: readonly string[]): Promise<RawSnapshot> {
    return this.transact('readonly', (table, done, fail) =>
      this.readRows(table, addresses, done, fail)
    )
  }
  private readRows(
    table: IDBObjectStore,
    addresses: readonly string[],
    done: (value: RawSnapshot) => void,
    fail: (error: unknown) => void
  ): void {
    const head: IDBRequest<unknown> = table.get(OPERATION_OBJECT_HEAD),
      keys = table.getAllKeys(undefined, this.cipher.maximumRows + 1)
    const requests: IDBRequest<unknown>[] = addresses.map(address => table.get(address))
    let remaining = requests.length + 2
    const ready = (): void => {
      if (--remaining !== 0) return
      try {
        this.current()
        outputAssert(
          keys.result.length <= this.cipher.maximumRows,
          'Protected object row capacity exceeded',
          'limited'
        )
        done({
          head: this.cipher.envelope(head.result),
          keys: keys.result,
          rows: requests.map(request =>
            request.result === undefined ? undefined : this.cipher.envelope(request.result)
          )
        })
      } catch (error) {
        fail(error)
      }
    }
    head.onsuccess = ready
    keys.onsuccess = ready
    for (const request of requests) request.onsuccess = ready
  }
  private async snapshot(id: string, originalBinding: OutputJSONObject): Promise<Snapshot> {
    const original = this.cipher.plan.reservation(id, originalBinding, 1)
    const raw = await this.raw(this.cipher.addresses(id))
    this.current()
    const inventory = await this.cipher.inventory(raw.head, raw.keys)
    this.current()
    const entry = inventory.entries.find(item => item.id === id)
    if (entry === undefined) {
      outputAssert(
        raw.rows.every(row => row === undefined),
        'Protected object orphaned rows',
        'unavailable'
      )
      return { ...raw, inventory }
    }
    const revision = entry.complete ? '2' : '1',
      addresses = this.cipher.addresses(id)
    for (let index = 0; index < raw.rows.length; index++)
      outputAssert(
        raw.rows[index] !== undefined &&
          this.cipher.envelopeDigest(raw.rows[index]) === entry.digests[index],
        'Protected object ciphertext differs from inventory',
        'unavailable'
      )
    const header = this.cipher.plan.parse(
      await this.cipher.open(raw.rows[0], addresses[0], revision, OPERATION_OBJECT_HEADER_BYTES),
      id,
      original.originalBinding
    )
    this.current()
    outputAssert(
      (header.receipt !== null) === entry.complete,
      'Protected object completion differs from inventory',
      'unavailable'
    )
    const slots = this.cipher.plan.slots({ ...header, receipt: null }),
      values: OutputJSONObject[] = []
    await Array.from(slots.entries()).reduce(
      (sequence, [index, slot]) =>
        sequence.then(async () => {
          values.push(
            await this.cipher.open(raw.rows[index + 1], slot.key, revision, slot.reservedBytes)
          )
          this.current()
        }),
      Promise.resolve()
    )
    return { ...raw, inventory, header, bytes: this.cipher.plan.restore(header, values) }
  }
  private async commit(
    before: Snapshot,
    completed: OperationObjectHeader,
    bytes?: Uint8Array
  ): Promise<void> {
    this.current()
    const revision = completed.receipt === null ? '1' : '2'
    const rows = [
      await this.cipher.seal(
        this.cipher.plan.address(completed.id, null),
        revision,
        this.cipher.plan.frame(completed),
        OPERATION_OBJECT_HEADER_BYTES
      )
    ]
    this.current()
    await Array.from(this.cipher.plan.slots(completed, bytes)).reduce(
      (sequence, slot) =>
        sequence.then(async () => {
          rows.push(await this.cipher.seal(slot.key, revision, slot.value, slot.reservedBytes))
          this.current()
        }),
      Promise.resolve()
    )
    const entries = before.inventory.entries.filter(entry => entry.id !== completed.id)
    entries.push({
      id: completed.id,
      complete: completed.receipt !== null,
      digests: rows.map(row => this.cipher.envelopeDigest(row))
    })
    entries.sort((left, right) => Number(left.id > right.id) - Number(left.id < right.id))
    const head = await this.cipher.sealInventory({
      revision: String(Number(before.inventory.revision) + 1),
      entries
    })
    this.current()
    await this.transact<void>('readwrite', (table, done, fail) => {
      this.readRows(
        table,
        this.cipher.addresses(completed.id),
        actual => {
          try {
            outputAssert(
              this.cipher.envelopeDigest(actual.head) === this.cipher.envelopeDigest(before.head) &&
                canonicalOutputJSON(actual.keys) === canonicalOutputJSON(before.keys) &&
                actual.rows.every((row, index) =>
                  row === undefined
                    ? before.rows[index] === undefined
                    : before.rows[index] !== undefined &&
                      this.cipher.envelopeDigest(row) ===
                        this.cipher.envelopeDigest(before.rows[index])
                ),
              'Protected object changed during encryption; reconcile the original operation',
              'conflict'
            )
            for (const row of rows) {
              if (before.header === undefined) table.add(row)
              else table.put(row)
            }
            table.put(head)
            done(undefined)
          } catch (error) {
            fail(error)
          }
        },
        fail
      )
    })
    this.current()
  }
  async reserve(
    id: string,
    originalBinding: OutputJSONObject,
    maximumBytes: number
  ): Promise<ProtectedOperationObjectReservation> {
    this.current()
    const wanted = this.cipher.plan.reservation(id, originalBinding, maximumBytes)
    const before = await this.snapshot(wanted.id, wanted.originalBinding)
    if (before.header !== undefined)
      outputAssert(
        before.header.maximumBytes === wanted.maximumBytes,
        'Protected operation object reservation changed',
        'conflict'
      )
    else {
      outputAssert(
        before.inventory.entries.length < this.configuration.maximumObjects,
        'Protected object installation capacity exhausted',
        'limited'
      )
      await this.commit(before, wanted)
    }
    return { id: wanted.id, bindingDigest: wanted.bindingDigest, maximumBytes: wanted.maximumBytes }
  }
  async read(
    id: string,
    originalBinding: OutputJSONObject
  ): Promise<ProtectedOperationObjectStatus> {
    const before = await this.snapshot(id, originalBinding)
    if (before.header === undefined) return { state: 'absent' }
    const { id: originalId, bindingDigest, maximumBytes, receipt } = before.header
    if (receipt === null)
      return { state: 'reserved', reservation: { id: originalId, bindingDigest, maximumBytes } }
    return { state: 'stored', receipt, bytes: before.bytes! as Uint8Array }
  }
  async put(
    id: string,
    originalBinding: OutputJSONObject,
    input: Uint8Array
  ): Promise<ProtectedOperationObjectReceipt> {
    this.current()
    outputAssert(
      input instanceof Uint8Array && input.length <= this.configuration.maximumObjectBytes,
      'Protected object exceeds installed capacity',
      'limited'
    )
    const bytes = new Uint8Array(input),
      original = this.cipher.plan.reservation(id, originalBinding, 1)
    try {
      const before = await this.snapshot(original.id, original.originalBinding)
      outputAssert(
        before.header !== undefined,
        'Protected object requires original reservation',
        'unavailable'
      )
      const completed = this.cipher.plan.complete(before.header, bytes)
      if (before.header.receipt !== null)
        outputAssert(
          before.bytes?.length === bytes.length &&
            before.bytes.every((byte, index) => byte === bytes[index]),
          'Protected object first bytes differ',
          'conflict'
        )
      else await this.commit(before, completed, bytes)
      return completed.receipt!
    } finally {
      bytes.fill(0)
    }
  }
  close(): Promise<void> {
    this.closed = true
    this.database.close()
    return Promise.resolve()
  }
}
