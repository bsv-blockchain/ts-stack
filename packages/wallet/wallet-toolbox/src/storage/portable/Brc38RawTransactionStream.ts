import { Brc38CleanupScope } from './Brc38StagingCleanupError'
import { SHA256 } from '@bsv/sdk/primitives/Hash'
import { toHex } from '@bsv/sdk/primitives/utils'
import { detachBrc38PrivateChunk } from './Brc38PrivateChunkPipe'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'

export interface Brc38RawTransactionStreamPolicy {
  readonly bytes: number
  readonly sha256: string
  readonly maximumBytes: number
  readonly maximumChunks: number
  readonly expiresAt: number
  readonly signal?: AbortSignal
}
export interface Brc38RawTransactionSummary {
  readonly version: number
  readonly inputs: number
  readonly outputs: number
  readonly lockTime: number
  readonly bytes: number
  readonly sha256: string
  readonly txid: string
}
function invalid(): never {
  throw new TypeError('Invalid streamed raw transaction framing or content')
}
/** Raw transaction structure follows SDK Transaction.fromBinaryView and its
 * unsigned canonical CompactSize reader. Scripts are opaque byte extents, as
 * in the SDK's lazy raw script view; this is not consensus/script verification.
 * Source ownership and active-chain/Merkle/profile admission are separate. */
class TransactionReader {
  private buffer: Uint8Array = new Uint8Array(0)
  private at = 0
  private received = 0
  private chunks = 0
  private consumed = 0
  private readonly hash = new SHA256()
  private readonly deadline: number
  constructor(
    private readonly source: AsyncIterator<Uint8Array>,
    private readonly policy: Brc38RawTransactionStreamPolicy
  ) {
    this.deadline = performance.now() + Math.max(0, policy.expiresAt - Date.now())
  }
  check(): void {
    this.policy.signal?.throwIfAborted()
    if (Date.now() >= this.policy.expiresAt || performance.now() >= this.deadline)
      throw new SnapshotResourceLimitError('Raw transaction source deadline reached')
  }
  get remaining(): number {
    return this.policy.bytes - this.consumed
  }
  dispose(): void {
    this.buffer.fill(0)
    this.buffer = new Uint8Array(0)
    this.at = 0
  }
  private async pull(): Promise<void> {
    this.check()
    this.buffer.fill(0)
    this.buffer = new Uint8Array(0)
    this.at = 0
    const next = await this.source.next()
    this.check()
    if (next.done) invalid()
    if (++this.chunks > this.policy.maximumChunks)
      throw new SnapshotResourceLimitError('Raw transaction chunk policy reached')
    const bytes = detachBrc38PrivateChunk(next.value, Math.min(65536, this.policy.bytes - this.received))
    if (bytes.byteLength === 0 || bytes.byteLength > this.policy.bytes - this.received) invalid()
    this.received += bytes.byteLength
    this.hash.update(bytes)
    this.buffer = bytes
    this.at = 0
    // Immediate in-memory producers still yield to foreground/cancellation.
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    this.check()
  }
  async fixed(size: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(size) || size < 1 || size > 8 || size > this.remaining) invalid()
    const result = new Uint8Array(size)
    for (let offset = 0; offset < size;) {
      this.check()
      if (this.at === this.buffer.byteLength) await this.pull()
      const amount = Math.min(size - offset, this.buffer.byteLength - this.at)
      result.set(this.buffer.subarray(this.at, this.at + amount), offset)
      this.at += amount
      this.consumed += amount
      offset += amount
    }
    return result
  }
  async skip(size: number): Promise<void> {
    if (!Number.isSafeInteger(size) || size < 0 || size > this.remaining) invalid()
    let remaining = size
    while (remaining > 0) {
      this.check()
      if (this.at === this.buffer.byteLength) await this.pull()
      const amount = Math.min(remaining, this.buffer.byteLength - this.at)
      this.at += amount
      this.consumed += amount
      remaining -= amount
    }
  }
  async integer(width: 1 | 2 | 4 | 8): Promise<number> {
    const bytes = await this.fixed(width)
    let value = 0n
    for (let index = width - 1; index >= 0; index--) value = value * 256n + BigInt(bytes[index])
    // Matches SDK BigNumber.toNumber's precision refusal, including amounts.
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) invalid()
    return Number(value)
  }
  async compactSize(): Promise<number> {
    const prefix = await this.integer(1)
    if (prefix < 253) return prefix
    const value = await this.integer(prefix === 253 ? 2 : prefix === 254 ? 4 : 8)
    if (value < (prefix === 253 ? 253 : prefix === 254 ? 65536 : 4294967296)) invalid()
    return value
  }
  async finish(): Promise<Readonly<{ sha256: string; txid: string }>> {
    this.check()
    if (this.remaining !== 0 || this.at !== this.buffer.byteLength || this.received !== this.policy.bytes) invalid()
    const next = await this.source.next()
    this.check()
    if (!next.done) invalid()
    const first = this.hash.digest(),
      sha256 = toHex(first)
    if (sha256 !== this.policy.sha256) invalid()
    return Object.freeze({ sha256, txid: toHex(new SHA256().update(first).digest().reverse()) })
  }
}
/** One <=64KiB native byte extent, constant scalar framing state and no complete
 * transaction/scripts/input/output arrays. Returns content DATA only. Complete
 * current Merkle/header/profile validation must precede receiver admission.
 * The owned source iterator is awaited through completion/error cleanup. */
