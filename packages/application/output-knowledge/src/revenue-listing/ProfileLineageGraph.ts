import { Hash, Spend, Utils, type OutputOutpoint, type Transaction } from '@bsv/sdk'
import {
  REVENUE_LISTING_PROFILE_PROGRAM_OFFSET,
  REVENUE_LISTING_ACTIVATION_SCRIPT_BYTES,
  REVENUE_LISTING_ACTIVE_SCRIPT_BYTES,
  REVENUE_LISTING_ACTIVATION_PROGRAM_SHA256,
  REVENUE_LISTING_ACTIVE_PROGRAM_SHA256,
  type RevenueListingProfile,
  type RevenueListingProfileDescriptor,
  type RevenueListingStage
} from '@bsv/sdk/script/templates/RevenueListingProfile'
import {
  planRevenueListingProfileSpend,
  type RevenueListingProfileAction,
  type RevenueListingProfilePlan
} from '@bsv/sdk/script/templates/RevenueListingProfilePlan'
import { requireLineage, type LineageAssembly } from './LineagePackage.js'

type Assembly = LineageAssembly<RevenueListingProfileDescriptor>
export interface ProfileListingTransition {
  transaction: Transaction
  parent?: OutputOutpoint
  plan?: RevenueListingProfilePlan
}
const maximumSatoshis = 2100000000000000n

/** Recognize either frozen executable, irrespective of a claimed descriptor. */
function familyScript(script: number[]): boolean {
  const digest = Utils.toHex(Hash.sha256(script.slice(REVENUE_LISTING_PROFILE_PROGRAM_OFFSET)))
  return (
    (script.length === REVENUE_LISTING_ACTIVATION_SCRIPT_BYTES &&
      digest === REVENUE_LISTING_ACTIVATION_PROGRAM_SHA256) ||
    (script.length === REVENUE_LISTING_ACTIVE_SCRIPT_BYTES &&
      digest === REVENUE_LISTING_ACTIVE_PROGRAM_SHA256)
  )
}
function dimensions(tx: Transaction, genesis: boolean): void {
  requireLineage(
    tx.inputs.length >= (genesis ? 1 : 2) &&
      tx.outputs.length >= 1 &&
      (genesis || (tx.inputs.length <= 8 && tx.outputs.length <= 11)),
    'Listing dimensions exceed profile'
  )
  for (const output of tx.outputs)
    requireLineage(
      Number.isSafeInteger(output.satoshis) &&
        output.satoshis! >= 0 &&
        BigInt(output.satoshis!) <= maximumSatoshis,
      'Invalid listing output value'
    )
}
function receipt(script: number[]): boolean {
  return (
    (script.length === 171 || script.length === 90) &&
    Utils.toHex(script.slice(0, 9)) ===
      (script.length === 171 ? '006a4ca7524f534c01' : '006a4c56524f534c01')
  )
}

/** Route selection comes from outputs, followed by the actual authenticated
 * Script. No canonical scriptSig spelling or fixed chunk count is required.
 */
function action(
  tx: Transaction,
  stage: RevenueListingStage,
  descriptor: RevenueListingProfileDescriptor
): RevenueListingProfileAction {
  if (stage === 'activation') return { operation: 'activate' }
  const receipts = tx.outputs
    .map((output, index) => ({ index, bytes: output.lockingScript.toBinary() }))
    .filter(item => receipt(item.bytes))
  requireLineage(receipts.length === 1, 'Exactly one listing operation receipt required')
  const { index, bytes } = receipts[0]
  switch (bytes[9]) {
    case 1:
      requireLineage(index === 1 && bytes.length === 171, 'Invalid purchase receipt position')
      return {
        operation: 'purchase',
        acquisitionId: Utils.toHex(bytes.slice(42, 74)),
        requestDigest: Utils.toHex(bytes.slice(74, 106)),
        recipient: Utils.toHex(bytes.slice(106, 139))
      }
    case 2:
      requireLineage(index === 2 && bytes.length === 90, 'Invalid split receipt position')
      return { operation: 'split', firstAmount: tx.outputs[0].satoshis!.toString() }
    case 4: {
      requireLineage(index === 1 && bytes.length === 90, 'Invalid payout receipt position')
      const payout = new DataView(Uint8Array.from(bytes).buffer).getBigUint64(50, true)
      const quantum = descriptor.initialRevenue.recipients.reduce(
        (sum, recipient) => sum + BigInt(recipient.weight),
        0n
      )
      requireLineage(payout > 0n && payout % quantum === 0n, 'Invalid payout quantum')
      return { operation: 'payout', units: (payout / quantum).toString() }
    }
    case 5:
      requireLineage(index === 0 && bytes.length === 90, 'Invalid retirement receipt position')
      return tx.lockTime === 0
        ? { operation: 'retire', authority: 'seller' }
        : { operation: 'retire', authority: 'expiry', lockHeight: tx.lockTime }
    default:
      throw new Error('Unknown immutable listing route')
  }
}

