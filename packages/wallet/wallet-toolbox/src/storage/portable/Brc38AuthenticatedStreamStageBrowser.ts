import { awaitFromSync } from '../../utility/promiseFromSync'
import { SHA256 } from '@bsv/sdk/primitives/Hash'
import { Brc39StreamFrame } from './Brc39Frame'
import { Brc39WebCryptoGcm } from './Brc39WebCryptoGcm'
import { deriveBrc39OwnedBrowserKey } from './Brc39OwnedBrowserKey'
import { Brc38OwnedByteSource } from './Brc38OwnedByteSource'
import { Brc38PrivateIdbStage } from './Brc38PrivateIdbStage'
import { Brc38SemanticStage } from './Brc38SemanticStage'
import { Brc38StreamedSemanticStage } from './Brc38StreamedSemanticStage'
import { brc38IdbStreamedFieldSink } from './Brc38IdbStreamedFieldSink'
import { brc38IdbStructuredFieldSink } from './Brc38IdbStructuredFieldSink'
import { brc38IdbTextFieldSink } from './Brc38IdbTextFieldSink'
import { brc38JsonTextFieldPolicy } from './Brc38JsonTextFields'
import { brc38JsonStreamedFieldPolicy } from './Brc38JsonBinaryFields'
import { brc38JsonStructuredFieldPolicy } from './Brc38JsonStructuredFields'
import { brc38PrivateIdbStructuredPolicy } from './Brc38PrivateIdbStructuredPolicy'
import { readBrc38JsonStream, type Brc38JsonStreamResult } from './Brc38JsonStream'
import { brc38StagingBinding } from './Brc38StagingBinding'
import { Brc38PrivateChunkPipe } from './Brc38PrivateChunkPipe'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import type { Brc38AuthenticatedPrivateBrowserOptions } from './Brc38AuthenticatedPrivateStageBrowser'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'

export interface Brc38AuthenticatedStreamBrowserOptions extends Omit<
  Brc38AuthenticatedPrivateBrowserOptions,
  'maximumEnvelopeBytes' | 'maximumEnvelopeAllocationBytes'
> {
  readonly maximumPlaintextBytes: number
  /** Crypto scratch alone. Argon2 memory and private storage/row/index budgets
   * are separately bounded; this is not a browser-wide physical quota claim. */
  readonly maximumCryptoAllocationBytes: number
  readonly sourceControl: {
    readonly maximumReadMilliseconds: number
    readonly maximumKdfMilliseconds: number
    readonly cleanupMilliseconds: number
    readonly closeSource?: (cause?: unknown) => Promise<void>
  }
}
/** Capture nested policy DATA before asynchronous source work. This copy
 * grants no backend, schema, authentication, semantic or activation authority. */
export function copyBrc38AuthenticatedStreamBrowserOptions(
  selected: Brc38AuthenticatedStreamBrowserOptions
): Brc38AuthenticatedStreamBrowserOptions {
  return {
    ...selected,
    limits: Object.freeze({ ...selected.limits }),
    binding: Object.freeze({ ...selected.binding }),
    cryptoPolicy: Object.freeze({ ...selected.cryptoPolicy }),
    sourceControl: Object.freeze({ ...selected.sourceControl }),
    streamedFields: selected.streamedFields === undefined ? undefined : Object.freeze({ ...selected.streamedFields }),
    streamedTextFields:
      selected.streamedTextFields === undefined ? undefined : Object.freeze({ ...selected.streamedTextFields }),
    streamedStructuredFields:
      selected.streamedStructuredFields === undefined
        ? undefined
        : {
            fields: Object.freeze({ ...selected.streamedStructuredFields.fields }),
            staging: Object.freeze({ ...selected.streamedStructuredFields.staging })
          }
  }
}
function bound(value: number, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new RangeError('Invalid streamed browser import bound')
}

/** Size-independent encrypted source → isolated native IDB staging. EOF is
 * withheld until actual complete GCM and encrypted-source SHA authentication;
 * only then do fresh all-thirteen-table semantic checks seal the stage. Resume
 * replays the complete original envelope and original resources/deadline. No
 * active-wallet mutation, restore activation or negotiated capability occurs. */