export async function inspectBrc38RawTransactionStream(
  source: AsyncIterable<Uint8Array>,
  input: Brc38RawTransactionStreamPolicy
): Promise<Brc38RawTransactionSummary> {
  const policy = Object.freeze({
    bytes: input.bytes,
    sha256: input.sha256,
    maximumBytes: input.maximumBytes,
    maximumChunks: input.maximumChunks,
    expiresAt: input.expiresAt,
    signal: input.signal
  })
  if (
    !Number.isSafeInteger(policy.maximumBytes) ||
    policy.maximumBytes < 10 ||
    !Number.isSafeInteger(policy.bytes) ||
    policy.bytes < 10 ||
    policy.bytes > policy.maximumBytes ||
    !Number.isSafeInteger(policy.maximumChunks) ||
    policy.maximumChunks < 1 ||
    !Number.isSafeInteger(policy.expiresAt) ||
    !/^[0-9a-f]{64}$/.test(policy.sha256)
  )
    invalid()
  policy.signal?.throwIfAborted()
  const iterator = source[Symbol.asyncIterator](),
    reader = new TransactionReader(iterator, policy)
  let failure: { cause: unknown } | undefined,
    complete = false
  const cleanupScope1 = new Brc38CleanupScope(async () => {
    reader.dispose()
    if (!complete && iterator.return !== undefined) {
      try {
        await iterator.return()
      } catch (error_) {
        throw new AggregateError(
          failure ? [failure.cause, error_] : [error_],
          'Raw transaction parsing and source cleanup failed',
          failure ? { cause: failure.cause } : undefined
        )
      }
    }
  })
  try {
    const version = await reader.integer(4),
      inputs = await reader.compactSize()
    // Each input needs32+4+1+4 bytes, then output count and locktime. Refuse an
    // impossible count before iterating or allocating attacker-chosen entries.
    if (inputs > Math.floor((reader.remaining - 5) / 41)) invalid()
    for (let index = 0; index < inputs; index++) {
      await reader.skip(36)
      await reader.skip(await reader.compactSize())
      await reader.skip(4)
    }
    const outputs = await reader.compactSize()
    if (outputs > Math.floor((reader.remaining - 4) / 9)) invalid()
    for (let index = 0; index < outputs; index++) {
      await reader.integer(8)
      await reader.skip(await reader.compactSize())
    }
    const lockTime = await reader.integer(4),
      digest = await reader.finish()
    complete = true
    return Object.freeze({ version, inputs, outputs, lockTime, bytes: policy.bytes, ...digest })
  } catch (cause) {
    failure = { cause }
    {
      await cleanupScope1.close()
      throw cause
    }
  } finally {
    await cleanupScope1.close()
  }
}
