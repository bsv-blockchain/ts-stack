import { utf16CodeUnitAt } from '../../utility/utf16CodeUnitAt'
import { SHA256 } from '@bsv/sdk/primitives/Hash'
import { Brc38PrivateIdbStage } from './Brc38PrivateIdbStage'
import { Brc38IdbImportJournal } from './Brc38IdbImportJournal'
import { boundedJson, digest, type Brc38ImportJournalReceipt } from './Brc38ImportJournalContract'
import { brc38ImportRowForm, brc38ImportTableOrder } from './Brc38ImportForms'
import { prepareBrc38IdbRestoreMetadata, type Brc38IdbRestoreParent } from './Brc38IdbRestoreMetadata'
import { prepareBrc38IdbRestoreHistory } from './Brc38IdbRestoreHistory'
import { prepareBrc38IdbStructuredHistory } from './Brc38IdbStructuredHistory'
import { decodePortableRow } from './Brc38PortableRows'
import { brc38Utf16Chunks } from './Brc38Utf16Chunks'
import { validatedCanonicalBrc38StructuredWalletField } from './Brc38StructuredJson'
import { chargeBrc38ImportDecodedValue } from './Brc38ImportDecodedBudget'
import type { Brc38IdbRestoreRowPolicy } from './Brc38IdbPreparedRestoreRow'
import type { Brc38StageTable } from './Brc38SemanticStage'
import type { PackedIdbField } from '../idbPackedFields'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'

function invalid(): never {
  throw new Error('Browser restored destination or original provenance differs from the current complete source')
}
function scalar(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value
}

/** Fresh full-thirteen-table row/parent/provenance/field inventory. Enclosing
 * controller must authenticate/replay the full envelope and current proofs;
 * this function never opens a writer or activates a profile. Every destination
 * range resolves CURRENT original -> native row -> content, and every field
 * is hashed to EOF. A returned summary/checksum is DATA, not a retained grant.
 * Physical global reference/orphan closure and publication remain separate. */
export async function inspectBrc38IdbRestoreInventory(
  source: Brc38PrivateIdbStage,
  journal: Brc38IdbImportJournal,
  selectedReceipt: Readonly<Brc38ImportJournalReceipt>,
  selected: Brc38IdbRestoreRowPolicy,
  expectedActiveStorage = ''
): Promise<
  Readonly<{
    rows: number
    fields: number
    unmappedHistoryIds: number
    receiptSha256: string
    sourceBindingSha256: string
  }>
