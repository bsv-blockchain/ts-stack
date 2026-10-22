import { Brc38WorkingAllocation, brc38WorkingAllocation } from './Brc38WorkingAllocation'
import type { Knex } from 'knex'
import { createHash } from 'node:crypto'
import { admissionCopy } from './Brc38ImportJournalCore'
import type { Brc38ImportJournalAdmission } from './Brc38ImportJournal'
import { readBrc38ImportJournal } from './Brc38ImportJournal'
import { readBrc38ImportJournal as readNativeJournal } from './Brc38NativeImportJournalNode'
import { KnexBrc38StagingStore, isBrc38OwnedPrivateNativeSqlite } from './KnexBrc38StagingStore'
import { isBrc38OwnedPublishedNativeSqlite } from './Brc38PublishedProfileNode'
import {
  requireBrc38StructuredProjectionRead,
  withBrc38PublishedStructuredFieldSource
} from './Brc38PublishedStructuredSourceNode'
import { brc38PrivateStructuredPolicy, type Brc38PrivateStructuredPolicy } from './Brc38PrivateStructuredPolicy'
import { Brc38StreamedNotifyProjectionNode } from './Brc38StreamedNotifyProjectionNode'
import {
  Brc38StreamedSyncMapProjectionNode,
  type Brc38StreamedSyncMapProjectionPolicy
} from './Brc38StreamedSyncMapProjectionNode'
import {
  validatedCanonicalBrc38StructuredWalletField,
  canonicalBrc38ProjectedNotify,
  type Brc38StreamedStructured
} from './Brc38StructuredJson'
import { readBrc38SqlStructuredDescriptors } from './Brc38SqlStructuredStaging'
import {
  readBrc38SqlCanonicalStructuredDescriptors,
  finishBrc38SqlCanonicalStructuredField,
  verifyBrc38SqlCanonicalStructuredSource
} from './Brc38SqlCanonicalStructuredStaging'
import {
  readBrc38SqlProjectedStructuredDescriptors,
  verifyBrc38SqlProjectedStructuredCompleteField,
  verifyBrc38SqlProjectedStructuredSource
} from './Brc38SqlProjectedStructuredStaging'
import {
  readBrc38NativePackedTextDescriptor,
  hashBrc38NativePackedTextVersion
} from './Brc38NativePackedTextFieldsNode'
import type { Brc38NativeTextRead } from './Brc38NativeBlobProtocol'
import { Brc38CleanupScope, Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import { detachBrc38PrivateChunk } from './Brc38PrivateChunkPipe'
import type { Brc38JsonStructuredField } from './Brc38JsonStructuredFields'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'

export interface Brc38StructuredNativeFieldInventoryPolicy {
  readonly sourcePolicy: Brc38PrivateStructuredPolicy
  readonly projectionPolicy: Brc38StreamedSyncMapProjectionPolicy
  readonly inspectionExpiresAt: number
  readonly maximumCombinedTemporaryBytes: number
  /** The actual original private owner, only for its private inspection. */
  readonly privateSource?: KnexBrc38StagingStore
}
function invalid(): never {
  throw new Error('Independent structured native field postimage differs')
}

/** One field's independent postimage proof, DATA only. Full all13 inventory
 * remains responsible for original envelopes/cardinalities/native keys and
 * exact source/destination/profile receipts. This always regenerates actual
 * canonical semantics and inactive operational mappings from raw bytes; a
 * stored projected hash or prior semantic result cannot supply the verdict. */
export async function inspectBrc38StructuredNativeField(
  k: Knex.Transaction,
  selectedAdmission: Readonly<Brc38ImportJournalAdmission>,
  selected: Pick<Brc38NativeTextRead, 'table' | 'field' | 'rowId'> & { readonly sourceIndex: number },
  selectedPolicy: Brc38StructuredNativeFieldInventoryPolicy
): Promise<Readonly<{ rawBytes: number; canonicalBytes: number; nativeBytes: number }>> {
  requireBrc38StructuredProjectionRead(k)
  const admission = admissionCopy(selectedAdmission),
    limits = JSON.parse(admission.originalLimitsJson) as number[],
    source = brc38PrivateStructuredPolicy(selectedPolicy.sourcePolicy),
    chosen = selectedPolicy.projectionPolicy,
    inspectionExpiresAt = selectedPolicy.inspectionExpiresAt,
    maximumCombinedTemporaryBytes = selectedPolicy.maximumCombinedTemporaryBytes,
    privateSource = selectedPolicy.privateSource,
    supplied = brc38WorkingAllocation(source.workingAllocation ?? chosen.workingAllocation)
  if (
    !Number.isSafeInteger(limits[4]) ||
    limits[4] < 1 ||
    limits[4] > 16777216 ||
    (supplied !== undefined && supplied.maximum > limits[4]) ||
    (source.workingAllocation !== undefined &&
      chosen.workingAllocation !== undefined &&
      source.workingAllocation !== chosen.workingAllocation)
  )
    invalid()
  const working = supplied ?? new Brc38WorkingAllocation(limits[4]),
    reservation = working.claim(8192),
    policy = Object.freeze({
      inspectionExpiresAt,
      maximumCombinedTemporaryBytes,
      privateSource,
      sourcePolicy: Object.freeze({ ...source, workingAllocation: working }),
      projectionPolicy: Object.freeze({ ...chosen, workingAllocation: working })
    })
  let retained = false
  try {
    return await inspectField(k, admission, selected, policy)
  } catch (error) {
    if (error instanceof Brc38StagingCleanupError) {
      retained = true
      throw new Brc38StagingCleanupError(
        [error],
        'Structured field retains its original allocation until cleanup',
        async () => {
          await error.retryCleanup()
          reservation.close()
        }
      )
    }
    throw error
  } finally {
    if (!retained) reservation.close()
  }
}
async function inspectField(
  k: Knex.Transaction,
  selectedAdmission: Readonly<Brc38ImportJournalAdmission>,
  selected: Pick<Brc38NativeTextRead, 'table' | 'field' | 'rowId'> & { readonly sourceIndex: number },
  selectedPolicy: Brc38StructuredNativeFieldInventoryPolicy
): Promise<Readonly<{ rawBytes: number; canonicalBytes: number; nativeBytes: number }>> {
  const admission = admissionCopy(selectedAdmission),
    coordinate = Object.freeze({
      table: selected.table,
      field: selected.field,
      rowId: selected.rowId,
      sourceIndex: selected.sourceIndex
    }),
    sourcePolicy = brc38PrivateStructuredPolicy(selectedPolicy.sourcePolicy),
    chosen = selectedPolicy.projectionPolicy,
    projection = Object.freeze({
      privateParent: chosen.privateParent,
      maximumTemporaryFileBytes: chosen.maximumTemporaryFileBytes,
      maximumMembers: chosen.maximumMembers,
      maximumOutputBytes: chosen.maximumOutputBytes,
      maximumScalarBytes: chosen.maximumScalarBytes,
      maximumIndexAllocationBytes: chosen.maximumIndexAllocationBytes,
      maximumGrammarAllocationBytes:
        sourcePolicy.maximumGrammarAllocationBytes === undefined
          ? chosen.maximumGrammarAllocationBytes
          : chosen.maximumGrammarAllocationBytes === undefined
            ? sourcePolicy.maximumGrammarAllocationBytes
            : Math.min(sourcePolicy.maximumGrammarAllocationBytes, chosen.maximumGrammarAllocationBytes),
      workingAllocation: sourcePolicy.workingAllocation ?? chosen.workingAllocation,
      maximumReadBytes: Math.min(sourcePolicy.maximumReadBytes ?? 65536, chosen.maximumReadBytes ?? 65536),
      expiresAt: chosen.expiresAt,
      signal: chosen.signal
    }),
    expiresAt = selectedPolicy.inspectionExpiresAt,
    combined = selectedPolicy.maximumCombinedTemporaryBytes,
    privateSource = selectedPolicy.privateSource,
    began = performance.now(),
    lifetime = expiresAt - Date.now()
  const check = (): void => {
    sourcePolicy.signal?.throwIfAborted()
    requireBrc38StructuredProjectionRead(k)
    if (Date.now() >= expiresAt || performance.now() - began >= lifetime)
      throw new SnapshotResourceLimitError('Structured field inventory inspection expired')
  }
  check()
  const limits = JSON.parse(admission.originalLimitsJson) as number[],
    actualPrivate = isBrc38OwnedPrivateNativeSqlite(k)
  if (
    !Number.isSafeInteger(coordinate.sourceIndex) ||
    coordinate.sourceIndex < 0 ||
    !Number.isSafeInteger(coordinate.rowId) ||
    !Number.isSafeInteger(expiresAt) ||
    lifetime < 1 ||
    lifetime > 3600000 ||
    !Number.isSafeInteger(combined) ||
    combined < 3145728 ||
    combined > 17179869184 ||
    projection.signal !== sourcePolicy.signal ||
    projection.privateParent !== sourcePolicy.privateIndexParent ||
    projection.expiresAt !== expiresAt ||
    !Number.isSafeInteger(projection.maximumTemporaryFileBytes) ||
    projection.maximumTemporaryFileBytes < 2097152 ||
    projection.maximumTemporaryFileBytes > combined - sourcePolicy.maximumTemporaryIndexBytes ||
    !Number.isSafeInteger(projection.maximumMembers) ||
    projection.maximumMembers < 1 ||
    projection.maximumMembers > 2000000000 ||
    !Number.isSafeInteger(projection.maximumOutputBytes) ||
    projection.maximumOutputBytes < 2 ||
    projection.maximumOutputBytes > sourcePolicy.maximumCanonicalBytes ||
    !Number.isSafeInteger(projection.maximumScalarBytes) ||
    projection.maximumScalarBytes < 2 ||
    projection.maximumScalarBytes > Math.min(admission.maximumStepBytes, limits[4]) ||
    (projection.maximumReadBytes !== undefined &&
      (!Number.isSafeInteger(projection.maximumReadBytes) ||
        projection.maximumReadBytes < 64 ||
        projection.maximumReadBytes > 65536)) ||
    (projection.maximumIndexAllocationBytes !== undefined &&
      (!Number.isSafeInteger(projection.maximumIndexAllocationBytes) ||
        projection.maximumIndexAllocationBytes < 4096 ||
        projection.maximumIndexAllocationBytes > limits[4])) ||
    (projection.maximumGrammarAllocationBytes !== undefined &&
      (!Number.isSafeInteger(projection.maximumGrammarAllocationBytes) ||
        projection.maximumGrammarAllocationBytes < 4096 ||
        projection.maximumGrammarAllocationBytes > limits[4])) ||
    (sourcePolicy.maximumGrammarAllocationBytes !== undefined &&
      sourcePolicy.maximumGrammarAllocationBytes > limits[4]) ||
    (sourcePolicy.maximumIndexAllocationBytes !== undefined && sourcePolicy.maximumIndexAllocationBytes > limits[4]) ||
    (actualPrivate && (!(privateSource instanceof KnexBrc38StagingStore) || expiresAt !== admission.expiresAt)) ||
    (!actualPrivate && privateSource !== undefined)
  )
    invalid()
  const readJournal = isBrc38OwnedPublishedNativeSqlite(k) ? readNativeJournal : readBrc38ImportJournal,
    receipt = await readJournal(k, admission, sourcePolicy.workingAllocation)
  if (receipt.state !== 'COMPLETE' || receipt.nextRow !== admission.totalRows) invalid()
  const { table, sourceIndex, field } = coordinate,
    raw = (await readBrc38SqlStructuredDescriptors(k, table, sourceIndex))[field],
    canonical = (await readBrc38SqlCanonicalStructuredDescriptors(k, table, sourceIndex))[field]
  if (raw === undefined || canonical === undefined || raw.bytes > sourcePolicy.maximumStructuredBytes) invalid()
  await verifyBrc38SqlCanonicalStructuredSource(k, table, sourceIndex, raw)
  const withSource = async <T>(
    work: (source: Readonly<Brc38StreamedStructured>) => Promise<T>,
    extra = 0
  ): Promise<T> => {
    check()
    const run = async (
      source: Readonly<Brc38StreamedStructured>,
      descriptor: Readonly<Brc38JsonStructuredField>
    ): Promise<T> => {
      if (JSON.stringify(descriptor) !== JSON.stringify(raw)) invalid()
      const value = await work(source)
      check()
      return value
    }
    if (actualPrivate)
      return await privateSource!.withPrivateStructuredFieldSource(
        k,
        table,
        sourceIndex,
        field,
        sourcePolicy,
        run,
        extra
      )
    return await withBrc38PublishedStructuredFieldSource(
      k,
      table,
      sourceIndex,
      field,
      { ...sourcePolicy, expiresAt, maximumCombinedTemporaryBytes: combined },
      run,
      extra
    )
  }
  const width = projection.maximumReadBytes
  const content = async (work: () => Promise<unknown>): Promise<void> => {
    const scratch = sourcePolicy.workingAllocation?.claim(2048 + 8 * (width ?? 65536))
    try {
      await work()
      check()
    } finally {
      scratch?.close()
    }
  }
  const hashOutput = async (
    output: AsyncIterable<Uint8Array>
  ): Promise<Readonly<{ bytes: number; sha256: string }>> => {
    const digest = createHash('sha256')
    let bytes = 0
    for await (const supplied of output) {
      check()
      const scratch = sourcePolicy.workingAllocation?.claim(512 + 2 * supplied.byteLength)
      let value: Uint8Array | undefined
      try {
        value = detachBrc38PrivateChunk(supplied, width)
        if (value.byteLength > sourcePolicy.maximumCanonicalBytes - bytes)
          throw new SnapshotResourceLimitError('Structured inventory output exceeds its admitted allowance')
        digest.update(value)
        bytes += value.byteLength
      } finally {
        value?.fill(0)
        scratch?.close()
      }
    }
    check()
    return Object.freeze({ bytes, sha256: digest.digest('hex') })
  }
  const options = {
      maximumInputBytes: sourcePolicy.maximumStructuredBytes,
      maximumOutputBytes: sourcePolicy.maximumCanonicalBytes,
      maximumChunkBytes: width,
      maximumAllocationBytes: sourcePolicy.maximumGrammarAllocationBytes,
      workingAllocation: sourcePolicy.workingAllocation,
      signal: sourcePolicy.signal
    },
    originalCanonical = await withSource(source =>
      hashOutput(validatedCanonicalBrc38StructuredWalletField(field, source, options, `${table}[${sourceIndex}]`))
    )
  if (originalCanonical.bytes !== canonical.bytes || originalCanonical.sha256 !== canonical.sha256) invalid()
  await content(() =>
    finishBrc38SqlCanonicalStructuredField(k, table, sourceIndex, canonical, check, sourcePolicy.maximumReadBytes)
  )
  let expected = originalCanonical
  if (field === 'notify' || field === 'syncMap') {
    expected = await withSource(async source => {
      const ids =
        field === 'notify'
          ? await Brc38StreamedNotifyProjectionNode.prepare(k, admission.scope, source, projection)
          : await Brc38StreamedSyncMapProjectionNode.prepare(k, admission.scope, source, projection)
      let failed = false,
        original: unknown
      const cleanupScope1 = new Brc38CleanupScope(async () => {
        try {
          await ids.close()
        } catch (error_) {
          throw new Brc38StagingCleanupError(
            failed ? [original, error_] : [error_],
            'Structured inventory retains projection cleanup',
            () => ids.close()
          )
        }
      })
      try {
        return await withSource(
          assembly =>
            hashOutput(
              field === 'notify'
                ? canonicalBrc38ProjectedNotify(assembly, options, `${table}[${sourceIndex}]`, ids)
                : (ids as Brc38StreamedSyncMapProjectionNode).chunks(width, assembly)
            ),
          projection.maximumTemporaryFileBytes
        )
      } catch (cause) {
        failed = true
        original = cause
        {
          await cleanupScope1.close()
          throw cause
        }
      } finally {
        await cleanupScope1.close()
      }
    }, projection.maximumTemporaryFileBytes)
    const persisted = (await readBrc38SqlProjectedStructuredDescriptors(k, table, sourceIndex))[field]
    if (persisted === undefined || persisted.bytes !== expected.bytes || persisted.sha256 !== expected.sha256) invalid()
    await verifyBrc38SqlProjectedStructuredSource(k, table, sourceIndex, raw)
    await content(() =>
      verifyBrc38SqlProjectedStructuredCompleteField(
        k,
        table,
        sourceIndex,
        persisted,
        check,
        sourcePolicy.maximumReadBytes
      )
    )
  }
  const postimage = await readBrc38NativePackedTextDescriptor(k, coordinate)
  if (
    postimage === undefined ||
    postimage.bytes !== expected.bytes ||
    postimage.sha256 !== expected.sha256 ||
    (await hashBrc38NativePackedTextVersion(
      k,
      postimage.sha256,
      postimage.bytes,
      check,
      width,
      sourcePolicy.workingAllocation
    )) !== expected.sha256
  )
    invalid()
  check()
  if (
    JSON.stringify(await readJournal(k, admission, sourcePolicy.workingAllocation)) !== JSON.stringify(receipt) ||
    JSON.stringify((await readBrc38SqlStructuredDescriptors(k, table, sourceIndex))[field]) !== JSON.stringify(raw) ||
    JSON.stringify(await readBrc38NativePackedTextDescriptor(k, coordinate)) !== JSON.stringify(postimage)
  )
    invalid()
  return Object.freeze({ rawBytes: raw.bytes, canonicalBytes: canonical.bytes, nativeBytes: postimage.bytes })
}
