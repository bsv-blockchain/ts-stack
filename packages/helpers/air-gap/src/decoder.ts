import { fromB64url } from './base64url'
import { blocksForPart, xorInto } from './coding'
import { AIR_GAP_PREFIX, HEADER_BYTES, MAX_MESSAGE_BYTES } from './constants'
import { crc32 } from './crc32'

/** What one call to {@link AirGapDecoder.accept} learned. */
export interface AirGapProgress {
  /** `false` for a read that was not a usable part of the current message. */
  ok: boolean
  /** All source blocks are recovered; call {@link AirGapDecoder.message}. */
  done: boolean
  /** Source blocks recovered so far. */
  have: number
  /** Source blocks in the message being received, or 0 before the first part. */
  total: number
}

/** A part that still mixes more than one unrecovered source block. */
interface PendingPart {
  indices: Set<number>
  payload: Uint8Array
}

/**
 * Reassembles a message from a stream of scanned parts.
 *
 * NEVER THROWS. A camera hands this whatever the barcode library thought it
 * saw: other people's QR codes, half-decoded frames, parts of a message the
 * user already walked away from. Every one of those is an ordinary
 * `{ ok: false }` read that changes nothing, because the alternative — an
 * exception inside a video frame callback — permanently wedges the scanner.
 *
 * Nor does it ever emit a partial or unverified message: {@link message}
 * returns the payload only once all blocks are recovered *and* the CRC matches.
 *
 * @example
 * ```ts
 * const decoder = new AirGapDecoder()
 * onScan(text => {
 *   if (decoder.accept(text).done) {
 *     const payload = decoder.message()
 *     if (payload) finish(payload)
 *   }
 * })
 * ```
 */
export class AirGapDecoder {
  /** `${K}:${msgLen}:${crc}` — identity of the message being received. */
  private key = ''
  private total = 0
  private msgLen = 0
  private crc = 0
  /**
   * Payload length pinned by the first part accepted into the current session
   * (0 = unpinned).
   *
   * The session key deliberately excludes the block size, so two honest
   * encoders configured with different `blockBytes` — or one part whose payload
   * was padded or truncated with its header untouched — can still satisfy the
   * `ceil(msgLen / len) === K` agreement check while disagreeing with every
   * part already accepted. Mixing those produces blocks of two different
   * lengths, and assembly would then size its buffer from one and overrun on
   * the other. Pinning turns that into an ordinary rejected read.
   */
  private blockBytes = 0
  private seen = new Set<number>()
  private solved: (Uint8Array | null)[] = []
  private solvedCount = 0
  private pending: PendingPart[] = []

  /**
   * Forget everything and wait for a fresh message.
   *
   * Not needed for correctness — a part from a different message resets the
   * decoder on its own — but useful when the UI abandons a scan.
   */
  reset(): void {
    this.startSession('', 0, 0, 0)
  }

  private startSession(key: string, total: number, msgLen: number, crc: number): void {
    this.key = key
    this.total = total
    this.msgLen = msgLen
    this.crc = crc
    this.blockBytes = 0
    this.seen = new Set()
    this.solved = Array.from({ length: total }, () => null)
    this.solvedCount = 0
    this.pending = []
  }

  /** Current progress, unchanged, for a read that could not be used. */
  private rejected(): AirGapProgress {
    return { ok: false, done: false, have: this.solvedCount, total: this.total }
  }

  /** Current progress after a read that was used (or was a known duplicate). */
  private accepted(): AirGapProgress {
    return {
      ok: true,
      done: this.solvedCount === this.total && this.total > 0,
      have: this.solvedCount,
      total: this.total
    }
  }

