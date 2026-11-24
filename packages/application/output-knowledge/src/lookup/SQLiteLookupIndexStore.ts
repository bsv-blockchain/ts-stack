import { sqliteLookupBridge, type SQLiteLookupBridge } from './SQLiteLookupBridge.js'
import { prepareLookupStatement, bytes, decimal, position } from './SQLiteLookupEncoding.js'
import { SQLiteLookupRecords } from './SQLiteLookupRecords.js'
import type { DatabaseSync } from 'node:sqlite'
import { SQLiteTransactionDomain } from '../storage/SQLiteTransactionDomain.js'
import {
  canonicalOutputJSON,
  outputString,
  outputHex32,
  outputU64,
  OutputProtocolError,
  type OutputJSONObject
} from '@bsv/sdk'
import { synchronousPromise } from '../internal/synchronousPromise.js'
import {
  LookupIndexCodec,
  type LookupIndexGroup,
  type LookupIndexLimits,
  type LookupIndexMutation,
  type LookupIndexRow
} from './LookupIndexCodec.js'
import { lookupIndexKey } from './LookupIndexKey.js'
import type {
  LookupIndexCapacity,
  LookupIndexConfiguration,
  LookupIndexHead,
  LookupIndexReadLimits,
  LookupIndexSnapshotPage,
  LookupIndexLogPage,
  LookupIndexTimeAdvance,
  LookupIndexCompactionLimits,
  LookupIndexCompaction,
  LookupIndexStorage
} from './LookupIndexStorage.js'
const capacityMaximums: Readonly<LookupIndexCapacity> = Object.freeze({
  keys: 65536,
  versions: 262144,
  groups: 65536,
  pins: 65536,
  bytes: 268435456
})
export interface SQLiteLookupIndexOptions {
  records?: Partial<LookupIndexLimits>
  capacity?: Partial<LookupIndexCapacity>
}
function readLimits(input: LookupIndexReadLimits): LookupIndexReadLimits {
  if (
    Object.keys(input).some(key => key !== 'records' && key !== 'bytes') ||
    !Number.isSafeInteger(input.records) ||
    input.records < 1 ||
    input.records > 1024 ||
    !Number.isSafeInteger(input.bytes) ||
    input.bytes < 1 ||
    input.bytes > 4194304
  )
    throw new OutputProtocolError('invalid', 'Invalid lookup index read limits')
  return { records: input.records, bytes: input.bytes }
}

function capacity(input: Partial<LookupIndexCapacity> = {}): Readonly<LookupIndexCapacity> {
  const result = { ...capacityMaximums, ...input }
  for (const key of Object.keys(result) as (keyof LookupIndexCapacity)[])
    if (
      !Object.hasOwn(capacityMaximums, key) ||
      !Number.isSafeInteger(result[key]) ||
      result[key] < 1 ||
      result[key] > capacityMaximums[key]
    )
      throw new OutputProtocolError('invalid', 'Invalid lookup storage capacity')
  return Object.freeze(result)
}

/** @internal Validated definition, prepared before opening or creating a file. */
export function lookupIndexDefinition(
  namespace: string,
  binding: OutputJSONObject,
  options: SQLiteLookupIndexOptions,
  composition?: OutputJSONObject
) {
  outputString(namespace)
  const codec = new LookupIndexCodec(options.records)
  const retainedCapacity = capacity(options.capacity)
  if (binding === null || typeof binding !== 'object' || Array.isArray(binding))
    throw new OutputProtocolError('invalid', 'Lookup index binding must be a JSON object')
  const configurationJSON = canonicalOutputJSON(
    {
      format:
        composition === undefined ? 'output-lookup-index/1' : 'proposal-current-channel-index/1',
      namespace,
      binding,
      records: codec.limits,
      capacity: retainedCapacity,
      ...(composition === undefined ? {} : { composition })
    },
    { bytes: 65536 }
  )
  return { namespace, codec, capacity: retainedCapacity, configurationJSON }
}

