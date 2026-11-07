import { Spend, Utils, type OutputOutpoint } from '@bsv/sdk'
import { RevenueListing, type RevenueListingState } from '@bsv/sdk/script/templates/RevenueListing'
import { requireLineage, type LineageAssembly } from './LineagePackage.js'
import {
  transitionFor,
  successorState,
  type InspectedTransition,
  type ListingTransition
} from './LineageTransition.js'
export type { ListingTransition } from './LineageTransition.js'

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