  /**
   * Feed one scanned string.
   *
   * A part belonging to a different message — different `(K, msgLen, crc32)` —
   * silently replaces the current session, which is also how the decoder
   * recovers after {@link message} discards a corrupt assembly: the sender is
   * still looping, so it simply refills.
   */
  accept(text: string): AirGapProgress {
    if (typeof text !== 'string' || !text.startsWith(AIR_GAP_PREFIX)) return this.rejected()
    let bytes: Uint8Array
    try {
      bytes = fromB64url(text.slice(AIR_GAP_PREFIX.length))
    } catch {
      return this.rejected()
    }
    if (bytes.length <= HEADER_BYTES) return this.rejected()
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const seq = view.getUint32(0)
    const total = view.getUint16(4)
    const msgLen = view.getUint32(6)
    const crc = view.getUint32(10)
    const payload = bytes.subarray(HEADER_BYTES)
    if (total === 0 || msgLen === 0 || msgLen > MAX_MESSAGE_BYTES) return this.rejected()
    // Block size, msgLen and K must agree, or the sender and this decoder are
    // not talking about the same message shape.
    if (Math.ceil(msgLen / payload.length) !== total) return this.rejected()

    const key = `${total}:${msgLen}:${crc}`
    if (key !== this.key) this.startSession(key, total, msgLen, crc)

    // The agreement check above admits a *range* of payload lengths for a given
    // (msgLen, K); only the pin can tell two block sizes apart.
    if (this.blockBytes === 0) this.blockBytes = payload.length
    else if (payload.length !== this.blockBytes) return this.rejected()

    if (this.seen.has(seq)) return this.accepted()
    this.seen.add(seq)

    const indices = seq < total ? new Set([seq]) : new Set(blocksForPart(seq, total))
    this.ingest({ indices, payload })
    return this.accepted()
  }

  /**
   * Peeling: reduce a part by what is already known, take it as a solution once
   * one unknown block remains, then cascade — one solve can unlock a chain of
   * previously over-determined parts.
   */
  private ingest(part: PendingPart): void {
    this.reduce(part)
    if (part.indices.size === 0) return // pure redundancy
    if (part.indices.size > 1) {
      this.pending.push(part)
      return
    }
    this.solve(part)
    // Reducing each pending part inside the loop means an earlier solve in the
    // same pass is already accounted for by the time a later part is examined.
    let progressed = true
    while (progressed) {
      progressed = false
      const still: PendingPart[] = []
      for (const p of this.pending) {
        this.reduce(p)
        if (p.indices.size === 1) {
          this.solve(p)
          progressed = true
        } else if (p.indices.size > 1) still.push(p)
      }
      this.pending = still
    }
  }

  /**
   * XOR out every block of `part` that is already solved.
   *
   * Deleting the entry the iterator is currently on is well-defined for a Set,
   * so this needs no snapshot of the index list.
   */
  private reduce(part: PendingPart): void {
    for (const index of part.indices) {
      const known = this.solved[index]
      if (known) {
        xorInto(part.payload, known)
        part.indices.delete(index)
      }
    }
  }

  /**
   * Record a degree-1 part as its one remaining block.
   *
   * Only ever called on a part {@link reduce} has just left with exactly one
   * index, and reduce removes every index that is already solved — so the block
   * recorded here is always new and `solvedCount` cannot double-count.
   */
  private solve(part: PendingPart): void {
    const [index] = part.indices
    this.solved[index] = part.payload
    this.solvedCount++
  }

  /**
   * The assembled message once {@link accept} reported `done`, or `null`.
   *
   * `null` means either "not finished yet" or "finished and the CRC did not
   * match" — in the latter case the assembly is discarded and the decoder
   * resets itself, so a still-looping sender refills it from scratch. Callers
   * never see unverified bytes, and never have to handle a retry themselves.
   */
  message(): Uint8Array | null {
    if (this.total === 0 || this.solvedCount !== this.total || this.blockBytes === 0) return null
    const out = new Uint8Array(this.total * this.blockBytes)
    for (let i = 0; i < this.total; i++) out.set(this.solved[i]!, i * this.blockBytes)
    const trimmed = out.subarray(0, this.msgLen)
    if (crc32(trimmed) !== this.crc) {
      this.reset()
      return null
    }
    // Copy so the result does not retain the padded assembly buffer.
    return trimmed.slice()
  }
}
