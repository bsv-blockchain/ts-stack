import Transaction from '../../transaction/Transaction.js'
import TransactionSignature from '../../primitives/TransactionSignature.js'
import PublicKey from '../../primitives/PublicKey.js'
import BigNumber from '../../primitives/BigNumber.js'
import Curve from '../../primitives/Curve.js'
import { sha256, sha256hmac, hash256 } from '../../primitives/Hash.js'
import { toArray, toHex, Writer } from '../../primitives/utils.js'
import Script from '../Script.js'
import UnlockingScript from '../UnlockingScript.js'
import { outputAssert } from '../../overlay-tools/OutputProtocolError.js'
import { normalized, object } from '../../overlay-tools/OutputProtocolSchema.js'
import {
  parseRevenueListingProfileDescriptor,
  REVENUE_LISTING_PROFILE_PROGRAM_OFFSET,
  REVENUE_LISTING_ACTIVATION_SCRIPT_BYTES,
  REVENUE_LISTING_ACTIVE_SCRIPT_BYTES,
  REVENUE_LISTING_ACTIVATION_PROGRAM_SHA256,
  REVENUE_LISTING_ACTIVE_PROGRAM_SHA256,
  type RevenueListingProfile
} from './RevenueListingProfile.js'
import {
  parseRevenueListingProfileAction,
  parseRevenueListingProfilePrevious,
  planRevenueListingProfileSpend,
  type RevenueListingProfileAction,
  type RevenueListingProfilePlan
} from './RevenueListingProfilePlan.js'
import { revenueListingChildPublicKey } from './RevenueListingKeys.js'

const maximumSatoshis = 2100000000000000
const maximumRawBytes = 4194304
const maximumPreviousBytes = 1048576
const order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
const field = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn
const nonceR = [
  0xc6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5n,
  0xf9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9n
] as const
const invoice = toArray('2-3241645161d8-brc197 authority', 'utf8')
type Descriptor = ReturnType<typeof parseRevenueListingProfileDescriptor>

