import { SHA256 } from '@bsv/sdk/primitives/Hash'
import { Brc38OwnedByteSource } from './Brc38OwnedByteSource'
import { deriveBrc39OwnedBrowserKey } from './Brc39OwnedBrowserKey'
import { decryptBrc39OwnedBrowserEnvelope } from './Brc39OwnedBrowserEnvelope'
import { Brc39StreamFrame, type Brc39StreamPolicy } from './Brc39Frame'
import { Brc38PrivateIdbStage } from './Brc38PrivateIdbStage'
import { Brc38SemanticStage } from './Brc38SemanticStage'
import { Brc38StreamedSemanticStage } from './Brc38StreamedSemanticStage'
import { brc38IdbStreamedFieldSink } from './Brc38IdbStreamedFieldSink'
import { brc38JsonStreamedFieldPolicy, type Brc38JsonStreamedFieldPolicy } from './Brc38JsonBinaryFields'
import { brc38JsonStructuredFieldPolicy, type Brc38JsonStructuredFieldPolicy } from './Brc38JsonStructuredFields'
import { brc38IdbStructuredFieldSink } from './Brc38IdbStructuredFieldSink'
import { brc38JsonTextFieldPolicy, type Brc38JsonTextFieldPolicy } from './Brc38JsonTextFields'
import { brc38IdbTextFieldSink } from './Brc38IdbTextFieldSink'
import {
  brc38PrivateIdbStructuredPolicy,
  type Brc38PrivateIdbStructuredPolicy
} from './Brc38PrivateIdbStructuredPolicy'
import { readBrc38JsonStream, type Brc38JsonStreamResult } from './Brc38JsonStream'
import { brc38StagingBinding, type Brc38StagingBinding } from './Brc38StagingBinding'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import type { KnexBrc38StagingLimits } from './Brc38StagingBinding'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'

export interface Brc38AuthenticatedPrivateBrowserOptions {
  readonly databaseName?: string
  readonly limits: KnexBrc38StagingLimits
  readonly binding: Brc38StagingBinding
  readonly maximumKeys: number
  readonly cryptoPolicy: Brc39StreamPolicy
  readonly maximumPasswordBytes: number
  readonly maximumCiphertextChunks: number
  /** Native WebCrypto decrypts one complete bounded envelope. This component
   * does not advertise the large-field streaming or native import capability. */
  readonly maximumEnvelopeBytes: number
  readonly maximumEnvelopeAllocationBytes: number
  readonly maximumMetadataAllocationBytes?: number
  readonly sourceControl?: {
    readonly maximumReadMilliseconds: number
    readonly maximumKdfMilliseconds: number
    readonly cleanupMilliseconds: number
    readonly closeSource?: (cause?: unknown) => Promise<void>
  }
  readonly streamedFields?: Brc38JsonStreamedFieldPolicy
  readonly streamedTextFields?: Brc38JsonTextFieldPolicy
  readonly streamedStructuredFields?: {
    readonly fields: Brc38JsonStructuredFieldPolicy
    readonly staging: Omit<Brc38PrivateIdbStructuredPolicy, 'databaseName' | 'signal'>
  }
  readonly signal?: AbortSignal
}
function bound(value: number, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new RangeError('Invalid browser private authentication bound')
}

/** An explicit bounded browser path: native GCM succeeds before any plaintext
 * parser writes, and all thirteen original semantic checks precede success.
 * Resume replays the complete encrypted source into the exact original stage;
 * no persisted marker, digest or previous semantic verdict authorizes it.
 * There is no active-wallet write, profile switch or capability advertisement. */
export async function stageAuthenticatedBrc39PrivateBrowserImport(
  source: AsyncIterable<Uint8Array>,
  password: string,
  selected: Brc38AuthenticatedPrivateBrowserOptions
): Promise<
  Readonly<{
    stage: Brc38PrivateIdbStage
    document: Brc38JsonStreamResult
    archiveSha256: string
    fileBytes: number
    plaintextBytes: number
  }>
