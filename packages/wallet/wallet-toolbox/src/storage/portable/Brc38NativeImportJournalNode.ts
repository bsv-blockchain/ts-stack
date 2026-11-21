import type { Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import type { Knex } from 'knex'

import {
  admissionCopy,
  loadAndReadBrc38ImportJournal,
  type Brc38ImportJournalAdmission,
  type Brc38ImportJournalReceipt
} from './Brc38ImportJournalCore'

import {
  requireBrc38ImportSqliteTransaction,
  verifyBrc38ImportJournalSchema
} from './Brc38NativeImportJournalSchemaNode'

export async function readBrc38ImportJournal(
  k: Knex.Transaction,
  selected: Brc38ImportJournalAdmission,
  workingAllocation?: Brc38WorkingAllocation
): Promise<Readonly<Brc38ImportJournalReceipt>> {
  requireBrc38ImportSqliteTransaction(k)
  const admission = admissionCopy(selected)
  await verifyBrc38ImportJournalSchema(k)
  return await loadAndReadBrc38ImportJournal(k, admission, workingAllocation)
}
