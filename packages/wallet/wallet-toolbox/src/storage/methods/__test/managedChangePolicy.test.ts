import {
  DEFAULT_MANAGED_CHANGE_MAX_OUTPUTS_PER_ACTION,
  DEFAULT_MANAGED_CHANGE_MIGRATION_INPUTS_PER_ACTION,
  DEFAULT_MANAGED_CHANGE_MINIMUM_SATOSHIS,
  DEFAULT_MANAGED_CHANGE_PENDING_COMPARISON_INPUTS,
  DEFAULT_MANAGED_CHANGE_TARGET_UTXOS,
  defaultManagedChangePolicy,
  isLegacyManagedChangeBasketDefault,
  upgradeLegacyManagedChangeBasketDefault,
  validateManagedChangePolicy
} from '../managedChangePolicy'

describe('managed change policy', () => {
  test('defaults provide parallel liquidity without creating dust', () => {
    expect(DEFAULT_MANAGED_CHANGE_TARGET_UTXOS).toBe(144)
    expect(DEFAULT_MANAGED_CHANGE_MINIMUM_SATOSHIS).toBe(5_000)
    expect(defaultManagedChangePolicy()).toEqual({
      maxOutputsPerAction: DEFAULT_MANAGED_CHANGE_MAX_OUTPUTS_PER_ACTION,
      migrationInputsPerAction: DEFAULT_MANAGED_CHANGE_MIGRATION_INPUTS_PER_ACTION,
      pendingComparisonInputs: DEFAULT_MANAGED_CHANGE_PENDING_COMPARISON_INPUTS
    })
  })

  test('partial overrides preserve unspecified defaults', () => {
    expect(validateManagedChangePolicy({ maxOutputsPerAction: 3 })).toEqual({
      ...defaultManagedChangePolicy(),
      maxOutputsPerAction: 3
    })
  })

  test('normalizes only the exact legacy basket default for migration, sync, and restore', () => {
    const legacy = { name: 'default', numberOfDesiredUTXOs: 144, minimumDesiredUTXOValue: 32, marker: 'kept' }
    expect(isLegacyManagedChangeBasketDefault(legacy)).toBe(true)
    expect(upgradeLegacyManagedChangeBasketDefault(legacy)).toEqual({
      ...legacy,
      minimumDesiredUTXOValue: 5_000
    })
    expect(upgradeLegacyManagedChangeBasketDefault({ ...legacy, minimumDesiredUTXOValue: 64 }))
      .toEqual({ ...legacy, minimumDesiredUTXOValue: 64 })
    expect(upgradeLegacyManagedChangeBasketDefault({ ...legacy, numberOfDesiredUTXOs: 100 }))
      .toEqual({ ...legacy, numberOfDesiredUTXOs: 100 })
    expect(upgradeLegacyManagedChangeBasketDefault({ ...legacy, name: 'application' }))
      .toEqual({ ...legacy, name: 'application' })
  })

  test('every operator limit supports explicit unlimited mode', () => {
    expect(validateManagedChangePolicy({
      maxOutputsPerAction: -1,
      migrationInputsPerAction: -1,
      pendingComparisonInputs: -1
    })).toEqual({
      maxOutputsPerAction: -1,
      migrationInputsPerAction: -1,
      pendingComparisonInputs: -1
    })
  })

  test.each([
    { maxOutputsPerAction: 0 },
    { migrationInputsPerAction: -2 },
    { pendingComparisonInputs: 0 },
    { maxOutputsPerAction: 1.5 },
    { migrationInputsPerAction: Number.MAX_SAFE_INTEGER + 1 }
  ])('rejects unsafe or out-of-range policy $policy', policy => {
    expect(() => validateManagedChangePolicy(policy)).toThrow('managedChangePolicy')
  })
})
