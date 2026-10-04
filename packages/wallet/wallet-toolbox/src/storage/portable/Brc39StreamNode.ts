import {
  createCipheriv,
  createDecipheriv,
  getCipherInfo,
  randomBytes,
  type CipherGCM,
  type DecipherGCM
} from 'node:crypto'
import { toArray } from '@bsv/sdk/primitives/utils'
import { argon2id } from '../../utility/hashWasm'
import { runInSeries } from '../../utility/runInSeries'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'
import {
  Brc39StreamFrame,
  encodeBrc39StreamPrefix,
  BRC39_STREAM_DEFAULT_KDF,
  type Brc39StreamPolicy,
  type Brc39StreamHeader,
  type Brc39StreamKdf
} from './Brc39Frame'

/** Host-owned private staging only. appendUntrusted must detach before its
 * promise settles; no reader, import or activation may observe those bytes.
 * validateAuthenticated must validate strict UTF8 and the complete BRC-38
 * document within its own bounded storage/validation implementation. */
export interface Brc39StreamQuarantine {
  appendUntrusted: (bytes: Uint8Array) => Promise<void>
  validateAuthenticated: () => Promise<void>
  discard: () => Promise<void>
}
export interface Brc39NodeStreamOptions {
  policy: Brc39StreamPolicy
  maximumPasswordBytes: number
  signal?: AbortSignal
  onProgress?: (progress: Readonly<{ fileBytes: number; plaintextBytes: number }>) => void
}
interface CryptoOwnership {
  cipher?: { destroy: () => void }
  key?: Uint8Array
}
interface Session extends CryptoOwnership {
  cipher?: DecipherGCM
  plaintextBytes: number
  fileBytes: number
}
function passwordLimit(maximumPasswordBytes: number): void {
  if (!Number.isSafeInteger(maximumPasswordBytes) || maximumPasswordBytes < 1 || maximumPasswordBytes > 65536)
    throw new RangeError('maximumPasswordBytes must be an integer from 1 to 65536')
}
async function deriveKey(
  header: Brc39StreamHeader,
  password: string,
  maximumPasswordBytes: number
): Promise<Uint8Array> {
  // Refuse impossible inputs before normalization/conversion. The temporary
  // UTF8 conversion is bounded by four bytes per admitted UTF16 unit.
  if (password.length > maximumPasswordBytes)
    throw new SnapshotResourceLimitError('BRC-39 password exceeds the selected stream policy')
  const normalized = password.normalize('NFC')
  if (normalized.length > maximumPasswordBytes)
    throw new SnapshotResourceLimitError('BRC-39 normalized password exceeds the selected stream policy')
  const bytes = new Uint8Array(toArray(normalized, 'utf8'))
  try {
    if (bytes.length > maximumPasswordBytes)
      throw new SnapshotResourceLimitError('BRC-39 encoded password exceeds the selected stream policy')
    const result = await argon2id({
      password: bytes,
      salt: header.salt,
      iterations: header.iterations,
      memorySize: header.memoryKiB,
      parallelism: header.parallelism,
      hashLength: 32,
      outputType: 'binary'
    })
    if (!(result instanceof Uint8Array) || result.length !== 32) throw new TypeError('Invalid BRC-39 derived key')
    return new Uint8Array(result)
  } finally {
    bytes.fill(0)
  }
}
function release(session: CryptoOwnership): void {
  const { cipher, key } = session
  session.cipher = undefined
  session.key = undefined
  try {
    cipher?.destroy()
  } finally {
    key?.fill(0)
  }
}
async function discard(quarantine: Pick<Brc39StreamQuarantine, 'discard'>, original: unknown): Promise<never> {
  try {
    await quarantine.discard()
  } catch (cleanup) {
    throw new AggregateError([original, cleanup], 'BRC-39 processing and quarantine cleanup failed', {
      cause: original
    })
  }
  throw original
}

/** Complete semantics must be checked by the coherent BRC-38 producer. This
 * final check runs after all chunks, before a tag or success can be published.
 * A crypto success receipt alone does not establish source/archive semantics. */
export interface Brc39StreamPlaintext {
  chunks: AsyncIterable<Uint8Array>
  validateCompleted: () => Promise<void>
  /** Optional backwards-compatible owned-source cleanup. Must be idempotent
   * and wait for pending source I/O. Called before publication and on failure. */
  close?: () => Promise<void>
}
/** Host-owned private output. appendUntrusted must detach before settling and
 * must not expose a partial file. Only the successful receipt permits the host
 * to complete its own durable file transaction. */
