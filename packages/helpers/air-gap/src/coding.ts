/**
 * The deterministic part-to-blocks mapping at the heart of the fountain.
 *
 * DETERMINISM IS THE CONTRACT. A part carries its `seq` and nothing about which
 * source blocks it mixes; the decoder reconstructs that set by running the same
 * RNG over the same seed. Change a constant here and every frozen conformance
 * vector — and every peer implementation — stops interoperating. Treat this
 * file as frozen wire format, not as code to improve.
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
 * The source-block indices XORed into part `seq`.
 *
 * Only meaningful for `seq >= k`; below `k` the part *is* block `seq` (the
 * systematic prefix, so one clean camera cycle decodes with zero overhead).
 *
 * The degree follows the ideal soliton distribution — 1 with probability 1/K,
 * otherwise `d` with probability 1/(d(d-1)) via the `ceil(1/u)` inverse-CDF
 * trick — which is what makes any K+ε distinct parts enough to peel out all K
 * blocks. Indices come from a partial Fisher–Yates shuffle, so they are
 * distinct without a rejection loop.
 *
 * @param seq - Part sequence number.
 * @param k - Source block count.
 */
export function blocksForPart(seq: number, k: number): number[] {
  const rng = makeRng((seq * 0x9e3779b1) >>> 0)
  // (0,1] for the degree draw — the +1 keeps 1/u finite.
  const open01 = () => ((rng() >>> 9) + 1) / 2 ** 23
  // [0,1) for index draws — floor stays in range.
  const half01 = () => (rng() >>> 9) / 2 ** 23
  let degree: number
  if (k === 1) degree = 1
  else if (open01() <= 1 / k) degree = 1
  else degree = Math.min(k, Math.ceil(1 / open01()))
  const pool = Array.from({ length: k }, (_, i) => i)
  for (let i = 0; i < degree; i++) {
    const j = i + Math.floor(half01() * (k - i))
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