export async function stageAuthenticatedBrc39StreamBrowserImport(
  source: AsyncIterable<Uint8Array>,
  password: string,
  selected: Brc38AuthenticatedStreamBrowserOptions
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
    passwordLimit = selected.maximumPasswordBytes,
    maximumChunks = selected.maximumCiphertextChunks,
    maximumPlaintextBytes = selected.maximumPlaintextBytes,
    cryptoAllocation = selected.maximumCryptoAllocationBytes,
    metadataBytes = selected.maximumMetadataAllocationBytes ?? 65536,
    databaseName = selected.databaseName,
    signal = selected.signal,
    control = Object.freeze({ ...selected.sourceControl }),
    began = performance.now(),
    lifetime = limits.expiresAt - Date.now(),
    binary = selected.streamedFields === undefined ? undefined : brc38JsonStreamedFieldPolicy(selected.streamedFields),
    text =
      selected.streamedTextFields === undefined ? undefined : brc38JsonTextFieldPolicy(selected.streamedTextFields),
    structured =
      selected.streamedStructuredFields === undefined
        ? undefined
        : brc38JsonStructuredFieldPolicy(selected.streamedStructuredFields.fields),
    structuredBounds =
      selected.streamedStructuredFields === undefined
        ? undefined
        : Object.freeze({ ...selected.streamedStructuredFields.staging })
  bound(maximumKeys, 1, 2000000000)
  bound(passwordLimit, 1, 65536)
  bound(maximumChunks, 1, 1000000)
  bound(metadataBytes, 1, 65536)
  bound(policy.maximumChunkBytes, 16, 65536)
  bound(maximumPlaintextBytes, 1, Math.min(limits.maximumLogicalBytes, 16 * (2 ** 32 - 2)))
  bound(cryptoAllocation, 65536, 16777216)
  bound(control.maximumReadMilliseconds, 1, 30000)
  bound(control.maximumKdfMilliseconds, 1, 30000)
  bound(control.cleanupMilliseconds, 1, 30000)
  if (16384 + 16 * policy.maximumChunkBytes + 8 * passwordLimit > cryptoAllocation)
    throw new SnapshotResourceLimitError('Streamed browser crypto preparation exceeds original allocation')
  if (
    binary !== undefined &&
    (binary.maximumBinaryBytes > limits.maximumLogicalBytes ||
      4096 + 32 * binary.maximumChunkBytes > limits.maximumRowAllocationBytes)
  )
    throw new RangeError('Streamed browser binary fields exceed original resources')
  if (
    text !== undefined &&
    (text.maximumTextBytes > limits.maximumLogicalBytes ||
      4096 + 32 * text.maximumChunkBytes > limits.maximumRowAllocationBytes)
  )
    throw new RangeError('Streamed browser scalar TEXT fields exceed original resources')
  if (structured !== undefined && structuredBounds !== undefined) {
    bound(structuredBounds.maximumTemporaryIndexBytes, 1048576, limits.maximumLogicalBytes)
    bound(structuredBounds.maximumIndexMembers, 1, maximumKeys)
    bound(structuredBounds.maximumStructuredBytes, 2, Math.min(1000000000, limits.maximumLogicalBytes))
    bound(structuredBounds.maximumCanonicalBytes, 2, 1000000000)
    if (
      structured.maximumStructuredBytes !== structuredBounds.maximumStructuredBytes ||
      4096 + 32 * structured.maximumChunkBytes > limits.maximumRowAllocationBytes
    )
      throw new RangeError('Streamed browser structured source/index/original allocation differ')
  }
  const frame = new Brc39StreamFrame(policy),
    check = () => {
      signal?.throwIfAborted()
      if (Date.now() >= limits.expiresAt || performance.now() - began >= lifetime)
        throw new SnapshotResourceLimitError('Streamed browser import original lifetime ended')
    }
  check()
  let stage: Brc38PrivateIdbStage | undefined,
    ownedSource: Brc38OwnedByteSource | undefined,
    cipher: Brc39WebCryptoGcm | undefined,
    parsing: Promise<Brc38JsonStreamResult> | undefined,
    keyCleanup: Brc38StagingCleanupError | undefined,
    sourceCleanup: Brc38StagingCleanupError | undefined,
    pipe: Brc38PrivateChunkPipe | undefined,
    authenticated = false,
    sourceDrained = false,
    plaintextBytes = 0
  try {
    stage =
      databaseName === undefined
        ? await Brc38PrivateIdbStage.create(limits, binding, maximumKeys, signal)
        : await Brc38PrivateIdbStage.resume(databaseName, limits, binding, maximumKeys, signal)
    const owner = stage
    try {
      ownedSource = await Brc38OwnedByteSource.open(source, {
        expiresAt: limits.expiresAt,
        maximumReadMilliseconds: control.maximumReadMilliseconds,
        cleanupMilliseconds: control.cleanupMilliseconds,
        maximumChunkBytes: policy.maximumChunkBytes,
        maximumChunks,
        maximumBytes: policy.maximumFileBytes,
        signal,
        closeSource: control.closeSource
      })
    } catch (cause) {
      if (cause instanceof Brc38StagingCleanupError) sourceCleanup = cause
      throw cause
    }
    pipe = new Brc38PrivateChunkPipe(policy.maximumChunkBytes)
    const output = pipe,
      idbStructured =
        structuredBounds === undefined
          ? undefined
          : brc38PrivateIdbStructuredPolicy({ ...structuredBounds, databaseName: owner.databaseName, signal }),
      semanticOptions = {
        expectedIdentityKey: binding.identityKey,
        expectedChain: binding.chain,
        expectedSourceStorageIdentityKey: binding.sourceStorageIdentityKey,
        maximumRows: limits.maximumRows,
        signal
      },
      semantic = new Brc38SemanticStage(owner, semanticOptions),
      streamed =
        binary === undefined && structured === undefined && text === undefined
          ? undefined
          : new Brc38StreamedSemanticStage(owner, semanticOptions, undefined, idbStructured),
      fieldSink =
        binary === undefined || streamed === undefined
          ? undefined
          : brc38IdbStreamedFieldSink(owner, binary, (table, index, row) =>
              awaitFromSync(() => streamed.provisionalRow(table, index, row))
            ),
      structuredSink =
        structured === undefined || streamed === undefined
          ? undefined
          : brc38IdbStructuredFieldSink(owner, structured, (table, index, row) =>
              awaitFromSync(() => streamed.provisionalRow(table, index, row))
            ),
      textSink =
        text === undefined || streamed === undefined
          ? undefined
          : brc38IdbTextFieldSink(owner, text, (table, index, row) =>
              awaitFromSync(() => streamed.provisionalRow(table, index, row))
            )
    parsing = readBrc38JsonStream(
      output,
      {
        streamedFields: fieldSink,
        streamedStructuredFields: structuredSink,
        streamedTextFields: textSink,
        provisionalRow: (table, index, row) => awaitFromSync(() => semantic.provisionalRow(table, index, row)),
        validateCompleted: async (header, counts) => {
          if (!authenticated || !sourceDrained)
            throw new Error('Streamed browser completion requires current complete authentication and source drain')
          check()
          if (streamed === undefined) await semantic.validateCompleted(header, counts)
          else await streamed.validateCompleted(header, counts)
        },
        discard: async cause => {
          output.fail(cause)
          await owner.discard(cause)
        }
      },
      {
        maximumArchiveBytes: maximumPlaintextBytes,
        maximumRowAllocationBytes: limits.maximumRowAllocationBytes,
        maximumMetadataAllocationBytes: metadataBytes,
        maximumInputChunkBytes: policy.maximumChunkBytes,
        maximumInputChunks: 2 * maximumChunks + 2,
        signal,
        streamedFields: binary,
        streamedStructuredFields: structured,
        streamedTextFields: text
      }
    )
    const reader = parsing
    void reader.catch(cause => output.fail(cause))
    async function append(bytes: Uint8Array): Promise<void> {
      try {
        if (bytes.byteLength > maximumPlaintextBytes - plaintextBytes)
          throw new SnapshotResourceLimitError('Streamed browser plaintext bound reached')
        for (let offset = 0; offset < bytes.byteLength; offset += policy.maximumChunkBytes) {
          check()
          await output.append(bytes.subarray(offset, Math.min(bytes.byteLength, offset + policy.maximumChunkBytes)))
        }
        plaintextBytes += bytes.byteLength
      } finally {
        bytes.fill(0)
      }
    }
    const digest = new SHA256()
    for await (const input of ownedSource) {
      const emitted: Uint8Array[] = []
      try {
        check()
        digest.update(input)
        emitted.push(...frame.accept(input))
        if (cipher === undefined) {
          const header = frame.header()
          if (header !== undefined) {
            let key: Uint8Array | undefined
            try {
              key = await deriveBrc39OwnedBrowserKey(header, password, {
                policy,
                expiresAt: limits.expiresAt,
                maximumPasswordBytes: passwordLimit,
                maximumOperationMilliseconds: control.maximumKdfMilliseconds,
                cleanupMilliseconds: control.cleanupMilliseconds,
                signal
              })
              check()
              cipher = await Brc39WebCryptoGcm.create(key, header.nonce, {
                maximumChunkBytes: policy.maximumChunkBytes,
                maximumPlaintextBytes,
                maximumAllocationBytes: cryptoAllocation,
                expiresAt: limits.expiresAt,
                cleanupMilliseconds: control.cleanupMilliseconds,
                signal
              })
            } catch (cause) {
              if (cause instanceof Brc38StagingCleanupError) keyCleanup = cause
              throw cause
            } finally {
              key?.fill(0)
              header.salt.fill(0)
              header.nonce.fill(0)
            }
          }
        }
        for (const chunk of emitted) {
          if (cipher === undefined) throw new Error('Streamed browser ciphertext precedes original KDF header')
          await append(await cipher.update(chunk))
        }
      } finally {
        input.fill(0)
        for (const bytes of emitted) bytes.fill(0)
      }
    }
    // Owned source EOF includes actual host/iterator close before authentication
    // delivery. No old digest/seal/semantic marker is consulted here.
    sourceDrained = true
    const complete = frame.finish(),
      archiveSha256 = digest.digestHex()
    if (cipher === undefined) throw new TypeError('Streamed browser archive has no complete decryptor')
    try {
      await append(await cipher.finish(complete.tag))
    } finally {
      complete.tag.fill(0)
    }
    if (archiveSha256 !== binding.archiveSha256 || plaintextBytes !== complete.ciphertextBytes)
      throw new Error('Streamed browser authenticated envelope differs from original binding or extent')
    await cipher.close()
    check()
    authenticated = true
    output.end()
    const document = await reader
    check()
    return Object.freeze({ stage: owner, document, archiveSha256, fileBytes: complete.fileBytes, plaintextBytes })
  } catch (cause) {
    pipe?.fail(cause)
    // Parser/source/crypto own distinct resources. Drain each, preserving every
    // failure and its concrete retry even when another resource closes first.
    if (parsing !== undefined) await Promise.allSettled([parsing])
    const cleanup = async () => {
      const failures: unknown[] = []
      for (const dispose of [
        async () => {
          if (keyCleanup !== undefined) await keyCleanup.retryCleanup()
        },
        async () => {
          if (sourceCleanup !== undefined) await sourceCleanup.retryCleanup()
          if (ownedSource !== undefined) await ownedSource.close(cause)
        },
        async () => {
          if (cipher !== undefined) await cipher.close()
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
      if (failures.length !== 0) throw new AggregateError(failures, 'Streamed browser import resource cleanup remains')
    }
    try {
      await cleanup()
    } catch (error_) {
      throw new Brc38StagingCleanupError(
        [cause, error_],
        'Streamed browser import retains original physical resource owners',
        cleanup
      )
    }
    throw cause
  }
}
