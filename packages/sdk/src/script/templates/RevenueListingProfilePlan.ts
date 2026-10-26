import Transaction from '../../transaction/Transaction.js'
import { hash160, sha256 } from '../../primitives/Hash.js'
import { toArray, toHex, Writer } from '../../primitives/utils.js'
import { outputAssert } from '../../overlay-tools/OutputProtocolError.js'
import { outputPacketDigest, outputU64 } from '../../overlay-tools/OutputProtocol.js'
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
  parseRevenueListingProfileDescriptor,
  type RevenueListingProfile,
  type RevenueListingProfileSchedule
} from './RevenueListingProfile.js'
import {
  revenueListingChildPublicKey,
  REVENUE_LISTING_AUTHORITY_PROTOCOL,
  REVENUE_LISTING_AUTHORITY_KEY_ID
} from './RevenueListingKeys.js'
import P2PKH from './P2PKH.js'

const maximumSatoshis = 2100000000000000n
const maximumPreviousBytes = 1048576
const actionSchema = tagged('operation', {
  activate: object({ operation: literal('activate') }),
  purchase: object({
    operation: literal('purchase'),
    acquisitionId: hex,
    requestDigest: hex,
    recipient: identity
  }),
  split: object({ operation: literal('split'), firstAmount: u64 }),
  payout: object({ operation: literal('payout'), units: u64 }),
  retire: tagged('authority', {
    seller: object({ operation: literal('retire'), authority: literal('seller') }),
    expiry: object({
      operation: literal('retire'),
      authority: literal('expiry'),
      lockHeight: u32
    })
  })
})

export type RevenueListingProfileAction = ReturnType<typeof actionSchema>
export interface RevenueListingProfileOutput {
  satoshis: string
  lockingScript: string
}
export interface RevenueListingProfilePlan {
  operation: RevenueListingProfileAction['operation']
  operationCode: 0 | 1 | 2 | 4 | 5
  listingId: string
  input: { txid: string; outputIndex: number; satoshis: string; lockingScript: string }
  outputs: RevenueListingProfileOutput[]
  schedule: RevenueListingProfileSchedule
  /** Activation has no receipt; all other routes have one one-satoshi receipt. */
  receiptIndex: number | null
  payout: string
  retirementTopUp: string
  /** External contribution before fees; activation still requires an external input. */
  minimumExternalFunding: string
  lockTime: number
  listingSequence: number
  /** Other expiry-retirement sequences remain subject to ordinary Bitcoin finality. */
  requireAllFinalInputs: boolean
  sellerAuthorization?: {
    identity: string
    publicKey: string
    protocolID: readonly [2, '3241645161d8']
    keyID: 'brc197 authority'
    counterparty: 'anyone'
  }
}

export function parseRevenueListingProfileAction(input: unknown): RevenueListingProfileAction {
  return normalized(input, actionSchema, 8192)
}

function rawHex(value: unknown): string {
  outputAssert(
    typeof value === 'string' &&
      value.length > 0 &&
      value.length <= maximumPreviousBytes * 2 &&
      value.length % 2 === 0 &&
      /^[0-9a-f]+$/.test(value),
    'Expected bounded canonical previous transaction hex'
  )
  return value
}
const previousSchema = array(object({ rawTransaction: rawHex, outputIndex: u32 }), 1, 1)

export interface RevenueListingProfilePrevious {
  rawTransaction: string
  outputIndex: number
}

export function parseRevenueListingProfilePrevious(
  input: unknown
): RevenueListingProfilePrevious[] {
  return normalized(input, previousSchema, 4194304)
}

function amount(value: bigint): string {
  outputAssert(value > 0n && value <= maximumSatoshis, 'Listing amount outside SatoshiValue')
  return value.toString()
}
function output(value: bigint, script: string): RevenueListingProfileOutput {
  return { satoshis: amount(value), lockingScript: script }
}
function le(value: bigint, length: number): number[] {
  return Array.from({ length }, (_, index) => Number((value >> BigInt(index * 8)) & 255n))
}
function serialized(outputs: RevenueListingProfileOutput[]): number[] {
  const writer = new Writer()
  for (const item of outputs) {
    const script = toArray(item.lockingScript, 'hex')
    writer.writeUInt64LE(Number(item.satoshis)).writeVarIntNum(script.length).write(script)
  }
  return writer.toArray()
}

/**
 * Plans the immutable profile's mandatory economic outputs and protected signer
 * selection. It checks the complete source lock and descriptor, not signed
 * genesis, activation ancestry, input Scripts, chain placement, currentness,
 * receipt eligibility or private entitlement. A funded builder must preserve
 * these outputs and headers and append at most one final P2PKH change output.
 */
