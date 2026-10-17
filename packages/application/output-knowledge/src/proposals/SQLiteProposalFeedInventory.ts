import {
  canonicalOutputJSON,
  outputU64,
  OutputProtocolError,
  type OutputJSONObject
} from '@bsv/sdk'
import { SQLiteTransactionDomain } from '../storage/SQLiteTransactionDomain.js'
import { position, decimal } from '../lookup/SQLiteLookupEncoding.js'
import type { ProposalChannelRecord } from './ProposalTransitions.js'
import { proposalChannelKey } from './ProposalPolicyRegistry.js'
import { proposalChannelIndexKey } from './ProposalChannelHeadsQuery.js'
import type { ProposalFeedObligations } from './ProposalChannelFeedCapacity.js'

export interface ProposalFeedInventoryHead {
  journal: string
  index: string
  clock: string
  processedThrough: string
}

/** Internal bounded deadline/obligation inventory, always in the journal/index transaction. */
export class SQLiteProposalFeedInventory {
  private readonly configuration: string
  constructor(
    private readonly domain: SQLiteTransactionDomain,
    private readonly namespace: string,
    configuration: OutputJSONObject,
    private readonly maximumChannels: number
  ) {
    this.configuration = canonicalOutputJSON(configuration, { bytes: 65536 })
    if (!Number.isSafeInteger(maximumChannels) || maximumChannels < 1 || maximumChannels > 1024)
      throw new OutputProtocolError('invalid', 'Invalid proposal feed inventory bound')
    domain.claim('proposal-feed:' + namespace)
  }

