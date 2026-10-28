import { createHash } from 'node:crypto'
import { decryptBrc39StreamToQuarantine, type Brc39NodeStreamOptions } from './Brc39StreamNode'
import { readBrc38JsonStream, type Brc38JsonStreamResult } from './Brc38JsonStream'
import { Brc38SemanticStage } from './Brc38SemanticStage'
import { Brc38StreamedSemanticStage, type Brc38StreamedStageStore } from './Brc38StreamedSemanticStage'
import { brc38SqlStreamedFieldSink } from './Brc38SqlStreamedFieldSink'
import { brc38JsonStreamedFieldPolicy, type Brc38JsonStreamedFieldPolicy } from './Brc38JsonBinaryFields'
import { brc38JsonStructuredFieldPolicy, type Brc38JsonStructuredFieldPolicy } from './Brc38JsonStructuredFields'
import { brc38JsonTextFieldPolicy, type Brc38JsonTextFieldPolicy } from './Brc38JsonTextFields'
import { brc38SqlTextFieldSink } from './Brc38SqlTextFieldSink'
import { brc38SqlStructuredFieldSink } from './Brc38SqlStructuredFieldSink'
import { brc38PrivateStructuredPolicy, type Brc38PrivateStructuredPolicy } from './Brc38PrivateStructuredPolicy'
import { Brc38PrivateChunkPipe, detachBrc38PrivateChunk } from './Brc38PrivateChunkPipe'
import { brc38StagingBinding, type Brc38StagingBinding } from './Brc38StagingBinding'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import type { Brc38StagingAdmissionNode, Brc38StagingReservation } from './Brc38StagingAdmissionNode'
import type { KnexBrc38StagingLimits } from './Brc38StagingBinding'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'

export interface Brc38AuthenticatedPrivateStageOptions {
  /** Resume the original charged private import by replaying the complete
   * authenticated envelope; no quota, binding or deadline is extended. */
  reservationId?: string
  limits: KnexBrc38StagingLimits
  /** archiveSha256 identifies the COMPLETE encrypted BRC-39 envelope. It is
   * independently recomputed here and checked only after GCM succeeds. The
   * destination generation remains a resume binding, not activation proof. */
  binding: Brc38StagingBinding
  crypto: Brc39NodeStreamOptions
  maximumPlaintextBytes: number
  maximumCiphertextChunks: number
  maximumMetadataAllocationBytes?: number
  /** Working private field-aware staging; does not enable legacy/native import
   * activation. Both plaintext grammar and complete authenticated semantics run. */
  streamedFields?: Brc38JsonStreamedFieldPolicy
  /** Decoded original scalar strings in bounded, privately sealed UTF-8 extents. */
  streamedTextFields?: Brc38JsonTextFieldPolicy
  /** Raw archive JSON and derived canonical fields remain privately owned.
   * Native publication still requires the full structured destination adapter. */
  streamedStructuredFields?: {
    readonly fields: Brc38JsonStructuredFieldPolicy
    readonly staging: Brc38PrivateStructuredPolicy
  }
}
export interface Brc38AuthenticatedPrivateStageResult {
  readonly reservation: Brc38StagingReservation
  readonly archiveSha256: string
  readonly document: Brc38JsonStreamResult
  readonly fileBytes: number
  readonly plaintextBytes: number
}

/** Capture resource DATA before an asynchronous controller yields. Neither
 * these values nor an archive hash supply authentication or native ownership. */
export function copyBrc38AuthenticatedPrivateStageOptions(
  selected: Brc38AuthenticatedPrivateStageOptions
): Readonly<Brc38AuthenticatedPrivateStageOptions> {
  return Object.freeze({
    reservationId: selected.reservationId,
    limits: Object.freeze({ ...selected.limits }),
    binding: Object.freeze({ ...selected.binding }),
    crypto: Object.freeze({ ...selected.crypto, policy: Object.freeze({ ...selected.crypto.policy }) }),
    maximumPlaintextBytes: selected.maximumPlaintextBytes,
    maximumCiphertextChunks: selected.maximumCiphertextChunks,
    maximumMetadataAllocationBytes: selected.maximumMetadataAllocationBytes,
    streamedFields:
      selected.streamedFields === undefined ? undefined : brc38JsonStreamedFieldPolicy(selected.streamedFields),
    streamedTextFields:
      selected.streamedTextFields === undefined ? undefined : brc38JsonTextFieldPolicy(selected.streamedTextFields),
    streamedStructuredFields:
      selected.streamedStructuredFields === undefined
        ? undefined
        : Object.freeze({
            fields: brc38JsonStructuredFieldPolicy(selected.streamedStructuredFields.fields),
            staging: brc38PrivateStructuredPolicy(selected.streamedStructuredFields.staging)
          })
  })
}
function bound(value: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new RangeError('Invalid authenticated private staging policy')
}

