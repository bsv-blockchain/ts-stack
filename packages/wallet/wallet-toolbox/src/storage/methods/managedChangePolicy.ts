import { WERR_INVALID_PARAMETER } from '../../sdk/WERR_errors'

/** Historical default retained only to identify untouched wallet baskets. */
export const LEGACY_MANAGED_CHANGE_MINIMUM_SATOSHIS = 32

/**
 * Default liquidity policy for wallet-managed change.
 *
 * The preferred minimum is deliberately much larger than the dust threshold.
 * Dust answers "can this output ever be spent economically?"; this value
 * answers "is this output useful as an independently selectable liquidity
 * unit at contemporary fee rates?".
 */
export const DEFAULT_MANAGED_CHANGE_TARGET_UTXOS = 144
export const DEFAULT_MANAGED_CHANGE_MINIMUM_SATOSHIS = 5_000
export const DEFAULT_MANAGED_CHANGE_MAX_OUTPUTS_PER_ACTION = 8
export const DEFAULT_MANAGED_CHANGE_MIGRATION_INPUTS_PER_ACTION = 4
export const DEFAULT_MANAGED_CHANGE_PENDING_COMPARISON_INPUTS = 16

export interface ManagedChangePolicy {
  /** Maximum change outputs created by one action while growing the pool; -1 is unlimited. */
  maxOutputsPerAction: number
  /** Maximum undersized, fee-positive inputs consumed only to improve the pool; -1 is unlimited. */
  migrationInputsPerAction: number
  /**
   * A completed-only plan above this input count is compared with pending
   * alternatives using exact BEEF bytes. This is a comparison trigger, never
   * a funding limit. -1 disables pending comparison until settled funding is
   * actually insufficient.
   */
  pendingComparisonInputs: number
}

export type ManagedChangePolicyOptions = Partial<ManagedChangePolicy>

export interface ManagedChangeBasketDefaults {
  name: string
  numberOfDesiredUTXOs: number
  minimumDesiredUTXOValue: number
}

/** True only for the exact historical default that is safe to auto-upgrade. */
export function isLegacyManagedChangeBasketDefault (
  basket: ManagedChangeBasketDefaults
): boolean {
  return basket.name === 'default' &&
    basket.numberOfDesiredUTXOs === DEFAULT_MANAGED_CHANGE_TARGET_UTXOS &&
    basket.minimumDesiredUTXOValue === LEGACY_MANAGED_CHANGE_MINIMUM_SATOSHIS
}

/**
 * Normalize a legacy default while retaining every other field and every
 * operator-selected non-default value. Used by migrations, sync, and restore.
 */
export function upgradeLegacyManagedChangeBasketDefault<T extends ManagedChangeBasketDefaults> (
  basket: T
): T {
  if (!isLegacyManagedChangeBasketDefault(basket)) return basket
  return { ...basket, minimumDesiredUTXOValue: DEFAULT_MANAGED_CHANGE_MINIMUM_SATOSHIS }
}

export function defaultManagedChangePolicy (): ManagedChangePolicy {
  return {
    maxOutputsPerAction: DEFAULT_MANAGED_CHANGE_MAX_OUTPUTS_PER_ACTION,
    migrationInputsPerAction: DEFAULT_MANAGED_CHANGE_MIGRATION_INPUTS_PER_ACTION,
    pendingComparisonInputs: DEFAULT_MANAGED_CHANGE_PENDING_COMPARISON_INPUTS
  }
}

export function validateManagedChangePolicy (
  options?: ManagedChangePolicyOptions
): ManagedChangePolicy {
  const policy = { ...defaultManagedChangePolicy(), ...options }
  const validateLimit = (value: number, name: keyof ManagedChangePolicy, minimum: number): void => {
    if (value !== -1 && (!Number.isSafeInteger(value) || value < minimum)) {
      throw new WERR_INVALID_PARAMETER(
        `managedChangePolicy.${name}`,
        `${minimum === 0 ? 'a non-negative' : 'a positive'} safe integer or -1 for unlimited`
      )
    }
  }
  validateLimit(policy.maxOutputsPerAction, 'maxOutputsPerAction', 1)
  validateLimit(policy.migrationInputsPerAction, 'migrationInputsPerAction', 0)
  validateLimit(policy.pendingComparisonInputs, 'pendingComparisonInputs', 1)
  return policy
}