/** Complete-source layout/economics inspection; execution and Bitcoin evidence
 * remain separate. Every external input must have its exact raw predecessor.
 */
export function inspectProfileTransition(
  tx: Transaction,
  assembly: Assembly,
  profile: RevenueListingProfile
): ProfileListingTransition {
  const packet = assembly.package,
    descriptor = packet.descriptor
  const genesis = tx.id('hex') === packet.genesis.body.genesis.txid
  dimensions(tx, genesis)
  if (genesis) {
    requireLineage(
      tx.inputs[0].sourceTXID === descriptor.lineageAnchor.txid &&
        tx.inputs[0].sourceOutputIndex === descriptor.lineageAnchor.outputIndex,
      'Genesis anchor mismatch'
    )
    requireLineage(
      tx.outputs[0].satoshis?.toString() === descriptor.reserve &&
        tx.outputs[0].lockingScript.toHex() === profile.lock('activation', descriptor).toHex(),
      'Genesis activation issuance mismatch'
    )
    tx.outputs.forEach((output, index) => {
      requireLineage(
        index === 0 || !familyScript(output.lockingScript.toBinary()),
        'Additional genesis family listing'
      )
      const bytes = output.lockingScript.toBinary()
      requireLineage(
        !(receipt(bytes) && bytes.length === 171 && bytes[9] === 1),
        'Genesis purchase receipt forbidden'
      )
    })
    return { transaction: tx }
  }
  const input = tx.inputs[0],
    previous = assembly.transactions.get(input.sourceTXID!)
  requireLineage(previous !== undefined, 'Listing predecessor raw bytes unavailable')
  const output = previous.outputs[input.sourceOutputIndex]
  requireLineage(output !== undefined, 'Listing predecessor output missing')
  const recognized = profile.decode(output.lockingScript.toBinary(), descriptor)
  const selectedAction = action(tx, recognized.stage, descriptor)
  const plan = planRevenueListingProfileSpend(
    profile,
    descriptor,
    [{ rawTransaction: previous.toHex(), outputIndex: input.sourceOutputIndex }],
    selectedAction
  )
  requireLineage(tx.lockTime === plan.lockTime, 'Listing route locktime differs')
  requireLineage(
    tx.outputs.length === plan.outputs.length || tx.outputs.length === plan.outputs.length + 1,
    'Listing output count differs'
  )
  let inputTotal = 0n,
    outputTotal = 0n
  const seen = new Set<string>()
  tx.inputs.forEach((funding, index) => {
    requireLineage(
      Number.isInteger(funding.sequence) &&
        funding.sequence! >= 0 &&
        funding.sequence! <= 0xffffffff &&
        (plan.requireAllFinalInputs
          ? funding.sequence === 0xffffffff
          : index !== 0 || funding.sequence! < 0xffffffff),
      'Listing route sequence differs'
    )
    const key = `${funding.sourceTXID}.${funding.sourceOutputIndex}`
    requireLineage(!seen.has(key), 'Duplicate listing input')
    seen.add(key)
    const source = assembly.transactions.get(funding.sourceTXID!)
    requireLineage(
      source !== undefined && source.id('hex') === funding.sourceTXID,
      'Funding predecessor raw bytes unavailable'
    )
    const sourceOutput = source.outputs[funding.sourceOutputIndex]
    requireLineage(
      sourceOutput !== undefined &&
        Number.isSafeInteger(sourceOutput.satoshis) &&
        sourceOutput.satoshis! >= 0,
      'Invalid funding output'
    )
    requireLineage(
      index === 0 || !familyScript(sourceOutput.lockingScript.toBinary()),
      'Additional family listing cannot fund a route'
    )
    inputTotal += BigInt(sourceOutput.satoshis!)
  })
  tx.outputs.forEach((output, index) => {
    requireLineage(output.satoshis! > 0, 'Listing outputs must be positive')
    outputTotal += BigInt(output.satoshis!)
    if (index < plan.outputs.length)
      requireLineage(
        output.satoshis!.toString() === plan.outputs[index].satoshis &&
          output.lockingScript.toHex() === plan.outputs[index].lockingScript,
        'Listing mandatory output differs'
      )
    else
      requireLineage(
        /^76a914[0-9a-f]{40}88ac$/.test(output.lockingScript.toHex()),
        'Only one final P2PKH change output is allowed'
      )
  })
  requireLineage(
    inputTotal <= maximumSatoshis && outputTotal <= inputTotal,
    'Listing transaction does not conserve value'
  )
  return {
    transaction: tx,
    parent: {
      chain: descriptor.chain,
      txid: input.sourceTXID!,
      outputIndex: input.sourceOutputIndex
    },
    plan
  }
}

