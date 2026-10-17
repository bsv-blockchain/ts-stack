import type { StorageIdb } from '../StorageIdb'
import { getPackedIdbConnection, requirePackedIdbTransaction } from '../idbPackedConnection'
import type { PackedIdbStagedField } from '../idbPackedStaging'
import { Brc38PrivateIdbStage } from './Brc38PrivateIdbStage'
import { Brc38IdbImportJournal } from './Brc38IdbImportJournal'
import {
  boundedJson,
  digest,
  type Brc38ImportJournalReceipt,
  type Brc38ImportJournalStep
} from './Brc38ImportJournalContract'
import { brc38ImportRowForm } from './Brc38ImportForms'
import {
  chargeBrc38ImportDecodedValue,
  copyBrc38ImportDecodedValue,
  type Brc38ImportDecodedBudget
} from './Brc38ImportDecodedBudget'
import { decodePortableRow } from './Brc38PortableRows'
import { prepareBrc38IdbRestoreMetadata, type Brc38IdbRestoreParent } from './Brc38IdbRestoreMetadata'
import { prepareBrc38IdbRestoreHistory, type Brc38IdbRestoreHistory } from './Brc38IdbRestoreHistory'
import { prepareBrc38IdbRestoreBinary, type Brc38IdbRestoreBinary } from './Brc38IdbRestoreBinary'
import { prepareBrc38IdbRestoreText, type Brc38IdbRestoreText } from './Brc38IdbRestoreText'
import { inspectBrc38PrivateIdbStreamedProof, type Brc38IdbStreamedProofPolicy } from './Brc38IdbStreamedProof'
import type { Brc38PrivateIdbStructuredPolicy } from './Brc38PrivateIdbStructuredPolicy'
import type { Brc38StreamedSyncMapProjectionPolicy } from './Brc38StreamedSyncMapProjection'
import type { Brc38StageTable } from './Brc38SemanticStage'
import type { EntityTimeStamp } from '../../sdk/types'
import { brc38Utf8ByteLength } from './Brc38Utf8Length'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'

export interface Brc38IdbRestoreRowPolicy {
  readonly source: Brc38PrivateIdbStructuredPolicy
  readonly projection: Brc38StreamedSyncMapProjectionPolicy
  readonly proof: Brc38IdbStreamedProofPolicy
  readonly maximumUtf16Bytes: number
  readonly maximumInlineHistoryBytes: number
}
export interface Brc38IdbPreparedRestoreRow {
  readonly step: Readonly<Brc38ImportJournalStep>
  readonly unmappedHistoryIds: number
  /** One use. Fresh receipt/source/actual writer checks still occur. */
  commit(): Promise<Readonly<Brc38ImportJournalReceipt>>
  close(): Promise<void>
}
function invalid(): never {
  throw new Error('Browser restore row differs from its current source, mappings or isolated writer')
}

/** Private row preparation, deliberately separate from encrypted admission.
 * The enclosing controller must replay the entire original authenticated
 * envelope and semantics on EACH invocation/resume. Current map/proof/source
 * work and genuine field staging finish BEFORE the short journal writer.
 * This plan is one-use data and owned resources, not a reusable source verdict.
 * Header, full destination/provenance inventory and activation are separate. */
