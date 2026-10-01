import { synchronousPromise } from '../internal/synchronousPromise.js'
import { closeSync, openSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import {
  canonicalOutputJSON,
  closedOutputObject,
  outputHex32,
  outputString,
  outputU64,
  OutputProtocolError,
  type OutputJSONObject
} from '@bsv/sdk'
import { ProposalJournalState } from './ProposalJournalState.js'
import { parseProposalPayload, proposalPayload } from './ProposalJournalPayload.js'
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
import type {
  ProposalJournalSend,
  ProposalJournalResponseReference
} from './ProposalJournalSend.js'

const position = (value: string): string => outputU64(value).toString(16).padStart(16, '0')
function decimal(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{16}$/.test(value))
    throw new OutputProtocolError('unavailable', 'Invalid proposal journal revision')
  return BigInt('0x' + value).toString()
}

export type SQLiteProposalJournalMode = 'create-or-open' | 'create' | 'open'

/**
 * Node-only WAL/FULL reference journal. The event, head, operation claim and job
 * are one commit. The constructor preserves its legacy create-or-open behavior.
 * Production startup should use open(), which never initializes absent state.
 */
export class SQLiteProposalJournal implements ProposalJournalStorage, ProposalJournalSend {
  readonly durability = 'durable' as const
  readonly contextRetention = 'proposal-journal-context/1' as const
  readonly completionReservation = 'proposal-journal-completion/1' as const
  readonly responseEnqueue = 'proposal-journal-send/1' as const
  private readonly database: DatabaseSync
  private readonly state: ProposalJournalState
  private closed = false
  private sending = false