/** @internal Compound-writer capability; never a public raw-SQL interface. */
export const sqliteLookupComposition = Symbol('SQLite lookup composition')

/** @internal Shared concrete implementation on one owned connection. */
export class SQLiteLookupIndexStore implements LookupIndexStorage {
  readonly durability = 'durable' as const
  readonly namespace: string
  private readonly database: DatabaseSync
  private readonly codec: LookupIndexCodec
  private readonly records: SQLiteLookupRecords
  private readonly capacity: Readonly<LookupIndexCapacity>
  private readonly configurationJSON: string

  constructor(
    private readonly domain: SQLiteTransactionDomain,
    definition: ReturnType<typeof lookupIndexDefinition>
  ) {
    this.namespace = definition.namespace
    this.database = domain.database
    this.codec = definition.codec
    this.capacity = definition.capacity
    this.configurationJSON = definition.configurationJSON
    this.records = new SQLiteLookupRecords(this.database, this.namespace, this.codec)
    domain.claim('lookup-index:' + this.namespace)
  }

  /** @internal Only concrete SQLite companions possess this symbol. */
  get [sqliteLookupComposition]() {
    return {
      initialize: (create: boolean) => {
        if (create) this.domain.writing()
        else this.domain.reading()
        if (create) this.initialize()
        this.metadata()
        this.verifyInventory()
      },
      append: (input: LookupIndexMutation) => {
        this.domain.writing()
        const mutation = this.codec.mutation(input)
        return this.commitPrepared(mutation, this.codec.mutationKey(mutation))
      },
      head: () => {
        this.domain.writing()
        return this.metadata()
      },
      row: (key: string) => {
        this.domain.writing()
        lookupIndexKey(key)
        const head = this.metadata()
        return this.records.row(key, head.sequence, head.sequence)
      }
    }
  }

