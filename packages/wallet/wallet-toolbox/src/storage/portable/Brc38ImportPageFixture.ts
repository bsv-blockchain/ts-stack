import { promiseFromSync } from '../../utility/promiseFromSync'
import { randomUUID } from 'node:crypto'
import { semanticStageFixture } from './Brc38SemanticStageFixture'
import { brc38StageTables, type Brc38StageTable } from './Brc38SemanticStage'
import { brc38StagingBinding } from './Brc38StagingBinding'
import type { BRC38WalletData, BRC38Tables } from './index'
import type { Brc38AuthenticatedImportReader } from './KnexBrc38StagingStore'
import type { Brc38ImportJournalAdmission } from './Brc38ImportJournal'
export function pageClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
export function importPageFixture(data: BRC38WalletData = semanticStageFixture()) {
  const rows = brc38StageTables.reduce((sum, table) => sum + data.tables[table].length, 0),
    header = {
      ...pageClone(data),
      tables: Object.fromEntries(brc38StageTables.map(table => [table, []])) as unknown as BRC38Tables
    },
    expiresAt = Date.now() + 180000,
    binding = brc38StagingBinding(
      {
        archiveSha256: 'b'.repeat(64),
        identityKey: 'original-identity',
        chain: 'test',
        sourceStorageIdentityKey: 'original-source',
        targetStorageIdentityKey: 'synthetic-target',
        targetGeneration: 0
      },
      {
        maximumRows: 1000,
        maximumLogicalBytes: 1048576,
        maximumPhysicalBytes: 7340032,
        maximumRowBytes: 65536,
        maximumRowAllocationBytes: 65536,
        expiresAt
      }
    ),
    admission: Brc38ImportJournalAdmission = {
      scope: {
        importId: randomUUID(),
        bindingSha256: binding.digest,
        archiveSha256: 'b'.repeat(64),
        userId: 7
      },
      previewId: randomUUID(),
      originalLimitsJson: binding.limitsJson,
      expiresAt,
      initialDestinationSha256: 'c'.repeat(64),
      totalRows: rows + 1,
      maximumStepRows: 128,
      maximumStepBytes: 65536,
      maximumMappedIds: 1000,
      maximumJournalLogicalBytes: 516096
    }
  const calls: Array<{ table: Brc38StageTable; index: number }> = []
  let scalarReads = 0,
    pending = 0,
    maximumPending = 0
  const reader: Brc38AuthenticatedImportReader = {
    header() {
      return promiseFromSync(() => {
        return pageClone(header)
      })
    },
    count(table) {
      return promiseFromSync(() => {
        scalarReads++
        return data.tables[table].length
      })
    },
    row(table, index) {
      return promiseFromSync(() => {
        pending++
        maximumPending = Math.max(maximumPending, pending)
        calls.push({ table, index })
        try {
          const value = data.tables[table].at(index)
          return value === undefined ? undefined : pageClone(value)
        } finally {
          pending--
        }
      })
    }
  }
  return {
    reader,
    admission,
    metadata: { rows },
    data,
    header,
    calls,
    get scalarReads() {
      return scalarReads
    },
    get maximumPending() {
      return maximumPending
    }
  }
}
