import { synchronousPromise } from '../internal/synchronousPromise.js'
import type { DatabaseSync } from 'node:sqlite'
import { SQLiteTransactionDomain } from '../storage/SQLiteTransactionDomain.js'
import {
  canonicalOutputJSON,
  closedOutputObject,
  outputHex32,
  outputString,
  outputU64,
  OutputProtocolError,
  type OutputJSONObject
} from '@bsv/sdk'
import { ProposalJournalState, type PreparedProposalCommit } from './ProposalJournalState.js'
import { parseProposalPayload, proposalPayload } from './ProposalJournalPayload.js'
import type {
  ProposalJournalLimits,
  ProposalJournalStorage,
  ProposalCommitResult,
  ProposalJournalEntry,
  ProposalJournalHead
} from './ProposalJournal.js'
import type { ProposalTransition, ProposalChannelRecord } from './ProposalTransitions.js'
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

function responseReference(
  reference: ProposalJournalResponseReference
): ProposalJournalResponseReference {
  closedOutputObject(reference, ['kind'], ['channelKey', 'proposalId'])
  if (reference.kind === 'channel') {
    closedOutputObject(reference, ['kind', 'channelKey'])
    outputString(reference.channelKey)
  } else if (reference.kind === 'proposal') {
    closedOutputObject(reference, ['kind', 'proposalId'])
    outputHex32(reference.proposalId)
  } else if (reference.kind === 'control') closedOutputObject(reference, ['kind'])
  else throw new OutputProtocolError('invalid', 'Invalid proposal response reference')
  return reference
}
function responseCallbacks(validate: unknown, enqueue: unknown): void {
  if (
    typeof validate !== 'function' ||
    typeof enqueue !== 'function' ||
    validate.constructor.name === 'AsyncFunction' ||
    enqueue.constructor.name === 'AsyncFunction'
  )
    throw new OutputProtocolError('invalid', 'Proposal response callbacks must be synchronous')
}

export type SQLiteProposalJournalMode = 'create-or-open' | 'create' | 'open'

/**
 * Node-only WAL/FULL reference journal. The event, head, operation claim and job
 * are one commit. The constructor preserves its legacy create-or-open behavior.
 * Production startup should use open(), which never initializes absent state.
 */
export const sqliteProposalBridge = Symbol('SQLite proposal journal composition')

/** @internal Shared implementation; not a public raw-SQL port. */
export class SQLiteProposalJournalStore implements ProposalJournalStorage, ProposalJournalSend {
  readonly durability = 'durable' as const
  readonly contextRetention = 'proposal-journal-context/1' as const
  readonly completionReservation = 'proposal-journal-completion/1' as const
  readonly responseEnqueue = 'proposal-journal-send/1' as const
  private readonly database: DatabaseSync
  private state: ProposalJournalState
  private readonly workingKey = Symbol('proposal journal state')
  private readonly configuration: string

  constructor(
    private readonly domain: SQLiteTransactionDomain,
    readonly namespace: string,
    readonly identity: string,
    state: ProposalJournalState,
    composition?: OutputJSONObject,
    private readonly observeSendClock?: () => void
  ) {
    outputString(namespace)
    this.state = state
    this.database = domain.database
    this.configuration =
      composition === undefined
        ? state.configuration
        : canonicalOutputJSON({
            ...JSON.parse(state.configuration),
            format: 'proposal-current-channel/1',
            composition
          })
    domain.claim('proposal-journal:' + namespace)
  }

  /** @internal Access requires the unexported package composition symbol. */
  get [sqliteProposalBridge]() {
    return {
      initialize: (mode: SQLiteProposalJournalMode) => this.initialize(mode),
      append: (transition: ProposalTransition, local?: OutputJSONObject) =>
        this.append(transition, local),
      channel: (key: string) => this.working().channel(key),
      head: () => this.working().head(),
      channelEntry: (key: string) => this.working().channelEntry(key),
      read: (after: string, maximum: number) => this.working().read(after, maximum)
    }
  }

