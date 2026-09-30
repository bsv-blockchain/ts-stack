import { BigNumber, Script, Spend, Utils, type OutputOutpoint, type Transaction } from '@bsv/sdk'
import { RevenueListing, type RevenueListingState } from '@bsv/sdk/script/templates/RevenueListing'
import { requireLineage, type LineageAssembly } from './LineagePackage.js'

export interface ListingTransition {
  transaction: Transaction
  inputs: number[]
}
export type ListingGraph =
  | { complete: false; missing: OutputOutpoint[] }
  | {
      complete: true
      transitions: ListingTransition[]
      state: RevenueListingState
      satoshis: string
      rawTransaction: string
    }

function pointKey(point: OutputOutpoint): string {
  return `${point.txid}.${point.outputIndex}`
}

function layout(tx: Transaction, genesis: boolean): void {
  requireLineage(
    (tx.version === 1 || tx.version === 2) && tx.lockTime === 0,
    'Invalid listing header'
  )
  requireLineage(
    tx.inputs.length >= (genesis ? 1 : 2) &&
      tx.inputs.length <= 8 &&
      tx.outputs.length >= 1 &&
      tx.outputs.length <= 11,
    'Listing dimensions exceed profile'
  )
  for (const input of tx.inputs)
    requireLineage(input.sequence === 0xffffffff, 'Non-final listing input')
  for (const output of tx.outputs)
    requireLineage(
      Number.isSafeInteger(output.satoshis) &&
        output.satoshis! >= 0 &&
        output.satoshis! <= 2100000000000000,
      'Invalid listing output value'
    )
}

/** Enforce the complete minimal-push ABI before running the authenticated program. */
function operation(tx: Transaction, inputIndex: number): number {
  const script = tx.inputs[inputIndex].unlockingScript
  requireLineage(
    script !== undefined && script.chunks.length === 14,
    'Invalid listing unlocking ABI'
  )
  const values = script.chunks.map(chunk => {
    if (chunk.data !== undefined) return chunk.data
    if (chunk.op === 0) return []
    requireLineage(chunk.op >= 0x51 && chunk.op <= 0x60, 'Non-push listing argument')
    return [chunk.op - 0x50]
  })
  const canonical = new Script()
  for (const value of values) {
    if (value.length === 1 && value[0] >= 1 && value[0] <= 16) canonical.writeNumber(value[0])
    else canonical.writeBin(value)
  }
  requireLineage(canonical.toHex() === script.toHex(), 'Nonminimal listing argument')
  for (const index of [2, 5, 6, 13]) {
    const number = BigNumber.fromSm(values[index], 'little')
    requireLineage(
      !number.isNeg() && Utils.toHex(number.toSm('little')) === Utils.toHex(values[index]),
      'Noncanonical listing integer'
    )
  }
  requireLineage(
    values[2].length === 1 && values[2][0] >= 1 && values[2][0] <= 6,
    'Unknown listing route'
  )
  requireLineage(values[0].length === 40167, 'Invalid listing preimage size')
  return values[2][0]
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

interface InspectedTransition extends ListingTransition {
  code: number
  parents: OutputOutpoint[]
}

function transitionFor(
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

function successorState(
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

interface Traversal {
  transitions: Map<string, InspectedTransition>
  visited: Set<string>
  active: Set<string>
  missing: Map<string, OutputOutpoint>
  stack: { point: OutputOutpoint; exit: boolean }[]
  target?: { state: RevenueListingState; satoshis: string; rawTransaction: string }
}

function visitPoint(
  point: OutputOutpoint,
  traversal: Traversal,
  assembly: LineageAssembly,
  family: RevenueListing
): void {
  const key = pointKey(point)
  if (traversal.visited.has(key)) return
  requireLineage(!traversal.active.has(key), 'Cyclic listing ancestry')
  if (!assembly.entries.has(point.txid)) {
    traversal.missing.set(key, point)
    return
  }
  let transition = traversal.transitions.get(point.txid)
  if (transition === undefined) {
    transition = transitionFor(point, assembly.transactions.get(point.txid)!, assembly, family)
    traversal.transitions.set(point.txid, transition)
  }
  const state = successorState(point, transition, assembly, family)
  if (key === pointKey(assembly.package.target)) {
    traversal.target = {
      state,
      satoshis: transition.transaction.outputs[point.outputIndex].satoshis!.toString(),
      rawTransaction: Utils.toBase64(transition.transaction.toBinary())
    }
  }
  traversal.active.add(key)
  traversal.stack.push({ point, exit: true })
  for (const parent of transition.parents) traversal.stack.push({ point: parent, exit: false })
}

/** Inspect both merge parents with a visited DAG. This does not execute Bitcoin verification. */
export function inspectLineage(assembly: LineageAssembly, family: RevenueListing): ListingGraph {
  const traversal: Traversal = {
    transitions: new Map(),
    visited: new Set(),
    active: new Set(),
    missing: new Map(),
    stack: [{ point: assembly.package.target, exit: false }]
  }
  while (traversal.stack.length > 0) {
    const { point, exit } = traversal.stack.pop()!
    if (exit) {
      traversal.active.delete(pointKey(point))
      traversal.visited.add(pointKey(point))
    } else visitPoint(point, traversal, assembly, family)
  }
  if (traversal.missing.size > 0)
    return { complete: false, missing: [...traversal.missing.values()] }
  requireLineage(
    traversal.transitions.has(assembly.package.genesis.body.genesis.txid),
    'Authorized genesis absent'
  )
  requireLineage(traversal.transitions.size === assembly.entries.size, 'Unrelated listing entries')
  requireLineage(traversal.target !== undefined, 'Target state unavailable')
  return {
    complete: true,
    transitions: [...traversal.transitions.values()],
    ...traversal.target
  }
}

/** Execute each actual covenant input even if its transaction has a mining proof. */
export function executeListingInput(
  assembly: LineageAssembly,
  transition: ListingTransition,
  index: number,
  memoryLimit: number
): void {
  const tx = transition.transaction,
    input = tx.inputs[index]
  const parent = assembly.transactions.get(input.sourceTXID!)
  requireLineage(
    parent !== undefined && parent.id('hex') === input.sourceTXID,
    'Listing predecessor unavailable'
  )
  const output = parent.outputs[input.sourceOutputIndex]
  requireLineage(output !== undefined, 'Listing predecessor output missing')
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
      unlockingScript: input.unlockingScript!,
      inputSequence: input.sequence!,
      lockTime: tx.lockTime,
      memoryLimit
    }).validateJavaScript(),
    'Listing covenant rejected'
  )
}
