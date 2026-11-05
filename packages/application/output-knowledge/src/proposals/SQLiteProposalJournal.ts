import { closeSync, openSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { outputString, OutputProtocolError } from '@bsv/sdk'
import { ProposalJournalState } from './ProposalJournalState.js'
import {
  SQLiteProposalJournalStore,
  sqliteProposalBridge,
  type SQLiteProposalJournalMode
} from './SQLiteProposalJournalStore.js'
import { SQLiteTransactionDomain } from '../storage/SQLiteTransactionDomain.js'
import type { ProposalJournalLimits } from './ProposalJournal.js'
import type { ProposalTransitions } from './ProposalTransitions.js'
export type { SQLiteProposalJournalMode } from './SQLiteProposalJournalStore.js'

/** Node-only WAL/FULL proposal journal. Existing constructors and durable namespace formats remain valid. */
export class SQLiteProposalJournal extends SQLiteProposalJournalStore {
  constructor(
    path: string,
    namespace: string,
    identity: string,
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
    const state = new ProposalJournalState(lifecycle, identity, limits)
    if (mode === 'open') closeSync(openSync(path, 'r+'))
    else {
      try {
        closeSync(openSync(path, 'ax', 0o600))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    const database = new DatabaseSync(path, {
      enableForeignKeyConstraints: true,
      allowExtension: false
    })
    const domain = new SQLiteTransactionDomain(database)
    super(domain, namespace, identity, state)
    try {
      database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;')
      domain.transaction(() => this[sqliteProposalBridge].initialize(mode))
    } catch (error) {
      domain.close()
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
}
