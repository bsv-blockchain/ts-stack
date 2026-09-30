import Transaction from '../../transaction/Transaction.js'
import TransactionSignature from '../../primitives/TransactionSignature.js'
import PublicKey from '../../primitives/PublicKey.js'
import BigNumber from '../../primitives/BigNumber.js'
import { sha256 } from '../../primitives/Hash.js'
import { toArray, toHex, Writer } from '../../primitives/utils.js'
import Script from '../Script.js'
import UnlockingScript from '../UnlockingScript.js'
import { outputAssert } from '../../overlay-tools/OutputProtocolError.js'
import { outputU32 } from '../../overlay-tools/OutputProtocol.js'
import { array, normalized, object } from '../../overlay-tools/OutputProtocolSchema.js'
import {
  RevenueListing,
  parseRevenueListingDescriptor,
  encodeRevenueListingState,
  REVENUE_LISTING_PROGRAM_SHA256,
  REVENUE_LISTING_SCRIPT_BYTES
} from './RevenueListing.js'
import {
  planRevenueListingSpend,
  parseRevenueListingAction,
  parseRevenueListingPrevious,
  type RevenueListingAction,
  type RevenueListingPlan,
  type RevenueListingPrevious
} from './RevenueListingPlan.js'

const maximumSatoshis = 2100000000000000
const maximumRawBytes = 4194304
const maximumPreviousBytes = 1048576
const preimageBytes = 40167

export interface RevenueListingSigningRequest {
  inputIndex: number
  identity: string
  role: 'seller' | 'recipient'
  /** SHA256(preimage); Bitcoin ECDSA signs SHA256(data). No message envelope. */
  data: number[]
  preimage: number[]
  scope: 65
}
export interface RevenueListingSignatures {
  seller?: string
  recipients: string[]
}
export interface PreparedRevenueListingSpend {
  /** Owned descriptions only; this object never acquires or invokes a private key. */
  signingRequests(): RevenueListingSigningRequest[]
  /** Exact fourteen-argument ABI after checking every required transaction signature. */
  complete(signatures: unknown): Transaction
  /** Checks the final wallet result against every signed input/output/header commitment. */
  assertFinalLayout(transaction: Transaction): void
}

function positiveAmount(value: unknown): number {
  outputAssert(
    typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value > 0 &&
      value <= maximumSatoshis,
    'Invalid funded amount'
  )
  return value
}
function snapshot(transaction: Transaction): Transaction {
  outputAssert(
    transaction.inputs.length >= 2 &&
      transaction.inputs.length <= 8 &&
      transaction.outputs.length >= 1 &&
      transaction.outputs.length <= 11,
    'Funded transaction layout exceeds profile'
  )
  const bytes = transaction.toBinary()
  outputAssert(bytes.length <= maximumRawBytes, 'Funded transaction exceeds local byte limit')
  return Transaction.fromBinary(bytes)
}
function sourceTransaction(transaction: Transaction): Transaction {
  const bytes = transaction.toBinary()
  outputAssert(bytes.length <= maximumPreviousBytes, 'Funding predecessor exceeds local byte limit')
  return Transaction.fromBinary(bytes)
}
function sameOutput(
  actual: Transaction['outputs'][number],
  expected: RevenueListingPlan['outputs'][number]
): boolean {
  return (
    actual.satoshis?.toString() === expected.satoshis &&
    actual.lockingScript.toHex() === expected.lockingScript
  )
}

/** Own and bind all prevouts before constructing any signature request. */
function fundedSnapshot(
  transaction: Transaction,
  plan: RevenueListingPlan,
  previous: RevenueListingPrevious[]
): Transaction {
  const tx = snapshot(transaction)
  outputAssert(
    (tx.version === 1 || tx.version === 2) && tx.lockTime === 0,
    'Invalid funded transaction header'
  )
  outputAssert(tx.inputs.length > plan.inputs.length, 'External funding input required')
  const seen = new Set<string>()
  let inputTotal = 0n,
    outputTotal = 0n
  tx.inputs.forEach((input, index) => {
    outputAssert(input.sequence === 0xffffffff, 'All funded inputs must be final')
    outputU32(input.sourceOutputIndex)
    const source =
      index < previous.length
        ? Transaction.fromHex(previous[index].rawTransaction)
        : transaction.inputs[index].sourceTransaction
    outputAssert(source !== undefined, 'Funding predecessor evidence required')
    const owned = sourceTransaction(source)
    const txid = owned.id('hex')
    outputAssert(input.sourceTXID === txid, 'Funding predecessor identity mismatch')
    const key = `${txid}.${input.sourceOutputIndex}`
    outputAssert(!seen.has(key), 'Duplicate funded input')
    seen.add(key)
    const output = owned.outputs[input.sourceOutputIndex]
    outputAssert(output !== undefined, 'Funding predecessor output missing')
    inputTotal += BigInt(positiveAmount(output.satoshis))
    if (index < plan.inputs.length) {
      outputAssert(
        txid === plan.inputs[index].txid &&
          input.sourceOutputIndex === plan.inputs[index].outputIndex,
        'Listing input order changed'
      )
    } else {
      const script = output.lockingScript.toBinary()
      outputAssert(
        script.length !== REVENUE_LISTING_SCRIPT_BYTES ||
          toHex(sha256(script.slice(428))) !== REVENUE_LISTING_PROGRAM_SHA256,
        'Additional family listing cannot fund this route'
      )
    }
    input.sourceTransaction = owned
  })
  outputAssert(
    tx.outputs.length === plan.outputs.length || tx.outputs.length === plan.outputs.length + 1,
    'Funded output count changed'
  )
  tx.outputs.forEach((output, index) => {
    outputTotal += BigInt(positiveAmount(output.satoshis))
    if (index < plan.outputs.length)
      outputAssert(sameOutput(output, plan.outputs[index]), 'Required listing output changed')
    else
      outputAssert(
        /^76a914[0-9a-f]{40}88ac$/.test(output.lockingScript.toHex()),
        'Only one final P2PKH change output is allowed'
      )
  })
  outputAssert(
    inputTotal <= BigInt(maximumSatoshis) && outputTotal <= inputTotal,
    'Funded transaction does not conserve value'
  )
  return tx
}

