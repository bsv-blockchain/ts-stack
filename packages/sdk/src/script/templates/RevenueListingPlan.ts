import Transaction from '../../transaction/Transaction.js'
import { hash160, sha256 } from '../../primitives/Hash.js'
import { toArray, toHex, Writer } from '../../primitives/utils.js'
import { outputAssert } from '../../overlay-tools/OutputProtocolError.js'
import { outputU64, incrementOutputU64 } from '../../overlay-tools/OutputProtocol.js'
import {
  array,
  hex,
  identity,
  literal,
  normalized,
  object,
  tagged,
  u32,
  u64
} from '../../overlay-tools/OutputProtocolSchema.js'
import {
  RevenueListing,
  parseRevenueListingDescriptor,
  parseRevenueListingState,
  encodeRevenueListingState,
  revenueListingId,
  type RevenueListingState
} from './RevenueListing.js'
import P2PKH from './P2PKH.js'

const maximumSatoshis = 2100000000000000n
export const REVENUE_LISTING_MAX_PREVIOUS_BYTES = 1048576
const actionSchema = tagged('operation', {
  purchase: object({
    operation: literal('purchase'),
    acquisitionId: hex,
    requestDigest: hex,
    recipient: identity
  }),
  split: object({ operation: literal('split'), firstAmount: u64 }),
  merge: object({ operation: literal('merge') }),
  payout: object({ operation: literal('payout'), units: u64 }),
  retire: object({ operation: literal('retire') }),
  amend: object({ operation: literal('amend'), state: parseRevenueListingState })
})
export type RevenueListingAction = ReturnType<typeof actionSchema>
export interface RevenueListingPrevious {
  rawTransaction: string
  outputIndex: number
}
export interface RevenueListingPlannedOutput {
  satoshis: string
  lockingScript: string
}
export interface RevenueListingPlan {
  operation: RevenueListingAction['operation']
  operationCode: 1 | 2 | 3 | 4 | 5 | 6
  listingId: string
  inputs: { txid: string; outputIndex: number; satoshis: string; lockingScript: string }[]
  outputs: RevenueListingPlannedOutput[]
  currentState: RevenueListingState
  successorState?: RevenueListingState
  receiptIndex: number
  payout: string
  retirementTopUp: string
  /** Required external contribution before fees, including the one-satoshi receipt. */
  minimumExternalFunding: string
  /** Required for each listing input. Recipient order is the old schedule order. */
  signers: { seller?: string; recipients: string[] }
}

export function parseRevenueListingAction(input: unknown): RevenueListingAction {
  return normalized(input, actionSchema, 8192)
}

/** Strict, bounded canonical raw transaction input; no network or ancestry inference. */
export function parseRevenueListingPrevious(input: unknown): RevenueListingPrevious[] {
  return normalized(
    input,
    array(object({ rawTransaction: rawHex, outputIndex: u32 }), 2, 1),
    4194304
  )
}

function rawHex(value: unknown): string {
  outputAssert(
    typeof value === 'string' &&
      value.length > 0 &&
      value.length <= REVENUE_LISTING_MAX_PREVIOUS_BYTES * 2 &&
      value.length % 2 === 0,
    'Invalid previous transaction length'
  )
  outputAssert(/^[0-9a-f]+$/.test(value), 'Expected canonical transaction hex')
  return value
}

/** Listing predecessors under this profile fit the same bounded layout, including genesis. */
export function readRevenueListingPrevious(raw: string): Transaction {
  const tx = Transaction.fromHex(rawHex(raw))
  outputAssert(
    (tx.version === 1 || tx.version === 2) && tx.lockTime === 0,
    'Invalid previous transaction header'
  )
  outputAssert(
    tx.inputs.length >= 1 &&
      tx.inputs.length <= 8 &&
      tx.outputs.length >= 1 &&
      tx.outputs.length <= 11,
    'Previous transaction layout exceeds profile'
  )
  for (const input of tx.inputs)
    outputAssert(input.sequence === 0xffffffff, 'Previous transaction is non-final')
  for (const output of tx.outputs) {
    outputAssert(
      Number.isSafeInteger(output.satoshis) &&
        output.satoshis! >= 0 &&
        BigInt(output.satoshis!) <= maximumSatoshis,
      'Invalid previous output amount'
    )
  }
  return tx
}

function amount(value: bigint): string {
  outputAssert(value > 0n && value <= maximumSatoshis, 'Listing output amount outside SatoshiValue')
  return value.toString()
}
function output(value: bigint, script: string): RevenueListingPlannedOutput {
  return { satoshis: amount(value), lockingScript: script }
}
function le(value: bigint, length: number): number[] {
  return Array.from({ length }, (_, index) => Number((value >> BigInt(index * 8)) & 255n))
}
function serialized(outputs: RevenueListingPlannedOutput[]): number[] {
  const writer = new Writer()
  for (const item of outputs) {
    const script = toArray(item.lockingScript, 'hex')
    writer.writeUInt64LE(Number(item.satoshis)).writeVarIntNum(script.length).write(script)
  }
  return writer.toArray()
}

/**
 * Plans exact mandatory outputs and authorities for all six BRC-197 routes.
 * It authenticates source bytes and family/state encoding, not Bitcoin validity,
 * genesis lineage, asset authority, currentness, consent or private entitlement.
 * Validate all listing histories before using this plan to request signatures.
 * Funding may append only one P2PKH change output; it may not alter these outputs.
 */
