import { toHex } from '../primitives/utils.js'
export default class ScriptEvaluationError extends Error {
  txid: string
  outputIndex: number
  context: 'UnlockingScript' | 'LockingScript'
  programCounter: number
  stackState: number[][]
  altStackState: number[][]
  ifStackState: boolean[]
  stackMem: number
  altStackMem: number

  constructor (params: {
    message: string
    txid: string
    outputIndex: number
    context: 'UnlockingScript' | 'LockingScript'
    programCounter: number
    stackState: number[][]
    altStackState: number[][]
    ifStackState: boolean[]
    stackMem: number
    altStackMem: number
  }) {
    const stackHex = params.stackState.map(s => s != null && typeof s.length !== 'undefined' ? toHex(s) : (s === null || s === undefined ? 'null/undef' : 'INVALID_STACK_ITEM')).join(', ')
    const altStackHex = params.altStackState.map(s => s != null && typeof s.length !== 'undefined' ? toHex(s) : (s === null || s === undefined ? 'null/undef' : 'INVALID_STACK_ITEM')).join(', ')
    const pcInfo = `Context: ${params.context}, PC: ${params.programCounter}`
    const stackInfo = `Stack: [${stackHex}] (len: ${params.stackState.length}, mem: ${params.stackMem})`
    const altStackInfo = `AltStack: [${altStackHex}] (len: ${params.altStackState.length}, mem: ${params.altStackMem})`
    const ifStackInfo = `IfStack: [${params.ifStackState.join(', ')}]`
    const fullMessage = `Script evaluation error: ${params.message}\nTXID: ${params.txid}, OutputIdx: ${params.outputIndex}\n${pcInfo}\n${stackInfo}\n${altStackInfo}\n${ifStackInfo}`
    super(fullMessage)
    this.name = this.constructor.name
    this.txid = params.txid
    this.outputIndex = params.outputIndex
    this.context = params.context
    this.programCounter = params.programCounter
    this.stackState = params.stackState.map(s => s.slice())
    this.altStackState = params.altStackState.map(s => s.slice())
    this.ifStackState = params.ifStackState.slice()
    this.stackMem = params.stackMem
    this.altStackMem = params.altStackMem
  }
}
