import {
  canonicalOutputJSON,
  closedOutputObject,
  outputU64,
  OutputProtocolError,
  type OutputJSONObject
} from '@bsv/sdk'
import { synchronousPromise } from '../internal/synchronousPromise.js'
import { SQLiteTransactionDomain } from '../storage/SQLiteTransactionDomain.js'
import { SQLiteProposalJournalStore, sqliteProposalBridge } from './SQLiteProposalJournalStore.js'
import {
  SQLiteLookupIndexStore,
  sqliteLookupComposition
} from '../lookup/SQLiteLookupIndexStore.js'
import type { LookupIndexEdit, LookupIndexGroup } from '../lookup/LookupIndexCodec.js'
import type { LookupIndexHead, LookupIndexTimeAdvance } from '../lookup/LookupIndexStorage.js'
import type { ProposalCommitResult, ProposalJournalLimits } from './ProposalJournal.js'
import { ProposalTransitions, type ProposalTransition } from './ProposalTransitions.js'
import { proposalPayload } from './ProposalJournalPayload.js'
import { proposalChannelKey } from './ProposalPolicyRegistry.js'
import { proposalChannelIndexKey } from './ProposalChannelHeadsQuery.js'
import { SQLiteProposalFeedInventory } from './SQLiteProposalFeedInventory.js'
import { assertProposalFeedCapacity } from './ProposalChannelFeedCapacity.js'
import {
  assertProposalFeedRecordBounds,
  assertProposalFeedCommitTime,
  proposalFeedValue,
  proposalFeedEvent,
  proposalFeedWireLimits,
  assertProposalFeedWireGroup,
  type ProposalFeedWireLimits
} from './ProposalChannelFeedRecords.js'

export interface ProposalFeedCommit {
  transition: ProposalTransition
  local?: OutputJSONObject
}
export interface ProposalFeedCommitResult {
  entries: ProposalCommitResult[]
  group?: LookupIndexGroup
}

/** Internal synchronous composition. The public factory exposes restricted host facets. */
export class SQLiteProposalFeedWriter {
  private readonly journal
  private readonly index
  private readonly limits: ProposalJournalLimits
  private readonly wire: Readonly<ProposalFeedWireLimits>
  constructor(
    private readonly domain: SQLiteTransactionDomain,
    journal: SQLiteProposalJournalStore,
    private readonly storage: SQLiteLookupIndexStore,
    private readonly inventory: SQLiteProposalFeedInventory,
    private readonly lifecycle: ProposalTransitions,
    limits: ProposalJournalLimits,
    private readonly clock: () => string,
    private readonly publish: (
      previous: import('./ProposalTransitions.js').ProposalChannelRecord | undefined,
      next: import('./ProposalTransitions.js').ProposalChannelRecord
    ) => void = () => {},
    wire: Partial<ProposalFeedWireLimits> = {}
  ) {
    this.journal = journal[sqliteProposalBridge]
    this.index = storage[sqliteLookupComposition]
    this.limits = { ...limits }
    this.wire = proposalFeedWireLimits(wire, limits.entryBytes)
    assertProposalFeedRecordBounds(this.limits, storage.configuration.records)
  }

  /** Shared clock hook for the session companion, invoked only inside its owned write gate. */
  observeClock(): string {
    this.domain.writing()
    const head = this.index.head()
    const minimum =
      outputU64(head.recordedAt) > outputU64(head.retention.checkedAt)
        ? head.recordedAt
        : head.retention.checkedAt
    return this.inventory.observe(this.clock(), minimum)
  }

  private run<T>(work: (now: string) => T): T {
    const outcome = this.domain.transaction(() => {
      this.consistent()
      const now = this.observeClock()
      try {
        return { ok: true as const, value: this.domain.savepoint(() => work(now)) }
      } catch (error) {
        return { ok: false as const, error }
      }
    })
    if (!outcome.ok) throw outcome.error
    return outcome.value
  }

  private consistent(): void {
    const head = this.inventory.head()
    if (head.journal !== this.journal.head().revision || head.index !== this.index.head().sequence)
      throw new OutputProtocolError(
        'unavailable',
        'Proposal feed participants lost their atomic commit boundary'
      )
  }