export function planRevenueListingProfileSpend(
  profile: RevenueListingProfile,
  descriptorInput: unknown,
  previousInput: unknown,
  actionInput: unknown
): RevenueListingProfilePlan {
  const descriptor = parseRevenueListingProfileDescriptor(descriptorInput)
  const action = parseRevenueListingProfileAction(actionInput)
  const [previous] = parseRevenueListingProfilePrevious(previousInput)
  const tx = Transaction.fromHex(previous.rawTransaction)
  const source = tx.outputs[previous.outputIndex]
  outputAssert(source !== undefined, 'Missing previous listing output')
  outputAssert(
    Number.isSafeInteger(source.satoshis) && source.satoshis! > 0,
    'Invalid previous listing amount'
  )
  const oldValue = BigInt(source.satoshis!)
  const reserve = outputU64(descriptor.reserve)
  amount(oldValue)
  const recognized = profile.decode(source.lockingScript.toBinary(), descriptor)
  outputAssert(
    recognized.stage === (action.operation === 'activate' ? 'activation' : 'active'),
    'Listing stage does not permit this operation'
  )
  outputAssert(
    action.operation === 'activate' ? oldValue === reserve : oldValue >= reserve,
    'Listing reserve mismatch'
  )
  const listingId = outputPacketDigest('sale-listing', descriptor)
  const script = source.lockingScript.toHex()
  const codes = { activate: 0, purchase: 1, split: 2, payout: 4, retire: 5 } as const
  const operationCode = codes[action.operation]
  const economics = economicOutputs(profile, descriptor, action, oldValue, script)
  const { continuing, payments, payout, topUp, contribution } = economics
  const receipt = receiptScript(action, descriptor.termsDigest, listingId, operationCode, economics)
  const expiry = action.operation === 'retire' && action.authority === 'expiry'
  if (expiry)
    outputAssert(
      action.lockHeight >= descriptor.expiryHeight && action.lockHeight < 500000000,
      'Expiry retirement requires the committed height lock'
    )
  const needsSeller =
    action.operation === 'split' || (action.operation === 'retire' && action.authority === 'seller')
  return {
    operation: action.operation,
    operationCode,
    listingId,
    input: {
      txid: tx.id('hex'),
      outputIndex: previous.outputIndex,
      satoshis: oldValue.toString(),
      lockingScript: script
    },
    outputs: [
      ...continuing,
      ...(receipt === null ? [] : [output(1n, toHex(receipt))]),
      ...payments
    ],
    schedule: descriptor.initialRevenue,
    receiptIndex: receipt === null ? null : continuing.length,
    payout: payout.toString(),
    retirementTopUp: topUp.toString(),
    minimumExternalFunding: contribution.toString(),
    lockTime: expiry ? action.lockHeight : 0,
    listingSequence: expiry ? 0xfffffffe : 0xffffffff,
    requireAllFinalInputs: !expiry,
    ...(needsSeller
      ? {
          sellerAuthorization: {
            identity: descriptor.seller,
            publicKey: revenueListingChildPublicKey(descriptor.seller),
            protocolID: REVENUE_LISTING_AUTHORITY_PROTOCOL,
            keyID: REVENUE_LISTING_AUTHORITY_KEY_ID,
            counterparty: 'anyone' as const
          }
        }
      : {})
  }
}

function economicOutputs(
  profile: RevenueListingProfile,
  descriptor: ReturnType<typeof parseRevenueListingProfileDescriptor>,
  action: RevenueListingProfileAction,
  oldValue: bigint,
  script: string
) {
  const reserve = outputU64(descriptor.reserve)
  const continuing: RevenueListingProfileOutput[] = []
  const payments: RevenueListingProfileOutput[] = []
  let payout = 0n,
    topUp = 0n,
    contribution = action.operation === 'activate' ? 0n : 1n
  let commitment = Array.from({ length: 32 }, () => 0)
  switch (action.operation) {
    case 'activate':
      continuing.push(output(reserve, profile.lock('active', descriptor).toHex()))
      break
    case 'purchase':
      continuing.push(output(oldValue + outputU64(descriptor.purchasePrice), script))
      contribution += outputU64(descriptor.purchasePrice)
      break
    case 'split': {
      const first = outputU64(action.firstAmount)
      outputAssert(first >= reserve && oldValue - first >= reserve, 'Split violates reserve')
      continuing.push(output(first, script), output(oldValue - first, script))
      break
    }
    case 'payout':
    case 'retire': {
      const quantum = descriptor.initialRevenue.recipients.reduce(
        (sum, recipient) => sum + BigInt(recipient.weight),
        0n
      )
      const units =
        action.operation === 'payout'
          ? outputU64(action.units)
          : (oldValue + quantum - 1n) / quantum
      outputAssert(units > 0n, 'Payout units must be positive')
      payout = units * quantum
      amount(payout)
      for (const recipient of descriptor.initialRevenue.recipients)
        payments.push(
          output(
            units * BigInt(recipient.weight),
            new P2PKH()
              .lock(hash160(toArray(revenueListingChildPublicKey(recipient.identity), 'hex')))
              .toHex()
          )
        )
      commitment = sha256(serialized(payments))
      if (action.operation === 'payout') {
        outputAssert(oldValue - payout >= reserve, 'Payout violates reserve')
        continuing.push(output(oldValue - payout, script))
      } else {
        topUp = payout - oldValue
        contribution += topUp
      }
      break
    }
  }
  return { continuing, payments, payout, topUp, contribution, commitment }
}

function receiptScript(
  action: RevenueListingProfileAction,
  termsDigest: string,
  listingId: string,
  operationCode: RevenueListingProfilePlan['operationCode'],
  economics: ReturnType<typeof economicOutputs>
): number[] | null {
  if (action.operation === 'activate') return null
  if (action.operation === 'purchase')
    return [
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
      ...toArray(termsDigest, 'hex')
    ]
  return [
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
    ...le(1n, 4),
    ...le(BigInt(economics.continuing.length), 4),
    ...le(economics.payout, 8),
    ...economics.commitment
  ]
}