function preimage(tx: Transaction, index: number): number[] {
  const input = tx.inputs[index]
  const source = input.sourceTransaction!.outputs[input.sourceOutputIndex]
  return TransactionSignature.format({
    sourceTXID: input.sourceTXID!,
    sourceOutputIndex: input.sourceOutputIndex,
    sourceSatoshis: source.satoshis!,
    transactionVersion: tx.version,
    otherInputs: tx.inputs.filter((_, other) => other !== index),
    outputs: tx.outputs,
    inputIndex: index,
    subscript: Script.fromHex(source.lockingScript.toHex()),
    inputSequence: input.sequence!,
    lockTime: tx.lockTime,
    scope: 0x41
  })
}
function signatureHex(value: unknown): string {
  outputAssert(
    typeof value === 'string' &&
      value.length >= 18 &&
      value.length <= 144 &&
      value.length % 2 === 0 &&
      /^[0-9a-f]+$/.test(value),
    'Expected canonical transaction signature'
  )
  return value
}
const signatureSchema = object({ recipients: array(signatureHex, 8) }, { seller: signatureHex })
function signature(value: string, identity: string, pre: number[]): number[] {
  const bytes = toArray(value, 'hex')
  const parsed = TransactionSignature.fromChecksigFormat(bytes)
  outputAssert(
    parsed.scope === 0x41 && parsed.hasLowS() && toHex(parsed.toChecksigFormat()) === value,
    'Transaction signature must be strict DER, low-S and ALL|FORKID'
  )
  outputAssert(
    parsed.verify(sha256(pre), PublicKey.fromString(identity)),
    'Transaction signature does not authorize this input'
  )
  return bytes
}
function y(identity: string): number[] {
  return PublicKey.fromString(identity).getY().toArray('be', 32)
}

function unlock(
  tx: Transaction,
  index: number,
  plan: RevenueListingPlan,
  action: RevenueListingAction,
  signed: RevenueListingSignatures
): UnlockingScript {
  const pre = preimage(tx, index)
  outputAssert(pre.length === preimageBytes, 'Unexpected family preimage size')
  const prevouts = new Writer()
  for (const input of tx.inputs)
    prevouts
      .write(toArray(input.sourceTXID!, 'hex').reverse())
      .writeUInt32LE(input.sourceOutputIndex)
  const admin =
    plan.signers.seller === undefined ? [] : signature(signed.seller!, plan.signers.seller, pre)
  let consents: number[] = []
  if (action.operation === 'amend') {
    consents = Array<number>(584).fill(0)
    plan.signers.recipients.forEach((identity, slot) => {
      const value = signature(signed.recipients[slot], identity, pre)
      consents[slot * 73] = value.length
      value.forEach((byte, offset) => {
        consents[slot * 73 + offset + 1] = byte
      })
    })
  }
  const newKeys = Array<number>(256).fill(0)
  if (action.operation === 'amend')
    action.state.recipients.forEach((item, slot) => {
      y(item.identity).forEach((byte, offset) => {
        newKeys[slot * 32 + offset] = byte
      })
    })
  const change = tx.outputs[plan.outputs.length]
  return new UnlockingScript()
    .writeBin(pre)
    .writeBin(prevouts.toArray())
    .writeNumber(plan.operationCode)
    .writeBin(toArray(plan.outputs[plan.receiptIndex].lockingScript, 'hex'))
    .writeBin(action.operation === 'purchase' ? y(action.recipient) : [])
    .writeBn(new BigNumber(action.operation === 'split' ? action.firstAmount : '0'))
    .writeBn(new BigNumber(action.operation === 'payout' ? action.units : '0'))
    .writeBin(
      action.operation === 'merge' ? tx.inputs[1 - index].sourceTransaction!.toBinary() : []
    )
    .writeBin(
      action.operation === 'amend' ? Array.from(encodeRevenueListingState(action.state)) : []
    )
    .writeBin(action.operation === 'amend' ? newKeys : [])
    .writeBin(admin)
    .writeBin(consents)
    .writeBin(
      change === undefined
        ? Array<number>(20).fill(0)
        : toArray(change.lockingScript.toHex().slice(6, 46), 'hex')
    )
    .writeNumber(change?.satoshis ?? 0)
}

