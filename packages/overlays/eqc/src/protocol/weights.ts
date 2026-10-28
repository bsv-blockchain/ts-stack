import { MAX_RANKED_HOSTS } from './query.js'

function assertRankCount(k: number): void {
  if (!Number.isSafeInteger(k) || k < 1 || k > MAX_RANKED_HOSTS) {
    throw new RangeError(`k must be an integer from 1 to ${MAX_RANKED_HOSTS}`)
  }
}

/**
 * BRC-178 weights for ranks `1..k`: `weight(i) = sqrt(k - i + 1)`, as IEEE-754 binary64. `sqrt` is
 * correctly rounded, so every conforming implementation computes the same bits.
 */
export function squareRootWeights(k: number): number[] {
  assertRankCount(k)
  return Array.from({ length: k }, (_, index) => Math.sqrt(k - index))
}

/** `S = weight(1) + ... + weight(k)`, summed in rank order so the binary64 result is fixed. */
export function sumOfWeights(k: number): number {
  return squareRootWeights(k).reduce((sum, weight) => sum + weight, 0)
}

/** The smallest fee at which every one of `k` ranks is paid at least one satoshi. */
export function minimumFeeForAllRanks(k: number): number {
  return Math.ceil(sumOfWeights(k))
}

/** `floor(R * weight / S)` in binary64, evaluated as `(R * weight) / S` as BRC-178 specifies. */
function rawShare(totalSats: number, weight: number, sum: number): number {
  return Math.floor((totalSats * weight) / sum)
}

/** Splits `totalSats` across `k` ranks: `floor(R * weight / S)` each, remainder to rank 1. */
export function computePayouts(totalSats: number, k: number): number[] {
  if (!Number.isSafeInteger(totalSats) || totalSats < 1) {
    throw new RangeError('totalSats must be a positive safe integer')
  }
  const weights = squareRootWeights(k)
  const sum = weights.reduce((accumulator, weight) => accumulator + weight, 0)
  const payouts = weights.map(weight => rawShare(totalSats, weight, sum))
  const distributed = payouts.reduce((accumulator, payout) => accumulator + payout, 0)
  payouts[0] += totalSats - distributed
  return payouts
}

/**
 * The share a host may insist on at `rank` of `k` for a fee it quoted: `floor(feeSats * weight / S)`
 * with no rounding remainder. `computePayouts` hands rank 1 the remainder, and that remainder does
 * not grow with the fee, so only this remainder-free share is covered by every payment of at least
 * `feeSats`, at every rank.
 */
export function requiredShare(feeSats: number, k: number, rank: number): number {
  if (!Number.isSafeInteger(feeSats) || feeSats < 1) {
    throw new RangeError('feeSats must be a positive safe integer')
  }
  const weights = squareRootWeights(k)
  if (!Number.isSafeInteger(rank) || rank < 1 || rank > k) {
    throw new RangeError(`rank must be an integer from 1 to ${k}`)
  }
  const sum = weights.reduce((accumulator, weight) => accumulator + weight, 0)
  return rawShare(feeSats, weights[rank - 1], sum)
}
