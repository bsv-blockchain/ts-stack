import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'

export interface Brc39StreamPolicy {
  maximumFileBytes: number
  maximumChunkBytes: number
  maximumIterations: number
  maximumMemoryKiB: number
  maximumParallelism: number
}
export interface Brc39StreamKdf {
  iterations: number
  memoryKiB: number
  parallelism: number
}
export interface Brc39StreamHeader extends Brc39StreamKdf {
  salt: Uint8Array
  nonce: Uint8Array
}
export const BRC39_STREAM_DEFAULT_KDF: Readonly<Brc39StreamKdf> = Object.freeze({
  iterations: 7,
  memoryKiB: 131072,
  parallelism: 1
})
const fixedHeaderBytes = 33
const tagBytes = 16
const maximumPrefixBytes = fixedHeaderBytes + 255 + 255
const constants = [0x57, 0x44, 0x41, 0x54, 1, 1, 38, 1, 0]

function positive(value: number, maximum: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new RangeError(`${name} must be a positive integer no greater than ${maximum}`)
}
function copyPolicy(policy: Brc39StreamPolicy): Readonly<Brc39StreamPolicy> {
  const result = { ...policy }
  positive(result.maximumFileBytes, Number.MAX_SAFE_INTEGER, 'maximumFileBytes')
  positive(result.maximumChunkBytes, 65536, 'maximumChunkBytes')
  positive(result.maximumIterations, 0xffffffff, 'maximumIterations')
  positive(result.maximumMemoryKiB, 0xffffffff, 'maximumMemoryKiB')
  positive(result.maximumParallelism, 255, 'maximumParallelism')
  return Object.freeze(result)
}
function admitKdf(kdf: Brc39StreamKdf, policy: Readonly<Brc39StreamPolicy>): void {
  positive(kdf.iterations, 0xffffffff, 'iterations')
  positive(kdf.memoryKiB, 0xffffffff, 'memoryKiB')
  positive(kdf.parallelism, 255, 'parallelism')
  if (
    kdf.iterations > policy.maximumIterations ||
    kdf.memoryKiB > policy.maximumMemoryKiB ||
    kdf.parallelism > policy.maximumParallelism
  )
    throw new SnapshotResourceLimitError('BRC-39 KDF exceeds the selected stream work policy')
}
function readKdf(prefix: Uint8Array, policy: Readonly<Brc39StreamPolicy>): Readonly<Brc39StreamKdf> {
  for (let index = 0; index < constants.length; index++)
    if (prefix[index] !== constants[index]) throw new TypeError('Unsupported BRC-39 fixed header')
  if (prefix[9] === 0 || prefix[10] === 0 || prefix[20] !== 32)
    throw new TypeError('Invalid BRC-39 salt, nonce or key length')
  for (let index = 21; index < fixedHeaderBytes; index++)
    if (prefix[index] !== 0) throw new TypeError('Invalid BRC-39 reserved bytes')
  const view = new DataView(prefix.buffer, prefix.byteOffset, fixedHeaderBytes)
  const kdf = { iterations: view.getUint32(11), memoryKiB: view.getUint32(15), parallelism: prefix[19] }
  admitKdf(kdf, policy)
  return Object.freeze(kdf)
}

/** Bounded prefix encoder. Salt and nonce must come from the host's secure
 * random source for each export. This does not validate or encrypt BRC-38.
 * Explicit stream work limits never alter the existing materialized API.
 */
export function encodeBrc39StreamPrefix(
  options: Brc39StreamKdf,
  salt: Uint8Array,
  nonce: Uint8Array,
  policy: Brc39StreamPolicy
): Uint8Array {
  const kdf = { ...options }
  const admitted = copyPolicy(policy)
  admitKdf(kdf, admitted)
  if (kdf.iterations < 7 || kdf.memoryKiB < 131072)
    throw new RangeError('BRC-39 new exports require at least the canonical KDF strength')
  if (!(salt instanceof Uint8Array) || salt.length !== 32 || !(nonce instanceof Uint8Array) || nonce.length !== 32)
    throw new TypeError('BRC-39 new exports require 32-byte salt and nonce')
  const result = new Uint8Array(fixedHeaderBytes + salt.length + nonce.length)
  if (result.length + tagBytes + 1 > admitted.maximumFileBytes)
    throw new SnapshotResourceLimitError('BRC-39 prefix exceeds the selected file policy')
  result.set(constants)
  result[9] = salt.length
  result[10] = nonce.length
  const view = new DataView(result.buffer)
  view.setUint32(11, kdf.iterations)
  view.setUint32(15, kdf.memoryKiB)
  result[19] = kdf.parallelism
  result[20] = 32
  result.set(salt, fixedHeaderBytes)
  result.set(nonce, fixedHeaderBytes + salt.length)
  return result
}

