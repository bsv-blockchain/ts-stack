import { synchronousPromise } from '../internal/synchronousPromise.js'
import { DatabaseSync } from 'node:sqlite'
import { closeSync, openSync } from 'node:fs'
import {
  outputString,
  outputU64,
  OutputProtocolError,
  canonicalOutputJSON,
  type OutputJSONObject
} from '@bsv/sdk'
import type { CommitResult, Mutation } from '../ports.js'
import {
  checkJournalRead,
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

// Fixed-width hexadecimal TEXT ordering preserves the entire unsigned U64 range;
// SQLite INTEGER is signed and JavaScript number would lose precision.
const position = (decimal: string): string => outputU64(decimal).toString(16).padStart(16, '0')
const decimal = (hex: unknown): string => {
  if (typeof hex !== 'string' || !/^[0-9a-f]{16}$/.test(hex))
    throw new OutputProtocolError('unavailable', 'Corrupt journal position')
  return BigInt('0x' + hex).toString()
}
type Row = Record<string, unknown>

/**
 * Node-only durable adapter. WAL plus synchronous=FULL makes receipt and cursor
 * commits survive process restart. Back up the database through SQLite's online
 * backup API, never by copying the main file while its WAL is live.
 */
export class SQLiteJournal implements JournalStorage {
  readonly durability = 'durable' as const
  private readonly database: DatabaseSync
  private readonly limits: JournalLimits
  private closed = false

  constructor(
    path: string,
    readonly namespace: string,
    limits: Partial<JournalLimits> = {}
  ) {
    outputString(namespace)
    if (path === ':memory:' || path.startsWith('file:'))
      throw new OutputProtocolError('invalid', 'Durable journal requires an ordinary file path')
    this.limits = journalLimits(limits)
    // A newly created private journal is owner-only; never widen existing access.
    try {
      closeSync(openSync(path, 'ax', 0o600))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    this.database = new DatabaseSync(path, {
      enableForeignKeyConstraints: true,
      allowExtension: false
    })
    try {
      this.database.exec(
        'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;'
      )
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS output_journal_meta (
          namespace TEXT PRIMARY KEY, format INTEGER NOT NULL,
          received TEXT NOT NULL, accepted TEXT NOT NULL,
          retained_bytes INTEGER NOT NULL, entries INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS output_journal_entries (
          namespace TEXT NOT NULL, received TEXT NOT NULL, accepted TEXT NOT NULL,
          mutation_key TEXT NOT NULL, body TEXT NOT NULL, body_bytes INTEGER NOT NULL,
          PRIMARY KEY(namespace, received), UNIQUE(namespace, mutation_key),
          FOREIGN KEY(namespace) REFERENCES output_journal_meta(namespace)
        ) STRICT;
      `)
      this.database
        .prepare('INSERT OR IGNORE INTO output_journal_meta VALUES (?, 1, ?, ?, 0, 0)')
        .run(namespace, position('0'), position('0'))
      this.currentHead()
    } catch (error) {
      this.database.close()
      throw error
    }
  }
  private ready(): void {
    if (this.closed) throw new OutputProtocolError('unavailable', 'Journal is closed')
  }
  private currentHead(): JournalHead {
    const row = this.database
      .prepare('SELECT * FROM output_journal_meta WHERE namespace=?')
      .get(this.namespace) as Row | undefined
    if (
      row?.format !== 1 ||
      !Number.isSafeInteger(row.retained_bytes) ||
      !Number.isSafeInteger(row.entries) ||
      Number(row.retained_bytes) < 0 ||
      Number(row.entries) < 0
    )
      throw new OutputProtocolError('unavailable', 'Unsupported or corrupt journal metadata')
    return {
      received: decimal(row.received),
      accepted: decimal(row.accepted),
      bytes: Number(row.retained_bytes),
      entries: Number(row.entries)
    }
  }
  private entry(row: Row): JournalEntry {
    if (typeof row.body !== 'string' || typeof row.mutation_key !== 'string')
      throw new OutputProtocolError('unavailable', 'Corrupt journal entry')
    return {
      key: row.mutation_key,
      ...parseJournalPayload(row.body, this.limits.entryBytes),
      revision: { received: decimal(row.received), accepted: decimal(row.accepted) }
    }
  }
  head(): Promise<JournalHead> {
    return synchronousPromise(() => {
      this.ready()
      return this.currentHead()
    })
  }
  getMutation(key: string): Promise<MutationLookup> {
    return synchronousPromise(() => {
      this.ready()
      const row = this.database
        .prepare('SELECT * FROM output_journal_entries WHERE namespace=? AND mutation_key=?')
        .get(this.namespace, key) as Row | undefined
      return row ? { status: 'committed', entry: this.entry(row) } : { status: 'absent' }
    })
  }
  append(
    expectedReceived: string,
    mutation: Mutation,
    local?: OutputJSONObject
  ): Promise<CommitResult> {
    return synchronousPromise(() => {
      this.ready()
      const body = journalPayload(mutation, this.limits, local)
      this.database.exec('BEGIN IMMEDIATE')
      try {
        const saved = this.database
          .prepare('SELECT * FROM output_journal_entries WHERE namespace=? AND mutation_key=?')
          .get(this.namespace, mutation.key) as Row | undefined
        if (saved) {
          const result: CommitResult =
            canonicalOutputJSON(this.entry(saved).body) === body.bodyText
              ? { status: 'replayed', revision: this.entry(saved).revision }
              : { status: 'equivocation', reason: 'Mutation key reused with different body' }
          this.database.exec('ROLLBACK')
          return result
        }
        const head = this.currentHead()
        const result = planAppend(head, expectedReceived, mutation, body.bytes, this.limits)
        if (result.status !== 'committed') {
          this.database.exec('ROLLBACK')
          return result
        }
        const received = position(result.revision.received),
          accepted = position(result.revision.accepted)
        this.database
          .prepare('INSERT INTO output_journal_entries VALUES (?, ?, ?, ?, ?, ?)')
          .run(this.namespace, received, accepted, mutation.key, body.text, body.bytes)
        this.database
          .prepare(
            'UPDATE output_journal_meta SET received=?, accepted=?, retained_bytes=?, entries=? WHERE namespace=?'
          )
          .run(received, accepted, head.bytes + body.bytes, head.entries + 1, this.namespace)
        this.database.exec('COMMIT')
        return result
      } catch (error) {
        // COMMIT may have succeeded before an I/O error was surfaced. The caller
        // resolves uncertainty by getMutation, never by assuming this rollback won.
        try {
          this.database.exec('ROLLBACK')
        } catch {
          /* transaction may already be committed */
        }
        throw error
      }
    })
  }
  read(afterReceived: string, maximumEntries: number): Promise<JournalEntry[]> {
    return synchronousPromise(() => {
      this.ready()
      checkJournalRead(afterReceived, maximumEntries)
      const rows = this.database
        .prepare(
          'SELECT * FROM output_journal_entries WHERE namespace=? AND received>? ORDER BY received LIMIT ?'
        )
        .iterate(this.namespace, position(afterReceived), maximumEntries)
      const result: JournalEntry[] = []
      let bytes = 0
      for (const row of rows) {
        if (result.length > 0 && bytes + Number(row.body_bytes) > this.limits.entryBytes) break
        bytes += Number(row.body_bytes)
        result.push(this.entry(row))
      }
      return result
    })
  }
  close(): Promise<void> {
    return synchronousPromise(() => {
      if (!this.closed) {
        this.database.close()
        this.closed = true
      }
    })
  }
}