  /** Caller creates all participant namespaces in this same transaction. */
  private initialize(mode: SQLiteProposalJournalMode): void {
    this.domain.writing()
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
    if (
      mode === 'create' &&
      this.database
        .prepare('SELECT 1 FROM proposal_journal_meta WHERE namespace=?')
        .get(this.namespace) !== undefined
    )
      throw new OutputProtocolError('conflict', 'Proposal journal namespace already exists')
    if (mode !== 'open') {
      this.database
        .prepare('INSERT OR IGNORE INTO proposal_journal_meta VALUES (?, ?, ?, ?, 0, 0)')
        .run(this.namespace, this.state.serviceIdentity, this.configuration, position('0'))
      // A legacy database gains its capacity seal without rewriting its entries.
      // All writers must use this version before relying on held completion space.
      this.database
        .prepare(
          'INSERT OR IGNORE INTO proposal_journal_capacity SELECT namespace, ? FROM proposal_journal_meta WHERE namespace=?'
        )
        .run(canonicalOutputJSON(this.state.limits), this.namespace)
    }
    this.refresh()
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
      return this.domain.transaction(() => {
        const result = this.appendPrepared(prepared)
        if (result.status !== 'committed') this.domain.rollback(result)
        return result
      })
    })
  }

  /** Internal compound writer only. All participants commit or roll back together. */
  private append(transition: ProposalTransition, local?: OutputJSONObject): ProposalCommitResult {
    this.domain.writing()
    return this.appendPrepared(this.state.prepare(transition, local))
  }

  private appendPrepared(prepared: PreparedProposalCommit): ProposalCommitResult {
    const state = this.working()
    const result = state.plan(prepared)
    if (result.status !== 'committed') return result
    const head = state.head()
    this.database
      .prepare('INSERT INTO proposal_journal_entries VALUES (?, ?, ?, ?, ?)')
      .run(this.namespace, position(result.revision), prepared.key, prepared.text, prepared.bytes)
    this.database
      .prepare(
        'UPDATE proposal_journal_meta SET revision=?, retained_bytes=?, entries=? WHERE namespace=?'
      )
      .run(position(result.revision), head.bytes + prepared.bytes, head.entries + 1, this.namespace)
    state.apply(prepared, result.revision)
    return result
  }

  private working(): ProposalJournalState {
    return this.domain.stage(
      this.workingKey,
      () => {
        this.refresh()
        return this.state.fork()
      },
      value => {
        this.state = value
      },
      value => value.fork()
    )
  }

  private responseEntry(
    reference: ProposalJournalResponseReference
  ): ProposalJournalEntry | undefined {
    if (reference.kind === 'channel') return this.state.channelEntry(reference.channelKey)
    if (reference.kind === 'proposal') return this.state.proposalEntry(reference.proposalId)
    return undefined
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
      const reference = responseReference(candidate.reference)
      responseCallbacks(validate, enqueue)
      const bytes = new Uint8Array(candidate.bytes)
      let started = false
      try {
        const outcome = this.domain.transaction(
          () => {
            started = true
            this.refresh()
            const send = () => {
              const entry = this.responseEntry(reference)
              if (validate(entry, bytes.slice()) !== true)
                throw new OutputProtocolError(
                  'unauthorized',
                  'Proposal response is no longer authorized'
                )
              if (enqueue(bytes) !== undefined)
                throw new OutputProtocolError(
                  'invalid',
                  'Proposal response enqueue must be synchronous'
                )
            }
            if (this.observeSendClock === undefined) {
              send()
              return { ok: true as const }
            }
            this.observeSendClock()
            try {
              this.domain.savepoint(send)
              return { ok: true as const }
            } catch (error) {
              return { ok: false as const, error }
            }
          },
          { retireOnFailedRollback: true }
        )
        if (!outcome.ok) throw outcome.error
      } catch (error) {
        if (
          !started &&
          error !== null &&
          typeof error === 'object' &&
          'errcode' in error &&
          (error.errcode === 5 || error.errcode === 6)
        )
          throw new OutputProtocolError('unavailable', 'Proposal journal is busy', true)
        throw error
      }
    })
  }

  close(): Promise<void> {
    return synchronousPromise(() => this.domain.close('Proposal journal'))
  }

  private readState(): ProposalJournalState {
    this.ready()
    // Pin metadata and its immutable prefix to one synchronous read snapshot.
    // Installed replay policy must not reenter or close the physical owner.
    return this.domain.transaction(
      () => {
        this.refresh()
        return this.state
      },
      { write: false }
    )
  }

  private refresh(): void {
    const row = this.metadata()
    const target = decimal(row.revision),
      before = this.state.head()
    if (outputU64(target) < outputU64(before.revision))
      throw new OutputProtocolError('unavailable', 'Proposal journal revision moved backwards')
    let cursor = before.revision
    do {
      // Finish the native read before invoking installed application policy.
      // Every page remains inside the owner's same physical snapshot.
      const rows = this.database
        .prepare(
          'SELECT * FROM proposal_journal_entries WHERE namespace=? AND revision>? AND revision<=? ORDER BY revision LIMIT ?'
        )
        .all(this.namespace, position(cursor), position(target), 128)
      const last = rows.at(-1)
      if (last === undefined) break
      const next = decimal(last.revision)
      if (outputU64(next) <= outputU64(cursor))
        throw new OutputProtocolError('unavailable', 'Proposal journal replay did not advance')
      for (const entry of rows) this.replayRow(entry)
      cursor = next
    } while (outputU64(cursor) < outputU64(target))
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
      row?.configuration !== this.configuration ||
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
    this.domain.idle('Proposal journal')
  }
}