export interface RevenueListingProfileSigningRequest {
  inputIndex: 0
  identity: string
  publicKey: string
  role: 'seller'
  protocolID: readonly [2, '3241645161d8']
  keyID: 'brc197 authority'
  counterparty: 'anyone'
  /** SHA256(preimage); a protected Bitcoin signer hashes this once more. */
  data: number[]
  preimage: number[]
  scope: 65
}
export interface PreparedRevenueListingProfileSpend {
  /** Full SHA256d(input-zero preimage), before scalar reduction; construction is not verification. */
  readonly purchaseCommitment?: string
  signingRequests(): RevenueListingProfileSigningRequest[]
  /** Seller-child signature only when required. All other routes require an empty record. */
  complete(signatures: unknown): Transaction
  /** Header/prevout/output binding; complete input Script verification remains separate. */
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
function fundingAmount(value: unknown): number {
  outputAssert(
    typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= 0 &&
      value <= maximumSatoshis,
    'Invalid external funding amount'
  )
  return value
}
function copyTransaction(transaction: Transaction, bound: number): Transaction {
  const raw = transaction.toBinary()
  outputAssert(raw.length <= bound, 'Transaction exceeds local byte limit')
  return Transaction.fromBinary(raw)
}
function isFamilySource(script: number[]): boolean {
  const program = script.slice(REVENUE_LISTING_PROFILE_PROGRAM_OFFSET)
  return (
    (script.length === REVENUE_LISTING_ACTIVATION_SCRIPT_BYTES &&
      toHex(sha256(program)) === REVENUE_LISTING_ACTIVATION_PROGRAM_SHA256) ||
    (script.length === REVENUE_LISTING_ACTIVE_SCRIPT_BYTES &&
      toHex(sha256(program)) === REVENUE_LISTING_ACTIVE_PROGRAM_SHA256)
  )
}
function fundedSnapshot(
  transaction: Transaction,
  plan: RevenueListingProfilePlan,
  previous: Transaction
): Transaction {
  outputAssert(
    transaction.inputs.length >= 2 &&
      transaction.inputs.length <= 8 &&
      transaction.outputs.length >= 1 &&
      transaction.outputs.length <= 11,
    'Funded transaction layout exceeds profile'
  )
  const tx = copyTransaction(transaction, maximumRawBytes)
  outputAssert(tx.lockTime === plan.lockTime, 'Funded transaction locktime changed')
  const seen = new Set<string>()
  let inputTotal = 0n,
    outputTotal = 0n
  tx.inputs.forEach((input, index) => {
    outputAssert(
      Number.isInteger(input.sequence) &&
        input.sequence! >= 0 &&
        input.sequence! <= 0xffffffff &&
        (plan.requireAllFinalInputs
          ? input.sequence === 0xffffffff
          : index !== 0 || input.sequence! < 0xffffffff),
      'Funded input finality differs from the route'
    )
    const source = index === 0 ? previous : transaction.inputs[index].sourceTransaction
    outputAssert(source !== undefined, 'Funding predecessor evidence required')
    const owned = copyTransaction(source, maximumPreviousBytes)
    const txid = owned.id('hex')
    outputAssert(input.sourceTXID === txid, 'Funding predecessor identity mismatch')
    const key = `${txid}.${input.sourceOutputIndex}`
    outputAssert(!seen.has(key), 'Duplicate funded input')
    seen.add(key)
    const output = owned.outputs[input.sourceOutputIndex]
    outputAssert(output !== undefined, 'Funding predecessor output missing')
    inputTotal += BigInt(
      index === 0 ? positiveAmount(output.satoshis) : fundingAmount(output.satoshis)
    )
    if (index === 0) {
      outputAssert(
        txid === plan.input.txid &&
          input.sourceOutputIndex === plan.input.outputIndex &&
          output.satoshis!.toString() === plan.input.satoshis &&
          output.lockingScript.toHex() === plan.input.lockingScript,
        'Listing input changed'
      )
    } else {
      outputAssert(
        !isFamilySource(output.lockingScript.toBinary()),
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
    if (index < plan.outputs.length) {
      outputAssert(
        output.satoshis!.toString() === plan.outputs[index].satoshis &&
          output.lockingScript.toHex() === plan.outputs[index].lockingScript,
        'Required listing output changed'
      )
    } else {
      outputAssert(
        /^76a914[0-9a-f]{40}88ac$/.test(output.lockingScript.toHex()),
        'Only one final P2PKH change output is allowed'
      )
    }
  })
  outputAssert(
    inputTotal <= BigInt(maximumSatoshis) && outputTotal <= inputTotal,
    'Funded transaction does not conserve value'
  )
  return tx
}
function preimage(tx: Transaction): number[] {
  const input = tx.inputs[0]
  const source = input.sourceTransaction!.outputs[input.sourceOutputIndex]
  return TransactionSignature.format({
    sourceTXID: input.sourceTXID!,
    sourceOutputIndex: input.sourceOutputIndex,
    sourceSatoshis: source.satoshis!,
    transactionVersion: tx.version,
    otherInputs: tx.inputs.slice(1),
    outputs: tx.outputs,
    inputIndex: 0,
    subscript: Script.fromHex(source.lockingScript.toHex()),
    inputSequence: input.sequence!,
    lockTime: tx.lockTime,
    scope: 0x41
  })
}
const mod = (value: bigint, modulus: bigint): bigint => ((value % modulus) + modulus) % modulus
function inverse(value: bigint, modulus: bigint): bigint {
  let a = mod(value, modulus),
    b = modulus,
    x = 1n,
    y = 0n
  while (b !== 0n) {
    const quotient = a / b
    ;[a, b] = [b, a - quotient * b]
    ;[x, y] = [y, x - quotient * y]
  }
  outputAssert(a === 1n, 'Degenerate public linkage inverse')
  return mod(x, modulus)
}
/** Fixed-nonce signatures use only public scalars: 1 or the public HMAC tweak. */
function publicSignature(nonce: 2 | 3, digest: bigint, scalar: bigint): number[] {
  const r = nonceR[nonce - 2]
  let s = mod(inverse(BigInt(nonce), order) * (digest + r * scalar), order)
  outputAssert(s !== 0n, 'Exceptional public binder digest; rebuild the funded transaction')
  if (s > order / 2n) s = order - s
  return new TransactionSignature(
    new BigNumber(r.toString(16), 16),
    new BigNumber(s.toString(16), 16),
    0x41
  ).toChecksigFormat()
}
type PublicWitnessValue = number[] | bigint
function coordinates(key: PublicKey): [bigint, bigint] {
  return [BigInt(key.getX().toString(10)), BigInt(key.getY().toString(10))]
}
function linkage(rootIdentity: string, digest: bigint): PublicWitnessValue[] {
  const root = PublicKey.fromString(rootIdentity)
  const tweak = mod(BigInt('0x' + toHex(sha256hmac(root.encode(true), invoice))), order)
  outputAssert(tweak !== 0n, 'Degenerate public child tweak')
  const child = PublicKey.fromString(revenueListingChildPublicKey(rootIdentity))
  const delta = new Curve().g.mul(new BigNumber(tweak.toString(16), 16))
  const [rootX, rootY] = coordinates(root),
    [childX, childY] = coordinates(child)
  const deltaX = BigInt(delta.getX().toString(10)),
    deltaY = BigInt(delta.getY().toString(10))
  outputAssert(rootX !== childX, 'Degenerate public child slope')
  const slope = mod((childY + rootY) * inverse(childX - rootX, field), field)
  return [
    delta.encode(true) as number[],
    tweak,
    publicSignature(2, digest, tweak),
    publicSignature(3, digest, tweak),
    rootX,
    rootY,
    childX,
    childY,
    slope,
    deltaX,
    deltaY
  ]
}
function signatureHex(input: unknown): string {
  outputAssert(
    typeof input === 'string' &&
      input.length >= 18 &&
      input.length <= 144 &&
      input.length % 2 === 0 &&
      /^[0-9a-f]+$/.test(input),
    'Expected canonical seller-child signature'
  )
  return input
}
const signaturesSchema = object({}, { seller: signatureHex })
function sellerSignature(input: string, publicKey: string, pre: number[]): number[] {
  const parsed = TransactionSignature.fromChecksigFormat(toArray(input, 'hex'))
  outputAssert(
    parsed.scope === 0x41 &&
      parsed.hasLowS() &&
      toHex(parsed.toChecksigFormat()) === input &&
      parsed.verify(sha256(pre), PublicKey.fromString(publicKey)),
    'Seller signature must authorize this input with the protected child and ALL|FORKID'
  )
  return parsed.toChecksigFormat()
}
function activationWitness(descriptor: Descriptor, digest: bigint): PublicWitnessValue[] {
  const values = linkage(descriptor.seller, digest)
  for (const recipient of descriptor.initialRevenue.recipients)
    values.push(...linkage(recipient.identity, digest))
  for (let index = descriptor.initialRevenue.recipients.length; index < 8; index++)
    values.push(...new Array<bigint>(11).fill(0n))
  return values
}
function operationParameter(action: RevenueListingProfileAction): bigint {
  if (action.operation === 'split') return BigInt(action.firstAmount)
  if (action.operation === 'payout') return BigInt(action.units)
  return 0n
}
function witness(
  tx: Transaction,
  descriptor: Descriptor,
  action: RevenueListingProfileAction,
  plan: RevenueListingProfilePlan,
  signature: number[]
): UnlockingScript {
  const pre = preimage(tx)
  const digest = mod(BigInt('0x' + toHex(hash256(pre))), order)
  outputAssert(digest !== 0n, 'Exceptional public binder digest; rebuild the funded transaction')
  const prevouts = new Writer()
  for (const input of tx.inputs)
    prevouts
      .write(toArray(input.sourceTXID!, 'hex').reverse())
      .writeUInt32LE(input.sourceOutputIndex)
  const change = tx.outputs[plan.outputs.length]
  const buyer = action.operation === 'purchase' ? PublicKey.fromString(action.recipient) : undefined
  const [buyerX, buyerY] = buyer === undefined ? [0n, 0n] : coordinates(buyer)
  const values: PublicWitnessValue[] = []
  if (action.operation === 'activate') values.push(...activationWitness(descriptor, digest))
  values.push(
    pre,
    prevouts.toArray(),
    BigInt(plan.operationCode),
    action.operation === 'purchase'
      ? toArray(action.acquisitionId, 'hex')
      : new Array<number>(32).fill(0),
    action.operation === 'purchase'
      ? toArray(action.requestDigest, 'hex')
      : new Array<number>(32).fill(0),
    buyer === undefined ? new Array<number>(33).fill(0) : (buyer.encode(true) as number[]),
    buyerX,
    buyerY,
    operationParameter(action),
    change === undefined
      ? new Array<number>(20).fill(0)
      : toArray(change.lockingScript.toHex().slice(6, 46), 'hex'),
    BigInt(change?.satoshis ?? 0),
    signature,
    digest,
    publicSignature(2, digest, 1n),
    publicSignature(3, digest, 1n)
  )
  const script = new UnlockingScript()
  for (const value of values) {
    if (typeof value === 'bigint') script.writeBn(new BigNumber(value.toString(16), 16))
    else script.writeBin(value)
  }
  return script
}

/** Funded layout and public witness construction; never acquires or exports a private scalar. */
export class RevenueListingProfileSpend {
  private readonly descriptor: Descriptor
  private readonly previous: Transaction
  private readonly action: RevenueListingProfileAction
  private readonly planned: RevenueListingProfilePlan

  constructor(
    profile: RevenueListingProfile,
    descriptor: unknown,
    previous: unknown,
    action: unknown
  ) {
    this.descriptor = parseRevenueListingProfileDescriptor(descriptor)
    const ownedPrevious = parseRevenueListingProfilePrevious(previous)
    this.previous = Transaction.fromHex(ownedPrevious[0].rawTransaction)
    this.action = parseRevenueListingProfileAction(action)
    this.planned = planRevenueListingProfileSpend(
      profile,
      this.descriptor,
      ownedPrevious,
      this.action
    )
  }
  plan(): RevenueListingProfilePlan {
    const p = this.planned
    return {
      ...p,
      input: { ...p.input },
      outputs: p.outputs.map(output => ({ ...output })),
      schedule: { recipients: p.schedule.recipients.map(recipient => ({ ...recipient })) },
      ...(p.sellerAuthorization === undefined
        ? {}
        : { sellerAuthorization: { ...p.sellerAuthorization } })
    }
  }
  /** Conservative full 114/15-value ABI size, including eight possible prevouts. */
  estimateUnlockingLength(inputIndex = 0): number {
    outputAssert(inputIndex === 0, 'Only input zero may consume the listing')
    const bytes =
      (this.action.operation === 'activate'
        ? REVENUE_LISTING_ACTIVATION_SCRIPT_BYTES
        : REVENUE_LISTING_ACTIVE_SCRIPT_BYTES) + 159
    const common = [bytes, 288, 1, 32, 32, 33, 33, 33, 8, 20, 8, 72, 33, 72, 72]
    const proof = [33, 33, 72, 72, 33, 33, 33, 33, 33, 33, 33]
    const pushed = (length: number) => {
      if (length < 76) return length + 1
      if (length <= 255) return length + 2
      return length + 3
    }
    return (
      common.reduce((sum, length) => sum + pushed(length), 0) +
      (this.action.operation === 'activate'
        ? 9 * proof.reduce((sum, length) => sum + pushed(length), 0)
        : 0)
    )
  }
  prepare(transaction: Transaction): PreparedRevenueListingProfileSpend {
    const tx = fundedSnapshot(transaction, this.planned, this.previous),
      pre = preimage(tx)
    const authority = this.planned.sellerAuthorization
    const request: RevenueListingProfileSigningRequest | undefined =
      authority === undefined
        ? undefined
        : {
            ...authority,
            inputIndex: 0,
            role: 'seller',
            data: sha256(pre),
            preimage: pre,
            scope: 65
          }
    return {
      ...(this.action.operation === 'purchase' ? { purchaseCommitment: toHex(hash256(pre)) } : {}),
      signingRequests: () =>
        request === undefined
          ? []
          : [{ ...request, data: [...request.data], preimage: [...request.preimage] }],
      complete: input => {
        const signed = normalized(input, signaturesSchema, 8192)
        outputAssert(
          (signed.seller !== undefined) === (authority !== undefined),
          'Exact seller-child signature presence required'
        )
        const completed = fundedSnapshot(tx, this.planned, this.previous)
        const signature =
          authority === undefined ? [] : sellerSignature(signed.seller!, authority.publicKey, pre)
        completed.inputs[0].unlockingScript = witness(
          completed,
          this.descriptor,
          this.action,
          this.planned,
          signature
        )
        outputAssert(
          completed.toBinary().length <= maximumRawBytes,
          'Completed transaction exceeds local byte limit'
        )
        return completed
      },
      assertFinalLayout: final => {
        const checked = fundedSnapshot(final, this.planned, this.previous)
        outputAssert(
          toHex(preimage(checked)) === toHex(pre),
          'Wallet changed the authenticated transaction layout'
        )
      }
    }
  }
}