> {
  const limits = Object.freeze({ ...selected.limits }),
    binding = brc38StagingBinding(selected.binding, limits).binding,
    policy = Object.freeze({ ...selected.cryptoPolicy }),
    maximumKeys = selected.maximumKeys,
    maximumPasswordBytes = selected.maximumPasswordBytes,
    maximumChunks = selected.maximumCiphertextChunks,
    envelopeBytes = selected.maximumEnvelopeBytes,
    allocationBytes = selected.maximumEnvelopeAllocationBytes,
    metadataBytes = selected.maximumMetadataAllocationBytes ?? 65536,
    databaseName = selected.databaseName,
    signal = selected.signal,
    began = performance.now(),
    lifetime = limits.expiresAt - Date.now(),
    sourceControl = Object.freeze({
      ...(selected.sourceControl ?? {
        maximumReadMilliseconds: 30000,
        maximumKdfMilliseconds: 30000,
        cleanupMilliseconds: 30000
      })
    }),
    fieldPolicy =
      selected.streamedFields === undefined ? undefined : brc38JsonStreamedFieldPolicy(selected.streamedFields),
    textPolicy =
      selected.streamedTextFields === undefined ? undefined : brc38JsonTextFieldPolicy(selected.streamedTextFields),
    structuredPolicy =
      selected.streamedStructuredFields === undefined
        ? undefined
        : brc38JsonStructuredFieldPolicy(selected.streamedStructuredFields.fields),
    structuredBounds =
      selected.streamedStructuredFields === undefined
        ? undefined
        : Object.freeze({
            maximumTemporaryIndexBytes: selected.streamedStructuredFields.staging.maximumTemporaryIndexBytes,
            maximumIndexMembers: selected.streamedStructuredFields.staging.maximumIndexMembers,
            maximumStructuredBytes: selected.streamedStructuredFields.staging.maximumStructuredBytes,
            maximumCanonicalBytes: selected.streamedStructuredFields.staging.maximumCanonicalBytes
          })
  bound(allocationBytes, 1048576, 16777216)
  bound(envelopeBytes, 114, 16777216)
  bound(maximumPasswordBytes, 1, 65536)
  bound(maximumChunks, 1, 1000000)
  bound(metadataBytes, 1, 65536)
  bound(maximumKeys, 1, 2000000000)
  bound(sourceControl.maximumReadMilliseconds, 1, 30000)
  bound(sourceControl.maximumKdfMilliseconds, 1, 30000)
  bound(sourceControl.cleanupMilliseconds, 1, 30000)
  if (
    1048576 + 8 * envelopeBytes + 8 * maximumPasswordBytes > allocationBytes ||
    policy.maximumFileBytes !== envelopeBytes
  )
    throw new SnapshotResourceLimitError('Browser envelope preparation exceeds its original allocation')
  const frame = new Brc39StreamFrame(policy)
  if (
    fieldPolicy !== undefined &&
    (fieldPolicy.maximumBinaryBytes > limits.maximumLogicalBytes ||
      4096 + 32 * fieldPolicy.maximumChunkBytes > limits.maximumRowAllocationBytes)
  )
    throw new RangeError('Browser binary chunks exceed the original staging allocation')
  if (
    textPolicy !== undefined &&
    (textPolicy.maximumTextBytes > limits.maximumLogicalBytes ||
      4096 + 32 * textPolicy.maximumChunkBytes > limits.maximumRowAllocationBytes)
  )
    throw new RangeError('Browser scalar TEXT chunks exceed the original staging allocation')
  if (structuredPolicy !== undefined && structuredBounds !== undefined) {
    bound(structuredBounds.maximumTemporaryIndexBytes, 1048576, limits.maximumLogicalBytes)
    bound(structuredBounds.maximumIndexMembers, 1, maximumKeys)
    bound(structuredBounds.maximumStructuredBytes, 2, Math.min(1000000000, limits.maximumLogicalBytes))
    bound(structuredBounds.maximumCanonicalBytes, 2, 1000000000)
    if (
      structuredPolicy.maximumStructuredBytes !== structuredBounds.maximumStructuredBytes ||
      4096 + 32 * structuredPolicy.maximumChunkBytes > limits.maximumRowAllocationBytes
    )
      throw new RangeError('Browser structured source/index/original allocation differ')
  }
  const check = () => {
    signal?.throwIfAborted()
    if (Date.now() >= limits.expiresAt || performance.now() - began >= lifetime)
      throw new SnapshotResourceLimitError('Browser private authentication original lifetime ended')
  }
  check()
  if (typeof SubtleCrypto === 'undefined' || globalThis.crypto?.subtle === undefined)
    throw new Error('Private browser authentication requires native WebCrypto')
  if (typeof password !== 'string' || password.length > maximumPasswordBytes)
    throw new SnapshotResourceLimitError('Browser import password exceeds its original bound')
  let stage: Brc38PrivateIdbStage | undefined,
    envelope: Uint8Array<ArrayBuffer> | undefined,
    plaintext: Uint8Array<ArrayBuffer> | undefined,
    keyBytes: Uint8Array | undefined,
    ownedSource: Brc38OwnedByteSource | undefined,
    pendingCleanup: Brc38StagingCleanupError | undefined
  try {
    stage =
      databaseName === undefined
        ? await Brc38PrivateIdbStage.create(limits, binding, maximumKeys, signal)
        : await Brc38PrivateIdbStage.resume(databaseName, limits, binding, maximumKeys, signal)
    check()
    envelope = new Uint8Array(envelopeBytes)
    try {
      ownedSource = await Brc38OwnedByteSource.open(source, {
        expiresAt: limits.expiresAt,
        maximumReadMilliseconds: sourceControl.maximumReadMilliseconds,
        cleanupMilliseconds: sourceControl.cleanupMilliseconds,
        maximumChunkBytes: policy.maximumChunkBytes,
        maximumChunks,
        maximumBytes: envelopeBytes,
        signal,
        closeSource: sourceControl.closeSource
      })
    } catch (cause) {
      if (cause instanceof Brc38StagingCleanupError) pendingCleanup = cause
      throw cause
    }
    const digest = new SHA256()
    let used = 0,
      count = 0
    for await (const input of ownedSource) {
      const chunk = input
      try {
        check()
        if (++count > maximumChunks)
          throw new SnapshotResourceLimitError('Browser encrypted source chunk bound reached')
        if (chunk.byteLength > envelopeBytes - used)
          throw new SnapshotResourceLimitError('Browser encrypted source byte bound reached')
        digest.update(chunk)
        envelope.set(chunk, used)
        used += chunk.byteLength
        // Framing validates header/KDF limits before the expensive derivation.
        // Its ciphertext copies are provisional and never reach a wallet.
        for (const provisional of frame.accept(chunk)) provisional.fill(0)
      } finally {
        chunk.fill(0)
        input.fill(0)
      }
    }
    const header = frame.header(),
      complete = frame.finish(),
      archiveSha256 = digest.digestHex()
    if (header === undefined || complete.fileBytes !== used || archiveSha256 !== binding.archiveSha256)
      throw new Error('Browser encrypted source differs from its complete original binding')
    check()
    try {
      keyBytes = await deriveBrc39OwnedBrowserKey(header, password, {
        policy,
        expiresAt: limits.expiresAt,
        maximumPasswordBytes,
        maximumOperationMilliseconds: sourceControl.maximumKdfMilliseconds,
        cleanupMilliseconds: sourceControl.cleanupMilliseconds,
        signal
      })
    } catch (cause) {
      if (cause instanceof Brc38StagingCleanupError) pendingCleanup = cause
      throw cause
    } finally {
      header.salt.fill(0)
    }
    check()
    const payloadStart = used - complete.ciphertextBytes - 16
    try {
      plaintext = await decryptBrc39OwnedBrowserEnvelope(
        keyBytes,
        header.nonce,
        envelope.subarray(payloadStart, used),
        {
          maximumPayloadBytes: envelopeBytes,
          expiresAt: limits.expiresAt,
          cleanupMilliseconds: sourceControl.cleanupMilliseconds,
          signal
        }
      )
    } catch (cause) {
      if (cause instanceof Brc38StagingCleanupError) pendingCleanup = cause
      throw cause
    } finally {
      keyBytes.fill(0)
      header.nonce.fill(0)
    }
    check()
    if (plaintext.byteLength !== complete.ciphertextBytes)
      throw new Error('Native browser GCM plaintext extent differs')
    const idbStructured =
        structuredBounds === undefined
          ? undefined
          : brc38PrivateIdbStructuredPolicy({ ...structuredBounds, databaseName: stage.databaseName, signal }),
      semanticOptions = {
        expectedIdentityKey: binding.identityKey,
        expectedChain: binding.chain,
        expectedSourceStorageIdentityKey: binding.sourceStorageIdentityKey,
        maximumRows: limits.maximumRows,
        signal
      },
      semantic = new Brc38SemanticStage(stage, semanticOptions),
      streamed =
        fieldPolicy === undefined && structuredPolicy === undefined && textPolicy === undefined
          ? undefined
          : new Brc38StreamedSemanticStage(stage, semanticOptions, undefined, idbStructured),
      fieldSink =
        fieldPolicy === undefined || streamed === undefined
          ? undefined
          : brc38IdbStreamedFieldSink(
              stage,
              fieldPolicy,
              async (table, index, row) => await streamed.provisionalRow(table, index, row)
            ),
      structuredSink =
        structuredPolicy === undefined || streamed === undefined
          ? undefined
          : brc38IdbStructuredFieldSink(
              stage,
              structuredPolicy,
              async (table, index, row) => await streamed.provisionalRow(table, index, row)
            ),
      textSink =
        textPolicy === undefined || streamed === undefined
          ? undefined
          : brc38IdbTextFieldSink(
              stage,
              textPolicy,
              async (table, index, row) => await streamed.provisionalRow(table, index, row)
            ),
      bytes = plaintext,
      maximumInputChunkBytes = Math.min(4096, policy.maximumChunkBytes)
    async function* chunks() {
      for (let offset = 0; offset < bytes.byteLength; offset += maximumInputChunkBytes) {
        check()
        yield bytes.subarray(offset, Math.min(bytes.byteLength, offset + maximumInputChunkBytes))
      }
    }
    const document = await readBrc38JsonStream(
      chunks(),
      {
        streamedFields: fieldSink,
        streamedStructuredFields: structuredSink,
        streamedTextFields: textSink,
        provisionalRow: async (table, index, row) => await semantic.provisionalRow(table, index, row),
        validateCompleted: async (header, counts) => {
          if (streamed === undefined) await semantic.validateCompleted(header, counts)
          else await streamed.validateCompleted(header, counts)
        },
        discard: async cause => await stage!.discard(cause)
      },
      {
        maximumArchiveBytes: envelopeBytes,
        maximumRowAllocationBytes: limits.maximumRowAllocationBytes,
        maximumMetadataAllocationBytes: metadataBytes,
        maximumInputChunkBytes,
        maximumInputChunks: Math.ceil(envelopeBytes / maximumInputChunkBytes),
        signal,
        streamedFields: fieldPolicy,
        streamedStructuredFields: structuredPolicy,
        streamedTextFields: textPolicy
      }
    )
    check()
    return Object.freeze({ stage, document, archiveSha256, fileBytes: used, plaintextBytes: plaintext.byteLength })
  } catch (cause) {
    const cleanup = async () => {
      const failures: unknown[] = []
      for (const dispose of [
        async () => {
          if (pendingCleanup !== undefined) await pendingCleanup.retryCleanup()
        },
        async () => {
          if (ownedSource !== undefined) await ownedSource.close(cause)
        },
        async () => {
          if (stage !== undefined) await stage.discard(cause)
        }
      ]) {
        try {
          await dispose()
        } catch (error_) {
          failures.push(error_)
        }
      }
      if (failures.length !== 0) throw new AggregateError(failures, 'Authenticated browser physical cleanup remains')
    }
    try {
      await cleanup()
    } catch (error_) {
      throw new Brc38StagingCleanupError(
        [cause, error_],
        'Authenticated browser import retains original source/KDF/namespace owners',
        cleanup
      )
    }
    throw cause
  } finally {
    keyBytes?.fill(0)
    plaintext?.fill(0)
    envelope?.fill(0)
  }
}
