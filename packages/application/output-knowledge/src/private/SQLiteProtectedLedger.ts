import { closeSync, openSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import {
  canonicalOutputJSON,
  closedOutputObject,
  incrementOutputU64,
  outputAssert,
  outputHex32,
  outputU64,
  parseOutputJSON,
  type OutputJSONObject
} from '@bsv/sdk'
import { SQLiteTransactionDomain } from '../storage/SQLiteTransactionDomain.js'
import { NodeProtectedPayloadCodec } from './NodeProtectedPayloadCodec.js'
import {
  protectedAddress,
  protectedConfiguration,
  protectedDigest,
  protectedHeader,
  protectedInteger,
  protectedInventory,
  protectedUpdates,
  protectedRevisionCapacity,
  protectedValue,
  type ProtectedLedgerAddress,
  type ProtectedLedgerChange,
  type ProtectedLedgerConfiguration,
  type ProtectedLedgerGuard,
  type ProtectedLedgerHead,
  type ProtectedLedgerHeader,
  type ProtectedLedgerRecord,
  type ProtectedLedgerView
} from './ProtectedLedgerCodec.js'

/** Explicit local storage-plan capacity; never widens protocol JSON packets. */
export interface ProtectedLedgerCommitOptions {
  maximumBatchBytes: number
}

const FORMAT = 'output-protected-ledger/1'
const HEAD_BYTES = 16384
const HEADER_COLUMNS = `CASE WHEN length(kind)<=32 THEN kind END AS kind,
  CASE WHEN length(key)=64 THEN key END AS key,
  CASE WHEN length(revision)<=20 THEN revision END AS revision,
  reserved_bytes AS reservedBytes,reserved_updates AS reservedUpdates,bytes,
  CASE WHEN length(sealed_digest)=64 THEN sealed_digest END AS sealedDigest`

/**
 * Internal bounded native transaction domain for private service state machines.
 * Every effect owner reserves its future records and bytes before promising work.
 * This port has no network mutation endpoint. It never deletes fences or silently
 * shrinks reservations, initializes during open, or performs external effects.
 * Whole-database rollback is outside authenticated-record integrity: restoration
 * requires the operator's authoritative fence/obligation reconciliation.
 */
export class SQLiteProtectedLedger {
  private readonly database: DatabaseSync
  private readonly domain: SQLiteTransactionDomain
  private readonly configuration: ProtectedLedgerConfiguration
  private readonly configurationDigest: string

  private constructor(
    path: string,
    configuration: ProtectedLedgerConfiguration,
    private readonly payloads: NodeProtectedPayloadCodec,
    create: boolean
  ) {
    this.configuration = protectedConfiguration(configuration)
    outputAssert(
      payloads.maximumPlaintextBytes >= Math.max(HEAD_BYTES, this.configuration.maximumRecordBytes),
      'Protected custody codec cannot honor ledger reservations'
    )
    this.configurationDigest = protectedDigest(
      canonicalOutputJSON(this.configuration, { bytes: 32768 })
    )
    outputAssert(
      path.length > 0 && path !== ':memory:' && !path.startsWith('file:'),
      'Protected ledger requires an explicit file'
    )
    closeSync(openSync(path, create ? 'ax' : 'r+', 0o600))
    this.database = new DatabaseSync(path, {
      allowExtension: false,
      enableForeignKeyConstraints: true
    })
    this.domain = new SQLiteTransactionDomain(this.database)
    try {
      this.database.exec(
        'PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;'
      )
      if (create) this.initialize()
      this.domain.transaction(
        () => {
          const head = this.head()
          this.inventory(head)
          // Opening establishes custody for every retained record, not just the active write key.
          for (const header of this.headers()) this.record(header)
        },
        { write: false }
      )
    } catch (error) {
      this.domain.close()
      throw error
    }
  }
  static create(
    path: string,
    configuration: ProtectedLedgerConfiguration,
    payloads: NodeProtectedPayloadCodec
  ): SQLiteProtectedLedger {
    return new SQLiteProtectedLedger(path, configuration, payloads, true)
  }
  static open(
    path: string,
    configuration: ProtectedLedgerConfiguration,
    payloads: NodeProtectedPayloadCodec
  ): SQLiteProtectedLedger {
    return new SQLiteProtectedLedger(path, configuration, payloads, false)
  }
  private initialize(): void {
    this.domain.transaction(() => {
      this.database
        .exec(`CREATE TABLE protected_head (id INTEGER PRIMARY KEY CHECK(id=1), revision TEXT NOT NULL, envelope TEXT NOT NULL) STRICT;
        CREATE TABLE protected_records (kind TEXT NOT NULL, key TEXT NOT NULL, revision TEXT NOT NULL,
        reserved_bytes INTEGER NOT NULL, reserved_updates INTEGER NOT NULL, bytes INTEGER NOT NULL, sealed_digest TEXT NOT NULL,
        envelope TEXT NOT NULL, PRIMARY KEY(kind,key)) STRICT;`)
      const head = {
        revision: '0',
        observedAt: '0',
        ...protectedInventory(
          [],
          this.configuration.maximumRecords,
          this.configuration.maximumReservedBytes
        )
      }
      this.saveHead(head, true)
    })
  }
  private binding(kind: string, extra: OutputJSONObject): OutputJSONObject {
    return {
      format: FORMAT,
      storeId: this.configuration.storeId,
      configuration: this.configurationDigest,
      kind,
      ...extra
    }
  }
  private encode(binding: OutputJSONObject, text: string): string {
    const bytes = Buffer.from(text, 'utf8')
    try {
      return canonicalOutputJSON(this.payloads.seal(binding, bytes), {
        bytes: this.envelopeBound(bytes.byteLength)
      })
    } finally {
      bytes.fill(0)
    }
  }
  private decode(binding: OutputJSONObject, envelope: string, maximum: number): unknown {
    const bytes = this.payloads.open(
      binding,
      parseOutputJSON(envelope, { bytes: this.envelopeBound(maximum) })
    )
    try {
      outputAssert(
        bytes.byteLength <= maximum,
        'Protected ledger plaintext exceeds its bound',
        'unavailable'
      )
      const text = Buffer.from(bytes).toString('utf8')
      outputAssert(
        Buffer.from(text, 'utf8').equals(Buffer.from(bytes)),
        'Invalid protected ledger UTF-8',
        'unavailable'
      )
      const value = parseOutputJSON(text, { bytes: maximum })
      outputAssert(
        canonicalOutputJSON(value, { bytes: maximum }) === text,
        'Noncanonical protected ledger record',
        'unavailable'
      )
      return value
    } finally {
      bytes.fill(0)
    }
  }
  private envelopeBound(bytes: number): number {
    return Math.ceil(bytes / 3) * 4 + 1024
  }
  private saveHead(head: ProtectedLedgerHead, insert = false): void {
    this.domain.writing()
    const envelope = this.encode(
      this.binding('head', { revision: head.revision }),
      canonicalOutputJSON(head, { bytes: HEAD_BYTES })
    )
    if (insert)
      this.database
        .prepare('INSERT INTO protected_head VALUES (1,?,?)')
        .run(head.revision, envelope)
    else
      this.database
        .prepare('UPDATE protected_head SET revision=?,envelope=? WHERE id=1')
        .run(head.revision, envelope)
  }
  private head(): ProtectedLedgerHead {
    this.domain.reading()
    const row = this.database
      .prepare(
        'SELECT CASE WHEN length(revision)<=20 THEN revision END AS revision,CASE WHEN length(CAST(envelope AS BLOB))<=? THEN envelope END AS envelope FROM protected_head WHERE id=1'
      )
      .get(this.envelopeBound(HEAD_BYTES))
    outputAssert(
      row && typeof row.envelope === 'string',
      'Protected ledger head is missing or oversized',
      'unavailable'
    )
    const revision = outputU64(row.revision).toString()
    const value = this.decode(this.binding('head', { revision }), row.envelope, HEAD_BYTES)
    closedOutputObject(value, [
      'revision',
      'observedAt',
      'records',
      'reservedBytes',
      'reservedUpdates',
      'inventory'
    ])
    outputAssert(
      value.revision === revision &&
        Number.isSafeInteger(value.records) &&
        Number.isSafeInteger(value.reservedBytes) &&
        Number.isSafeInteger(value.reservedUpdates),
      'Protected ledger head binding failed',
      'unavailable'
    )
    outputU64(value.observedAt)
    outputHex32(value.inventory)
    return value as unknown as ProtectedLedgerHead
  }
  private headers(): ProtectedLedgerHeader[] {
    this.domain.reading()
    return this.database
      .prepare(`SELECT ${HEADER_COLUMNS} FROM protected_records ORDER BY kind,key LIMIT ?`)
      .all(this.configuration.maximumRecords + 1)
      .map(row => protectedHeader(row, this.configuration.maximumRecordBytes))
  }
  private inventory(head: ProtectedLedgerHead): void {
    const headers = this.headers()
    const actual = protectedInventory(
      headers,
      this.configuration.maximumRecords,
      this.configuration.maximumReservedBytes
    )
    outputAssert(
      actual.inventory === head.inventory &&
        actual.records === head.records &&
        actual.reservedBytes === head.reservedBytes &&
        actual.reservedUpdates === head.reservedUpdates &&
        headers.every(row => outputU64(row.revision) <= outputU64(head.revision)),
      'Protected ledger inventory binding failed',
      'unavailable'
    )
    protectedRevisionCapacity(head.revision, actual.reservedUpdates)
  }
  private record(address: ProtectedLedgerAddress): ProtectedLedgerRecord | undefined {
    this.domain.reading()
    const row = this.database
      .prepare(
        `SELECT ${HEADER_COLUMNS},CASE WHEN length(CAST(envelope AS BLOB))<=? THEN envelope END AS envelope FROM protected_records WHERE kind=? AND key=?`
      )
      .get(this.envelopeBound(this.configuration.maximumRecordBytes), address.kind, address.key)
    if (!row) return undefined
    const header = protectedHeader(row, this.configuration.maximumRecordBytes)
    outputAssert(
      typeof row.envelope === 'string' && protectedDigest(row.envelope) === header.sealedDigest,
      'Protected ledger record integrity failed',
      'unavailable'
    )
    const { kind, key, revision, reservedBytes, reservedUpdates, bytes } = header
    const value = this.decode(
      this.binding('record', {
        recordKind: kind,
        key,
        revision,
        reservedBytes,
        reservedUpdates,
        bytes
      }),
      row.envelope,
      reservedBytes
    )
    const owned = protectedValue(value, reservedBytes)
    outputAssert(
      Buffer.byteLength(owned.text, 'utf8') === bytes,
      'Protected ledger record length differs',
      'unavailable'
    )
    return { kind, key, revision, reservedBytes, reservedUpdates, value: owned.value }
  }
  private authorize(head: ProtectedLedgerHead, guard: ProtectedLedgerGuard): void {
    let active = true
    const view: ProtectedLedgerView = {
      revision: head.revision,
      observedAt: head.observedAt,
      get: address => {
        outputAssert(active, 'Protected ledger authorization view has expired', 'unavailable')
        return this.record(protectedAddress(address))
      }
    }
    try {
      outputAssert(
        guard(view) === undefined,
        'Protected ledger guard returned asynchronous or invalid state'
      )
    } finally {
      active = false
    }
  }
  private synchronous(work: (...args: never[]) => unknown): void {
    outputAssert(
      work.constructor.name !== 'AsyncFunction',
      'Protected ledger callback must be synchronous'
    )
  }
  /** Commit monotonic observation even when authorization, CAS or later work rejects. */
  private observed<T>(
    clock: () => string,
    guard: ProtectedLedgerGuard,
    work: (head: ProtectedLedgerHead) => T
  ): T {
    this.synchronous(clock)
    this.synchronous(guard)
    const result = this.domain.transaction(() => {
      const head = this.head()
      this.inventory(head)
      const now = outputU64(clock())
      if (now > outputU64(head.observedAt)) head.observedAt = now.toString()
      const draft = structuredClone(head)
      try {
        const value = this.domain.savepoint(() => {
          this.authorize(draft, guard)
          const value = work(draft)
          // Metadata sealing/writing is part of the same rollback scope as every record.
          this.saveHead(draft)
          return value
        })
        return { ok: true as const, value }
      } catch (error) {
        this.saveHead(head)
        return { ok: false as const, error }
      }
    })
    if (!result.ok) throw result.error
    return result.value
  }
  read(
    addresses: readonly ProtectedLedgerAddress[],
    clock: () => string,
    guard: ProtectedLedgerGuard
  ): { revision: string; observedAt: string; records: (ProtectedLedgerRecord | undefined)[] } {
    const keys = this.addresses(addresses)
    return this.observed(clock, guard, head => ({
      revision: head.revision,
      observedAt: head.observedAt,
      records: keys.map(address => this.record(address))
    }))
  }
  /**
   * Internal bounded work discovery. Each page is one authenticated current read;
   * this is not a retained snapshot or a claim that all pending work is complete.
   * A reconciler wraps to null after each pass to discover inserts behind its key,
   * then rereads each candidate and uses its actual revision at effect reservation.
   * Enumeration never decrypts record bodies or grants authority to disclose them.
   */
  enumerate(
    kind: ProtectedLedgerAddress['kind'],
    afterKey: string | null,
    maximum: number,
    clock: () => string,
    guard: ProtectedLedgerGuard
  ): {
    revision: string
    observedAt: string
    entries: (ProtectedLedgerAddress & { revision: string })[]
    next: string | null
  } {
    const selected = protectedAddress({ kind, key: afterKey ?? '00'.repeat(32) })
    const limit = protectedInteger(maximum, 64)
    return this.observed(clock, guard, head => {
      const rows = this.database
        .prepare(
          `SELECT ${HEADER_COLUMNS} FROM protected_records WHERE kind=? AND key>? ORDER BY key LIMIT ?`
        )
        .all(selected.kind, afterKey === null ? '' : selected.key, limit + 1)
        .map(row => protectedHeader(row, this.configuration.maximumRecordBytes))
      const page = rows.slice(0, limit)
      return {
        revision: head.revision,
        observedAt: head.observedAt,
        entries: page.map(({ kind, key, revision }) => ({ kind, key, revision })),
        next: rows.length > limit ? page.at(-1)!.key : null
      }
    })
  }
  private addresses(input: readonly ProtectedLedgerAddress[]): ProtectedLedgerAddress[] {
    const owned = parseOutputJSON(canonicalOutputJSON(input, { bytes: 16384 }))
    outputAssert(
      Array.isArray(owned) && owned.length >= 1 && owned.length <= 64,
      'Protected ledger read batch must contain 1–64 addresses'
    )
    return owned.map(protectedAddress)
  }
  private ownLocalBatch(
    changes: readonly ProtectedLedgerChange[],
    input: ProtectedLedgerCommitOptions
  ) {
    const options = parseOutputJSON(canonicalOutputJSON(input, { bytes: 1024 }))
    closedOutputObject(options, ['maximumBatchBytes'])
    const maximum = protectedInteger(
      options.maximumBatchBytes,
      this.configuration.maximumReservedBytes + 65536
    )
    outputAssert(
      Array.isArray(changes) && changes.length >= 1 && changes.length <= 64,
      'Protected ledger commit must contain 1–64 records'
    )
    outputAssert(
      Object.getPrototypeOf(changes) === Array.prototype,
      'Protected ledger commit array has an unexpected prototype'
    )
    outputAssert(
      Reflect.ownKeys(changes).length === changes.length + 1 &&
        Object.keys(changes).length === changes.length,
      'Protected ledger commit array is decorated or sparse'
    )
    let bytes = 2 + changes.length - 1
    const result = []
    // Each complete record plan stays below the protocol JSON ceiling. Only this
    // local atomic batch can be larger; own all entries before any clock/effect.
    for (let i = 0; i < changes.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(changes, i)
      outputAssert(
        descriptor?.enumerable && 'value' in descriptor,
        'Protected ledger commit array contains an accessor or hole'
      )
      const limits = { bytes: this.configuration.maximumRecordBytes + 1024, depth: 31 }
      const text = canonicalOutputJSON(descriptor.value, limits)
      bytes += Buffer.byteLength(text, 'utf8')
      outputAssert(
        bytes <= maximum,
        'Protected ledger local batch exceeds its byte allowance',
        'limited'
      )
      result.push(parseOutputJSON(text, limits))
    }
    return result
  }
  commit(
    expectedRevision: string,
    changes: readonly ProtectedLedgerChange[],
    clock: () => string,
    guard: ProtectedLedgerGuard,
    options?: ProtectedLedgerCommitOptions
  ): string {
    const expected = outputU64(expectedRevision).toString()
    const inputs =
      options === undefined
        ? parseOutputJSON(canonicalOutputJSON(changes))
        : this.ownLocalBatch(changes, options)
    outputAssert(
      Array.isArray(inputs) && inputs.length >= 1 && inputs.length <= 64,
      'Protected ledger commit must contain 1–64 records'
    )
    const owned = inputs.map(change => {
      closedOutputObject(change, [
        'kind',
        'key',
        'expectedRevision',
        'reservedBytes',
        'reservedUpdates',
        'value'
      ])
      const { text } = protectedValue(change.value, this.configuration.maximumRecordBytes)
      return {
        ...protectedAddress({ kind: change.kind, key: change.key }),
        expectedRevision:
          change.expectedRevision === null ? null : outputU64(change.expectedRevision).toString(),
        reservedBytes: protectedInteger(
          change.reservedBytes,
          this.configuration.maximumRecordBytes
        ),
        reservedUpdates: protectedUpdates(change.reservedUpdates),
        text
      }
    })
    outputAssert(
      new Set(owned.map(change => canonicalOutputJSON({ kind: change.kind, key: change.key })))
        .size === owned.length,
      'Protected ledger commit repeats an address'
    )
    return this.observed(clock, guard, head => {
      outputAssert(head.revision === expected, 'Protected ledger changed before commit', 'conflict')
      const revision = incrementOutputU64(head.revision)
      let count = head.records,
        capacity = head.reservedBytes
      for (const change of owned) {
        const prior = this.record(change)
        outputAssert(
          (prior?.revision ?? null) === change.expectedRevision,
          'Protected record changed before commit',
          'conflict'
        )
        const bytes = Buffer.byteLength(change.text, 'utf8')
        outputAssert(
          bytes <= change.reservedBytes && (!prior || change.reservedBytes >= prior.reservedBytes),
          'Protected record reservation cannot be exceeded or silently reduced',
          'limited'
        )
        capacity += change.reservedBytes - (prior?.reservedBytes ?? 0)
        if (!prior) count++
        outputAssert(
          count <= this.configuration.maximumRecords &&
            capacity <= this.configuration.maximumReservedBytes,
          'Protected ledger capacity is full',
          'limited'
        )
        outputAssert(
          change.reservedUpdates >= Math.max(0, (prior?.reservedUpdates ?? 0) - 1),
          'Protected completion reservation cannot be silently discarded',
          'limited'
        )
        const recordRevision = prior ? incrementOutputU64(prior.revision) : '1'
        const binding = this.binding('record', {
          recordKind: change.kind,
          key: change.key,
          revision: recordRevision,
          reservedBytes: change.reservedBytes,
          reservedUpdates: change.reservedUpdates,
          bytes
        })
        const envelope = this.encode(binding, change.text)
        this.database
          .prepare(
            'INSERT INTO protected_records VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(kind,key) DO UPDATE SET revision=excluded.revision,reserved_bytes=excluded.reserved_bytes,reserved_updates=excluded.reserved_updates,bytes=excluded.bytes,sealed_digest=excluded.sealed_digest,envelope=excluded.envelope'
          )
          .run(
            change.kind,
            change.key,
            recordRevision,
            change.reservedBytes,
            change.reservedUpdates,
            bytes,
            protectedDigest(envelope),
            envelope
          )
      }
      Object.assign(
        head,
        protectedInventory(
          this.headers(),
          this.configuration.maximumRecords,
          this.configuration.maximumReservedBytes
        ),
        { revision }
      )
      protectedRevisionCapacity(revision, head.reservedUpdates)
      return revision
    })
  }
  /** The service must durably create the disclosure obligation before calling this final enqueue. */
  disclose(
    expectedRevision: string,
    addresses: readonly ProtectedLedgerAddress[],
    clock: () => string,
    guard: ProtectedLedgerGuard,
    enqueue: (records: (ProtectedLedgerRecord | undefined)[]) => void
  ): void {
    const keys = this.addresses(addresses),
      expected = outputU64(expectedRevision).toString()
    this.synchronous(enqueue)
    this.observed(clock, guard, head => {
      outputAssert(
        head.revision === expected,
        'Protected ledger changed before disclosure',
        'conflict'
      )
      outputAssert(
        enqueue(keys.map(address => this.record(address))) === undefined,
        'Protected disclosure enqueue must be synchronous'
      )
    })
  }
  close(): void {
    this.domain.close('Protected ledger')
  }
}
