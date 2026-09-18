import { MAX_RANKED_HOSTS } from './query.js'

function assertRankCount(k: number): void {
  if (!Number.isSafeInteger(k) || k < 1 || k > MAX_RANKED_HOSTS) {
    throw new RangeError(`k must be an integer from 1 to ${MAX_RANKED_HOSTS}`)
  }
}

/** Weights for ranks `1..k`: `weight(i) = F_(k - i + 1)` with `F_1 = F_2 = 1`. */
export function fibonacciWeights(k: number): number[] {
  assertRankCount(k)
  const ascending: number[] = []
  for (let n = 0; n < k; n++) {
    ascending.push(n < 2 ? 1 : ascending[n - 1] + ascending[n - 2])
  }
  return ascending.reverse()
}

export function sumOfWeights(k: number): number {
  return fibonacciWeights(k).reduce((sum, weight) => sum + weight, 0)
}

/**
 * Splits `totalSats` across `k` ranks: `floor(R * weight / S)` each, remainder to rank 1.
 * BigInt keeps the product exact for any fee up to the BSV supply.
 */
export function computePayouts(totalSats: number, k: number): number[] {
  if (!Number.isSafeInteger(totalSats) || totalSats < 1) {
    throw new RangeError('totalSats must be a positive safe integer')
  }
  const weights = fibonacciWeights(k)
  const total = BigInt(totalSats)
  const sum = BigInt(weights.reduce((accumulator, weight) => accumulator + weight, 0))
  const payouts = weights.map(weight => Number((total * BigInt(weight)) / sum))
  const distributed = payouts.reduce((accumulator, payout) => accumulator + payout, 0)
  payouts[0] += totalSats - distributed
  return payouts
}
