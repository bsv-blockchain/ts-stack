import { closeSync, openSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import {
  canonicalOutputJSON,
  outputIdentity,
  outputString,
  OutputProtocolError,
  type OutputJSONObject
} from '@bsv/sdk'
import { synchronousPromise } from '../internal/synchronousPromise.js'
import { SQLiteTransactionDomain } from '../storage/SQLiteTransactionDomain.js'
import {
  lookupIndexDefinition,
  SQLiteLookupIndexStore,
  sqliteLookupComposition,
  type SQLiteLookupIndexOptions
} from '../lookup/SQLiteLookupIndexStore.js'
import { sqliteLookupBridge, type SQLiteLookupBridge } from '../lookup/SQLiteLookupBridge.js'
import { LookupSessionCodec } from '../lookup/LookupSessionCodec.js'
import { lookupSessionCapacity, sessionConfiguration } from '../lookup/SQLiteLookupSessionSchema.js'
import { SQLiteLookupSessionRecords } from '../lookup/SQLiteLookupSessionRecords.js'
import { SQLiteLookupDisclosure } from '../lookup/SQLiteLookupDisclosure.js'
import { bootstrapSQLiteLookupSessions } from '../lookup/SQLiteLookupSessionBootstrap.js'
import type { SQLiteLookupSessions } from '../lookup/SQLiteLookupSessions.js'
import type {
  LookupSessionAuthorization,
  LookupSessionCapacity
} from '../lookup/LookupSessionStorage.js'
import type { LookupIndexFeed } from '../lookup/LookupIndexFeed.js'
import { ProposalTransitions, type ProposalChannelRecord } from './ProposalTransitions.js'
import { ProposalPolicyRegistry, proposalChannelKey } from './ProposalPolicyRegistry.js'
import { ProposalJournalState } from './ProposalJournalState.js'
import { SQLiteProposalJournalStore, sqliteProposalBridge } from './SQLiteProposalJournalStore.js'
import type {
  ProposalJournalStorage,
  ProposalJournalLimits,
  ProposalCommitResult
} from './ProposalJournal.js'
import type { ProposalJournalSend } from './ProposalJournalSend.js'
import {
  SQLiteProposalFeedWriter,
  type ProposalFeedCommit,
  type ProposalFeedCommitResult
} from './SQLiteProposalFeedWriter.js'
import { SQLiteProposalFeedInventory } from './SQLiteProposalFeedInventory.js'
import { ProposalFeedPrivacy } from './ProposalFeedPrivacy.js'
import { assertProposalFeedCapacity } from './ProposalChannelFeedCapacity.js'
import {
  assertProposalFeedRecordBounds,
  proposalFeedValue,
  proposalFeedWireLimits,
  type ProposalFeedWireLimits
} from './ProposalChannelFeedRecords.js'
import { proposalChannelIndexKey } from './ProposalChannelHeadsQuery.js'

export interface SQLiteProposalChannelStoreOptions {
  path: string
  namespace: string
  identity: string
  lifecycle: ProposalTransitions
  policies: ProposalPolicyRegistry
  sessionCodec: LookupSessionCodec
  now(): string
  journal?: Partial<ProposalJournalLimits>
  index?: SQLiteLookupIndexOptions
  sessions?: Partial<LookupSessionCapacity>
  wire?: Partial<ProposalFeedWireLimits>
}

/**
 * Optional Node-only atomic private proposal/current-lookup/session composition.
 * One owner closes all facets. No generic index writer or raw SQL is exposed.
 * The finite append-only history preserves terminal fences and all session pins;
 * capacity exhaustion requires explicit migration, never implicit payload eviction.
 */
export class SQLiteProposalChannelStore {
  readonly journal: ProposalJournalStorage & ProposalJournalSend
  readonly feed: LookupIndexFeed
  readonly sessions: SQLiteLookupSessions
  private readonly domain: SQLiteTransactionDomain
  private readonly writer: SQLiteProposalFeedWriter
  private readonly privacy: ProposalFeedPrivacy

  private constructor(options: SQLiteProposalChannelStoreOptions, create: boolean) {
    const namespace = outputString(options.namespace),
      identity = outputIdentity(options.identity)
    if (
      typeof options.path !== 'string' ||
      options.path === ':memory:' ||
      options.path.startsWith('file:') ||
      typeof options.now !== 'function' ||
      options.now.constructor.name === 'AsyncFunction'
    )
      throw new OutputProtocolError(
        'invalid',
        'Proposal channel storage requires a file and synchronous clock'
      )
    const lifecycle = options.lifecycle.configuration()
    if (
      canonicalOutputJSON(lifecycle.policies) !== canonicalOutputJSON(options.policies.describe())
    )
      throw new OutputProtocolError(
        'context-changed',
        'Proposal channel policies differ from journal lifecycle'
      )
    const capacity = lookupSessionCapacity(options.sessions)
    const configuredWire = { maxBytes: 4194304, maxObservations: 1024, ...options.wire }
    const composition = JSON.parse(
      canonicalOutputJSON({
        format: 'proposal-channel-provider/1',
        namespace,
        identity,
        lifecycle,
        wire: configuredWire
      })
    ) as OutputJSONObject
    const definition = lookupIndexDefinition(
      namespace,
      JSON.parse(
        canonicalOutputJSON({ ...lifecycle.scope, provider: identity })
      ) as OutputJSONObject,
      options.index ?? {},
      composition
    )
    const maxEntry = Math.min(
      262144,
      definition.codec.limits.rowBytes - 512,
      Math.floor((definition.codec.limits.groupBytes - 1536) / 2)
    )
    const state = new ProposalJournalState(options.lifecycle, identity, {
      entryBytes: maxEntry,
      ...options.journal
    })
    assertProposalFeedRecordBounds(state.limits, definition.codec.limits)
    const wire = proposalFeedWireLimits(configuredWire, state.limits.entryBytes)
    if (create) {
      try {
        closeSync(openSync(options.path, 'ax', 0o600))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    } else closeSync(openSync(options.path, 'r+'))
    const db = new DatabaseSync(options.path, {
      allowExtension: false,
      enableForeignKeyConstraints: true
    })
    this.domain = new SQLiteTransactionDomain(db)
    try {
      db.exec('PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
      const journal = new SQLiteProposalJournalStore(
        this.domain,
        namespace,
        identity,
        state,
        composition,
        () => {
          this.writer.observeClock()
        }
      )
      const index = new SQLiteLookupIndexStore(this.domain, definition)
      const inventory = new SQLiteProposalFeedInventory(
        this.domain,
        namespace,
        composition,
        state.limits.channels
      )
      this.writer = new SQLiteProposalFeedWriter(
        this.domain,
        journal,
        index,
        inventory,
        options.lifecycle,
        state.limits,
        options.now.bind(options),
        (before, after) => this.privacy.publish(before, after),
        wire
      )
      const raw = index[sqliteLookupBridge]()
      const bridge: SQLiteLookupBridge = {
        ...raw,
        head: () => this.writer.currentHead(),
        recordClock: now => {
          inventory.observe(now, raw.head().recordedAt)
        },
        validateOpening: value => this.privacy.opening(value)
      }
      const records = new SQLiteLookupSessionRecords(
        bridge,
        options.sessionCodec,
        sessionConfiguration(capacity),
        capacity
      )
      this.privacy = new ProposalFeedPrivacy(
        this.domain,
        options.policies,
        new SQLiteLookupDisclosure(records, capacity),
        { ...lifecycle.scope, provider: identity },
        wire
      )
      this.sessions = this.domain.transaction(() => {
        journal[sqliteProposalBridge].initialize(create ? 'create' : 'open')
        index[sqliteLookupComposition].initialize(create)
        inventory.initialize(create)
        const sessions = bootstrapSQLiteLookupSessions(
          this.domain,
          bridge,
          options.sessionCodec,
          options.now.bind(options),
          capacity,
          create
        )
        this.privacy.initialize(create)
        this.verify(journal, index, inventory, state.limits)
        return sessions
      })
      this.journal = this.journalFacet(journal)
      this.feed = Object.freeze({
        durability: 'durable' as const,
        namespace,
        get configuration() {
          return index.configuration
        },
        head: this.writer.head.bind(this.writer),
        advanceTime: this.writer.advanceTime.bind(this.writer),
        group: index.group.bind(index),
        snapshot: index.snapshot.bind(index),
        changes: index.changes.bind(index)
      })
    } catch (error) {
      this.domain.close()
      throw error
    }
  }

  static create(options: SQLiteProposalChannelStoreOptions): SQLiteProposalChannelStore {
    return new SQLiteProposalChannelStore(options, true)
  }
  static open(options: SQLiteProposalChannelStoreOptions): SQLiteProposalChannelStore {
    return new SQLiteProposalChannelStore(options, false)
  }

  /** Trusted host batch. Replays retain original groups; only newly committed entries form this group. */
  commit(items: readonly ProposalFeedCommit[]): Promise<ProposalFeedCommitResult> {
    return this.writer.commit(items)
  }

  /** Add the mandatory profile continuity premise to the host's freshly evaluated authorization. */
  async authorizeLookup(
    policy: { id: string; digest: string },
    authorization: LookupSessionAuthorization
  ): Promise<LookupSessionAuthorization> {
    const owned = structuredClone(authorization),
      id = this.privacy.guard(policy)
    const current = await this.sessions.guardState(id)
    if (current.blocked)
      throw new OutputProtocolError('unauthorized', 'Proposal visibility is being changed')
    if (owned.guards.some(guard => guard.id === id))
      throw new OutputProtocolError(
        'invalid',
        'Host authorization duplicates the proposal visibility guard'
      )
    return {
      ...owned,
      guards: [...owned.guards, { id, revision: current.revision, failure: 'reset-required' }]
    }
  }

  close(): Promise<void> {
    return synchronousPromise(() => this.domain.close())
  }

  private journalFacet(
    store: SQLiteProposalJournalStore
  ): ProposalJournalStorage & ProposalJournalSend {
    return Object.freeze<ProposalJournalStorage & ProposalJournalSend>({
      durability: store.durability,
      namespace: store.namespace,
      identity: store.identity,
      contextRetention: store.contextRetention,
      completionReservation: store.completionReservation,
      responseEnqueue: store.responseEnqueue,
      head: store.head.bind(store),
      getLimits: store.getLimits.bind(store),
      getChannel: store.getChannel.bind(store),
      getChannelEntry: store.getChannelEntry.bind(store),
      getProposal: store.getProposal.bind(store),
      getProposalEntry: store.getProposalEntry.bind(store),
      getOperation: store.getOperation.bind(store),
      getCommit: store.getCommit.bind(store),
      read: store.read.bind(store),
      commit: async (transition, local): Promise<ProposalCommitResult> => {
        try {
          return (
            await this.writer.commit([{ transition, ...(local === undefined ? {} : { local }) }])
          ).entries[0]
        } catch (error) {
          if (
            error instanceof OutputProtocolError &&
            (error.code === 'conflict' || error.code === 'limited')
          )
            return { status: error.code, reason: error.message }
          throw error
        }
      },
      enqueueResponse: store.enqueueResponse.bind(store),
      close: this.close.bind(this)
    })
  }

  private verify(
    journal: SQLiteProposalJournalStore,
    index: SQLiteLookupIndexStore,
    inventory: SQLiteProposalFeedInventory,
    limits: ProposalJournalLimits
  ): void {
    const saved = new Map<string, ProposalChannelRecord>(),
      bridge = journal[sqliteProposalBridge]
    const head = bridge.head()
    let after = '0'
    while (after !== head.revision) {
      const entries = bridge.read(after, 256)
      if (entries.length === 0)
        throw new OutputProtocolError('unavailable', 'Proposal feed history is incomplete')
      for (const entry of entries) {
        saved.set(proposalChannelKey(entry.transition.next.proposal.body), entry.transition.next)
        after = entry.revision
      }
    }
    inventory.verify([...saved.values()])
    const indexed = index[sqliteLookupComposition]
    if (indexed.head().retained.keys !== saved.size)
      throw new OutputProtocolError('unavailable', 'Proposal feed index contains unrelated keys')
    for (const record of saved.values()) {
      const row = indexed.row(proposalChannelIndexKey(record.proposal))
      if (
        row === null ||
        canonicalOutputJSON(row.value) !== canonicalOutputJSON(proposalFeedValue(record))
      )
        throw new OutputProtocolError(
          'unavailable',
          'Proposal feed current row differs from journal state'
        )
    }
    this.writer.currentHead()
    assertProposalFeedCapacity(
      head,
      indexed.head(),
      inventory.obligations(),
      limits,
      index.configuration
    )
  }
}