/** Internal Node integration. Unauthenticated plaintext can reach only private
 * row staging. EOF is withheld from its reader until complete envelope digest
 * and GCM authentication succeed; only then may semantic validation seal it.
 * Failures await parser/I/O settlement and ownership-aware physical disposal.
 * There are no active-wallet writes, ID mappings or capability advertisements. */
export async function stageAuthenticatedBrc39PrivateImport(
  source: AsyncIterable<Uint8Array>,
  password: string,
  admission: Brc38StagingAdmissionNode,
  selected: Brc38AuthenticatedPrivateStageOptions
): Promise<Readonly<Brc38AuthenticatedPrivateStageResult>> {
  return await runAuthenticatedBrc39PrivateImport(source, password, admission, selected)
}

/** Resume only an existing original charged native reservation. A fresh full
 * envelope, GCM tag, original fields and complete semantic closure are checked.
 * Failure closes this attempt's physical owner; it cannot discard already
 * committed candidate rows, mappings, original postimages or recovery pages. */
export async function authenticateBrc39PrivateNativeImport(
  source: AsyncIterable<Uint8Array>,
  password: string,
  admission: Brc38StagingAdmissionNode,
  selected: Brc38AuthenticatedPrivateStageOptions,
  executable: string
): Promise<Readonly<Brc38AuthenticatedPrivateStageResult>> {
  if (selected.reservationId === undefined || typeof executable !== 'string' || executable.length < 1)
    throw new TypeError('Native reauthentication requires the original reservation and executable')
  return await runAuthenticatedBrc39PrivateImport(source, password, admission, selected, executable)
}

