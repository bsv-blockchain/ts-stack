import { closeSync, openSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import {
  canonicalOutputJSON,
  outputString,
  outputU64,
  OutputProtocolError,
  parseOutputJSON
} from '@bsv/sdk'
import { ProposalJournalState } from './ProposalJournalState.js'
import type {
  ProposalJournalLimits,
  ProposalJournalStorage,
  ProposalCommitResult,
  ProposalJournalEntry,
  ProposalJournalHead
} from './ProposalJournal.js'
import type {
  ProposalTransitions,
  ProposalTransition,
  ProposalChannelRecord
} from './ProposalTransitions.js'

const position = (value: string): string => outputU64(value).toString(16).padStart(16, '0')
function decimal(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{16}$/.test(value))
    throw new OutputProtocolError('unavailable', 'Invalid proposal journal revision')
  return BigInt('0x' + value).toString()
}

/** Node-only WAL/FULL reference journal. The event, head, operation claim and job are one commit. */
export class SQLiteProposalJournal implements ProposalJournalStorage {
  readonly durability = 'durable' as const
  private readonly database: DatabaseSync
  private readonly state: ProposalJournalState
  private closed = false

  constructor(
    path: string,
    readonly namespace: string,
    readonly identity: string,
    lifecycle: ProposalTransitions,
    limits: Partial<ProposalJournalLimits> = {}
  ) {
    outputString(namespace)
    if (path === ':memory:' || path.startsWith('file:'))
      throw new OutputProtocolError(
        'invalid',
        'Durable proposal journal requires an ordinary file path'
      )
    this.state = new ProposalJournalState(lifecycle, identity, limits)
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
        CREATE TABLE IF NOT EXISTS proposal_journal_meta (
          namespace TEXT PRIMARY KEY, service_identity TEXT NOT NULL UNIQUE, configuration TEXT NOT NULL,
          revision TEXT NOT NULL, retained_bytes INTEGER NOT NULL, entries INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS proposal_journal_entries (
          namespace TEXT NOT NULL, revision TEXT NOT NULL, commit_key TEXT NOT NULL,
          transition TEXT NOT NULL, entry_bytes INTEGER NOT NULL,
          PRIMARY KEY(namespace, revision), UNIQUE(namespace, commit_key),
          FOREIGN KEY(namespace) REFERENCES proposal_journal_meta(namespace)
        ) STRICT;
      `)
      this.database
        .prepare('INSERT OR IGNORE INTO proposal_journal_meta VALUES (?, ?, ?, ?, 0, 0)')
        .run(namespace, this.state.serviceIdentity, this.state.configuration, position('0'))
      this.refresh()
    } catch (error) {
      this.database.close()
      throw error
    }
  }

  async head(): Promise<ProposalJournalHead> {
    return this.readState().head()
  }
  async getChannel(key: string): Promise<ProposalChannelRecord | undefined> {
    return this.readState().channel(key)
  }
  async getProposal(
    id: string
  ): Promise<{ record: ProposalChannelRecord; current: boolean } | undefined> {
    return this.readState().proposal(id)
  }
  async getOperation(
    caller: string,
    service: string,
    operationId: string
  ): Promise<ProposalChannelRecord | undefined> {
    return this.readState().operation(caller, service, operationId)
  }
  async getCommit(key: string): Promise<ProposalJournalEntry | undefined> {
    return this.readState().commit(key)
  }
  async read(after: string, maximum: number): Promise<ProposalJournalEntry[]> {
    return this.readState().read(after, maximum)
  }

  async commit(transition: ProposalTransition): Promise<ProposalCommitResult> {
    this.ready()
    const prepared = this.state.prepare(transition)
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.refresh()
      const result = this.state.plan(prepared)
      if (result.status !== 'committed') {
        this.database.exec('ROLLBACK')
        return result
      }
      const head = this.state.head()
      this.database
        .prepare('INSERT INTO proposal_journal_entries VALUES (?, ?, ?, ?, ?)')
        .run(this.namespace, position(result.revision), prepared.key, prepared.text, prepared.bytes)
      this.database
        .prepare(
          'UPDATE proposal_journal_meta SET revision=?, retained_bytes=?, entries=? WHERE namespace=?'
        )
        .run(
          position(result.revision),
          head.bytes + prepared.bytes,
          head.entries + 1,
          this.namespace
        )
      this.database.exec('COMMIT')
      this.state.apply(prepared, result.revision)
      return result
    } catch (error) {
      this.rollback()
      throw error
    }
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.database.close()
      this.closed = true
    }
  }

  private readState(): ProposalJournalState {
    this.ready()
    // The immutable prefix is pinned by its target revision; concurrent appends
    // after that revision do not change the prefix or its recorded byte counts.
    this.refresh()
    return this.state
  }

  private refresh(): void {
    const row = this.metadata()
    const target = decimal(row.revision),
      before = this.state.head()
    if (outputU64(target) < outputU64(before.revision))
      throw new OutputProtocolError('unavailable', 'Proposal journal revision moved backwards')
    const rows = this.database
      .prepare(
        'SELECT * FROM proposal_journal_entries WHERE namespace=? AND revision>? AND revision<=? ORDER BY revision'
      )
      .iterate(this.namespace, position(before.revision), position(target))
    for (const entry of rows) this.replayRow(entry)
    const after = this.state.head()
    if (
      after.revision !== target ||
      after.entries !== row.entries ||
      after.bytes !== row.retained_bytes
    )
      throw new OutputProtocolError('unavailable', 'Incomplete proposal journal prefix')
  }

  private metadata(): Record<string, unknown> {
    const row = this.database
      .prepare('SELECT * FROM proposal_journal_meta WHERE namespace=?')
      .get(this.namespace)
    if (
      row?.configuration !== this.state.configuration ||
      row.service_identity !== this.state.serviceIdentity
    )
      throw new OutputProtocolError(
        'context-changed',
        'Proposal journal identity or installed configuration changed'
      )
    if (
      !Number.isSafeInteger(row.retained_bytes) ||
      !Number.isSafeInteger(row.entries) ||
      Number(row.entries) < 0 ||
      Number(row.retained_bytes) < 0 ||
      Number(row.entries) > this.state.limits.entries ||
      Number(row.retained_bytes) > this.state.limits.bytes
    )
      throw new OutputProtocolError(
        'unavailable',
        'Invalid proposal journal metadata or retained limits'
      )
    return row
  }

  private replayRow(entry: Record<string, unknown>): void {
    if (
      typeof entry.transition !== 'string' ||
      new TextEncoder().encode(entry.transition).length !== entry.entry_bytes
    )
      throw new OutputProtocolError('unavailable', 'Invalid proposal journal entry length')
    const transition = parseOutputJSON(entry.transition, { bytes: this.state.limits.entryBytes })
    if (canonicalOutputJSON(transition) !== entry.transition)
      throw new OutputProtocolError('unavailable', 'Noncanonical proposal journal entry')
    this.state.replay({ revision: decimal(entry.revision), key: entry.commit_key, transition })
  }

  private ready(): void {
    if (this.closed) throw new OutputProtocolError('unavailable', 'Proposal journal is closed')
  }

  private rollback(): void {
    try {
      this.database.exec('ROLLBACK')
    } catch {
      /* COMMIT may already have succeeded; recover the original commit key. */
    }
  }
}
