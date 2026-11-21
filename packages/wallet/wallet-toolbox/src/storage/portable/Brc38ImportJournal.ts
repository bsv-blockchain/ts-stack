import type { Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import type { Knex } from 'knex'

import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'

import { requireBrc38ImportSqliteTransaction, verifyBrc38ImportJournalSchema } from './Brc38ImportJournalSchema'

import {
  Brc38ImportJournalAdmission,
  Brc38ImportJournalStep,
  Brc38ImportJournalReceipt,
  StoredReceipt,
  isSha,
  invalid,
  digest,
  boundedJson,
  admissionCopy,
  stepCopy,
  decodeReceipt,
  load,
  read,
  mappingCapacity,
  validateMappingCharge,
  loadAndReadBrc38ImportJournal
} from './Brc38ImportJournalCore'

export type {
  Brc38ImportJournalAdmission,
  Brc38ImportJournalStep,
  Brc38ImportJournalReceipt
} from './Brc38ImportJournalCore'

async function lock(k: Knex.Transaction, admission: Brc38ImportJournalAdmission): Promise<void> {
  requireBrc38ImportSqliteTransaction(k)
  await verifyBrc38ImportJournalSchema(k)
  // A real SQLite write statement takes writer ownership even for a missing row.
  await k('brc38_import_journal')
    .where({ importId: admission.scope.importId })
    .update({ receiptSha256: k.ref('receiptSha256') })
}

function live(admission: Brc38ImportJournalAdmission): void {
  if (Date.now() >= admission.expiresAt) throw new Error('Private import original admission expired')
}

async function save(
  k: Knex.Transaction,
  admission: Brc38ImportJournalAdmission,
  previous: StoredReceipt,
  receipt: Brc38ImportJournalReceipt
): Promise<void> {
  const receiptJson = boundedJson(receipt)
  decodeReceipt(receiptJson, admission)
  await verifyBrc38ImportJournalSchema(k)
  const charged = await load(k, admission)
  if (charged === undefined) invalid()
  validateMappingCharge(charged, admission, receipt.mappedIds)
  if (
    (await k('brc38_import_journal')
      .where({
        importId: admission.scope.importId,
        mappedIds: receipt.mappedIds,
        cleanupAllowed: 0,
        admissionJson: previous.admissionJson,
        receiptJson: previous.receiptJson,
        admissionSha256: previous.admissionSha256,
        receiptSha256: previous.receiptSha256
      })
      .update({ receiptJson, receiptSha256: digest(receiptJson) })) !== 1
  )
    invalid()
}

export async function prepareBrc38ImportJournal(
  k: Knex.Transaction,
  selected: Brc38ImportJournalAdmission,
  actualDestinationSha256: string,
  validateInitial?: () => Promise<void>
): Promise<Readonly<Brc38ImportJournalReceipt>> {
  requireBrc38ImportSqliteTransaction(k)
  const admission = admissionCopy(selected)
  live(admission)
  if (!isSha(actualDestinationSha256)) invalid()
  await lock(k, admission)
  const existing = await load(k, admission)
  if (existing !== undefined) {
    const receipt = read(existing, admission)
    if (receipt.state === 'EXPIRED' || receipt.destinationSha256 !== actualDestinationSha256) invalid()
    return receipt
  }
  if (actualDestinationSha256 !== admission.initialDestinationSha256) invalid()
  await validateInitial?.()
  const receipt: Brc38ImportJournalReceipt = Object.freeze({
    protocol: 'brc38-destination-import/v1',
    state: admission.totalRows === 0 ? 'COMPLETE' : 'PREPARED',
    sequence: 0,
    nextRow: 0,
    mappedIds: 0,
    logicalBytes: 4096,
    destinationSha256: actualDestinationSha256,
    lastStep: null
  })
  const admissionJson = boundedJson(admission),
    receiptJson = boundedJson(receipt)
  await k('brc38_import_journal').insert({
    importId: admission.scope.importId,
    bindingSha256: admission.scope.bindingSha256,
    archiveSha256: admission.scope.archiveSha256,
    userId: admission.scope.userId,
    mappedIds: 0,
    maximumMappedIds: mappingCapacity(admission),
    cleanupAllowed: 0,
    admissionJson,
    admissionSha256: digest(admissionJson),
    receiptJson,
    receiptSha256: digest(receiptJson)
  })
  live(admission)
  return receipt
}

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

export async function commitBrc38ImportJournalStep(
  k: Knex.Transaction,
  selected: Brc38ImportJournalAdmission,
  proposed: Brc38ImportJournalStep,
  actualDestinationSha256: string,
  apply: () => Promise<string>,
  signal?: AbortSignal
): Promise<Readonly<Brc38ImportJournalReceipt>> {
  requireBrc38ImportSqliteTransaction(k)
  const admission = admissionCopy(selected),
    step = stepCopy(proposed, admission)
  live(admission)
  signal?.throwIfAborted()
  await lock(k, admission)
  signal?.throwIfAborted()
  const row = await load(k, admission)
  if (row === undefined) invalid()
  const receipt = read(row, admission)
  if (receipt.state === 'EXPIRED' || receipt.destinationSha256 !== actualDestinationSha256) invalid()
  if (step.fromRow < receipt.nextRow) {
    if (JSON.stringify(step) !== JSON.stringify(receipt.lastStep)) invalid()
    return receipt
  }
  if (receipt.state === 'COMPLETE' || step.fromRow !== receipt.nextRow) invalid()
  const mappedIds = receipt.mappedIds + step.mappedIds,
    logicalBytes = 4096 + mappedIds * 512
  if (mappedIds > admission.maximumMappedIds || logicalBytes > admission.maximumJournalLogicalBytes)
    throw new SnapshotResourceLimitError('Private import destination journal quota reached')
  const destinationSha256 = await apply()
  signal?.throwIfAborted()
  live(admission)
  if (!isSha(destinationSha256)) invalid()
  const nextRow = receipt.nextRow + step.rows,
    next: Readonly<Brc38ImportJournalReceipt> = Object.freeze({
      protocol: receipt.protocol,
      state: nextRow === admission.totalRows ? 'COMPLETE' : 'COMMITTED',
      sequence: receipt.sequence + 1,
      nextRow,
      mappedIds,
      logicalBytes,
      destinationSha256,
      lastStep: step
    })
  await save(k, admission, row, next)
  signal?.throwIfAborted()
  live(admission)
  return next
}

export async function expireBrc38ImportJournal(
  k: Knex.Transaction,
  selected: Brc38ImportJournalAdmission
): Promise<Readonly<Brc38ImportJournalReceipt>> {
  requireBrc38ImportSqliteTransaction(k)
  const admission = admissionCopy(selected)
  if (Date.now() < admission.expiresAt) invalid()
  await lock(k, admission)
  const row = await load(k, admission)
  if (row === undefined) invalid()
  const receipt = read(row, admission)
  if (receipt.state === 'COMPLETE' || receipt.state === 'EXPIRED') return receipt
  const next = Object.freeze({ ...receipt, state: 'EXPIRED' as const })
  await save(k, admission, row, next)
  return next
}
