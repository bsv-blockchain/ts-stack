import { lchAssert } from './errors.js'
import { LCH_LIMITS } from './constants.js'
import { toHex } from './hash.js'
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
  const roundedUnits = (selected + size - 1n) / size
  const units = minimum > roundedUnits ? minimum : roundedUnits
  if (maximumUnits !== undefined)
    lchAssert(
      units <= checkedUint(maximumUnits, 'ERR_LCH_QUOTE', 'Maximum units'),
      'ERR_LCH_QUOTE',
      'Maximum units exceeded'
    )
  return checkedSatoshis(units * checkedSatoshis(pricePerUnit))
}

export function matchFinalizedOutputs(
  demands: readonly PaymentDemand[],
  outputs: readonly PaymentOutput[]
): Map<string, number> {
  lchAssert(
    Array.isArray(demands) &&
      demands.length > 0 &&
      demands.length <= LCH_LIMITS.cborEntries &&
      Array.isArray(outputs) &&
      outputs.length <= LCH_LIMITS.cborEntries,
    'ERR_LCH_PAYMENT',
    'Payment Demand or output count is invalid'
  )
  const demandIds = demands.map(demand => {
    lchAssert(
      demand.demandId instanceof Uint8Array &&
        demand.demandId.length === 32 &&
        demand.lockingScript instanceof Uint8Array &&
        demand.lockingScript.length > 0,
      'ERR_LCH_PAYMENT',
      'Demand ID or locking script is invalid'
    )
    checkedSatoshis(demand.satoshis)
    return toHex(demand.demandId as Uint8Array)
  })
  lchAssert(
    new Set(demandIds).size === demandIds.length,
    'ERR_LCH_PAYMENT',
    'Demand IDs must be unique'
  )
  const explicitOutputIndexes = outputs
    .map(output => output.outputIndex)
    .filter((value): value is number => value !== undefined)
  lchAssert(
    new Set(explicitOutputIndexes).size === explicitOutputIndexes.length &&
      outputs.every(output => {
        checkedSatoshis(output.satoshis)
        return (
          output.lockingScript instanceof Uint8Array &&
          output.lockingScript.length > 0 &&
          (output.outputIndex === undefined ||
            (Number.isSafeInteger(output.outputIndex) && output.outputIndex >= 0))
        )
      }),
    'ERR_LCH_PAYMENT',
    'Finalized outputs are malformed or repeat an output index'
  )
  const candidatesByDestination = new Map<string, Array<{ output: PaymentOutput; index: number }>>()
  outputs.forEach((output, index) => {
    const key = `${output.satoshis}:${toHex(output.lockingScript as Uint8Array)}`
    const candidates = candidatesByDestination.get(key) ?? []
    candidates.push({ output, index })
    candidatesByDestination.set(key, candidates)
  })
  const used = new Set<number>()
  const usedOutputIndexes = new Set<number>()
  const matches = new Map<string, number>()
  for (const demand of demands) {
    const destination = `${demand.satoshis}:${toHex(demand.lockingScript as Uint8Array)}`
    const candidates = (candidatesByDestination.get(destination) ?? []).filter(
      ({ index }) => !used.has(index)
    )
    lchAssert(
      candidates.length === 1,
      'ERR_LCH_PAYMENT',
      'Demand output is missing or ambiguous after finalization'
    )
    const index = candidates[0].output.outputIndex ?? candidates[0].index
    lchAssert(
      Number.isSafeInteger(index) && index >= 0 && !usedOutputIndexes.has(index),
      'ERR_LCH_PAYMENT',
      'Finalized output index is invalid or ambiguous'
    )
    used.add(candidates[0].index)
    usedOutputIndexes.add(index)
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
  lchAssert(result <= 0xffffffffffffffffn, 'ERR_LCH_QUOTE', 'Recovery deadline overflows uint64')
  return result
}