export async function prepareBrc38IdbRestoreRow(
  source: Brc38PrivateIdbStage,
  storage: StorageIdb,
  journal: Brc38IdbImportJournal,
  selectedCurrent: Readonly<Brc38ImportJournalReceipt>,
  table: Brc38StageTable,
  index: number,
  selected: Brc38IdbRestoreRowPolicy
): Promise<Readonly<Brc38IdbPreparedRestoreRow>> {
  const working = journal.workingAllocation,
    policy = Object.freeze({
      ...selected,
      source: Object.freeze({ ...selected.source }),
      projection: Object.freeze({ ...selected.projection }),
      proof: Object.freeze({ ...selected.proof })
    }),
    capturedReceipt = boundedJson(selectedCurrent),
    current = Object.freeze(JSON.parse(capturedReceipt) as Brc38ImportJournalReceipt),
    receiptSha256 = digest(capturedReceipt),
    expiresAt = journal.admission.expiresAt,
    deadline = performance.now() + Math.max(0, expiresAt - Date.now())
  if (
    working === undefined ||
    policy.projection.workingAllocation !== working ||
    policy.proof.workingAllocation !== working ||
    working.maximum > source.limits.maximumRowAllocationBytes ||
    expiresAt > source.limits.expiresAt ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    current.state === 'COMPLETE' ||
    current.state === 'EXPIRED' ||
    !Number.isSafeInteger(policy.maximumInlineHistoryBytes) ||
    policy.maximumInlineHistoryBytes < 1 ||
    policy.maximumInlineHistoryBytes > 65536
  )
    invalid()
  let open = true,
    consumed = false,
    active: Promise<unknown> = Promise.resolve(),
    owned: Awaited<ReturnType<Brc38PrivateIdbStage['ownedStreamedRow']>> | undefined,
    history: Brc38IdbRestoreHistory | undefined
  const binaries = new Set<Brc38IdbRestoreBinary>(),
    texts = new Set<Brc38IdbRestoreText>(),
    failed = new Set<Brc38StagingCleanupError>(),
    allowance = working.claim(8192 + 64 * source.limits.maximumRowBytes),
    budget: Brc38ImportDecodedBudget = {
      maximum: 8192 + 64 * source.limits.maximumRowBytes,
      remaining: 8192 + 64 * source.limits.maximumRowBytes,
      signal: policy.projection.signal
    }
  const check = () => {
    policy.projection.signal?.throwIfAborted()
    policy.proof.signal?.throwIfAborted()
    if (!open || Date.now() >= expiresAt || performance.now() >= deadline) invalid()
  }
  const cleanup = async (): Promise<void> => {
    open = false
    await active.catch(() => undefined)
    const failures: unknown[] = []
    for (const value of binaries)
      try {
        await value.close()
        binaries.delete(value)
      } catch (cause) {
        failures.push(cause)
      }
    for (const value of texts)
      try {
        await value.close()
        texts.delete(value)
      } catch (cause) {
        failures.push(cause)
      }
    for (const value of failed)
      try {
        await value.retryCleanup()
        failed.delete(value)
      } catch (cause) {
        failures.push(cause)
      }
    if (failures.length !== 0)
      throw new Brc38StagingCleanupError(
        failures,
        'Browser prepared row retains its actual source/content owners and original allocations',
        cleanup
      )
    history?.close()
    owned?.close()
    allowance.close()
  }
  const currentReceipt = async () => {
    const read = await journal.readMappings(receiptSha256, [])
    read.close()
    check()
  }
  try {
    check()
    await currentReceipt()
    const owner = getPackedIdbConnection(await storage.verifyDB())
    if (owner === undefined || !/^wallet-toolbox-(main|test)net-restore-v1-[0-9a-f]{32}$/.test(owner.database.name))
      invalid()
    owned = await source.ownedStreamedRow(table, index, working)
    check()
    const row = owned.row
    if (row === undefined) invalid()
    const sourceJson = JSON.stringify(row),
      originalPayload = JSON.stringify(row.fields),
      bytes = brc38Utf8ByteLength(originalPayload),
      form = brc38ImportRowForm(table),
      parents: Brc38IdbRestoreParent[] = [],
      destinationFields: Record<string, PackedIdbStagedField> = Object.create(null),
      originalFields: Record<string, PackedIdbStagedField> = Object.create(null)
    if (bytes > journal.admission.maximumStepBytes) invalid()
    chargeBrc38ImportDecodedValue(budget, row.fields)
    // The reserved allowance precedes base64/Date/inline JSON decoding. The
    // actual source contains bounded small metadata and separate large fields.
    const decoded = decodePortableRow<Record<string, unknown>>(form.kind, { ...row.fields })
    chargeBrc38ImportDecodedValue(budget, decoded)
    const requests = form.parents.flatMap(parent => {
        const incomingId = decoded[parent.field]
        if (incomingId === undefined && parent.optional === true) return []
        if (typeof incomingId !== 'number' || !Number.isInteger(incomingId)) invalid()
        return [{ entity: parent.entity, incomingId, required: true }]
      }),
      read = await journal.readMappings(receiptSha256, requests)
    try {
      for (const mapping of read.mappings) {
        if (mapping.localId === undefined) invalid()
        // Two fields may point to the same parent. Metadata consumes one exact
        // entity/incoming mapping, rather than treating duplicate requests as IDs.
        if (!parents.some(parent => parent.entity === mapping.entity && parent.incomingId === mapping.incomingId))
          parents.push({ entity: mapping.entity, incomingId: mapping.incomingId, localId: mapping.localId })
      }
    } finally {
      read.close()
    }
    const historyField = table === 'provenTxReqs' ? 'notify' : table === 'syncStates' ? 'syncMap' : undefined,
      streamedHistory =
        historyField !== undefined && Object.hasOwn(row.structured ?? {}, historyField) ? historyField : undefined
    if (historyField !== undefined && streamedHistory === undefined) {
      if (typeof decoded[historyField] !== 'string') invalid()
      history = await prepareBrc38IdbRestoreHistory(
        journal,
        current,
        historyField,
        decoded[historyField],
        policy.maximumInlineHistoryBytes,
        policy.projection.signal
      )
    }
    if (table === 'provenTxs') {
      // The controller selects the explicit streamed binary parser, including
      // small proof fields. No inline placeholder or cached proof grant.
      const proof = await inspectBrc38PrivateIdbStreamedProof(source, storage, index, policy.proof, expiresAt)
      decoded.txid = proof.txid
      decoded.blockHash = proof.blockHash
      decoded.merkleRoot = proof.merkleRoot
    }
    const prepared = prepareBrc38IdbRestoreMetadata(
      table,
      decoded,
      journal.admission.scope.userId,
      parents,
      budget,
      history?.projection,
      streamedHistory
    )
    // Normal provider date/boolean/null handling runs before the writer. This
    // is the existing provider behavior; original portable values stay separate.
    const normalized: Record<string, unknown> = await storage.validateEntityForInsert(
      copyBrc38ImportDecodedValue(prepared.row, budget) as unknown as EntityTimeStamp & Record<string, unknown>,
      undefined,
      table === 'syncStates' ? ['when'] : undefined,
      table === 'syncStates'
        ? ['init']
        : ['outputBaskets', 'outputTags', 'txLabels', 'txLabelMaps', 'outputTagMaps', 'certificates'].includes(table)
          ? ['isDeleted']
          : undefined
    )
    chargeBrc38ImportDecodedValue(budget, normalized)
    check()
    for (const name of Object.keys(row.binaries)) {
      const value = await prepareBrc38IdbRestoreBinary(
        source,
        storage,
        table,
        index,
        name,
        working,
        expiresAt,
        policy.projection.signal
      )
      binaries.add(value)
      originalFields[name] = value.staged
      destinationFields[name] = value.staged
      check()
    }
    let unmappedHistoryIds = history?.projection.unmappedIds ?? 0
    for (const name of Object.keys(row.structured ?? {})) {
      const original = await prepareBrc38IdbRestoreText(
        source,
        storage,
        journal,
        current,
        table,
        index,
        name,
        'original',
        policy.source,
        policy.projection,
        policy.maximumUtf16Bytes
      )
      texts.add(original)
      originalFields[name] = original.staged
      check()
      const value = await prepareBrc38IdbRestoreText(
        source,
        storage,
        journal,
        current,
        table,
        index,
        name,
        name === streamedHistory ? 'mapped' : 'canonical',
        policy.source,
        policy.projection,
        policy.maximumUtf16Bytes
      )
      texts.add(value)
      destinationFields[name] = value.staged
      unmappedHistoryIds += value.unmappedIds
      check()
    }
    for (const name of Object.keys(row.texts ?? {})) {
      if (Object.hasOwn(normalized, name) || Object.hasOwn(destinationFields, name)) invalid()
      const value = await prepareBrc38IdbRestoreText(
        source,
        storage,
        journal,
        current,
        table,
        index,
        name,
        'scalar',
        policy.source,
        policy.projection,
        policy.maximumUtf16Bytes
      )
      texts.add(value)
      originalFields[name] = value.staged
      destinationFields[name] = value.staged
      check()
    }
    await currentReceipt()
    const step: Brc38ImportJournalStep = Object.freeze({
      fromRow: current.nextRow,
      rows: 1,
      bytes,
      mappedIds: prepared.identity === undefined ? 0 : 1,
      pageSha256: digest(sourceJson)
    })
    return Object.freeze({
      step,
      unmappedHistoryIds,
      close: cleanup,
      commit: () => {
        check()
        if (consumed) invalid()
        consumed = true
        const operation = (async () => {
          const fresh = await source.ownedStreamedRow(table, index, working)
          try {
            check()
            if (JSON.stringify(fresh.row) !== sourceJson) invalid()
          } finally {
            fresh.close()
          }
          await currentReceipt()
          return await journal.commit(
            step,
            current.destinationSha256,
            async writer => {
              check()
              requirePackedIdbTransaction(owner.database, writer.transaction)
              // Re-admit every parent in the actual writer; prior preparation is
              // data, never authority over current map/profile/revision state.
              for (const parent of parents)
                if ((await writer.lookup(parent.entity, parent.incomingId)) !== parent.localId) invalid()
              const key = await storage.writeStagedStorageRow(
                prepared.store,
                normalized,
                destinationFields,
                'add',
                writer.transaction
              )
              check()
              if (prepared.identity !== undefined) {
                if (typeof key !== 'number' || !Number.isSafeInteger(key) || key < 1) invalid()
                await writer.map(prepared.identity.entity, prepared.identity.incomingId, key)
              }
              if (Object.keys(originalFields).length === 0) await writer.original(table, index, originalPayload, key)
              else await writer.originalStreamed(table, index, originalPayload, originalFields, key)
              check()
              // Postimage chain checksum DATA, not independent inventory or an
              // activation grant. The actual native key participates in this step.
              return digest(
                JSON.stringify([
                  'browser-restore-row/v1',
                  current.destinationSha256,
                  table,
                  index,
                  key,
                  normalized,
                  sourceJson,
                  step.pageSha256
                ])
              )
            },
            receiptSha256
          )
        })()
        active = operation
        return operation
      }
    })
  } catch (cause) {
    if (cause instanceof Brc38StagingCleanupError) failed.add(cause)
    try {
      await cleanup()
    } catch (error_) {
      throw new Brc38StagingCleanupError(
        [cause, error_],
        'Browser row preparation retains concrete cleanup owners',
        cleanup
      )
    }
    throw cause
  }
}