> {
  const working = journal.workingAllocation,
    policy = Object.freeze({
      ...selected,
      source: Object.freeze({ ...selected.source }),
      projection: Object.freeze({ ...selected.projection })
    }),
    width = Math.min(65536, policy.projection.maximumReadBytes ?? 65536)
  if (
    working === undefined ||
    policy.projection.workingAllocation !== working ||
    working.maximum > source.limits.maximumRowAllocationBytes ||
    !Number.isSafeInteger(width) ||
    width < 64
  )
    invalid()
  const scratch = working.claim(16384 + 80 * source.limits.maximumRowBytes),
    failures = new Set<Brc38StagingCleanupError>(),
    readers = new Set<Awaited<ReturnType<Brc38PrivateIdbStage['openStructuredField']>>>(),
    projections = new Set<Awaited<ReturnType<typeof prepareBrc38IdbStructuredHistory>>>()
  const disposeStructured = async () => {
    const causes: unknown[] = []
    for (const value of projections)
      try {
        await value.close()
        projections.delete(value)
      } catch (cause) {
        causes.push(cause)
      }
    for (const value of readers)
      try {
        await value.close()
        readers.delete(value)
      } catch (cause) {
        causes.push(cause)
      }
    if (causes.length !== 0)
      throw new Brc38StagingCleanupError(
        causes,
        'Browser inventory retains actual structured readers/indexes',
        disposeStructured
      )
  }
  const cleanup = async () => {
    const causes: unknown[] = []
    try {
      await disposeStructured()
    } catch (cause) {
      causes.push(cause)
    }
    for (const value of failures)
      try {
        await value.retryCleanup()
        failures.delete(value)
      } catch (cause) {
        causes.push(cause)
      }
    if (causes.length !== 0)
      throw new Brc38StagingCleanupError(
        causes,
        'Browser inventory retains actual callbacks and original scratch',
        cleanup
      )
    scratch.close()
  }
  try {
    const receiptJson = boundedJson(selectedReceipt),
      receipt = JSON.parse(receiptJson) as Brc38ImportJournalReceipt,
      receiptSha256 = digest(receiptJson),
      metadata = await source.sealedMetadata(),
      counts = await journal.readDestinationCounts(receiptSha256)
    if (
      receipt.state !== 'COMPLETE' ||
      receipt.nextRow !== metadata.rows + 1 ||
      receipt.nextRow !== journal.admission.totalRows ||
      metadata.bindingSha256 !== journal.admission.scope.bindingSha256 ||
      metadata.binding.archiveSha256 !== journal.admission.scope.archiveSha256 ||
      metadata.originalLimitsJson !== journal.admission.originalLimitsJson ||
      counts.users !== 1 ||
      counts.originals !== receipt.nextRow
    )
      invalid()
    if (expectedActiveStorage !== '' && expectedActiveStorage !== metadata.binding.targetStorageIdentityKey) invalid()
    let mapped = 0,
      fields = 0,
      unmappedHistoryIds = 0
    for (const table of brc38ImportTableOrder) {
      if (counts.counts[table] !== metadata.counts[table]) invalid()
      if (brc38ImportRowForm(table).entity !== undefined) mapped += metadata.counts[table]
    }
    if (counts.mappings !== mapped) invalid()
    const fieldHash = async (
      table: Brc38StageTable | 'header',
      index: number,
      field: string,
      expected: Readonly<PackedIdbField>,
      original: boolean
    ) => {
      const hash = new SHA256()
      for (let offset = 0; offset < expected.bytes; offset += 65536) {
        const bytes = original
          ? await journal.readOriginalExtent(
              receiptSha256,
              table as Brc38StageTable,
              index,
              field,
              offset,
              Math.min(65536, expected.bytes - offset)
            )
          : await journal.readDestinationExtent(
              receiptSha256,
              table,
              index,
              field,
              offset,
              Math.min(65536, expected.bytes - offset)
            )
        try {
          hash.update(bytes)
        } finally {
          bytes.fill(0)
        }
      }
      if (hash.digestHex() !== expected.sha256) invalid()
      // Empty content still requires an actual current native range admission.
      if (expected.bytes === 0) {
        const bytes = original
          ? await journal.readOriginalExtent(receiptSha256, table as Brc38StageTable, index, field, 0, 0)
          : await journal.readDestinationExtent(receiptSha256, table, index, field, 0, 0)
        bytes.fill(0)
      }
    }
    const inlineField = async (
      table: Brc38StageTable | 'header',
      index: number,
      name: string,
      actual: Readonly<PackedIdbField>,
      expected: unknown
    ) => {
      const hash = new SHA256()
      if (typeof expected === 'string') {
        if (actual.kind !== 'utf16' || actual.bytes !== 2 * expected.length) invalid()
        for (let offset = 0; offset < actual.bytes; offset += 65536) {
          const bytes = new Uint8Array(Math.min(65536, actual.bytes - offset))
          try {
            for (let at = 0; at < bytes.length; at += 2) {
              const unit = utf16CodeUnitAt(expected, (offset + at) / 2)
              bytes[at] = unit & 255
              bytes[at + 1] = unit >>> 8
            }
            hash.update(bytes)
          } finally {
            bytes.fill(0)
          }
        }
      } else if (Array.isArray(expected) || expected instanceof Uint8Array) {
        if (!['array', 'typed'].includes(actual.kind) || actual.bytes !== expected.length) invalid()
        for (let offset = 0; offset < actual.bytes; offset += 65536) {
          const bytes = new Uint8Array(Math.min(65536, actual.bytes - offset))
          try {
            for (let at = 0; at < bytes.length; at++) {
              const value: unknown = expected[offset + at]
              if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 255) invalid()
              bytes[at] = value
            }
            hash.update(bytes)
          } finally {
            bytes.fill(0)
          }
        }
      } else invalid()
      if (hash.digestHex() !== actual.sha256) invalid()
      await fieldHash(table, index, name, actual, false)
      fields++
    }
    const compareSmall = async (
      table: Brc38StageTable | 'header',
      index: number,
      expected: Readonly<Record<string, unknown>>,
      streamed: ReadonlySet<string>
    ) => {
      const actual = await journal.readDestination(receiptSha256, table, index)
      try {
        const names = new Set([...Object.keys(actual.fields), ...Object.keys(actual.extents), ...Object.keys(expected)])
        for (const name of names) {
          if (streamed.has(name)) continue
          if (!Object.hasOwn(expected, name)) {
            // Retain existing provider defaults for an omitted legacy timestamp.
            if (
              !['created_at', 'updated_at'].includes(name) ||
              !(actual.fields[name] instanceof Date) ||
              !Number.isFinite((actual.fields[name] as Date).getTime())
            )
              invalid()
            continue
          }
          if (Object.hasOwn(actual.extents, name))
            await inlineField(table, index, name, actual.extents[name], expected[name])
          else if (
            scalar(actual.fields[name]) !== scalar(expected[name]) &&
            !(expected[name] === null && actual.fields[name] === undefined)
          )
            invalid()
        }
        return actual.key
      } finally {
        actual.close()
      }
    }
    const headerOriginal = await journal.readOriginal(receiptSha256, 'header', 0)
    try {
      if (headerOriginal.payload !== JSON.stringify(metadata.header) || Object.keys(headerOriginal.fields).length !== 0)
        invalid()
    } finally {
      headerOriginal.close()
    }
    const user = decodePortableRow<Record<string, unknown>>('user', metadata.header.user)
    user.userId = journal.admission.scope.userId
    user.activeStorage = expectedActiveStorage
    if ((await compareSmall('header', 0, user, new Set())) !== journal.admission.scope.userId) invalid()
    for (const table of brc38ImportTableOrder)
      for (let index = 0; index < metadata.counts[table]; index++) {
        const owned = await source.ownedStreamedRow(table, index, working)
        try {
          const row = owned.row
          if (row === undefined) invalid()
          const budget = {
              maximum: 8192 + 64 * source.limits.maximumRowBytes,
              remaining: 8192 + 64 * source.limits.maximumRowBytes,
              signal: policy.projection.signal
            },
            decoded = decodePortableRow<Record<string, unknown>>(brc38ImportRowForm(table).kind, { ...row.fields }),
            parents: Brc38IdbRestoreParent[] = [],
            form = brc38ImportRowForm(table)
          chargeBrc38ImportDecodedValue(budget, decoded)
          const requests = form.parents.flatMap(parent => {
              const incomingId = decoded[parent.field]
              if (incomingId === undefined && parent.optional) return []
              if (typeof incomingId !== 'number' || !Number.isInteger(incomingId)) invalid()
              return [{ entity: parent.entity, incomingId, required: true }]
            }),
            mappings = await journal.readMappings(receiptSha256, requests)
          try {
            for (const value of mappings.mappings) {
              if (value.localId === undefined) invalid()
              if (!parents.some(parent => parent.entity === value.entity && parent.incomingId === value.incomingId))
                parents.push({ entity: value.entity, incomingId: value.incomingId, localId: value.localId })
            }
          } finally {
            mappings.close()
          }
          const historyField = table === 'provenTxReqs' ? 'notify' : table === 'syncStates' ? 'syncMap' : undefined,
            streamedHistory =
              historyField !== undefined && Object.hasOwn(row.structured ?? {}, historyField)
                ? historyField
                : undefined,
            history =
              historyField === undefined || streamedHistory !== undefined
                ? undefined
                : await prepareBrc38IdbRestoreHistory(
                    journal,
                    receipt,
                    historyField,
                    decoded[historyField] as string,
                    policy.maximumInlineHistoryBytes,
                    policy.projection.signal
                  )
          let expected: Record<string, unknown>
          try {
            const prepared = prepareBrc38IdbRestoreMetadata(
              table,
              decoded,
              journal.admission.scope.userId,
              parents,
              budget,
              history?.projection,
              streamedHistory
            )
            expected = { ...prepared.row }
            unmappedHistoryIds += history?.projection.unmappedIds ?? 0
          } finally {
            history?.close()
          }
          const original = await journal.readOriginal(receiptSha256, table, index)
          try {
            if (
              original.payload !== JSON.stringify(row.fields) ||
              original.destinationKey === undefined ||
              Object.keys(original.fields).length !==
                Object.keys(row.binaries).length +
                  Object.keys(row.structured ?? {}).length +
                  Object.keys(row.texts ?? {}).length
            )
              invalid()
            if (form.id !== undefined) expected[form.id] = original.destinationKey
            if (table === 'syncStates') expected.syncStateId = original.destinationKey
            if (table === 'provenTxs')
              for (const name of ['txid', 'blockHash', 'merkleRoot']) {
                if (typeof expected[name] !== 'string') invalid()
                expected[name] = expected[name].toLowerCase()
              }
            const all = new Set([
              ...Object.keys(row.binaries),
              ...Object.keys(row.structured ?? {}),
              ...Object.keys(row.texts ?? {})
            ])
            const key = await compareSmall(table, index, expected, all)
            if (JSON.stringify(key) !== JSON.stringify(original.destinationKey)) invalid()
            if (form.entity !== undefined && form.id !== undefined) {
              const mappedId = await journal.readMappings(receiptSha256, [
                { entity: form.entity, incomingId: Number(row.fields[form.id]), required: true }
              ])
              try {
                if (mappedId.mappings[0].localId !== key) invalid()
              } finally {
                mappedId.close()
              }
            }
            for (const [name, descriptor] of Object.entries(row.binaries)) {
              const provenance = original.fields[name],
                actual = await journal.readDestination(receiptSha256, table, index)
              try {
                const field = actual.extents[name]
                if (
                  provenance === undefined ||
                  field === undefined ||
                  provenance.kind !== 'array' ||
                  field.kind !== 'array' ||
                  provenance.bytes !== descriptor.bytes ||
                  field.bytes !== descriptor.bytes ||
                  provenance.sha256 !== descriptor.sha256 ||
                  field.sha256 !== descriptor.sha256
                )
                  invalid()
                // Fresh full source EOF also checks the actual private chunks.
                for await (const bytes of source.readBinaryFieldChunks(table, index, descriptor)) bytes.fill(0)
                await fieldHash(table, index, name, provenance, true)
                await fieldHash(table, index, name, field, false)
                fields++
              } finally {
                actual.close()
              }
            }
            for (const name of Object.keys(row.structured ?? {})) {
              const provenance = original.fields[name],
                actual = await journal.readDestination(receiptSha256, table, index)
              try {
                const field = actual.extents[name]
                if (
                  provenance === undefined ||
                  field === undefined ||
                  provenance.kind !== 'utf16' ||
                  field.kind !== 'utf16'
                )
                  invalid()
                for (const mode of ['original', name === streamedHistory ? 'mapped' : 'canonical'] as const) {
                  const reader = await source.openStructuredField(
                    table,
                    index,
                    name,
                    policy.source,
                    working,
                    journal.admission.expiresAt
                  )
                  readers.add(reader)
                  let projection: Awaited<ReturnType<typeof prepareBrc38IdbStructuredHistory>> | undefined
                  try {
                    async function* raw() {
                      const hash = new SHA256()
                      for (let offset = 0; offset < reader.source.length; offset += width) {
                        const bytes = await reader.source.read(offset, Math.min(width, reader.source.length - offset))
                        try {
                          hash.update(bytes)
                          yield bytes
                        } finally {
                          bytes.fill(0)
                        }
                      }
                      reader.check()
                      if (hash.digestHex() !== reader.source.sha256) invalid()
                    }
                    if (mode === 'mapped')
                      projection = await prepareBrc38IdbStructuredHistory(
                        source,
                        journal,
                        receipt,
                        table as 'provenTxReqs' | 'syncStates',
                        index,
                        name as 'notify' | 'syncMap',
                        policy.source,
                        policy.projection
                      )
                    if (projection !== undefined) projections.add(projection)
                    const chunks =
                        mode === 'original'
                          ? raw()
                          : projection !== undefined
                            ? projection.chunks(width)
                            : validatedCanonicalBrc38StructuredWalletField(
                                name,
                                reader.source,
                                {
                                  maximumInputBytes: policy.source.maximumStructuredBytes,
                                  maximumOutputBytes: policy.projection.maximumOutputBytes,
                                  maximumChunkBytes: width,
                                  maximumAllocationBytes: policy.projection.maximumGrammarAllocationBytes,
                                  workingAllocation: working,
                                  signal: policy.projection.signal
                                },
                                `${table}[${index}].${name}`
                              ),
                      hash = new SHA256()
                    let bytes = 0
                    for await (const chunk of brc38Utf16Chunks(
                      chunks,
                      policy.maximumUtf16Bytes,
                      working,
                      policy.projection.signal
                    )) {
                      try {
                        hash.update(chunk)
                        bytes += chunk.length
                      } finally {
                        chunk.fill(0)
                      }
                    }
                    const expectedField = mode === 'original' ? provenance : field
                    if (bytes !== expectedField.bytes || hash.digestHex() !== expectedField.sha256) invalid()
                    await fieldHash(table, index, name, expectedField, mode === 'original')
                    if (projection !== undefined) unmappedHistoryIds += projection.unmappedIds
                  } finally {
                    await disposeStructured()
                  }
                }
                fields++
              } finally {
                actual.close()
              }
            }
            for (const [name, descriptor] of Object.entries(row.texts ?? {})) {
              const provenance = original.fields[name],
                actual = await journal.readDestination(receiptSha256, table, index)
              let allocation: ReturnType<typeof working.claim> | undefined
              try {
                allocation = working.claim(8192 + 32 * 65536)
                const field = actual.extents[name]
                if (
                  provenance === undefined ||
                  field === undefined ||
                  provenance.kind !== 'utf16' ||
                  field.kind !== 'utf16' ||
                  provenance.bytes !== field.bytes ||
                  provenance.sha256 !== field.sha256
                )
                  invalid()
                const hash = new SHA256()
                let offset = 0
                // Compare independently read CURRENT provenance and destination
                // bytes directly with the original scalar source transcoding.
                // Matching descriptor hashes alone never qualify this field.
                for await (const chunk of brc38Utf16Chunks(
                  source.readTextFieldChunks(table, index, descriptor),
                  policy.maximumUtf16Bytes,
                  working,
                  policy.projection.signal
                )) {
                  let originalBytes: Uint8Array | undefined, destinationBytes: Uint8Array | undefined
                  try {
                    if (chunk.length > field.bytes - offset) invalid()
                    originalBytes = await journal.readOriginalExtent(
                      receiptSha256,
                      table,
                      index,
                      name,
                      offset,
                      chunk.length
                    )
                    destinationBytes = await journal.readDestinationExtent(
                      receiptSha256,
                      table,
                      index,
                      name,
                      offset,
                      chunk.length
                    )
                    if (
                      originalBytes.length !== chunk.length ||
                      destinationBytes.length !== chunk.length ||
                      chunk.some((value, at) => value !== originalBytes![at] || value !== destinationBytes![at])
                    )
                      invalid()
                    hash.update(chunk)
                    offset += chunk.length
                  } finally {
                    originalBytes?.fill(0)
                    destinationBytes?.fill(0)
                    chunk.fill(0)
                  }
                }
                if (offset !== field.bytes || hash.digestHex() !== field.sha256) invalid()
                if (offset === 0) {
                  const originalBytes = await journal.readOriginalExtent(receiptSha256, table, index, name, 0, 0)
                  try {
                    if (originalBytes.length !== 0) invalid()
                  } finally {
                    originalBytes.fill(0)
                  }
                  const destinationBytes = await journal.readDestinationExtent(receiptSha256, table, index, name, 0, 0)
                  try {
                    if (destinationBytes.length !== 0) invalid()
                  } finally {
                    destinationBytes.fill(0)
                  }
                }
                fields++
              } finally {
                allocation?.close()
                actual.close()
              }
            }
          } finally {
            original.close()
          }
        } finally {
          owned.close()
        }
      }
    const final = await journal.readMappings(receiptSha256, [])
    final.close()
    return Object.freeze({
      rows: receipt.nextRow,
      fields,
      unmappedHistoryIds,
      receiptSha256,
      sourceBindingSha256: metadata.bindingSha256
    })
  } catch (cause) {
    if (cause instanceof Brc38StagingCleanupError) failures.add(cause)
    throw cause
  } finally {
    await cleanup()
  }
}