export interface Brc39StreamOutput {
  appendUntrusted: (bytes: Uint8Array) => Promise<void>
  discard: () => Promise<void>
}
export interface Brc39NodeEncryptOptions extends Brc39NodeStreamOptions {
  /** Defaults to the existing canonical strength; weaker new exports refuse. */
  kdf?: Brc39StreamKdf
}
interface EncryptSession extends CryptoOwnership {
  cipher?: CipherGCM
  plaintextBytes: number
  fileBytes: number
}
async function closeFailedSource(source: Brc39StreamPlaintext, original: unknown): Promise<unknown> {
  try {
    await source.close?.()
    return original
  } catch (cleanup) {
    if (cleanup === original) return original
    return new AggregateError([original, cleanup], 'BRC-39 encryption and source cleanup failed', { cause: original })
  }
}
function* splitOutput(bytes: Uint8Array, maximumChunkBytes: number): Generator<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += maximumChunkBytes)
    yield bytes.slice(offset, offset + maximumChunkBytes)
}

/** Node-only bounded encryption component using native secure random
 * salt/nonce and GCM, plus the existing Argon2id selection/NFC rules. Its output
 * is the standard envelope, without AAD or an additional wrapper. One source
 * chunk is consumed at a time; all writes, including prefix/tag, obey the same
 * byte ceiling and private-staging backpressure. The source must independently
 * validate complete semantics; hosts own durable file activation and adapters. */
export async function encryptBrc39StreamToQuarantine(
  source: Brc39StreamPlaintext,
  password: string,
  output: Brc39StreamOutput,
  options: Brc39NodeEncryptOptions
): Promise<Readonly<{ fileBytes: number; plaintextBytes: number }>> {
  const { maximumPasswordBytes, signal, onProgress } = options
  const session: EncryptSession = { plaintextBytes: 0, fileBytes: 0 }
  try {
    passwordLimit(maximumPasswordBytes)
    signal?.throwIfAborted()
    const policy = Object.freeze({ ...options.policy })
    const kdf = { ...(options.kdf ?? BRC39_STREAM_DEFAULT_KDF) }
    const salt = new Uint8Array(randomBytes(32))
    const nonce = new Uint8Array(randomBytes(32))
    const prefix = encodeBrc39StreamPrefix(kdf, salt, nonce, policy)
    session.key = await deriveKey({ ...kdf, salt, nonce }, password, maximumPasswordBytes)
    signal?.throwIfAborted()
    session.cipher = createCipheriv('aes-256-gcm', session.key, nonce, { authTagLength: 16 })
    const write = async (bytes: Uint8Array): Promise<void> => {
      await runInSeries(splitOutput(bytes, policy.maximumChunkBytes), async chunk => {
        signal?.throwIfAborted()
        await output.appendUntrusted(chunk)
        session.fileBytes += chunk.length
        signal?.throwIfAborted()
      })
    }
    await write(prefix)
    const consume = async (input: Uint8Array): Promise<Readonly<{ fileBytes: number; plaintextBytes: number }>> => {
      signal?.throwIfAborted()
      if (!(input instanceof Uint8Array)) throw new TypeError('BRC-39 plaintext stream requires byte chunks')
      if (input.length > policy.maximumChunkBytes)
        throw new SnapshotResourceLimitError('BRC-39 plaintext chunk exceeds the selected stream policy')
      if (input.length > policy.maximumFileBytes - session.fileBytes - 16)
        throw new SnapshotResourceLimitError('BRC-39 export exceeds the selected file policy')
      if (session.cipher === undefined) throw new Error('BRC-39 encryption context is closed')
      const ciphertext = session.cipher.update(input)
      if (ciphertext.length !== input.length) throw new Error('Selected GCM backend buffered ciphertext')
      await write(new Uint8Array(ciphertext))
      session.plaintextBytes += input.length
      return Object.freeze({ fileBytes: session.fileBytes, plaintextBytes: session.plaintextBytes })
    }
    async function* operations() {
      for await (const chunk of source.chunks) yield consume(chunk)
    }
    for await (const progress of operations()) onProgress?.(progress)
    signal?.throwIfAborted()
    if (session.plaintextBytes === 0) throw new TypeError('BRC-39 plaintext stream is empty')
    if (session.cipher.final().length !== 0) throw new Error('Selected GCM backend buffered final ciphertext')
    const tag = new Uint8Array(session.cipher.getAuthTag())
    release(session)
    signal?.throwIfAborted()
    await source.validateCompleted()
    signal?.throwIfAborted()
    await source.close?.()
    signal?.throwIfAborted()
    await write(tag)
    const result = Object.freeze({ fileBytes: session.fileBytes, plaintextBytes: session.plaintextBytes })
    onProgress?.(result)
    return result
  } catch (error) {
    let failure = error
    try {
      release(session)
    } catch (cleanup) {
      failure = new AggregateError([error, cleanup], 'BRC-39 encryption and crypto cleanup failed', { cause: error })
    }
    return await discard(output, await closeFailedSource(source, failure))
  }
}
async function start(
  session: Session,
  header: Brc39StreamHeader,
  password: string,
  maximumPasswordBytes: number,
  signal: AbortSignal | undefined
): Promise<void> {
  if (getCipherInfo('aes-256-gcm', { keyLength: 32, ivLength: header.nonce.length }) === undefined)
    throw new Error('Selected Node AES-GCM backend cannot process this BRC-39 nonce length')
  signal?.throwIfAborted()
  session.key = await deriveKey(header, password, maximumPasswordBytes)
  // Cancellation waits for the owned derivation to settle before releasing it.
  signal?.throwIfAborted()
  session.cipher = createDecipheriv('aes-256-gcm', session.key, header.nonce, { authTagLength: 16 })
}
/** Node-only authenticated streaming into a host-owned private quarantine.
 * Uses the existing Argon2id backend selection/NFC encoding and native GCM.
 * Source chunks and provisional plaintext stay bounded with serial staging
 * backpressure. No document/file byte array is assembled by this component.
 * A successful result follows GCM completion and the quarantine's independent
 * semantic validation; durable token/activation/platform integration remains
 * the caller's responsibility. Unsupported native nonce lengths refuse before
 * KDF; the existing materialized codec retains its accepted inputs unchanged.
 */
