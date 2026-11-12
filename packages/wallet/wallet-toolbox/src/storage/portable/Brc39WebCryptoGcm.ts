import { awaitFromSync } from '../../utility/promiseFromSync'
import { ghash, multiply } from '@bsv/sdk/primitives/AESGCM'
import { detachBrc38PrivateChunk } from './Brc38PrivateChunkPipe'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'

export interface Brc39WebCryptoGcmOptions {
  readonly maximumChunkBytes: number
  readonly maximumPlaintextBytes: number
  readonly maximumAllocationBytes: number
  readonly expiresAt: number
  readonly cleanupMilliseconds: number
  readonly signal?: AbortSignal
}
const maximumGcmBytes = 16 * (2 ** 32 - 2)
function bound(value: number, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new RangeError('Invalid incremental browser GCM bound')
}
function increment(counter: Uint8Array, blocks: number): void {
  const view = new DataView(counter.buffer, counter.byteOffset, 16)
  view.setUint32(12, (view.getUint32(12) + blocks) >>> 0)
}
function bitLength(block: Uint8Array, bytes: number): void {
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength),
    bits = bytes * 8
  view.setUint32(8, Math.floor(bits / 2 ** 32))
  view.setUint32(12, bits >>> 0)
}
interface Calendar {
  wall: number
  began: number
  milliseconds: number
}
async function bounded<T>(operation: Promise<T>, selected: Calendar, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted()
  const left = Math.min(selected.wall - Date.now(), selected.milliseconds - (performance.now() - selected.began))
  if (left <= 0) throw new SnapshotResourceLimitError('Incremental browser crypto calendar ended')
  let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new SnapshotResourceLimitError('Incremental browser crypto calendar ended')),
          left
        )
        if (signal !== undefined) {
          abort = () => reject(signal.reason)
          signal.addEventListener('abort', abort, { once: true })
          if (signal.aborted) abort()
        }
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (abort !== undefined) signal!.removeEventListener('abort', abort)
  }
}

/** Internal incremental GCM, no AAD, 128-bit tag. Native WebCrypto AES-CTR
 * supplies AES blocks and inc32 GCTR; the existing SDK GHASH multiplication
 * supplies the authentication accumulator (SP800-38D sections 6/7). Keeping a
 * partial block across calls preserves arbitrary input boundaries. The SDK's
 * JavaScript GHASH has no strict constant-time or secure-erasure guarantee;
 * this path is not a capability advertisement or qualification for shared-CPU
 * hostile contexts. Provisional output belongs ONLY in an isolated quarantine.
 * https://www.w3.org/TR/2017/REC-WebCryptoAPI-20170126/#aes-ctr
 * https://nvlpubs.nist.gov/nistpubs/legacy/sp/nistspecialpublication800-38d.pdf
 */