  initialize(create: boolean): void {
    this.domain.writing()
    const db = this.domain.database
    if (create) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS proposal_feed_meta (
          namespace TEXT PRIMARY KEY, configuration TEXT NOT NULL,
          journal_revision TEXT NOT NULL, index_sequence TEXT NOT NULL,
          clock TEXT NOT NULL, processed_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS proposal_feed_channels (
          namespace TEXT NOT NULL, channel_key TEXT NOT NULL, index_key TEXT NOT NULL,
          proposal_id TEXT NOT NULL, status TEXT NOT NULL, expires_at TEXT,
          PRIMARY KEY(namespace,channel_key), UNIQUE(namespace,index_key),
          FOREIGN KEY(namespace) REFERENCES proposal_feed_meta(namespace)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS proposal_feed_due
          ON proposal_feed_channels(namespace,expires_at,channel_key) WHERE expires_at IS NOT NULL;
        CREATE INDEX IF NOT EXISTS proposal_feed_obligations
          ON proposal_feed_channels(namespace,status);
      `)
      if (db.prepare('SELECT 1 FROM proposal_feed_meta WHERE namespace=?').get(this.namespace))
        throw new OutputProtocolError('conflict', 'Proposal feed namespace already exists')
      db.prepare('INSERT INTO proposal_feed_meta VALUES (?,?,?,?,?,?)').run(
        this.namespace,
        this.configuration,
        position('0'),
        position('0'),
        position('0'),
        position('0')
      )
    }
    this.head()
  }

  head(): ProposalFeedInventoryHead {
    this.domain.reading()
    const row = this.domain.database
      .prepare(
        `SELECT
      CASE WHEN length(CAST(configuration AS BLOB))<=65536 THEN configuration END AS configuration,
      journal_revision,index_sequence,clock,processed_at FROM proposal_feed_meta WHERE namespace=?`
      )
      .get(this.namespace)
    if (row?.configuration !== this.configuration)
      throw new OutputProtocolError(
        'context-changed',
        'Proposal feed configuration is missing or changed'
      )
    const head = {
      journal: decimal(row.journal_revision),
      index: decimal(row.index_sequence),
      clock: decimal(row.clock),
      processedThrough: decimal(row.processed_at)
    }
    if (outputU64(head.processedThrough) > outputU64(head.clock))
      throw new OutputProtocolError(
        'unavailable',
        'Proposal feed timer floor exceeds its observed clock'
      )
    return head
  }

  observe(now: string, minimum: string): string {
    this.domain.writing()
    const clock = outputU64(now),
      head = this.head()
    if (clock < outputU64(head.clock) || clock < outputU64(minimum))
      throw new OutputProtocolError('context-changed', 'Proposal feed clock moved backwards')
    this.domain.database
      .prepare('UPDATE proposal_feed_meta SET clock=? WHERE namespace=?')
      .run(position(now), this.namespace)
    return clock.toString()
  }

  seal(journal: string, index: string): void {
    this.domain.writing()
    const previous = this.head()
    if (
      outputU64(journal) < outputU64(previous.journal) ||
      outputU64(index) < outputU64(previous.index)
    )
      throw new OutputProtocolError('unavailable', 'Proposal feed commit heads moved backwards')
    this.domain.database
      .prepare(
        'UPDATE proposal_feed_meta SET journal_revision=?,index_sequence=? WHERE namespace=?'
      )
      .run(position(journal), position(index), this.namespace)
  }

  obligations(): ProposalFeedObligations {
    this.domain.reading()
    const rows = this.domain.database
      .prepare(
        'SELECT status,count(*) AS n FROM proposal_feed_channels WHERE namespace=? GROUP BY status'
      )
      .all(this.namespace)
    let total = 0
    const counts: ProposalFeedObligations = { active: 0, finalizing: 0 }
    for (const row of rows) {
      if (
        ![
          'active',
          'withdrawn',
          'expired',
          'finalizing',
          'finalized',
          'finalization-failed'
        ].includes(String(row.status)) ||
        !Number.isSafeInteger(row.n) ||
        Number(row.n) < 1
      )
        throw new OutputProtocolError('unavailable', 'Invalid proposal feed inventory status/count')
      total += Number(row.n)
      if (row.status === 'active' || row.status === 'finalizing') counts[row.status] = Number(row.n)
    }
    if (total > this.maximumChannels)
      throw new OutputProtocolError('limited', 'Proposal feed channel inventory is full')
    return counts
  }

  replace(previous: ProposalChannelRecord | undefined, next: ProposalChannelRecord): void {
    this.domain.writing()
    const key = proposalChannelKey(next.proposal.body)
    this.check(key, previous)
    this.domain.database
      .prepare(
        `INSERT INTO proposal_feed_channels VALUES (?,?,?,?,?,?)
      ON CONFLICT(namespace,channel_key) DO UPDATE SET index_key=excluded.index_key,
      proposal_id=excluded.proposal_id,status=excluded.status,expires_at=excluded.expires_at`
      )
      .run(
        this.namespace,
        key,
        proposalChannelIndexKey(next.proposal),
        next.proposalId,
        next.state.status,
        next.state.status === 'active' ? position(next.proposal.body.expiresAt) : null
      )
    this.obligations()
  }

  check(key: string, record: ProposalChannelRecord | undefined): void {
    this.domain.reading()
    const row = this.domain.database
      .prepare(
        'SELECT index_key,proposal_id,status,expires_at FROM proposal_feed_channels WHERE namespace=? AND channel_key=?'
      )
      .get(this.namespace, key)
    const expiresAt =
      record?.state.status === 'active' ? position(record.proposal.body.expiresAt) : null
    if (
      record === undefined
        ? row !== undefined
        : row?.index_key !== proposalChannelIndexKey(record.proposal) ||
          row.proposal_id !== record.proposalId ||
          row.status !== record.state.status ||
          row.expires_at !== expiresAt
    )
      throw new OutputProtocolError(
        'unavailable',
        'Proposal feed inventory differs from journal state'
      )
  }

  due(at: string, maximum: number): string[] {
    this.domain.reading()
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1024)
      throw new OutputProtocolError('invalid', 'Invalid proposal timer work bound')
    return this.domain.database
      .prepare(
        `SELECT channel_key FROM proposal_feed_channels
      WHERE namespace=? AND expires_at IS NOT NULL AND expires_at<=?
      ORDER BY expires_at,channel_key LIMIT ?`
      )
      .all(this.namespace, position(at), maximum)
      .map(row => String(row.channel_key))
  }

  processed(at: string): boolean {
    this.domain.writing()
    const head = this.head()
    if (outputU64(at) > outputU64(head.clock))
      throw new OutputProtocolError('invalid', 'Proposal timer boundary exceeds its observed clock')
    if (this.due(at, 1).length !== 0) return false
    if (outputU64(at) > outputU64(head.processedThrough))
      this.domain.database
        .prepare('UPDATE proposal_feed_meta SET processed_at=? WHERE namespace=?')
        .run(position(at), this.namespace)
    return true
  }

  /** Startup only: complete bounded inventory must match the independently replayed journal. */
  verify(records: readonly ProposalChannelRecord[]): void {
    this.domain.reading()
    if (records.length > this.maximumChannels)
      throw new OutputProtocolError(
        'unavailable',
        'Proposal feed startup inventory exceeds capacity'
      )
    const keys = new Set(records.map(record => proposalChannelKey(record.proposal.body)))
    const count = this.domain.database
      .prepare('SELECT count(*) AS n FROM proposal_feed_channels WHERE namespace=?')
      .get(this.namespace)?.n
    if (keys.size !== records.length || count !== records.length)
      throw new OutputProtocolError('unavailable', 'Proposal feed startup inventory is incomplete')
    for (const record of records) this.check(proposalChannelKey(record.proposal.body), record)
    this.obligations()
  }
}