export async function decryptBrc39StreamToQuarantine(
  source: AsyncIterable<Uint8Array>,
  password: string,
  quarantine: Brc39StreamQuarantine,
  options: Brc39NodeStreamOptions
): Promise<Readonly<{ fileBytes: number; plaintextBytes: number }>> {
  const { maximumPasswordBytes, signal, onProgress } = options
  const session: Session = { fileBytes: 0, plaintextBytes: 0 }
  try {
    passwordLimit(maximumPasswordBytes)
    const frame = new Brc39StreamFrame(options.policy)
    signal?.throwIfAborted()
    async function consume(input: Uint8Array): Promise<Readonly<{ fileBytes: number; plaintextBytes: number }>> {
      signal?.throwIfAborted()
      const ciphertext = frame.accept(input)
      session.fileBytes += input.length
      if (session.cipher === undefined) {
        const header = frame.header()
        if (header !== undefined) await start(session, header, password, maximumPasswordBytes, signal)
      }
      await runInSeries(ciphertext, async chunk => {
        signal?.throwIfAborted()
        if (session.cipher === undefined) throw new Error('BRC-39 ciphertext arrived before a complete header')
        const plaintext = session.cipher.update(chunk)
        if (plaintext.length !== chunk.length) throw new Error('Selected GCM backend buffered provisional plaintext')
        await quarantine.appendUntrusted(new Uint8Array(plaintext))
        session.plaintextBytes += plaintext.length
        signal?.throwIfAborted()
      })
      return Object.freeze({ fileBytes: session.fileBytes, plaintextBytes: session.plaintextBytes })
    }
    async function* operations() {
      for await (const chunk of source) yield consume(chunk)
    }
    for await (const progress of operations()) {
      onProgress?.(progress)
    }
    signal?.throwIfAborted()
    const end = frame.finish()
    if (session.cipher === undefined) throw new TypeError('BRC-39 stream has no decryptor')
    session.cipher.setAuthTag(end.tag)
    const final = session.cipher.final()
    if (final.length !== 0 || session.plaintextBytes !== end.ciphertextBytes)
      throw new Error('Selected GCM backend did not preserve the complete plaintext length')
    release(session)
    signal?.throwIfAborted()
    await quarantine.validateAuthenticated()
    signal?.throwIfAborted()
    return Object.freeze({ fileBytes: end.fileBytes, plaintextBytes: session.plaintextBytes })
  } catch (error) {
    try {
      release(session)
    } catch (cleanup) {
      return await discard(
        quarantine,
        new AggregateError([error, cleanup], 'BRC-39 processing and crypto cleanup failed', { cause: error })
      )
    }
    return await discard(quarantine, error)
  }
}