  commit(items: readonly ProposalFeedCommit[]): Promise<ProposalFeedCommitResult> {
    return synchronousPromise(() => {
      if (
        !Array.isArray(items) ||
        items.length < 1 ||
        items.length > Math.min(256, this.storage.configuration.records.changes)
      )
        throw new OutputProtocolError('invalid', 'Invalid proposal feed commit group bound')
      const owned = Array.from(items, item => {
        closedOutputObject(item, ['transition'], ['local'])
        const payload = proposalPayload(
          item.transition as unknown as ProposalTransition,
          this.limits.entryBytes,
          item.local as OutputJSONObject | undefined
        )
        return {
          transition: payload.transition,
          ...(payload.local === undefined ? {} : { local: payload.local })
        }
      })
      const keys = owned.map(item => proposalChannelKey(item.transition.next.proposal.body))
      if (new Set(keys).size !== keys.length)
        throw new OutputProtocolError('invalid', 'Proposal feed group repeats a channel')
      return this.run(now => this.append(owned, now))
    })
  }

  private append(items: readonly ProposalFeedCommit[], now: string): ProposalFeedCommitResult {
    const edits: LookupIndexEdit[] = [],
      entries: ProposalCommitResult[] = []
    for (const item of items) {
      const next = item.transition.next,
        key = proposalChannelKey(next.proposal.body)
      const previous = this.journal.channel(key)
      this.inventory.check(key, previous)
      const result = this.journal.append(item.transition, item.local)
      if (result.status === 'conflict' || result.status === 'limited')
        throw new OutputProtocolError(result.status, result.reason)
      entries.push(result)
      if (result.status === 'replayed') continue
      assertProposalFeedCommitTime(previous, item.transition, now)
      const indexKey = proposalChannelIndexKey(next.proposal),
        row = this.index.row(indexKey)
      if (
        (previous === undefined) !== (row === null) ||
        (previous &&
          canonicalOutputJSON(row!.value) !== canonicalOutputJSON(proposalFeedValue(previous)))
      )
        throw new OutputProtocolError(
          'unavailable',
          'Proposal feed row differs from the committed journal head'
        )
      edits.push({ key: indexKey, previous: row?.revision ?? null, next: proposalFeedValue(next) })
      this.publish(previous, next)
      this.inventory.replace(previous, next)
    }
    assertProposalFeedWireGroup(
      edits.map(edit => edit.next!),
      this.wire
    )
    const group =
      edits.length === 0
        ? undefined
        : this.index.append({
            base: this.index.head().sequence,
            evaluatedAt: now,
            edits,
            event: proposalFeedEvent
          })
    const journal = this.journal.head(),
      index = this.index.head()
    assertProposalFeedCapacity(
      journal,
      index,
      this.inventory.obligations(),
      this.limits,
      this.storage.configuration
    )
    this.inventory.seal(journal.revision, index.sequence)
    return { entries, ...(group === undefined ? {} : { group }) }
  }

  /** Empty processed snapshots remain meaningful; private rows never use independent retention timers. */
  currentHead(): LookupIndexHead {
    this.domain.writing()
    this.consistent()
    const head = this.index.head(),
      inventory = this.inventory.head()
    return { ...head, recordedAt: inventory.clock, processedThrough: inventory.processedThrough }
  }

  head(): Promise<LookupIndexHead> {
    return synchronousPromise(() => this.domain.transaction(() => this.currentHead()))
  }

  advanceTime(at: string, maximumGroups: number): Promise<LookupIndexTimeAdvance> {
    return synchronousPromise(() => {
      outputU64(at)
      if (!Number.isSafeInteger(maximumGroups) || maximumGroups < 1 || maximumGroups > 1024)
        throw new OutputProtocolError('invalid', 'Invalid proposal timer work bound')
      return this.run(now => {
        if (outputU64(at) > outputU64(now))
          throw new OutputProtocolError(
            'invalid',
            'Proposal timer boundary is ahead of the actual clock'
          )
        const due = this.inventory.due(at, maximumGroups)
        for (const key of due) {
          const entry = this.journal.channelEntry(key)
          if (!entry)
            throw new OutputProtocolError('unavailable', 'Proposal timer lost its journal head')
          this.append(
            [{ transition: this.lifecycle.expire(entry.transition.next, now), local: entry.local }],
            now
          )
        }
        const complete = this.inventory.processed(at)
        return { head: this.currentHead(), expired: due.length, complete }
      })
    })
  }
}