/** Incremental envelope framing only. Emitted ciphertext is unauthenticated;
 * decrypt it solely into an isolated quarantine. The caller must verify GCM
 * and then valid UTF-8/BRC-38 before import or activation. Header is not AAD.
 * Holds at most the 543-byte prefix plus the 16-byte trailing tag; each input
 * and detached output is bounded by an explicit policy. No crypto is run.
 */
export class Brc39StreamFrame {
  private readonly policy: Readonly<Brc39StreamPolicy>
  private readonly prefix = new Uint8Array(maximumPrefixBytes)
  private prefixUsed = 0
  private prefixRequired = fixedHeaderBytes
  private kdf: Readonly<Brc39StreamKdf> | undefined
  private readonly tail = new Uint8Array(tagBytes)
  private tailUsed = 0
  private fileBytes = 0
  private ciphertextBytes = 0
  private closed = false

  constructor(policy: Brc39StreamPolicy) {
    this.policy = copyPolicy(policy)
  }
  private live(): void {
    if (this.closed) throw new Error('BRC-39 stream frame is closed')
  }
  private collectPrefix(input: Uint8Array): number {
    let offset = 0
    while (this.prefixUsed < this.prefixRequired && offset < input.length) {
      const count = Math.min(this.prefixRequired - this.prefixUsed, input.length - offset)
      this.prefix.set(input.subarray(offset, offset + count), this.prefixUsed)
      this.prefixUsed += count
      offset += count
      if (this.prefixUsed === fixedHeaderBytes && this.kdf === undefined) {
        this.kdf = readKdf(this.prefix, this.policy)
        this.prefixRequired = fixedHeaderBytes + this.prefix[9] + this.prefix[10]
        if (this.prefixRequired + tagBytes + 1 > this.policy.maximumFileBytes)
          throw new SnapshotResourceLimitError('BRC-39 prefix exceeds the selected file policy')
      }
    }
    return offset
  }
  private ciphertext(input: Uint8Array): Uint8Array[] {
    const emit = Math.max(0, this.tailUsed + input.length - tagBytes)
    const fromTail = Math.min(emit, this.tailUsed)
    const fromInput = emit - fromTail
    const result: Uint8Array[] = []
    if (fromTail !== 0) result.push(this.tail.slice(0, fromTail))
    if (fromInput !== 0) result.push(input.slice(0, fromInput))
    this.tail.copyWithin(0, fromTail, this.tailUsed)
    this.tailUsed -= fromTail
    this.tail.set(input.subarray(fromInput), this.tailUsed)
    this.tailUsed += input.length - fromInput
    this.ciphertextBytes += emit
    return result
  }
  accept(chunk: Uint8Array): Uint8Array[] {
    this.live()
    try {
      if (!(chunk instanceof Uint8Array)) throw new TypeError('BRC-39 stream requires byte chunks')
      if (chunk.length > this.policy.maximumChunkBytes)
        throw new SnapshotResourceLimitError('BRC-39 input chunk exceeds the selected stream policy')
      if (chunk.length > this.policy.maximumFileBytes - this.fileBytes)
        throw new SnapshotResourceLimitError('BRC-39 file exceeds the selected stream policy')
      this.fileBytes += chunk.length
      const offset = this.collectPrefix(chunk)
      if (this.prefixUsed < this.prefixRequired) return []
      return this.ciphertext(chunk.subarray(offset))
    } catch (error) {
      this.closed = true
      throw error
    }
  }
  /** Every returned byte array is detached from both caller and frame state. */
  header(): Brc39StreamHeader | undefined {
    this.live()
    if (this.kdf === undefined || this.prefixUsed < this.prefixRequired) return undefined
    const saltEnd = fixedHeaderBytes + this.prefix[9]
    return {
      ...this.kdf,
      salt: this.prefix.slice(fixedHeaderBytes, saltEnd),
      nonce: this.prefix.slice(saltEnd, this.prefixRequired)
    }
  }
  finish(): Readonly<{ tag: Uint8Array; fileBytes: number; ciphertextBytes: number }> {
    this.live()
    this.closed = true
    if (
      this.kdf === undefined ||
      this.prefixUsed < this.prefixRequired ||
      this.tailUsed !== tagBytes ||
      this.ciphertextBytes === 0
    )
      throw new TypeError('Truncated or empty BRC-39 ciphertext')
    return Object.freeze({ tag: this.tail.slice(), fileBytes: this.fileBytes, ciphertextBytes: this.ciphertextBytes })
  }
}