async function runAuthenticatedBrc39PrivateImport(
  source: AsyncIterable<Uint8Array>,
  password: string,
  admission: Brc38StagingAdmissionNode,
  selected: Brc38AuthenticatedPrivateStageOptions,
  nativeExecutable?: string
): Promise<Readonly<Brc38AuthenticatedPrivateStageResult>> {
  const limits = Object.freeze({ ...selected.limits }),
    reservationId = selected.reservationId,
    binding = brc38StagingBinding(selected.binding, limits).binding,
    crypto = Object.freeze({
      ...selected.crypto,
      policy: Object.freeze({ ...selected.crypto.policy })
    }),
    maximumPlaintextBytes = selected.maximumPlaintextBytes,
    maximumCiphertextChunks = selected.maximumCiphertextChunks,
    maximumMetadataAllocationBytes = selected.maximumMetadataAllocationBytes ?? 65536,
    fieldPolicy =
      selected.streamedFields === undefined ? undefined : brc38JsonStreamedFieldPolicy(selected.streamedFields),
    textPolicy =
      selected.streamedTextFields === undefined ? undefined : brc38JsonTextFieldPolicy(selected.streamedTextFields),
    structuredPolicy =
      selected.streamedStructuredFields === undefined
        ? undefined
        : brc38JsonStructuredFieldPolicy(selected.streamedStructuredFields.fields),
    structuredStaging =
      selected.streamedStructuredFields === undefined
        ? undefined
        : brc38PrivateStructuredPolicy(selected.streamedStructuredFields.staging)
  if (
    structuredPolicy !== undefined &&
    structuredStaging !== undefined &&
    (structuredPolicy.maximumStructuredBytes > structuredStaging.maximumStructuredBytes ||
      (structuredStaging.signal !== undefined && structuredStaging.signal !== crypto.signal))
  )
    throw new RangeError('Private structured capture, source and lifecycle policies differ')
  bound(maximumPlaintextBytes, Number.MAX_SAFE_INTEGER)
  bound(maximumCiphertextChunks, 1000000)
  bound(maximumMetadataAllocationBytes, 65536)
  // Validate framing policy before any reservation or expensive KDF work.
  bound(crypto.policy.maximumFileBytes, Number.MAX_SAFE_INTEGER)
  bound(crypto.policy.maximumChunkBytes, 65536)
  bound(crypto.policy.maximumIterations, 0xffffffff)
  bound(crypto.policy.maximumMemoryKiB, 0xffffffff)
  bound(crypto.policy.maximumParallelism, 255)
  bound(crypto.maximumPasswordBytes, 65536)
  crypto.signal?.throwIfAborted()
  const reservation =
      nativeExecutable !== undefined
        ? await admission.resumeNative(reservationId!, limits, binding, nativeExecutable)
        : reservationId === undefined
          ? await admission.admit(limits, binding)
          : await admission.resume(reservationId, limits, binding),
    pipe = new Brc38PrivateChunkPipe(crypto.policy.maximumChunkBytes),
    semanticOptions = {
      expectedIdentityKey: binding.identityKey,
      expectedChain: binding.chain,
      expectedSourceStorageIdentityKey: binding.sourceStorageIdentityKey,
      maximumRows: limits.maximumRows,
      signal: crypto.signal
    },
    semantic = new Brc38SemanticStage(reservation.store, semanticOptions),
    streamedStore: Brc38StreamedStageStore =
      structuredStaging === undefined
        ? reservation.store
        : {
            append: record => reservation.store.append(record),
            appendStreamed: (record, binary, json, text) =>
              reservation.store.appendStreamed(record, binary, json, text),
            count: table => reservation.store.count(table),
            row: (table, index) => reservation.store.row(table, index),
            streamedRow: (table, index) => reservation.store.streamedRow(table, index),
            has: (namespace, key) => reservation.store.has(namespace, key),
            validateTextFields: (table, index, descriptors) =>
              reservation.store.validateTextFields(table, index, descriptors),
            validateStructuredFields: (table, index, descriptors, policy) =>
              reservation.store.validateOwnedSourceStructuredFields(table, index, descriptors, policy),
            seal: (header, counts) => reservation.store.seal(header, counts),
            sealStreamed: (header, counts) =>
              reservation.store.sealOwnedSourceStructuredStreamed(header, counts, {
                ...structuredStaging,
                signal: crypto.signal
              }),
            discard: async cause => {
              if (nativeExecutable === undefined) await reservation.store.discard(cause)
              else await reservation.store.close()
            }
          },
    streamedSemantic =
      fieldPolicy === undefined && structuredPolicy === undefined && textPolicy === undefined
        ? undefined
        : new Brc38StreamedSemanticStage(
            streamedStore,
            semanticOptions,
            structuredStaging === undefined ? undefined : { ...structuredStaging, signal: crypto.signal }
          ),
    fieldSink =
      fieldPolicy === undefined || streamedSemantic === undefined
        ? undefined
        : brc38SqlStreamedFieldSink(
            reservation.store,
            fieldPolicy,
            async (table, index, row) => await streamedSemantic.provisionalRow(table, index, row)
          ),
    structuredSink =
      structuredPolicy === undefined || streamedSemantic === undefined
        ? undefined
        : brc38SqlStructuredFieldSink(
            reservation.store,
            structuredPolicy,
            async (table, index, row) => await streamedSemantic.provisionalRow(table, index, row)
          ),
    textSink =
      textPolicy === undefined || streamedSemantic === undefined
        ? undefined
        : brc38SqlTextFieldSink(
            reservation.store,
            textPolicy,
            async (table, index, row) => await streamedSemantic.provisionalRow(table, index, row)
          )
  let authenticated = false,
    archiveSha256: string | undefined,
    disposal: Promise<void> | undefined
  const dispose = (cause: unknown): Promise<void> => {
    // Native resume owns an existing completed source and may own committed
    // composition episodes. Authentication failure is never retirement consent.
    const close = async (): Promise<void> => {
      if (nativeExecutable === undefined) await admission.discard(reservation, cause)
      else await reservation.store.close()
    }
    disposal ??= close().catch(error_ => {
      throw new Brc38StagingCleanupError(
        [cause, error_],
        'Authenticated private staging retains physical cleanup',
        close
      )
    })
    return disposal
  }
  const parsing = readBrc38JsonStream(
    pipe,
    {
      streamedFields: fieldSink,
      streamedStructuredFields: structuredSink,
      streamedTextFields: textSink,
      provisionalRow: async (table, index, row) => await semantic.provisionalRow(table, index, row),
      validateCompleted: async (header, counts) => {
        if (!authenticated) throw new Error('Private staging completion requires actual archive authentication')
        if (streamedSemantic === undefined) await semantic.validateCompleted(header, counts)
        else await streamedSemantic.validateCompleted(header, counts)
      },
      discard: async cause => {
        pipe.fail(cause)
        await dispose(cause)
      }
    },
    {
      maximumArchiveBytes: maximumPlaintextBytes,
      maximumRowAllocationBytes: limits.maximumRowAllocationBytes,
      maximumMetadataAllocationBytes,
      maximumInputChunkBytes: crypto.policy.maximumChunkBytes,
      // The frame emits at most two pieces per input: retained tag-tail bytes
      // and bytes from the new chunk. Keep the external ciphertext cap below.
      maximumInputChunks: 2 * maximumCiphertextChunks,
      signal: crypto.signal,
      streamedFields: fieldPolicy,
      streamedStructuredFields: structuredPolicy,
      streamedTextFields: textPolicy
    }
  )
  // Observe the original parser failure immediately and unblock its producer.
  // The original promise is still awaited before returning or cleanup.
  void parsing.catch(cause => pipe.fail(cause))
  const digest = createHash('sha256')
  async function* ciphertext() {
    let count = 0
    for await (const input of source) {
      crypto.signal?.throwIfAborted()
      if (++count > maximumCiphertextChunks)
        throw new SnapshotResourceLimitError('Authenticated archive chunk policy reached')
      const bytes = detachBrc38PrivateChunk(input, crypto.policy.maximumChunkBytes)
      digest.update(bytes)
      yield bytes
    }
    archiveSha256 = digest.digest('hex')
  }
  try {
    const receipt = await decryptBrc39StreamToQuarantine(
      ciphertext(),
      password,
      {
        appendUntrusted: async bytes => {
          try {
            await pipe.append(bytes)
          } catch (cause) {
            // Early reader return may precede its syntax/semantic rejection.
            // Await that exact result rather than replace it with a pipe sentinel.
            const [result] = await Promise.allSettled([parsing])
            if (result.status === 'rejected') throw result.reason
            throw cause
          }
        },
        validateAuthenticated: async () => {
          if (archiveSha256 !== binding.archiveSha256)
            throw new Error('Authenticated archive differs from its complete encrypted binding')
          authenticated = true
          pipe.end()
          await parsing
        },
        discard: async () => {
          const cause = new Error('Private archive authentication did not complete')
          pipe.fail(cause)
          await Promise.allSettled([parsing])
          await dispose(cause)
        }
      },
      crypto
    )
    const document = await parsing
    if (structuredStaging === undefined) await reservation.store.markAuthenticatedArchive(binding.archiveSha256)
    else
      await reservation.store.markAuthenticatedOwnedSourceStructuredArchive(binding.archiveSha256, {
        ...structuredStaging,
        signal: crypto.signal
      })
    return Object.freeze({
      reservation,
      archiveSha256: binding.archiveSha256,
      document,
      ...receipt
    })
  } catch (cause) {
    pipe.fail(cause)
    await Promise.allSettled([parsing])
    try {
      await dispose(cause)
    } catch (error_) {
      if (error_ === cause) throw cause
      throw new Brc38StagingCleanupError(
        [cause, error_],
        'Archive processing and private physical disposal failed',
        async () => {
          if (error_ instanceof Brc38StagingCleanupError) await error_.retryCleanup()
          else if (nativeExecutable === undefined) await admission.discard(reservation, cause)
          else await reservation.store.close()
        }
      )
    }
    throw cause
  }
}
