const BALANCE_BASKET = /^(?:balance |p [^ ]+ balance )/
const MODULE_BALANCE_BASKET = /^p [^ ]+ balance /
const CANONICAL_DECIMAL = /^(?:0|[1-9]\d*)$/

/** Retained for source compatibility with existing deep imports. */
export function isModuleBalanceQuery(basket: unknown): boolean {
  return typeof basket === 'string' && MODULE_BALANCE_BASKET.test(basket)
}

/** Retained canonical decimal validation for existing deep imports. */
export function isCanonicalDecimal(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_DECIMAL.test(value)
}

/**
 * True for a BRC-112 balance query, `balance <basket>` or `p <module> balance <basket>`.
 * Its `totalOutputs` is a balance, not an output count, and is not bounded by 2^32 - 1.
 */
export function isBalanceQuery(basket: unknown): boolean {
  return typeof basket === 'string' && BALANCE_BASKET.test(basket)
}
