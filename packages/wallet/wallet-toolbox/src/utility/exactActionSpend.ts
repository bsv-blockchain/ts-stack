/**
 * Local-only metadata carrying the Wallet Toolbox signer's exact wallet-funded
 * amount for a partial action. The shared WeakMap keeps this implementation
 * detail off BRC-100 result objects while preserving service-charge accounting
 * across separately loaded core, client and mobile bundles in the same realm.
 */
const exactActionSpendsKey = Symbol.for('@bsv/wallet-toolbox/exact-action-spends')
const shared = globalThis as typeof globalThis & { [exactActionSpendsKey]?: WeakMap<object, number> }
const exactActionSpends = shared[exactActionSpendsKey] ?? new WeakMap<object, number>()
if (shared[exactActionSpendsKey] === undefined) {
  Object.defineProperty(shared, exactActionSpendsKey, { value: exactActionSpends })
}

/** Legacy internal carrier; new results keep metadata in a WeakMap. */
export const exactActionSpendSymbol = Symbol.for('@bsv/wallet-toolbox/exact-action-spend')

/** Retained for compatibility with older local wallet implementations. */
export interface ExactActionSpendCarrier {
  [exactActionSpendSymbol]?: number
}

export function setExactActionSpend(result: object, amount: number): void {
  exactActionSpends.set(result, amount)
}

export function getExactActionSpend(result: object): number | undefined {
  return exactActionSpends.get(result) ?? (result as ExactActionSpendCarrier)[exactActionSpendSymbol]
}