export class Brc39WebCryptoGcm {
  readonly #options: Readonly<Brc39WebCryptoGcmOptions>
  readonly #mode: 'encrypt' | 'decrypt'
  readonly #began = performance.now()
  readonly #lifetime: number
  readonly #subtle: SubtleCrypto
  readonly #import: typeof SubtleCrypto.prototype.importKey
  readonly #encrypt: typeof SubtleCrypto.prototype.encrypt
  #key: CryptoKey | undefined
  #hashKey = new Uint8Array(16)
  #hash = new Uint8Array(16)
  #counter = new Uint8Array(16)
  #mask = new Uint8Array(16)
  #carry = new Uint8Array(16)
  #carryBytes = 0
  #bytes = 0
  #blocks = 0
  #busy = false
  #closed = false
  #finished = false
  #pending: Promise<void> | undefined
  #closing = false
  private constructor(selected: Brc39WebCryptoGcmOptions, mode: 'encrypt' | 'decrypt') {
    this.#mode = mode
    this.#options = Object.freeze({ ...selected })
    bound(this.#options.maximumChunkBytes, 16, 65536)
    bound(this.#options.maximumPlaintextBytes, 1, maximumGcmBytes)
    bound(this.#options.maximumAllocationBytes, 65536, 16777216)
    bound(this.#options.expiresAt, 1, Number.MAX_SAFE_INTEGER)
    bound(this.#options.cleanupMilliseconds, 1, 30000)
    if (16384 + 16 * this.#options.maximumChunkBytes > this.#options.maximumAllocationBytes)
      throw new SnapshotResourceLimitError('Incremental browser crypto exceeds original allocation')
    this.#lifetime = this.#options.expiresAt - Date.now()
    if (typeof SubtleCrypto === 'undefined' || globalThis.crypto?.subtle === undefined)
      throw new Error('Incremental browser GCM requires native WebCrypto')
    this.#subtle = globalThis.crypto.subtle
    this.#import = SubtleCrypto.prototype.importKey
    this.#encrypt = SubtleCrypto.prototype.encrypt
  }
  #check(): void {
    this.#options.signal?.throwIfAborted()
    if (this.#closed || this.#finished) throw new Error('Incremental browser GCM is closed')
    if (Date.now() >= this.#options.expiresAt || performance.now() - this.#began >= this.#lifetime)
      throw new SnapshotResourceLimitError('Incremental browser GCM original lifetime ended')
  }
  async #native<T>(operation: () => Promise<T>, erase: (value: T) => void): Promise<T> {
    this.#check()
    if (this.#pending !== undefined) throw new Error('Incremental browser crypto already owns a native operation')
    const result: { received?: { value: T } } = {}
    let abandoned = false
    const pending = Promise.resolve()
      .then(() =>
        awaitFromSync(() => {
          this.#check()
          return operation()
        })
      )
      .then(value => {
        result.received = { value }
        if (abandoned || this.#closed) {
          erase(value)
          result.received = undefined
        }
      })
    this.#pending = pending
    void pending.catch(() => {})
    const milliseconds = Math.min(
      30000,
      this.#options.expiresAt - Date.now(),
      this.#lifetime - (performance.now() - this.#began)
    )
    try {
      await bounded(
        pending,
        { wall: Date.now() + milliseconds, began: performance.now(), milliseconds },
        this.#options.signal
      )
      this.#check()
      if (result.received === undefined) throw new Error('Incremental browser crypto lost its owned result')
      this.#pending = undefined
      return result.received.value
    } catch (cause) {
      abandoned = true
      if (result.received !== undefined) {
        erase(result.received.value)
        result.received = undefined
      }
      throw cause
    }
  }
  async #ctr(input: Uint8Array, counter: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
    if (this.#key === undefined) throw new Error('Incremental browser GCM has no platform key')
    const key = this.#key,
      copiedCounter = counter.slice(),
      copiedInput = input.slice()
    try {
      const output = await this.#native(
        async () => {
          try {
            const bytes: ArrayBuffer = await Reflect.apply(this.#encrypt, this.#subtle, [
              { name: 'AES-CTR', counter: copiedCounter, length: 32 },
              key,
              copiedInput
            ])
            return new Uint8Array(bytes)
          } finally {
            copiedInput.fill(0)
            copiedCounter.fill(0)
          }
        },
        value => value.fill(0)
      )
      if (output.byteLength !== input.byteLength) {
        output.fill(0)
        throw new Error('Native CTR changed the admitted extent')
      }
      return output
    } catch (cause) {
      // A queued operation can fail before its body runs. Owned copies are
      // still safe to erase: WebCrypto captures its own bytes at invocation.
      copiedInput.fill(0)
      copiedCounter.fill(0)
      throw cause
    }
  }
  static create(key: Uint8Array, nonce: Uint8Array, selected: Brc39WebCryptoGcmOptions): Promise<Brc39WebCryptoGcm> {
    return awaitFromSync(() => Brc39WebCryptoGcm.#create(key, nonce, selected, 'decrypt'))
  }
  static createEncryptor(
    key: Uint8Array,
    nonce: Uint8Array,
    selected: Brc39WebCryptoGcmOptions
  ): Promise<Brc39WebCryptoGcm> {
    return awaitFromSync(() => Brc39WebCryptoGcm.#create(key, nonce, selected, 'encrypt'))
  }
  static async #create(
    key: Uint8Array,
    nonce: Uint8Array,
    selected: Brc39WebCryptoGcmOptions,
    mode: 'encrypt' | 'decrypt'
  ): Promise<Brc39WebCryptoGcm> {
    const owner = new Brc39WebCryptoGcm(selected, mode)
    let raw: Uint8Array | undefined, iv: Uint8Array | undefined, material: Uint8Array | undefined
    try {
      owner.#check()
      raw = detachBrc38PrivateChunk(key, 32)
      iv = detachBrc38PrivateChunk(nonce, 255)
      if (raw.byteLength !== 32 || iv.byteLength === 0) throw new TypeError('Invalid BRC-39 AES key or nonce')
      const ownedRaw = raw
      owner.#key = await owner.#native(
        async () => {
          try {
            return (await Reflect.apply(owner.#import, owner.#subtle, [
              'raw',
              ownedRaw,
              { name: 'AES-CTR' },
              false,
              ['encrypt']
            ])) as CryptoKey
          } finally {
            ownedRaw.fill(0)
          }
        },
        () => {}
      )
      raw.fill(0)
      const hashKey = await owner.#ctr(new Uint8Array(16), new Uint8Array(16))
      owner.#hashKey.set(hashKey)
      hashKey.fill(0)
      if (iv.byteLength === 12) {
        owner.#counter.set(iv)
        owner.#counter[15] = 1
      } else {
        material = new Uint8Array(Math.ceil(iv.byteLength / 16) * 16 + 16)
        material.set(iv)
        bitLength(material.subarray(material.byteLength - 16), iv.byteLength)
        const initial = ghash(material, owner.#hashKey)
        owner.#counter.set(initial)
        initial.fill(0)
        material.fill(0)
      }
      const mask = await owner.#ctr(new Uint8Array(16), owner.#counter)
      owner.#mask.set(mask)
      mask.fill(0)
      increment(owner.#counter, 1)
      return owner
    } catch (cause) {
      try {
        await owner.close()
      } catch (error_) {
        throw new Brc38StagingCleanupError(
          [cause, error_],
          'Incremental browser GCM initialization retains native drain',
          () => awaitFromSync(() => owner.close())
        )
      }
      throw cause
    } finally {
      raw?.fill(0)
      iv?.fill(0)
      material?.fill(0)
    }
  }
  async #accumulate(input: Uint8Array): Promise<void> {
    const block = new Uint8Array(16)
    try {
      for (let offset = 0; offset < input.byteLength; offset += 16) {
        block.set(this.#hash)
        for (let index = 0; index < 16; index++) block[index] ^= input[offset + index] ?? 0
        const next = multiply(block, this.#hashKey)
        this.#hash.set(next)
        next.fill(0)
        if ((offset / 16 + 1) % 256 === 0) {
          await new Promise<void>(resolve => setTimeout(resolve, 0))
          this.#check()
        }
      }
    } finally {
      block.fill(0)
    }
  }
  async update(input: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
    this.#check()
    if (this.#busy) throw new Error('Incremental browser GCM operation already owned')
    this.#busy = true
    let bytes: Uint8Array | undefined, combined: Uint8Array | undefined
    try {
      bytes = detachBrc38PrivateChunk(input, this.#options.maximumChunkBytes)
      if (bytes.byteLength > this.#options.maximumPlaintextBytes - this.#bytes)
        throw new SnapshotResourceLimitError('Incremental browser GCM byte bound reached')
      this.#bytes += bytes.byteLength
      combined = new Uint8Array(this.#carryBytes + bytes.byteLength)
      combined.set(this.#carry.subarray(0, this.#carryBytes))
      combined.set(bytes, this.#carryBytes)
      const full = Math.floor(combined.byteLength / 16) * 16
      this.#carry.fill(0)
      this.#carry.set(combined.subarray(full))
      this.#carryBytes = combined.byteLength - full
      if (full === 0) return new Uint8Array(0)
      if (this.#blocks + full / 16 > 2 ** 32 - 2) throw new SnapshotResourceLimitError('GCM counter sequence exhausted')
      const output = new Uint8Array(full),
        maximum = Math.floor(this.#options.maximumChunkBytes / 16) * 16
      try {
        for (let offset = 0; offset < full; offset += maximum) {
          const cipher = combined.subarray(offset, Math.min(full, offset + maximum))
          const transformed = await this.#ctr(cipher, this.#counter)
          try {
            await this.#accumulate(this.#mode === 'encrypt' ? transformed : cipher)
            output.set(transformed, offset)
          } finally {
            transformed.fill(0)
          }
          increment(this.#counter, cipher.byteLength / 16)
          this.#blocks += cipher.byteLength / 16
        }
        this.#check()
        return output
      } catch (cause) {
        output.fill(0)
        throw cause
      }
    } catch (cause) {
      this.#closed = true
      throw cause
    } finally {
      bytes?.fill(0)
      combined?.fill(0)
      this.#busy = false
    }
  }
  /** Verifies the original full tag before returning the final partial block.
   * Earlier update output remains unauthenticated until this succeeds. */
  async finish(inputTag: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
    this.#check()
    if (this.#mode !== 'decrypt') throw new Error('Encryption requires finishEncryption')
    if (this.#busy) throw new Error('Incremental browser GCM operation already owned')
    this.#busy = true
    let tag: Uint8Array | undefined, output: Uint8Array<ArrayBuffer> | undefined
    const lengths = new Uint8Array(16)
    try {
      tag = detachBrc38PrivateChunk(inputTag, 16)
      if (tag.byteLength !== 16) throw new TypeError('BRC-39 requires its complete 128-bit tag')
      if (this.#carryBytes !== 0) {
        await this.#accumulate(this.#carry)
        output = await this.#ctr(this.#carry.subarray(0, this.#carryBytes), this.#counter)
      } else output = new Uint8Array(0)
      bitLength(lengths, this.#bytes)
      await this.#accumulate(lengths)
      let difference = 0
      for (let index = 0; index < 16; index++) difference |= tag[index] ^ this.#hash[index] ^ this.#mask[index]
      if (difference !== 0) throw new Error('BRC-39 incremental browser authentication failed')
      this.#check()
      this.#finished = true
      return output
    } catch (cause) {
      output?.fill(0)
      this.#closed = true
      throw cause
    } finally {
      tag?.fill(0)
      lengths.fill(0)
      this.#busy = false
    }
  }
  /** Returns the final partial ciphertext and complete tag. A host must still
   * validate its coherent plaintext source before publishing that tag/file. */
  async finishEncryption(): Promise<Readonly<{ ciphertext: Uint8Array<ArrayBuffer>; tag: Uint8Array<ArrayBuffer> }>> {
    this.#check()
    if (this.#mode !== 'encrypt') throw new Error('Decryption requires its original authentication tag')
    if (this.#busy) throw new Error('Incremental browser GCM operation already owned')
    this.#busy = true
    let output: Uint8Array<ArrayBuffer> | undefined, tag: Uint8Array<ArrayBuffer> | undefined
    const lengths = new Uint8Array(16)
    try {
      output =
        this.#carryBytes === 0
          ? new Uint8Array(0)
          : await this.#ctr(this.#carry.subarray(0, this.#carryBytes), this.#counter)
      if (output.byteLength !== 0) await this.#accumulate(output)
      bitLength(lengths, this.#bytes)
      await this.#accumulate(lengths)
      tag = new Uint8Array(16)
      for (let index = 0; index < 16; index++) tag[index] = this.#hash[index] ^ this.#mask[index]
      this.#check()
      this.#finished = true
      return Object.freeze({ ciphertext: output, tag })
    } catch (cause) {
      output?.fill(0)
      tag?.fill(0)
      this.#closed = true
      throw cause
    } finally {
      lengths.fill(0)
      this.#busy = false
    }
  }
  async close(): Promise<void> {
    if (this.#closing) throw new Error('Incremental browser GCM cleanup already owned')
    this.#closed = true
    this.#closing = true
    try {
      if (this.#busy) throw new Error('Await the current incremental browser GCM operation before physical close')
      if (this.#pending !== undefined) {
        const milliseconds = this.#options.cleanupMilliseconds
        await bounded(
          this.#pending.then(
            () => {},
            () => {}
          ),
          { wall: Date.now() + milliseconds, began: performance.now(), milliseconds }
        )
        this.#pending = undefined
      }
      // WebCrypto has no key-destruction API. Drop our nonextractable platform
      // key only after actual settlement; erase every reachable owned buffer.
      this.#key = undefined
      this.#hashKey.fill(0)
      this.#hash.fill(0)
      this.#counter.fill(0)
      this.#mask.fill(0)
      this.#carry.fill(0)
      this.#carryBytes = 0
    } catch (error_) {
      throw new Brc38StagingCleanupError([error_], 'Incremental browser GCM retains actual native operation', () =>
        awaitFromSync(() => this.close())
      )
    } finally {
      this.#closing = false
    }
  }
}