  constructor(
    path: string,
    readonly namespace: string,
    readonly identity: string,
    lifecycle: ProposalTransitions,
    limits: Partial<ProposalJournalLimits> = {},
    mode: SQLiteProposalJournalMode = 'create-or-open'
  ) {
    if (!['create-or-open', 'create', 'open'].includes(mode))
      throw new OutputProtocolError('invalid', 'Invalid proposal journal open mode')
    outputString(namespace)
    if (path === ':memory:' || path.startsWith('file:'))
      throw new OutputProtocolError(
        'invalid',
        'Durable proposal journal requires an ordinary file path'
      )
    this.state = new ProposalJournalState(lifecycle, identity, limits)
    if (mode === 'open') closeSync(openSync(path, 'r+'))
    else {
      try {
        closeSync(openSync(path, 'ax', 0o600))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    this.database = new DatabaseSync(path, {
      enableForeignKeyConstraints: true,
      allowExtension: false
    })
    try {
      this.database.exec(
        'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;'
      )
      if (mode !== 'open')
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
        CREATE TABLE IF NOT EXISTS proposal_journal_capacity (
          namespace TEXT PRIMARY KEY, limits TEXT NOT NULL,
          FOREIGN KEY(namespace) REFERENCES proposal_journal_meta(namespace)
        ) STRICT;
      `)
      this.database.exec('BEGIN IMMEDIATE')
      if (
        mode === 'create' &&
        this.database
          .prepare('SELECT 1 FROM proposal_journal_meta WHERE namespace=?')
          .get(namespace) !== undefined
      )
        throw new OutputProtocolError('conflict', 'Proposal journal namespace already exists')
      if (mode !== 'open') {
        this.database
          .prepare('INSERT OR IGNORE INTO proposal_journal_meta VALUES (?, ?, ?, ?, 0, 0)')
          .run(namespace, this.state.serviceIdentity, this.state.configuration, position('0'))
        // A legacy database gains its capacity seal without rewriting its entries.
        // All writers must use this version before relying on held completion space.
        this.database
          .prepare(
            'INSERT OR IGNORE INTO proposal_journal_capacity SELECT namespace, ? FROM proposal_journal_meta WHERE namespace=?'
          )
          .run(canonicalOutputJSON(this.state.limits), namespace)
      }
      this.refresh()
      this.database.exec('COMMIT')
    } catch (error) {
      this.rollback()
      this.database.close()
      throw error
    }
  }

  /** Deliberate new namespace installation; rejects an existing namespace. */
  static create(
    path: string,
    namespace: string,
    identity: string,
    lifecycle: ProposalTransitions,
    limits: Partial<ProposalJournalLimits> = {}
  ): SQLiteProposalJournal {
    return new SQLiteProposalJournal(path, namespace, identity, lifecycle, limits, 'create')
  }

  /** Existing sealed state only: missing files/tables/namespaces/capacity seals fail closed. */
  static open(
    path: string,
    namespace: string,
    identity: string,
    lifecycle: ProposalTransitions,
    limits: Partial<ProposalJournalLimits> = {}
  ): SQLiteProposalJournal {
    return new SQLiteProposalJournal(path, namespace, identity, lifecycle, limits, 'open')
  }

  head(): Promise<ProposalJournalHead> {
    return synchronousPromise(() => {
      return this.readState().head()
    })
  }
  getLimits(): Promise<ProposalJournalLimits> {
    return synchronousPromise(() => {
      return { ...this.readState().limits }
    })
  }
  getChannelEntry(key: string): Promise<ProposalJournalEntry | undefined> {
    return synchronousPromise(() => {
      return this.readState().channelEntry(key)
    })
  }
  getChannel(key: string): Promise<ProposalChannelRecord | undefined> {
    return synchronousPromise(() => {
      return this.readState().channel(key)
    })
  }
  getProposal(
    id: string
  ): Promise<{ record: ProposalChannelRecord; current: boolean } | undefined> {
    return synchronousPromise(() => {
      return this.readState().proposal(id)
    })
  }
  getProposalEntry(id: string): Promise<ProposalJournalEntry | undefined> {
    return synchronousPromise(() => {
      return this.readState().proposalEntry(id)
    })
  }
  getOperation(
    caller: string,
    service: string,
    operationId: string
  ): Promise<ProposalChannelRecord | undefined> {
    return synchronousPromise(() => {
      return this.readState().operation(caller, service, operationId)
    })
  }
  getCommit(key: string): Promise<ProposalJournalEntry | undefined> {
    return synchronousPromise(() => {
      return this.readState().commit(key)
    })
  }
  read(after: string, maximum: number): Promise<ProposalJournalEntry[]> {
    return synchronousPromise(() => {
      return this.readState().read(after, maximum)
    })
  }

  commit(transition: ProposalTransition, local?: OutputJSONObject): Promise<ProposalCommitResult> {
    return synchronousPromise(() => {
      this.ready()
      const prepared = this.state.prepare(transition, local)
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
          .run(
            this.namespace,
            position(result.revision),
            prepared.key,
            prepared.text,
            prepared.bytes
          )
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
    })
  }

  enqueueResponse(
    candidate: { reference: ProposalJournalResponseReference; bytes: Uint8Array },
    validate: (entry: ProposalJournalEntry | undefined, bytes: Uint8Array) => boolean,
    enqueue: (bytes: Uint8Array) => undefined
  ): Promise<void> {
    return synchronousPromise(() => {
      this.ready()
      closedOutputObject(candidate, ['reference', 'bytes'])
      if (!(candidate.bytes instanceof Uint8Array) || candidate.bytes.byteLength > 4194304)
        throw new OutputProtocolError('invalid', 'Invalid proposal response byte capacity')
      const reference = candidate.reference
      closedOutputObject(reference, ['kind'], ['channelKey', 'proposalId'])
      if (reference.kind === 'channel') {
        closedOutputObject(reference, ['kind', 'channelKey'])
        outputString(reference.channelKey)
      } else if (reference.kind === 'proposal') {
        closedOutputObject(reference, ['kind', 'proposalId'])
        outputHex32(reference.proposalId)
      } else if (reference.kind === 'control') closedOutputObject(reference, ['kind'])
      else throw new OutputProtocolError('invalid', 'Invalid proposal response reference')
      if (
        typeof validate !== 'function' ||
        typeof enqueue !== 'function' ||
        validate.constructor.name === 'AsyncFunction' ||
        enqueue.constructor.name === 'AsyncFunction'
      )
        throw new OutputProtocolError('invalid', 'Proposal response callbacks must be synchronous')
      const bytes = new Uint8Array(candidate.bytes)
      try {
        this.database.exec('BEGIN IMMEDIATE')
      } catch (error) {
        if (
          error !== null &&
          typeof error === 'object' &&
          'errcode' in error &&
          (error.errcode === 5 || error.errcode === 6)
        )
          throw new OutputProtocolError('unavailable', 'Proposal journal is busy', true)
        throw error
      }
      this.sending = true
      try {
        this.refresh()
        const entry =
          reference.kind === 'channel'
            ? this.state.channelEntry(reference.channelKey)
            : reference.kind === 'proposal'
              ? this.state.proposalEntry(reference.proposalId)
              : undefined
        if (validate(entry, bytes.slice()) !== true)
          throw new OutputProtocolError('unauthorized', 'Proposal response is no longer authorized')
        if (enqueue(bytes) !== undefined)
          throw new OutputProtocolError('invalid', 'Proposal response enqueue must be synchronous')
        this.database.exec('COMMIT')
      } catch (error) {
        try {
          this.database.exec('ROLLBACK')
        } catch {
          // After an uncertain completion, never reuse this send connection.
          // The caller separately tracks whether native enqueue already ran.
          this.closed = true
          try {
            this.database.close()
          } catch {
            // Preserve the original failure; the connection is already retired.
          }
        }
        throw error
      } finally {
        this.sending = false
      }
    })
  }

  close(): Promise<void> {
    return synchronousPromise(() => {
      if (this.sending)
        throw new OutputProtocolError('unavailable', 'Proposal journal is reentered')
      if (!this.closed) {
        this.database.close()
        this.closed = true
      }
    })
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
    const capacity = this.database
      .prepare('SELECT limits FROM proposal_journal_capacity WHERE namespace=?')
      .get(this.namespace)
    if (capacity?.limits !== canonicalOutputJSON(this.state.limits))
      throw new OutputProtocolError('context-changed', 'Proposal journal capacity limits changed')
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
    const payload = parseProposalPayload(entry.transition, this.state.limits.entryBytes)
    if (
      proposalPayload(payload.transition, this.state.limits.entryBytes, payload.local).text !==
      entry.transition
    )
      throw new OutputProtocolError('unavailable', 'Noncanonical proposal journal entry')
    this.state.replay({ revision: decimal(entry.revision), key: entry.commit_key, ...payload })
  }

  private ready(): void {
    if (this.closed) throw new OutputProtocolError('unavailable', 'Proposal journal is closed')
    if (this.sending) throw new OutputProtocolError('unavailable', 'Proposal journal is reentered')
  }

  private rollback(): void {
    try {
      this.database.exec('ROLLBACK')
    } catch {
      /* COMMIT may already have succeeded; recover the original commit key. */
    }
  }
}