/**
 * Separate planning and funded-input binding. Callers establish full lineage and
 * chain validity first, and use BRC-100 two-phase funding without output shuffling.
 * No wallet secret, network, broadcast, signing prompt or fee choice is implicit.
 */
export class RevenueListingSpend {
  private readonly descriptor: ReturnType<typeof parseRevenueListingDescriptor>
  private readonly previous: RevenueListingPrevious[]
  private readonly action: RevenueListingAction
  private readonly planned: RevenueListingPlan

  constructor(family: RevenueListing, descriptor: unknown, previous: unknown, action: unknown) {
    this.descriptor = parseRevenueListingDescriptor(descriptor)
    this.previous = parseRevenueListingPrevious(previous)
    this.action = parseRevenueListingAction(action)
    this.planned = planRevenueListingSpend(family, this.descriptor, this.previous, this.action)
  }
  /** JSON-only owned plan suitable for displaying all economic terms before funding. */
  plan(): RevenueListingPlan {
    return JSON.parse(JSON.stringify(this.planned)) as RevenueListingPlan
  }

  /** Conservative ABI size for funding, with all eight permitted final inputs. */
  estimateUnlockingLength(inputIndex: number): number {
    outputAssert(
      Number.isInteger(inputIndex) && inputIndex >= 0 && inputIndex < this.previous.length,
      'Invalid listing input index'
    )
    // PUSHDATA prefixes included. Numeric arguments occupy at most eight bytes.
    const other =
      this.action.operation === 'merge'
        ? this.previous[1 - inputIndex].rawTransaction.length / 2
        : 0
    const fields = [
      preimageBytes,
      288,
      1,
      this.planned.outputs[this.planned.receiptIndex].lockingScript.length / 2,
      this.action.operation === 'purchase' ? 32 : 0,
      8,
      8,
      other,
      this.action.operation === 'amend' ? 305 : 0,
      this.action.operation === 'amend' ? 256 : 0,
      this.action.operation === 'purchase' ? 0 : 72,
      this.action.operation === 'amend' ? 584 : 0,
      20,
      8
    ]
    return fields.reduce(
      (sum, length) =>
        sum + length + (length < 76 ? 1 : length <= 255 ? 2 : length <= 65535 ? 3 : 5),
      0
    )
  }

  prepare(transaction: Transaction): PreparedRevenueListingSpend {
    const plan = this.planned,
      action = this.action
    const tx = fundedSnapshot(transaction, plan, this.previous)
    const preimages = plan.inputs.map((_, index) => preimage(tx, index))
    const requests: RevenueListingSigningRequest[] = []
    plan.inputs.forEach((_, inputIndex) => {
      const pre = preimages[inputIndex]
      const add = (identity: string, role: 'seller' | 'recipient') =>
        requests.push({ inputIndex, identity, role, data: sha256(pre), preimage: pre, scope: 65 })
      if (plan.signers.seller !== undefined) add(plan.signers.seller, 'seller')
      for (const identity of plan.signers.recipients) add(identity, 'recipient')
    })
    return {
      signingRequests: () =>
        requests.map(item => ({ ...item, data: [...item.data], preimage: [...item.preimage] })),
      complete: (input: unknown) => {
        const signatures = normalized(input, array(signatureSchema, 2, 1), 8192)
        outputAssert(signatures.length === plan.inputs.length, 'Wrong signature input count')
        const completed = fundedSnapshot(tx, plan, this.previous)
        signatures.forEach((signed, index) => {
          outputAssert(
            (signed.seller !== undefined) === (plan.signers.seller !== undefined) &&
              signed.recipients.length === plan.signers.recipients.length,
            'Exact seller and recipient signatures required'
          )
          completed.inputs[index].unlockingScript = unlock(completed, index, plan, action, signed)
        })
        outputAssert(
          completed.toBinary().length <= maximumRawBytes,
          'Completed transaction exceeds local byte limit'
        )
        return completed
      },
      assertFinalLayout: (final: Transaction) => {
        const checked = fundedSnapshot(final, plan, this.previous)
        plan.inputs.forEach((_, index) =>
          outputAssert(
            toHex(preimage(checked, index)) === toHex(preimages[index]),
            'Wallet changed the signed transaction layout'
          )
        )
      }
    }
  }
}
