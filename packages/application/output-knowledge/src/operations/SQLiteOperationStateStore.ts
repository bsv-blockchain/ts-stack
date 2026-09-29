import { closeSync, openSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { OutputProtocolError, type OutputJSONObject } from '@bsv/sdk'
import {
  type OperationStateLimits,
  type OperationStateStore,
  type OperationStateSnapshot,
  type OperationStateResult
} from './OperationStateStore.js'
import { OperationStateCodec, type StoredOperationState } from './OperationStateCodec.js'

/** Node-only, one bounded CAS cell per local namespace; WAL with synchronous=FULL. */
export class SQLiteOperationStateStore implements OperationStateStore {
  readonly durability = 'durable' as const
  private readonly database: DatabaseSync
  private closed = false

  private constructor(
    path: string,
    readonly namespace: string,
    private readonly codec: OperationStateCodec,
    initial?: StoredOperationState
  ) {
    if (path === ':memory:' || path.startsWith('file:'))
      throw new OutputProtocolError('invalid', 'Durable operation state requires a file path')
    // Opening for recovery must not silently create a lost database.
    if (initial === undefined) closeSync(openSync(path, 'r+'))
    else {
      try {
        closeSync(openSync(path, 'ax', 0o600))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    this.database = new DatabaseSync(path, { allowExtension: false })
    try {
      this.database.exec(
        'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;'
      )
      if (initial !== undefined) {
        const first = initial
        this.database.exec(`CREATE TABLE IF NOT EXISTS output_operation_state (
          namespace TEXT PRIMARY KEY, configuration TEXT NOT NULL, initial_digest TEXT NOT NULL,
          revision TEXT NOT NULL, state TEXT NOT NULL, state_digest TEXT NOT NULL, checksum TEXT NOT NULL
        ) STRICT;`)
        this.transaction(() => {
          this.database
            .prepare('INSERT OR IGNORE INTO output_operation_state VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(
              namespace,
              first.configuration,
              first.initialDigest,
              '0',
              first.text,
              first.digest,
              first.checksum
            )
          const saved = this.stored()
          if (saved.initialDigest !== first.initialDigest)
            throw new OutputProtocolError('conflict', 'Operation initialization changed')
        })
      } else this.stored()
    } catch (error) {
      this.database.close()
      throw error
    }
  }

  /** Use only for a new local workflow identity. An exact retry preserves all existing state. */
  static create(
    path: string,
    namespace: string,
    binding: OutputJSONObject,
    initial: OutputJSONObject,
    limits: Partial<OperationStateLimits> = {}
  ): SQLiteOperationStateStore {
    const codec = new OperationStateCodec(namespace, binding, limits)
    return new SQLiteOperationStateStore(path, namespace, codec, codec.initial(initial))
  }

  /** Recover an existing namespace; absence is never interpreted as a new operation. */
  static open(
    path: string,
    namespace: string,
    binding: OutputJSONObject,
    limits: Partial<OperationStateLimits> = {}
  ): SQLiteOperationStateStore {
    return new SQLiteOperationStateStore(
      path,
      namespace,
      new OperationStateCodec(namespace, binding, limits)
    )
  }

  private ready(): void {
    if (this.closed) throw new OutputProtocolError('unavailable', 'Operation state store is closed')
  }
  get configuration(): OperationStateStore['configuration'] {
    return this.codec.configurationValue()
  }
  private stored(): StoredOperationState {
    this.ready()
    const row = this.database
      .prepare(
        `SELECT
        CASE WHEN length(CAST(configuration AS BLOB)) <= ? THEN configuration END AS configuration,
        CASE WHEN length(initial_digest) = 64 THEN initial_digest END AS initialDigest,
        CASE WHEN length(revision) <= 20 THEN revision END AS revision,
        CASE WHEN length(CAST(state AS BLOB)) <= ? THEN state END AS text,
        CASE WHEN length(state_digest) = 64 THEN state_digest END AS digest,
        CASE WHEN length(checksum) = 64 THEN checksum END AS checksum
        FROM output_operation_state WHERE namespace = ?`
      )
      .get(this.codec.limits.configurationBytes, this.codec.limits.stateBytes, this.namespace)
    if (!row) throw new OutputProtocolError('reset-required', 'Operation namespace is missing')
    for (const key of ['configuration', 'initialDigest', 'revision', 'text', 'digest', 'checksum'])
      if (typeof row[key] !== 'string')
        throw new OutputProtocolError('reset-required', 'Invalid or oversized operation storage')
    const stored = row as unknown as StoredOperationState
    this.codec.snapshot(stored)
    return stored
  }
  private transaction<T>(work: () => T): T {
    this.ready()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }
  async read(): Promise<OperationStateSnapshot> {
    return this.codec.snapshot(this.stored())
  }
  async compareAndSwap(
    expectedRevision: string,
    value: OutputJSONObject
  ): Promise<OperationStateResult> {
    this.ready()
    const encoded = this.codec.encode(value)
    return this.transaction(() => {
      const { result, next } = this.codec.plan(this.stored(), expectedRevision, encoded)
      if (next)
        this.database
          .prepare(
            'UPDATE output_operation_state SET revision = ?, state = ?, state_digest = ?, checksum = ? WHERE namespace = ?'
          )
          .run(next.revision, next.text, next.digest, next.checksum, this.namespace)
      return result
    })
  }
  async close(): Promise<void> {
    if (!this.closed) {
      this.database.close()
      this.closed = true
    }
  }
}
