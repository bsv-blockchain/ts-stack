/**
 * The deterministic part-to-blocks mapping at the heart of the fountain.
 *
 * DETERMINISM IS THE CONTRACT. A part carries its `seq` and nothing about which
 * source blocks it mixes; the decoder reconstructs that set by running the same
 * RNG over the same seed. Change a constant here and every frozen conformance
 * vector — and every peer implementation — stops interoperating. Treat this
 * file as frozen wire format, not as code to improve.
 *
 * Every operation below is exact in 64-bit floating point and is specified in
 * plain integer arithmetic, so a port to any language with 32-bit integers and
 * 64-bit integer (or double) multiplication reproduces it bit for bit. The
 * normative statement of this mapping is §5 of
 * `specs/transport/air-gap-optical.md` (BRC-141).
 */

/**
 * xorshift32. Never returns 0 and is never seeded with 0.
 *
 * Chosen for reproducibility across runtimes and languages rather than for
 * statistical quality: 32-bit state, three shifts, no library, no floats.
 */
function makeRng(seed: number): () => number {
  let x = seed >>> 0
  if (x === 0) x = 0x6d2b79f5
  return () => {
    x ^= x << 13
    x >>>= 0
    x ^= x >>> 17
    x ^= x << 5
    x >>>= 0
    return x
  }
}

/**
 * One 23-bit draw from `rng`, in `[0, 2^23)`.
 *
 * 23 bits so every downstream product stays inside the 53-bit exact-integer
 * range of a double: `r * (k - i)` is at most `(2^23 - 1) * 65535 < 2^40`.
 */
function draw23(rng: () => number): number {
  return rng() >>> 9
}

/**
 * The source-block indices XORed into part `seq`.
 *
 * Only meaningful for `seq >= k`; below `k` the part *is* block `seq` (the
 * systematic prefix, so one clean camera cycle decodes with zero overhead).
 *
 * The degree is drawn from the ideal soliton distribution over `1..k` —
 * ρ(1) = 1/K, ρ(d) = 1/(d(d−1)) — by exact integer inverse-CDF: one 23-bit
 * draw `r` gives `d = ceil(2^23 / (r + 1))`, computed as
 * `floor((2^23 + r) / (r + 1))`, and any `d > k` (the truncated tail, total
 * probability ≈ 1/K) becomes degree 1, which is precisely the mass ρ(1) needs.
 * Indices then come from a partial Fisher–Yates shuffle, so they are distinct
 * without a rejection loop, with `j = i + floor(r_i * (k - i) / 2^23)` per
 * swap — exact integer arithmetic throughout.
 *
 * The seed is the 32-bit modular product `seq * 0x9e3779b1` (`Math.imul`, not
 * `*`: JavaScript number multiplication loses low bits past 2^53, and those
 * are exactly the bits a u32 port keeps).
 *
 * @param seq - Part sequence number.
 * @param k - Source block count.
 */
export function blocksForPart(seq: number, k: number): number[] {
  const rng = makeRng(Math.imul(seq, 0x9e3779b1) >>> 0)
  const r = draw23(rng)
  let degree = Math.floor((2 ** 23 + r) / (r + 1))
  if (degree > k) degree = 1
  const pool = Array.from({ length: k }, (_, i) => i)
  for (let i = 0; i < degree; i++) {
    const j = i + Math.floor((draw23(rng) * (k - i)) / 2 ** 23)
    const t = pool[i]
    pool[i] = pool[j]
    pool[j] = t
  }
  return pool.slice(0, degree)
}

/**
 * XOR `source` into `target`, in place, over `target.length` bytes.
 *
 * Both sides are always one block long — the encoder pads the last source
 * block and the decoder pins the session's block size — so the loop needs no
 * length reconciliation.
 */
export function xorInto(target: Uint8Array, source: Uint8Array): void {
  for (let i = 0; i < target.length; i++) target[i] ^= source[i]
}