export type ProfileListingGraph =
  | { complete: false; missing: OutputOutpoint[] }
  | {
      complete: true
      transitions: ProfileListingTransition[]
      stage: RevenueListingStage
      satoshis: string
      rawTransaction: string
    }

/** One parent per current-family transition; split branches share immutable
 * ancestry. Genesis and activation must occur on every path to an active UTXO.
 */
export function inspectProfileLineage(
  assembly: Assembly,
  profile: RevenueListingProfile
): ProfileListingGraph {
  const visited = new Set<string>(),
    transitions: ProfileListingTransition[] = []
  let point = assembly.package.target
  let target: { stage: RevenueListingStage; satoshis: string; rawTransaction: string } | undefined
  for (;;) {
    requireLineage(!visited.has(point.txid), 'Cyclic listing ancestry')
    if (!assembly.entries.has(point.txid)) return { complete: false, missing: [point] }
    visited.add(point.txid)
    const tx = assembly.transactions.get(point.txid)!
    const transition = inspectProfileTransition(tx, assembly, profile)
    const code = transition.plan?.operationCode
    requireLineage(
      point.outputIndex < (code === 2 ? 2 : 1) && code !== 5,
      'Not a listing successor'
    )
    const output = tx.outputs[point.outputIndex]
    requireLineage(
      output !== undefined && output.satoshis! >= Number(assembly.package.descriptor.reserve),
      'Listing below reserve'
    )
    const { stage } = profile.decode(output.lockingScript.toBinary(), assembly.package.descriptor)
    requireLineage(
      stage === (transition.parent === undefined ? 'activation' : 'active'),
      'Listing stage ancestry differs'
    )
    target ??= {
      stage,
      satoshis: output.satoshis!.toString(),
      rawTransaction: Utils.toBase64(tx.toBinary())
    }
    transitions.push(transition)
    if (transition.parent === undefined) break
    point = transition.parent
  }
  requireLineage(visited.size === assembly.entries.size, 'Unrelated listing entries')
  requireLineage(target !== undefined, 'Target unavailable')
  return { complete: true, transitions, ...target }
}

/** Execute every actual input, including externally funded inputs, even for
 * a mined target. Complete raw sources are required; a mining proof alone
 * does not authenticate the profile's own transition predicates.
 */
export function executeProfileInputs(
  assembly: Assembly,
  tx: Transaction,
  memoryLimit: number
): void {
  tx.inputs.forEach((_, index) => executeProfileInput(assembly, tx, index, memoryLimit))
}

/** One bounded invocation, allowing the owner to yield/check cancellation between inputs. */
export function executeProfileInput(
  assembly: Assembly,
  tx: Transaction,
  index: number,
  memoryLimit: number
): void {
  const input = tx.inputs[index]
  const previous = assembly.transactions.get(input.sourceTXID!)
  requireLineage(previous !== undefined, 'Input predecessor raw bytes unavailable')
  const output = previous.outputs[input.sourceOutputIndex]
  requireLineage(
    output !== undefined && input.unlockingScript !== undefined,
    'Input Script unavailable'
  )
  requireLineage(
    new Spend({
      sourceTXID: input.sourceTXID!,
      sourceOutputIndex: input.sourceOutputIndex,
      sourceSatoshis: output.satoshis!,
      lockingScript: output.lockingScript,
      transactionVersion: tx.version,
      otherInputs: tx.inputs.filter((_, other) => other !== index),
      outputs: tx.outputs,
      inputIndex: index,
      unlockingScript: input.unlockingScript,
      inputSequence: input.sequence!,
      lockTime: tx.lockTime,
      memoryLimit
    }).validateJavaScript(),
    'Listing input Script rejected'
  )
}