  private initialize(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS output_lookup_meta (
        namespace TEXT PRIMARY KEY, configuration TEXT NOT NULL, sequence TEXT NOT NULL,
        recorded_at TEXT NOT NULL, processed_at TEXT NOT NULL,
        retention_floor TEXT NOT NULL, retention_time TEXT NOT NULL,
        keys INTEGER NOT NULL, versions INTEGER NOT NULL,
        groups INTEGER NOT NULL, pins INTEGER NOT NULL, payload_bytes INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS output_lookup_keys (
        namespace TEXT NOT NULL, row_key TEXT NOT NULL, first_sequence TEXT NOT NULL,
        current_sequence TEXT NOT NULL, expires_at TEXT, head_digest TEXT NOT NULL,
        PRIMARY KEY(namespace,row_key), FOREIGN KEY(namespace) REFERENCES output_lookup_meta(namespace)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS output_lookup_due ON output_lookup_keys(namespace,expires_at,row_key)
        WHERE expires_at IS NOT NULL;
      CREATE TABLE IF NOT EXISTS output_lookup_versions (
        namespace TEXT NOT NULL, row_key TEXT NOT NULL, sequence TEXT NOT NULL,
        payload TEXT NOT NULL, payload_bytes INTEGER NOT NULL, digest TEXT NOT NULL,
        next_sequence TEXT, link_digest TEXT NOT NULL,
        PRIMARY KEY(namespace,row_key,sequence),
        FOREIGN KEY(namespace,row_key) REFERENCES output_lookup_keys(namespace,row_key)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS output_lookup_groups (
        namespace TEXT NOT NULL, sequence TEXT NOT NULL, mutation_key TEXT NOT NULL,
        payload TEXT NOT NULL, payload_bytes INTEGER NOT NULL, digest TEXT NOT NULL,
        PRIMARY KEY(namespace,sequence), FOREIGN KEY(namespace) REFERENCES output_lookup_meta(namespace)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS output_lookup_pins (
        namespace TEXT NOT NULL, pin_key TEXT NOT NULL, watermark TEXT NOT NULL,
        replay_until TEXT NOT NULL, PRIMARY KEY(namespace,pin_key),
        FOREIGN KEY(namespace) REFERENCES output_lookup_meta(namespace)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS output_lookup_pin_deadlines
        ON output_lookup_pins(namespace,replay_until,watermark);
    `)
    prepareLookupStatement(
      this.database,
      'INSERT OR IGNORE INTO output_lookup_meta VALUES (?,?,?,?,?,?,?,0,0,0,0,0)'
    ).run(
      this.namespace,
      this.configurationJSON,
      position('0'),
      position('0'),
      position('0'),
      position('0'),
      position('0')
    )
    this.metadata()
  }

  private ready(): void {
    this.domain.ready('Lookup index')
  }
  private transaction<T>(work: () => T, write = true): T {
    this.ready()
    return this.domain.transaction(work, { write })
  }

  private metadata(): LookupIndexHead {
    this.ready()
    const record = prepareLookupStatement(
      this.database,
      `SELECT
      CASE WHEN length(CAST(configuration AS BLOB))<=65536 THEN configuration END AS configuration,
      CASE WHEN length(sequence)=16 THEN sequence END AS sequence,
      CASE WHEN length(recorded_at)=16 THEN recorded_at END AS recorded_at,
      CASE WHEN length(processed_at)=16 THEN processed_at END AS processed_at,
      CASE WHEN length(retention_floor)=16 THEN retention_floor END AS retention_floor,
      CASE WHEN length(retention_time)=16 THEN retention_time END AS retention_time,
      keys,versions,groups,pins,payload_bytes FROM output_lookup_meta WHERE namespace=?`
    ).get(this.namespace)
    if (record === undefined)
      throw new OutputProtocolError('reset-required', 'Lookup index namespace is missing')
    if (record.configuration !== this.configurationJSON)
      throw new OutputProtocolError('context-changed', 'Lookup index configuration changed')
    const retained = {
      keys: record.keys,
      versions: record.versions,
      groups: record.groups,
      pins: record.pins,
      bytes: record.payload_bytes
    }
    for (const key of Object.keys(retained) as (keyof LookupIndexCapacity)[])
      if (
        !Number.isSafeInteger(retained[key]) ||
        Number(retained[key]) < 0 ||
        Number(retained[key]) > this.capacity[key]
      )
        throw new OutputProtocolError('reset-required', 'Invalid lookup index retained counts')
    const sequence = decimal(record.sequence)
    const floor = decimal(record.retention_floor)
    if (outputU64(sequence) - outputU64(floor) !== BigInt(Number(retained.groups)))
      throw new OutputProtocolError('reset-required', 'Lookup index lost its contiguous log head')
    return {
      sequence,
      recordedAt: decimal(record.recorded_at),
      processedThrough: decimal(record.processed_at),
      retention: { floor, checkedAt: decimal(record.retention_time) },
      retained: retained as unknown as LookupIndexCapacity
    }
  }

  head(): Promise<LookupIndexHead> {
    return synchronousPromise(() => this.metadata())
  }

  get configuration(): LookupIndexConfiguration {
    const saved = JSON.parse(this.configurationJSON) as LookupIndexConfiguration
    return { binding: saved.binding, records: saved.records, capacity: saved.capacity }
  }

  private verifyInventory(): void {
    const expected = this.metadata().retained
    const keys = prepareLookupStatement(
      this.database,
      'SELECT count(*) AS count FROM output_lookup_keys WHERE namespace=?'
    ).get(this.namespace)!
    const versions = prepareLookupStatement(
      this.database,
      'SELECT count(*) AS count,coalesce(sum(payload_bytes),0) AS bytes FROM output_lookup_versions WHERE namespace=?'
    ).get(this.namespace)!
    const groups = prepareLookupStatement(
      this.database,
      'SELECT count(*) AS count,coalesce(sum(payload_bytes),0) AS bytes FROM output_lookup_groups WHERE namespace=?'
    ).get(this.namespace)!
    const pins = prepareLookupStatement(
      this.database,
      'SELECT count(*) AS count FROM output_lookup_pins WHERE namespace=?'
    ).get(this.namespace)!
    if (
      keys.count !== expected.keys ||
      versions.count !== expected.versions ||
      groups.count !== expected.groups ||
      pins.count !== expected.pins ||
      Number(versions.bytes) + Number(groups.bytes) !== expected.bytes
    )
      throw new OutputProtocolError(
        'reset-required',
        'Lookup index retained inventory is incomplete'
      )
  }

  /** A historical point read under an exact known index watermark. */
  row(key: string, at: string): Promise<LookupIndexRow | null> {
    return synchronousPromise(() => {
      lookupIndexKey(key)
      outputU64(at)
      return this.transaction(() => {
        const head = this.metadata()
        this.requireRetained(at, head)
        if (outputU64(at) > outputU64(head.sequence))
          throw new OutputProtocolError('revision-unavailable', 'Lookup watermark is not committed')
        return this.records.row(key, at, head.sequence)
      }, false)
    })
  }

  group(sequence: string): Promise<LookupIndexGroup> {
    return synchronousPromise(() => {
      outputU64(sequence)
      return this.transaction(() => {
        const head = this.metadata()
        if (sequence !== '0' && outputU64(sequence) <= outputU64(head.retention.floor))
          throw new OutputProtocolError('reset-required', 'Lookup group history was compacted')
        if (sequence === '0' || outputU64(sequence) > outputU64(head.sequence))
          throw new OutputProtocolError('revision-unavailable', 'Lookup group is not committed')
        return this.records.group(sequence).group
      }, false)
    })
  }

  /**
   * Scan immutable keys/versions at W. Later insertions cannot change a replay
   * prefix. Tombstones consume scan work and advance after, without returning a
   * current row. Hydration retains at most the page plus one bounded candidate.
   */
  snapshot(
    at: string,
    after: string | null,
    input: LookupIndexReadLimits
  ): Promise<LookupIndexSnapshotPage> {
    return synchronousPromise(() => {
      outputU64(at)
      if (after !== null) lookupIndexKey(after)
      const limits = readLimits(input)
      return this.transaction(() => this.snapshotPage(at, after, limits), false)
    })
  }

  private snapshotPage(
    at: string,
    after: string | null,
    limits: LookupIndexReadLimits
  ): LookupIndexSnapshotPage {
    const head = this.metadata()
    this.requireRetained(at, head)
    if (outputU64(at) > outputU64(head.sequence))
      throw new OutputProtocolError('revision-unavailable', 'Lookup watermark is not committed')
    const page: LookupIndexSnapshotPage = {
      watermark: at,
      rows: [],
      after,
      scanned: 0,
      complete: false
    }
    if (bytes(canonicalOutputJSON(page)) > limits.bytes)
      throw new OutputProtocolError('limited', 'Lookup snapshot page envelope exceeds its budget')
    const keys = prepareLookupStatement(
      this.database,
      `SELECT CASE WHEN length(row_key)<=256 THEN row_key END AS row_key FROM output_lookup_keys
      WHERE namespace=? AND first_sequence<=? AND row_key>? ORDER BY row_key LIMIT ?`
    ).all(this.namespace, position(at), after ?? '', limits.records + 1)
    let rowBytes = 0
    for (const entry of keys.slice(0, limits.records)) {
      const key = lookupIndexKey(entry.row_key)
      const row = this.records.row(key, at, head.sequence)
      const separator = page.rows.length > 0 ? 1 : 0
      const added = row === null ? 0 : bytes(canonicalOutputJSON(row)) + separator
      const envelope = { ...page, rows: [], after: key, scanned: page.scanned + 1 }
      if (bytes(canonicalOutputJSON(envelope)) + rowBytes + added > limits.bytes) {
        if (page.scanned === 0)
          throw new OutputProtocolError('limited', 'Next whole lookup row exceeds its page budget')
        return page
      }
      rowBytes += added
      page.after = key
      page.scanned++
      if (row !== null) page.rows.push(row)
    }
    page.complete = keys.length <= limits.records
    return page
  }

  /** Bounded contiguous provider log, before query-specific filtering. Reads consume nothing. */
  changes(after: string, input: LookupIndexReadLimits): Promise<LookupIndexLogPage> {
    return synchronousPromise(() => {
      outputU64(after)
      const limits = readLimits(input)
      return this.transaction(() => this.logPage(after, limits), false)
    })
  }

  private logPage(after: string, limits: LookupIndexReadLimits): LookupIndexLogPage {
    const head = this.metadata()
    this.requireRetained(after, head)
    if (outputU64(after) > outputU64(head.sequence))
      throw new OutputProtocolError(
        'revision-unavailable',
        'Lookup log cursor is ahead of the index'
      )
    const page: LookupIndexLogPage = { groups: [], through: after, highWater: head.sequence }
    if (bytes(canonicalOutputJSON(page)) > limits.bytes)
      throw new OutputProtocolError('limited', 'Lookup log page envelope exceeds its budget')
    let groupBytes = 0
    for (
      let count = 0;
      count < limits.records && outputU64(page.through) < outputU64(head.sequence);
      count++
    ) {
      const sequence = (outputU64(page.through) + 1n).toString()
      const group = this.records.group(sequence).group
      const added = bytes(canonicalOutputJSON(group)) + (page.groups.length > 0 ? 1 : 0)
      const envelope = { groups: [], through: sequence, highWater: head.sequence }
      if (bytes(canonicalOutputJSON(envelope)) + groupBytes + added > limits.bytes) {
        if (page.groups.length === 0)
          throw new OutputProtocolError(
            'limited',
            'Next whole lookup group exceeds its page budget'
          )
        return page
      }
      groupBytes += added
      page.groups.push(group)
      page.through = sequence
    }
    return page
  }

  /** Compare the complete observed head and commit every version and group together. */
  commit(input: LookupIndexMutation): Promise<LookupIndexGroup> {
    return synchronousPromise(() => {
      const mutation = this.codec.mutation(input)
      const key = this.codec.mutationKey(mutation)
      return this.transaction(() => this.commitPrepared(mutation, key))
    })
  }

  private commitPrepared(mutation: LookupIndexMutation, key: string): LookupIndexGroup {
    const head = this.metadata()
    if (outputU64(mutation.base) < outputU64(head.sequence)) {
      if (outputU64(mutation.base) < outputU64(head.retention.floor))
        throw new OutputProtocolError(
          'reset-required',
          'Lookup mutation retry history was compacted'
        )
      const saved = this.records.group((outputU64(mutation.base) + 1n).toString())
      if (saved.key === key) return saved.group
    }
    if (mutation.base !== head.sequence)
      throw new OutputProtocolError('conflict', 'Lookup index changed after assessment')
    this.checkTime(mutation.evaluatedAt, head)
    if (this.due(mutation.evaluatedAt, head) !== null)
      throw new OutputProtocolError('unavailable', 'Drain due lookup timers before assessment')
    const rows = this.mutationRows(mutation, head.sequence)
    const group = this.codec.plan(mutation, rows)
    this.persist(group, key, head)
    this.setProcessedTime(mutation.evaluatedAt)
    return group
  }

  private requireRetained(watermark: string, head: LookupIndexHead): void {
    if (outputU64(watermark) < outputU64(head.retention.floor))
      throw new OutputProtocolError('reset-required', 'Lookup watermark history was compacted')
  }

  /** Internal companion capability; it never owns or closes a second connection. */
  [sqliteLookupBridge](): SQLiteLookupBridge {
    this.ready()
    return {
      database: this.database,
      namespace: this.namespace,
      transaction: work => this.transaction(work),
      savepoint: work => this.domain.savepoint(work),
      head: () => this.metadata(),
      retainSnapshot: (key, watermark, replayUntil) =>
        this.retainSnapshotInTransaction(key, watermark, replayUntil)
    }
  }

  retainSnapshot(key: string, watermark: string, replayUntil: string): Promise<void> {
    return synchronousPromise(() =>
      this.transaction(() => this.retainSnapshotInTransaction(key, watermark, replayUntil))
    )
  }

  private retainSnapshotInTransaction(key: string, watermark: string, replayUntil: string): void {
    outputHex32(key)
    outputU64(watermark)
    outputU64(replayUntil)
    const head = this.metadata()
    this.requireRetained(watermark, head)
    if (outputU64(watermark) > outputU64(head.sequence))
      throw new OutputProtocolError('revision-unavailable', 'Cannot pin an uncommitted watermark')
    if (outputU64(replayUntil) <= outputU64(head.retention.checkedAt))
      throw new OutputProtocolError('expired', 'Lookup retention promise already expired')
    const existing = prepareLookupStatement(
      this.database,
      'SELECT watermark,replay_until FROM output_lookup_pins WHERE namespace=? AND pin_key=?'
    ).get(this.namespace, key)
    if (existing !== undefined) {
      if (
        existing.watermark !== position(watermark) ||
        existing.replay_until !== position(replayUntil)
      )
        throw new OutputProtocolError('conflict', 'Lookup retention promise changed')
      return
    }
    if (head.retained.pins >= this.capacity.pins)
      throw new OutputProtocolError('limited', 'Lookup retention pin capacity is full')
    prepareLookupStatement(this.database, 'INSERT INTO output_lookup_pins VALUES (?,?,?,?)').run(
      this.namespace,
      key,
      position(watermark),
      position(replayUntil)
    )
    prepareLookupStatement(
      this.database,
      'UPDATE output_lookup_meta SET pins=pins+1 WHERE namespace=?'
    ).run(this.namespace)
  }

  /**
   * Advance only as far as the oldest unexpired promise. Bound deletion work,
   * preserve the latest baseline row at/before the new floor, and keep immutable
   * key order (including tombstones). No page, log group or pin is partly removed.
   */
  compact(at: string, limits: LookupIndexCompactionLimits): Promise<LookupIndexCompaction> {
    return synchronousPromise(() => {
      outputU64(at)
      if (
        Object.keys(limits).length !== 3 ||
        Object.keys(limits).some(key => !['groups', 'versions', 'pins'].includes(key)) ||
        [limits.groups, limits.versions, limits.pins].some(
          value => !Number.isSafeInteger(value) || value < 1 || value > 1024
        )
      )
        throw new OutputProtocolError('invalid', 'Invalid lookup compaction work bound')
      return this.transaction(() => {
        const head = this.metadata()
        if (
          outputU64(at) < outputU64(head.retention.checkedAt) ||
          outputU64(at) < outputU64(head.recordedAt)
        )
          throw new OutputProtocolError('context-changed', 'Lookup retention clock moved backwards')
        const promise = prepareLookupStatement(
          this.database,
          'SELECT count(*) AS count,min(CASE WHEN replay_until>? THEN watermark END) AS watermark FROM output_lookup_pins WHERE namespace=?'
        ).get(position(at), this.namespace)!
        if (promise.count !== head.retained.pins)
          throw new OutputProtocolError(
            'reset-required',
            'Lookup compaction lost its retained promises'
          )
        const target =
          promise.watermark === null
            ? outputU64(head.sequence)
            : outputU64(decimal(promise.watermark))
        const previous = outputU64(head.retention.floor)
        if (target < previous || target > outputU64(head.sequence))
          throw new OutputProtocolError('reset-required', 'Lookup retention pin lost its history')
        const next = previous + BigInt(limits.groups)
        // Keep sequence arithmetic in bigint, including positions above 2^53.
        let bounded = target
        if (next < target) bounded = next
        const floor = bounded.toString()
        const groups = prepareLookupStatement(
          this.database,
          'SELECT count(*) AS count,coalesce(sum(payload_bytes),0) AS bytes FROM output_lookup_groups WHERE namespace=? AND sequence<=?'
        ).get(this.namespace, position(floor))!
        if (BigInt(Number(groups.count)) !== outputU64(floor) - previous)
          throw new OutputProtocolError(
            'reset-required',
            'Lookup compaction found a missing log interval'
          )
        prepareLookupStatement(
          this.database,
          'DELETE FROM output_lookup_groups WHERE namespace=? AND sequence<=?'
        ).run(this.namespace, position(floor))
        const versions = this.compactVersions(floor, limits.versions)
        const pins = prepareLookupStatement(
          this.database,
          `DELETE FROM output_lookup_pins WHERE namespace=? AND pin_key IN (
          SELECT pin_key FROM output_lookup_pins WHERE namespace=? AND replay_until<=? ORDER BY replay_until,pin_key LIMIT ?)`
        ).run(this.namespace, this.namespace, position(at), limits.pins)
        const removed = {
          groups: Number(groups.count),
          versions: versions.count,
          pins: Number(pins.changes)
        }
        prepareLookupStatement(
          this.database,
          `UPDATE output_lookup_meta SET retention_floor=?,retention_time=?,
          groups=groups-?,versions=versions-?,pins=pins-?,payload_bytes=payload_bytes-? WHERE namespace=?`
        ).run(
          position(floor),
          position(at),
          removed.groups,
          removed.versions,
          removed.pins,
          Number(groups.bytes) + versions.bytes,
          this.namespace
        )
        return { head: this.metadata(), removed }
      })
    })
  }

  private compactVersions(floor: string, maximum: number): { count: number; bytes: number } {
    const removable = prepareLookupStatement(
      this.database,
      `SELECT older.row_key,older.sequence,older.payload_bytes
      FROM output_lookup_versions AS older WHERE older.namespace=? AND older.sequence<=? AND EXISTS (
        SELECT 1 FROM output_lookup_versions AS newer WHERE newer.namespace=older.namespace AND
        newer.row_key=older.row_key AND newer.sequence>older.sequence AND newer.sequence<=?)
      ORDER BY older.row_key,older.sequence LIMIT ?`
    ).all(this.namespace, position(floor), position(floor), maximum)
    let removedBytes = 0
    for (const row of removable) {
      const key = lookupIndexKey(row.row_key)
      const sequence = decimal(row.sequence)
      if (
        !Number.isSafeInteger(row.payload_bytes) ||
        Number(row.payload_bytes) < 1 ||
        Number(row.payload_bytes) > this.codec.limits.rowBytes
      )
        throw new OutputProtocolError('reset-required', 'Invalid compacted lookup row size')
      removedBytes += Number(row.payload_bytes)
      prepareLookupStatement(
        this.database,
        'DELETE FROM output_lookup_versions WHERE namespace=? AND row_key=? AND sequence=?'
      ).run(this.namespace, key, position(sequence))
    }
    return { count: removable.length, bytes: removedBytes }
  }

  private checkTime(at: string, head: LookupIndexHead): void {
    if (
      outputU64(at) < outputU64(head.recordedAt) ||
      outputU64(at) < outputU64(head.processedThrough) ||
      outputU64(at) < outputU64(head.retention.checkedAt)
    )
      throw new OutputProtocolError('context-changed', 'Lookup evaluation time moved backwards')
  }

  private setProcessedTime(at: string): void {
    prepareLookupStatement(
      this.database,
      'UPDATE output_lookup_meta SET processed_at=? WHERE namespace=?'
    ).run(position(at), this.namespace)
  }

  private due(at: string, head: LookupIndexHead): LookupIndexRow | null {
    const entry = prepareLookupStatement(
      this.database,
      `SELECT
      CASE WHEN length(row_key)<=256 THEN row_key END AS row_key,
      CASE WHEN length(current_sequence)=16 THEN current_sequence END AS current_sequence,
      CASE WHEN length(expires_at)=16 THEN expires_at END AS expires_at
      FROM output_lookup_keys WHERE namespace=? AND expires_at<=?
      ORDER BY expires_at,row_key LIMIT 1`
    ).get(this.namespace, position(at))
    if (entry === undefined) return null
    const key = lookupIndexKey(entry.row_key)
    const row = this.records.row(key, head.sequence, head.sequence)
    if (
      row?.revision !== decimal(entry.current_sequence) ||
      row.value.expiresAt !== decimal(entry.expires_at)
    )
      throw new OutputProtocolError('reset-required', 'Lookup timer lost its current row binding')
    return row
  }

  /**
   * Each expiresAt is an independent row timer. Coupled domain transitions must
   * use a domain mutation instead. A bounded transaction records whole expiry
   * groups; the floor advances only once no timer through at remains. Restart or
   * a lost acknowledgement can repeat this operation without duplicate groups.
   */
  advanceTime(at: string, maximumGroups: number): Promise<LookupIndexTimeAdvance> {
    return synchronousPromise(() => {
      outputU64(at)
      if (!Number.isSafeInteger(maximumGroups) || maximumGroups < 1 || maximumGroups > 1024)
        throw new OutputProtocolError('invalid', 'Invalid lookup timer work bound')
      return this.transaction(() => {
        let head = this.metadata()
        this.checkTime(at, head)
        let expired = 0
        let row = this.due(at, head)
        while (row !== null && expired < maximumGroups) {
          const mutation: LookupIndexMutation = {
            base: head.sequence,
            evaluatedAt: at,
            edits: [{ key: row.key, previous: row.revision, next: null }],
            event: { type: 'output-lookup-row-expired/1' }
          }
          const group = this.codec.plan(mutation, [row])
          this.persist(group, this.codec.mutationKey(mutation), head)
          expired++
          head = this.metadata()
          row = this.due(at, head)
        }
        const complete = row === null
        if (complete) this.setProcessedTime(at)
        return { head: this.metadata(), expired, complete }
      })
    })
  }

  private mutationRows(mutation: LookupIndexMutation, head: string): (LookupIndexRow | null)[] {
    const rows: (LookupIndexRow | null)[] = []
    let retained = 2
    for (const edit of mutation.edits) {
      const row = this.records.row(edit.key, head, head)
      retained +=
        bytes(canonicalOutputJSON(row, { bytes: this.codec.limits.rowBytes })) +
        (rows.length > 0 ? 1 : 0)
      if (retained > this.codec.limits.groupBytes)
        throw new OutputProtocolError('limited', 'Lookup mutation read-set byte limit')
      rows.push(row)
    }
    return rows
  }

  private persist(group: LookupIndexGroup, mutationKey: string, head: LookupIndexHead): void {
    const payload = canonicalOutputJSON(group, { bytes: this.codec.limits.groupBytes })
    const versions = this.records.prepare(group, head.sequence)
    const retained = {
      keys: head.retained.keys + versions.filter(version => version.previous === undefined).length,
      versions: head.retained.versions + versions.length,
      groups: head.retained.groups + 1,
      pins: head.retained.pins,
      bytes:
        head.retained.bytes +
        bytes(payload) +
        versions.reduce((sum, version) => sum + bytes(version.payload), 0)
    }
    for (const key of Object.keys(retained) as (keyof LookupIndexCapacity)[])
      if (retained[key] > this.capacity[key])
        throw new OutputProtocolError('limited', 'Lookup index retained capacity is full')
    const sequence = position(group.sequence)
    this.records.write(group.sequence, versions)
    prepareLookupStatement(
      this.database,
      'INSERT INTO output_lookup_groups VALUES (?,?,?,?,?,?)'
    ).run(
      this.namespace,
      sequence,
      mutationKey,
      payload,
      bytes(payload),
      this.records.digest('group', group.sequence, payload)
    )
    prepareLookupStatement(
      this.database,
      `UPDATE output_lookup_meta SET sequence=?,recorded_at=?,keys=?,versions=?,groups=?,payload_bytes=? WHERE namespace=?`
    ).run(
      sequence,
      position(group.recordedAt),
      retained.keys,
      retained.versions,
      retained.groups,
      retained.bytes,
      this.namespace
    )
  }

  close(): Promise<void> {
    return synchronousPromise(() => this.domain.close('Lookup index'))
  }
}
