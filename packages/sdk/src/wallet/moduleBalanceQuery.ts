const BALANCE_BASKET = /^(?:balance |p [^ ]+ balance )/

/**
 * True for a BRC-112 balance query, `balance <basket>` or `p <module> balance <basket>`.
 * Its `totalOutputs` is a balance, not an output count, and is not bounded by 2^32 - 1.
 */
export function isBalanceQuery(basket: unknown): boolean {
  return typeof basket === 'string' && BALANCE_BASKET.test(basket)
}
