import { OutputProtocolError } from '@bsv/sdk'
import type { DatabaseSync } from 'node:sqlite'

class RollbackValue {
  constructor(
    readonly owner: SQLiteTransactionDomain,
    readonly value: unknown
  ) {}
}

interface StagedValue {
  value: unknown
  publish: () => void
  fork?: () => StagedValue
}

/** Internal ownership of one physical connection; never a public SQL capability. */
export class SQLiteTransactionDomain {
  private active: 'read' | 'write' | 'publishing' | undefined
  private closed = false
  private staged = new Map<symbol, StagedValue>()
  private preparing = new Set<symbol>()
  private owners = new Set<string>()
  private parents: Map<symbol, StagedValue>[] = []
  private savepointSequence = 0
  private poisoned?: { error: unknown }

  constructor(readonly database: DatabaseSync) {}

  ready(label = 'SQLite transaction domain'): void {
    if (this.closed) throw new OutputProtocolError('unavailable', label + ' is closed')
  }

  idle(label = 'SQLite transaction domain'): void {
    this.ready(label)
    if (this.active !== undefined)
      throw new OutputProtocolError('unavailable', label + ' is reentered')
  }

  /** One cache-owning adapter for each component namespace on this connection. */
  claim(key: string): void {
    this.idle()
    if (this.owners.has(key))
      throw new OutputProtocolError('conflict', 'SQLite component already owns this namespace')
    this.owners.add(key)
  }

  reading(): void {
    this.ready()
    if (this.active !== 'read' && this.active !== 'write')
      throw new OutputProtocolError('unavailable', 'SQLite operation requires a transaction')
  }

  writing(): void {
    this.ready()
    if (this.active !== 'write')
      throw new OutputProtocolError('unavailable', 'SQLite operation requires a write transaction')
  }

  /** Callbacks are trusted synchronous storage code; they may not await or schedule effects. */
  transaction<T>(
    work: () => T,
    options: { write?: boolean; retireOnFailedRollback?: boolean } = {}
  ): T {
    this.idle()
    if (work.constructor.name === 'AsyncFunction')
      throw new OutputProtocolError('invalid', 'SQLite transaction work must be synchronous')
    this.active = options.write === false ? 'read' : 'write'
    let began = false
    let committed = false
    let committing = false
    try {
      this.database.exec(this.active === 'write' ? 'BEGIN IMMEDIATE' : 'BEGIN')
      began = true
      const result = work()
      this.synchronous(result)
      if (this.poisoned) throw this.poisoned.error
      committing = true
      this.database.exec('COMMIT')
      committed = true
      this.active = 'publishing'
      for (const value of this.staged.values()) value.publish()
      return result
    } catch (error) {
      if (began && !committed) {
        try {
          this.database.exec('ROLLBACK')
        } catch (rollbackError) {
          // A pre-commit failure cannot leave an active transaction readable.
          // Only a lost COMMIT acknowledgement with native autocommit restored
          // may keep the connection for durable-state recovery.
          if (options.retireOnFailedRollback || !committing || !this.settled()) this.retire()
          // An intentional no-op rollback cannot report success when rollback failed.
          if (error instanceof RollbackValue && error.owner === this) throw rollbackError
        }
      }
      if (committed) this.retire()
      if (error instanceof RollbackValue && error.owner === this) return error.value as T
      throw error
    } finally {
      this.staged.clear()
      this.preparing.clear()
      this.parents = []
      this.savepointSequence = 0
      this.poisoned = undefined
      this.active = undefined
    }
  }

  /** One private working copy per component and transaction, installed only after COMMIT. */
  stage<T>(key: symbol, create: () => T, publish: (value: T) => void, fork?: (value: T) => T): T {
    this.ready()
    if (this.active !== 'write')
      throw new OutputProtocolError('unavailable', 'SQLite staging requires a write transaction')
    const existing = this.staged.get(key)
    if (existing !== undefined) return existing.value as T
    if (
      create.constructor.name === 'AsyncFunction' ||
      publish.constructor.name === 'AsyncFunction' ||
      fork?.constructor.name === 'AsyncFunction'
    )
      throw new OutputProtocolError('invalid', 'SQLite state callbacks must be synchronous')
    if (this.preparing.has(key))
      throw new OutputProtocolError('unavailable', 'SQLite state construction is reentered')
    this.preparing.add(key)
    try {
      const build = (value: T): StagedValue => {
        this.synchronous(value)
        return {
          value,
          publish: () => this.synchronous(publish(value)),
          ...(fork === undefined
            ? {}
            : {
                fork: () => {
                  const copy = fork(value)
                  if (
                    copy === value &&
                    value !== null &&
                    (typeof value === 'object' || typeof value === 'function')
                  )
                    throw new OutputProtocolError(
                      'invalid',
                      'SQLite staged fork must isolate mutable state'
                    )
                  return build(copy)
                }
              })
        }
      }
      let inherited: StagedValue | undefined
      for (let index = this.parents.length - 1; index >= 0; index--) {
        inherited = this.parents[index].get(key)
        if (inherited !== undefined) break
      }
      if (inherited !== undefined && inherited.fork === undefined)
        throw new OutputProtocolError(
          'unavailable',
          'SQLite staged savepoint requires a state fork'
        )
      const entry = inherited === undefined ? build(create()) : inherited.fork!()
      this.staged.set(key, entry)
      return entry.value as T
    } finally {
      this.preparing.delete(key)
    }
  }

  /** SQL and staged caches share the same nested rollback boundary. */
  savepoint<T>(work: () => T): T {
    this.reading()
    if (this.parents.length >= 32 || this.preparing.size !== 0)
      throw new OutputProtocolError('unavailable', 'SQLite nested state scope is unavailable')
    if (work.constructor.name === 'AsyncFunction')
      throw new OutputProtocolError('invalid', 'SQLite savepoint work must be synchronous')
    const name = 'staged_domain_' + ++this.savepointSequence
    this.database.exec('SAVEPOINT ' + name)
    const parent = this.staged
    this.parents.push(parent)
    this.staged = new Map()
    try {
      const result = work()
      this.synchronous(result)
      if (this.poisoned) throw this.poisoned.error
      this.database.exec('RELEASE ' + name)
      for (const [key, value] of this.staged) parent.set(key, value)
      return result
    } catch (error) {
      try {
        this.database.exec('ROLLBACK TO ' + name + '; RELEASE ' + name)
      } catch (rollbackError) {
        this.poisoned = { error: rollbackError }
      }
      throw error
    } finally {
      this.staged = parent
      this.parents.pop()
    }
  }

  /** Preserve an adapter's no-op/conflict rollback result without committing earlier work. */
  rollback<T>(value: T): never {
    this.ready()
    if (this.active !== 'read' && this.active !== 'write')
      throw new OutputProtocolError('unavailable', 'SQLite rollback requires a transaction')
    throw new RollbackValue(this, value)
  }

  close(label = 'SQLite transaction domain'): void {
    if (this.closed) return
    this.idle(label)
    this.database.close()
    this.closed = true
  }

  private settled(): boolean {
    try {
      return this.database.isTransaction === false
    } catch {
      return false
    }
  }

  private retire(): void {
    this.closed = true
    try {
      this.database.close()
    } catch {
      // The failed send connection remains unavailable even if physical close fails.
    }
  }

  private synchronous(value: unknown): void {
    if (
      value !== null &&
      (typeof value === 'object' || typeof value === 'function') &&
      typeof (value as { then?: unknown }).then === 'function'
    )
      throw new OutputProtocolError(
        'invalid',
        'SQLite transaction work returned asynchronous state'
      )
  }
}
