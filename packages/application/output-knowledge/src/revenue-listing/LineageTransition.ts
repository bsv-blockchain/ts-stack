import { Utils, type OutputOutpoint, type Transaction } from '@bsv/sdk'
import { RevenueListing, type RevenueListingState } from '@bsv/sdk/script/templates/RevenueListing'
import { requireLineage, type LineageAssembly } from './LineagePackage.js'
import { layout, operation } from './LineageLayout.js'

export interface ListingTransition {
  transaction: Transaction
  inputs: number[]
}
function isListing(
  family: RevenueListing,
  script: number[],
  descriptor: LineageAssembly['package']['descriptor']
): boolean {
  try {
    family.decode(script, descriptor)
    return true
  } catch {
    return false
  }
}

function genesis(tx: Transaction, assembly: LineageAssembly, family: RevenueListing): void {
  const descriptor = assembly.package.descriptor
  layout(tx, true)
  requireLineage(
    tx.inputs[0].sourceTXID === descriptor.lineageAnchor.txid &&
      tx.inputs[0].sourceOutputIndex === descriptor.lineageAnchor.outputIndex,
    'Genesis anchor mismatch'
  )
  requireLineage(
    tx.outputs[0].satoshis?.toString() === descriptor.reserve &&
      tx.outputs[0].lockingScript.toHex() ===
        family.lock(descriptor, descriptor.initialRevenue).toHex(),
    'Genesis issuance mismatch'
  )
  tx.outputs.forEach((output, index) => {
    if (index > 0)
      requireLineage(
        !isListing(family, output.lockingScript.toBinary(), descriptor),
        'Additional genesis listing'
      )
    const bytes = output.lockingScript.toBinary()
    const receipt = bytes.length === 90 || bytes.length === 171
    requireLineage(
      !(
        receipt &&
        bytes[0] === 0 &&
        bytes[1] === 0x6a &&
        bytes[2] === 0x4c &&
        Utils.toHex(bytes.slice(4, 9)) === '524f534c01' &&
        bytes[9] >= 1 &&
        bytes[9] <= 6
      ),
      'Genesis operation receipt forbidden'
    )
  })
}

export interface InspectedTransition extends ListingTransition {
  code: number
  parents: OutputOutpoint[]
}

export function transitionFor(
  point: OutputOutpoint,
  tx: Transaction,
  assembly: LineageAssembly,
  family: RevenueListing
): InspectedTransition {
  const packet = assembly.package
  if (point.txid === packet.genesis.body.genesis.txid) {
    genesis(tx, assembly, family)
    return { transaction: tx, inputs: [], code: 0, parents: [] }
  }
  layout(tx, false)
  const code = operation(tx, 0),
    count = code === 3 ? 2 : 1
  requireLineage(tx.inputs.length > count, 'Missing external funding')
  const inputs = Array.from({ length: count }, (_, index) => index)
  const parents = inputs.map(index => {
    requireLineage(operation(tx, index) === code, 'Mixed listing operations')
    const input = tx.inputs[index]
    return {
      chain: packet.descriptor.chain,
      txid: input.sourceTXID!,
      outputIndex: input.sourceOutputIndex
    }
  })
  return { transaction: tx, inputs, code, parents }
}

export function successorState(
  point: OutputOutpoint,
  transition: InspectedTransition,
  assembly: LineageAssembly,
  family: RevenueListing
): RevenueListingState {
  const { code, transaction: tx } = transition
  requireLineage(code !== 5 && point.outputIndex < (code === 2 ? 2 : 1), 'Not a listing successor')
  const output = tx.outputs[point.outputIndex]
  requireLineage(output !== undefined, 'Missing listing output')
  const state = family.decode(output.lockingScript.toBinary(), assembly.package.descriptor)
  requireLineage(
    Number.isSafeInteger(output.satoshis) &&
      BigInt(output.satoshis!) >= BigInt(assembly.package.descriptor.reserve),
    'Listing below reserve'
  )
  return state
}
