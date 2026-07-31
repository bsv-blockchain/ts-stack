import { fromB64url } from './base64url'
import { blocksForPart, xorInto } from './coding'
import {
  AIR_GAP_PREFIX,
  AIR_GAP_WIRE_VERSION,
  HEADER_BYTES,
  MAX_BLOCK_BYTES,
  MAX_MESSAGE_BYTES,
  MAX_PENDING_INDICES,
  MAX_PENDING_PARTS,
  MAX_TRACKED_SEQS,
  SESSION_SWITCH_PARTS
} from './constants'
import { crc32 } from './crc32'
import { estimatePartCharLength } from './helpers'

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

/** The five header fields of a structurally valid version-1 part. */
interface ParsedPart {
  key: string
  seq: number
  total: number
  msgLen: number
  crc: number
  payload: Uint8Array
}

/**
 * The longest scanned string that could possibly be a valid part: the largest
 * allowed block behind the largest allowed header rendering. Anything longer
 * is rejected before any base64 work — the length test is the resource gate
 * for this untrusted parser, so no allocation scales with hostile input.
 */
const MAX_PART_CHARS = estimatePartCharLength(MAX_BLOCK_BYTES)

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
 * The decoder locks onto the first session it accepts. A stray well-formed
 * frame from a different sender is rejected rather than allowed to erase
 * progress; only {@link SESSION_SWITCH_PARTS} consecutive parts of the same
 * new session — the camera really has moved to a different sender — switch
 * the decoder over. Memory and work are bounded no matter what the camera
 * feeds in: see {@link MAX_TRACKED_SEQS}, {@link MAX_PENDING_PARTS} and
 * {@link MAX_PENDING_INDICES}.
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
  /** `hex(sessionId):K:msgLen:crc` — identity of the session being received. */
  private key = ''
  private total = 0
  private msgLen = 0
  private crc = 0
  /**
   * Payload length pinned by the first part accepted into the current session
   * (0 = unpinned).
   *
   * The session identity deliberately excludes the block size, so one part
   * whose payload was padded or truncated with its header untouched could
   * still satisfy the `ceil(msgLen / len) === K` agreement check while
   * disagreeing with every part already accepted. Mixing those produces
   * blocks of two different lengths, and assembly would then size its buffer
   * from one and overrun on the other. Pinning turns that into an ordinary
   * rejected read.
   */
  private blockBytes = 0
  private seen = new Set<number>()
  private solved: (Uint8Array | null)[] = []
  private solvedCount = 0
  private pending: PendingPart[] = []
  /** Unresolved block references across `pending`, kept ≤ MAX_PENDING_INDICES. */
  private pendingIndices = 0
  /** Foreign session key being counted toward a switch ('' = none). */
  private candidateKey = ''
  private candidateCount = 0

  /**
   * Forget everything and wait for a fresh message.
   *
   * Useful when the UI abandons a scan; the decoder also calls it on itself
   * when a completed assembly fails its CRC check.
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
    this.pendingIndices = 0
    this.candidateKey = ''
    this.candidateCount = 0
  }

  /** Current progress, unchanged, for a read that could not be used. */
  private rejected(): AirGapProgress {
    return { ok: false, done: this.isDone(), have: this.solvedCount, total: this.total }
  }

  /** Current progress after a read that was used (or was a known duplicate). */
  private accepted(): AirGapProgress {
    return { ok: true, done: this.isDone(), have: this.solvedCount, total: this.total }
  }

  private isDone(): boolean {
    return this.total > 0 && this.solvedCount === this.total
  }

  /**
   * Parse one scanned string into header fields, or `null` for anything that
   * is not a structurally valid version-1 part. Length is checked *before*
   * base64 decoding, so hostile input is rejected without allocation.
   */
  private parse(text: string): ParsedPart | null {
    if (typeof text !== 'string' || !text.startsWith(AIR_GAP_PREFIX)) return null
    if (text.length > MAX_PART_CHARS) return null
    let bytes: Uint8Array
    try {
      bytes = fromB64url(text.slice(AIR_GAP_PREFIX.length))
    } catch {
      return null
    }
    if (bytes.length <= HEADER_BYTES || bytes.length > HEADER_BYTES + MAX_BLOCK_BYTES) return null
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (view.getUint8(0) !== AIR_GAP_WIRE_VERSION) return null
    let session = ''
    for (let i = 1; i <= 8; i++) session += bytes[i].toString(16).padStart(2, '0')
    const seq = view.getUint32(9)
    const total = view.getUint16(13)
    const msgLen = view.getUint32(15)
    const crc = view.getUint32(19)
    const payload = bytes.subarray(HEADER_BYTES)
    if (total === 0 || msgLen === 0 || msgLen > MAX_MESSAGE_BYTES) return null
    // Block size, msgLen and K must agree, or the sender and this decoder are
    // not talking about the same message shape.
    if (Math.ceil(msgLen / payload.length) !== total) return null
    return { key: `${session}:${total}:${msgLen}:${crc}`, seq, total, msgLen, crc, payload }
  }

  /**
   * Feed one scanned string.
   *
   * Unusable reads change nothing. Parts of a *different* session are
   * rejected while the current one is in progress, until
   * {@link SESSION_SWITCH_PARTS} consecutive parts of the same new session
   * arrive — then the decoder adopts that session and starts over. Once the
   * current message is complete, further parts of its session are
   * acknowledged without any state change.
   */
  accept(text: string): AirGapProgress {
    const part = this.parse(text)
    if (part === null) return this.rejected()
    if (!this.enterSession(part)) return this.rejected()

    // A completed session is immutable: acknowledge and change nothing.
    if (this.isDone()) return this.accepted()

    // The agreement check in parse admits a *range* of payload lengths for a
    // given (msgLen, K); only the pin can tell two block sizes apart.
    if (this.blockBytes === 0) this.blockBytes = part.payload.length
    else if (part.payload.length !== this.blockBytes) return this.rejected()

    if (this.seen.has(part.seq)) return this.accepted()
    return this.ingest(part)
  }

  /**
   * Route `part` into the right session, locking and switching as documented
   * on {@link accept}. Returns `false` when the part belongs to a foreign
   * session that has not yet earned the switch.
   */
  private enterSession(part: ParsedPart): boolean {
    if (this.key === '') {
      this.startSession(part.key, part.total, part.msgLen, part.crc)
      return true
    }
    if (part.key === this.key) {
      // A part of the locked session interrupts any foreign-candidate run.
      this.candidateKey = ''
      this.candidateCount = 0
      return true
    }
    // Foreign session: never let one stray frame erase progress. Count
    // consecutive sightings of the same candidate; a camera genuinely
    // pointed at a new sender produces them back to back.
    if (part.key === this.candidateKey) this.candidateCount++
    else {
      this.candidateKey = part.key
      this.candidateCount = 1
    }
    if (this.candidateCount < SESSION_SWITCH_PARTS) return false
    this.startSession(part.key, part.total, part.msgLen, part.crc)
    return true
  }

  /** Feed one new in-session part into the peeling state, within budgets. */
  private ingest(part: ParsedPart): AirGapProgress {
    const indices =
      part.seq < this.total ? new Set([part.seq]) : new Set(blocksForPart(part.seq, this.total))
    const candidate: PendingPart = { indices, payload: part.payload }
    this.reduce(candidate)
    if (candidate.indices.size > 1) {
      // Buffering is the one place hostile input could grow state without
      // bound, so mixes are budgeted; solved blocks and duplicates are not
      // affected, and systematic parts always land, which preserves liveness.
      if (
        this.pending.length >= MAX_PENDING_PARTS ||
        this.pendingIndices + candidate.indices.size > MAX_PENDING_INDICES
      ) {
        return this.rejected()
      }
      this.pending.push(candidate)
      this.pendingIndices += candidate.indices.size
    } else if (candidate.indices.size === 1) {
      this.solve(candidate)
      this.cascade()
    }
    this.remember(part.seq)
    return this.accepted()
  }

  /** Duplicate suppression, capped: past the cap, repeats are re-processed. */
  private remember(seq: number): void {
    if (this.seen.size < MAX_TRACKED_SEQS) this.seen.add(seq)
  }

  /**
   * Peeling: after a new solve, reduce every buffered part by what is now
   * known; each pass may solve more parts, which unlocks the next pass.
   */
  private cascade(): void {
    let progressed = true
    while (progressed) {
      progressed = false
      const still: PendingPart[] = []
      let stillIndices = 0
      for (const p of this.pending) {
        this.reduce(p)
        if (p.indices.size === 1) {
          this.solve(p)
          progressed = true
        } else if (p.indices.size > 1) {
          still.push(p)
          stillIndices += p.indices.size
        }
      }
      this.pending = still
      this.pendingIndices = stillIndices
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