export function planRevenueListingSpend(
  family: RevenueListing,
  descriptorInput: unknown,
  previousInput: unknown,
  actionInput: unknown
): RevenueListingPlan {
  const descriptor = parseRevenueListingDescriptor(descriptorInput)
  const action = parseRevenueListingAction(actionInput)
  const previous = parseRevenueListingPrevious(previousInput)
  outputAssert(
    previous.length === (action.operation === 'merge' ? 2 : 1),
    'Wrong listing input count'
  )
  const inputs = previous.map(item => {
    const tx = readRevenueListingPrevious(item.rawTransaction)
    const source = tx.outputs[item.outputIndex]
    outputAssert(source !== undefined, 'Missing previous listing output')
    const satoshis = amount(BigInt(source.satoshis!))
    outputAssert(BigInt(satoshis) >= outputU64(descriptor.reserve), 'Listing below reserve')
    return {
      txid: tx.id('hex'),
      outputIndex: item.outputIndex,
      satoshis,
      lockingScript: source.lockingScript.toHex()
    }
  })
  const states = inputs.map(item => family.decode(toArray(item.lockingScript, 'hex'), descriptor))
  if (inputs.length === 2) {
    outputAssert(
      inputs[0].txid !== inputs[1].txid || inputs[0].outputIndex !== inputs[1].outputIndex,
      'Duplicate listing input'
    )
    outputAssert(
      inputs[0].lockingScript === inputs[1].lockingScript,
      'Merge schedules or scripts differ'
    )
  }
  const state = states[0]
  const oldValue = inputs.reduce((sum, item) => sum + BigInt(item.satoshis), 0n)
  const script = inputs[0].lockingScript
  const reserve = outputU64(descriptor.reserve)
  const listingId = revenueListingId(descriptor)
  const codes = { purchase: 1, split: 2, merge: 3, payout: 4, retire: 5, amend: 6 } as const
  const operationCode = codes[action.operation]
  if (action.operation !== 'purchase')
    outputAssert(descriptor.administration === 'seller-v1', 'Administrative routes disabled')
  const continuing: RevenueListingPlannedOutput[] = []
  const payments: RevenueListingPlannedOutput[] = []
  let payout = 0n,
    topUp = 0n,
    contribution = 1n
  let successorState: RevenueListingState | undefined = parseRevenueListingState(state)
  let commitment = Array<number>(32).fill(0)
  switch (action.operation) {
    case 'purchase':
      continuing.push(output(oldValue + outputU64(descriptor.purchasePrice), script))
      contribution += outputU64(descriptor.purchasePrice)
      break
    case 'split': {
      const first = outputU64(action.firstAmount)
      outputAssert(first >= reserve && oldValue - first >= reserve, 'Split would violate reserve')
      continuing.push(output(first, script), output(oldValue - first, script))
      break
    }
    case 'merge':
      continuing.push(output(oldValue, script))
      break
    case 'payout':
    case 'retire': {
      const quantum = state.recipients.reduce((sum, item) => sum + BigInt(item.weight), 0n)
      const units =
        action.operation === 'payout'
          ? outputU64(action.units)
          : (oldValue + quantum - 1n) / quantum
      outputAssert(units > 0n, 'Payout units must be positive')
      payout = units * quantum
      // The receipt encodes the aggregate amount, which is also bounded by Script.
      amount(payout)
      for (const recipient of state.recipients)
        payments.push(
          output(
            units * BigInt(recipient.weight),
            new P2PKH().lock(hash160(toArray(recipient.identity, 'hex'))).toHex()
          )
        )
      commitment = sha256(serialized(payments))
      if (action.operation === 'payout') {
        outputAssert(oldValue - payout >= reserve, 'Payout would violate reserve')
        continuing.push(output(oldValue - payout, script))
      } else {
        topUp = payout - oldValue
        contribution += topUp
        successorState = undefined
      }
      break
    }
    case 'amend':
      outputAssert(
        action.state.revision === incrementOutputU64(state.revision),
        'Amendment must increment revision once'
      )
      successorState = parseRevenueListingState(action.state)
      continuing.push(output(oldValue, family.lock(descriptor, successorState).toHex()))
      commitment = sha256(Array.from(encodeRevenueListingState(successorState)))
      break
  }
  const receipt =
    action.operation === 'purchase'
      ? [
          0,
          0x6a,
          0x4c,
          0xa7,
          0x52,
          0x4f,
          0x53,
          0x4c,
          1,
          1,
          ...toArray(listingId, 'hex'),
          ...toArray(action.acquisitionId, 'hex'),
          ...toArray(action.requestDigest, 'hex'),
          ...toArray(action.recipient, 'hex'),
          ...toArray(descriptor.termsDigest, 'hex')
        ]
      : [
          0,
          0x6a,
          0x4c,
          0x56,
          0x52,
          0x4f,
          0x53,
          0x4c,
          1,
          operationCode,
          ...toArray(listingId, 'hex'),
          ...le(BigInt(inputs.length), 4),
          ...le(BigInt(continuing.length), 4),
          ...le(payout, 8),
          ...commitment
        ]
  return {
    operation: action.operation,
    operationCode,
    listingId,
    inputs,
    outputs: [...continuing, output(1n, toHex(receipt)), ...payments],
    currentState: parseRevenueListingState(state),
    ...(successorState === undefined ? {} : { successorState }),
    receiptIndex: continuing.length,
    payout: payout.toString(),
    retirementTopUp: topUp.toString(),
    minimumExternalFunding: contribution.toString(),
    signers: {
      ...(action.operation === 'purchase' ? {} : { seller: descriptor.seller }),
      recipients: action.operation === 'amend' ? state.recipients.map(item => item.identity) : []
    }
  }
}
