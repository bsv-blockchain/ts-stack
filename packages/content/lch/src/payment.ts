import { lchAssert } from './errors.js'
import type { PaymentDemand, PaymentOutput } from './types.js'

const MAX_SATOSHIS = 2_100_000_000_000_000n

function checkedUint(
  value: number | bigint,
  code: 'ERR_LCH_PAYMENT' | 'ERR_LCH_QUOTE',
  name: string
): bigint {
  lchAssert(
    typeof value === 'bigint' || Number.isSafeInteger(value),
    code,
    `${name} must be an exact integer`
  )
  const result = BigInt(value)
  lchAssert(result >= 0n, code, `${name} must be unsigned`)
  return result
}

export function checkedSatoshis(value: number | bigint): bigint {
  const amount = checkedUint(value, 'ERR_LCH_PAYMENT', 'Satoshi amount')
  lchAssert(
    amount >= 0n && amount <= MAX_SATOSHIS,
    'ERR_LCH_PAYMENT',
    'Satoshi amount is out of range'
  )
  return amount
}

export function fixedTotal(requirements: ReadonlyArray<{ satoshis: number | bigint }>): bigint {
  return requirements.reduce((total, requirement) => {
    const next = total + checkedSatoshis(requirement.satoshis)
    return checkedSatoshis(next)
  }, 0n)
}

export function unitAmount(
  quantity: number | bigint,
  unitSize: number | bigint,
  minimumUnits: number | bigint,
  pricePerUnit: number | bigint,
  maximumUnits?: number | bigint
): bigint {
  const selected = checkedUint(quantity, 'ERR_LCH_QUOTE', 'Quantity')
  const size = checkedUint(unitSize, 'ERR_LCH_QUOTE', 'Unit size')
  const minimum = checkedUint(minimumUnits, 'ERR_LCH_QUOTE', 'Minimum units')
  lchAssert(size > 0n, 'ERR_LCH_QUOTE', 'Unit size must be positive')
  const units = [minimum, (selected + size - 1n) / size].reduce((left, right) =>
    left > right ? left : right
  )
  if (maximumUnits !== undefined)
    lchAssert(
      units <= checkedUint(maximumUnits, 'ERR_LCH_QUOTE', 'Maximum units'),
      'ERR_LCH_QUOTE',
      'Maximum units exceeded'
    )
  return checkedSatoshis(units * checkedSatoshis(pricePerUnit))
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index])
}

export function matchFinalizedOutputs(
  demands: readonly PaymentDemand[],
  outputs: readonly PaymentOutput[]
): Map<string, number> {
  lchAssert(demands.length > 0, 'ERR_LCH_PAYMENT', 'No payment Demands were supplied')
  const demandIds = demands.map(demand => {
    lchAssert(demand.demandId.length === 32, 'ERR_LCH_PAYMENT', 'Demand ID must contain 32 bytes')
    return Array.from(demand.demandId, byte => byte.toString(16).padStart(2, '0')).join('')
  })
  lchAssert(
    new Set(demandIds).size === demandIds.length,
    'ERR_LCH_PAYMENT',
    'Demand IDs must be unique'
  )
  const used = new Set<number>()
  const matches = new Map<string, number>()
  for (const demand of demands) {
    const candidates = outputs
      .map((output, index) => ({ output, index }))
      .filter(
        ({ output, index }) =>
          !used.has(index) &&
          output.satoshis === demand.satoshis &&
          bytesEqual(output.lockingScript, demand.lockingScript)
      )
    lchAssert(
      candidates.length === 1,
      'ERR_LCH_PAYMENT',
      'Demand output is missing or ambiguous after finalization'
    )
    const index = candidates[0].output.outputIndex ?? candidates[0].index
    lchAssert(
      Number.isSafeInteger(index) && index >= 0,
      'ERR_LCH_PAYMENT',
      'Finalized output index is invalid'
    )
    used.add(candidates[0].index)
    matches.set(demandIds[matches.size], index)
  }
  return matches
}

export function recoveryUntil(
  expiresAt: number | bigint,
  recoveryPeriodSeconds: number | bigint
): bigint {
  const expires = checkedUint(expiresAt, 'ERR_LCH_QUOTE', 'Quote expiry')
  const period = checkedUint(recoveryPeriodSeconds, 'ERR_LCH_QUOTE', 'Recovery period')
  lchAssert(period >= 86_400n, 'ERR_LCH_QUOTE', 'Recovery period must be at least one day')
  const result = expires + period
  lchAssert(result <= 0xffff_ffff_ffff_ffffn, 'ERR_LCH_QUOTE', 'Recovery deadline overflows uint64')
  return result
}
