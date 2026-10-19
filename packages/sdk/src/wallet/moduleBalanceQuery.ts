const MODULE_BALANCE_BASKET = /^p [^ ]+ balance /
const CANONICAL_DECIMAL = /^(?:0|[1-9]\d*)$/

/**
 * True for a BRC-112 module balance query, `p <module> balance <basket>`. Its
 * `totalOutputs` is an exact decimal string, also on the BRC-100 binary wire.
 */
export function isModuleBalanceQuery(basket: unknown): boolean {
  return typeof basket === 'string' && MODULE_BALANCE_BASKET.test(basket)
}

/** True for canonical nonnegative decimal text: no sign, leading zeroes, point or exponent. */
export function isCanonicalDecimal(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_DECIMAL.test(value)
}
