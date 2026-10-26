import Transaction from '../transaction/Transaction.js'
import Script from '../script/Script.js'
import type UnlockingScript from '../script/UnlockingScript.js'
import type {
  CreateActionArgs,
  CreateActionResult,
  SignActionOptions,
  WalletInterface
} from './Wallet.interfaces.js'

/** Capability marker for caller-installed additional-output authorization. */
export const BOUND_ACTION_OUTPUT_AUTHORIZATION_VERSION = 1

const MAX_ACTION_TRANSACTION_BYTES = 256 * 1024 * 1024
const MAX_SATOSHIS = 21e14
const MAX_ACTION_GRAPH_DEPTH = 64
const MAX_ACTION_GRAPH_NODES = 1_000_000

// Wallet callbacks execute in the caller's realm. Capture the intrinsics used
// by the boundary before an untrusted callback can replace collection or
// object prototype methods.
const arrayIsArray = Array.isArray
const ArrayConstructor = Array
const NumberConstructor = Number
const StringConstructor = String
const numberIsFinite = Number.isFinite
const numberIsInteger = Number.isInteger
const numberIsSafeInteger = Number.isSafeInteger
const objectIs = Object.is
const objectCreate = Object.create
const objectDefineProperty = Object.defineProperty
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const objectGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors
const objectGetPrototypeOf = Object.getPrototypeOf
const objectKeys = Object.keys
const reflectApply = Reflect.apply
const reflectOwnKeys = Reflect.ownKeys
const regexpExec = RegExp.prototype.exec
const regexpTest = RegExp.prototype.test
const stringToLowerCase = String.prototype.toLowerCase
const Uint8ArrayConstructor = Uint8Array
const Uint8ArrayPrototype = Uint8Array.prototype
const typedArrayPrototype = objectGetPrototypeOf(Uint8ArrayPrototype) as object
const typedArrayBufferGetter = objectGetOwnPropertyDescriptor(typedArrayPrototype, 'buffer')?.get
const typedArrayLengthGetter = objectGetOwnPropertyDescriptor(typedArrayPrototype, 'length')?.get
const typedArrayTagGetter = objectGetOwnPropertyDescriptor(
  typedArrayPrototype,
  Symbol.toStringTag
)?.get
const typedArraySet = Uint8ArrayPrototype.set
const sharedArrayBufferByteLengthGetter =
  typeof SharedArrayBuffer === 'undefined'
    ? undefined
    : objectGetOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength')?.get
const weakMapGet = WeakMap.prototype.get
const weakMapSet = WeakMap.prototype.set
const weakSetAdd = WeakSet.prototype.add
const weakSetDelete = WeakSet.prototype.delete
const weakSetHas = WeakSet.prototype.has
const ownedByteArrays = new WeakSet<object>()
const scriptToHex = Script.prototype.toHex
let transactionFromAtomicBEEF: typeof Transaction.fromAtomicBEEF | undefined
let transactionId: typeof Transaction.prototype.id | undefined
let transactionToAtomicBEEF: typeof Transaction.prototype.toAtomicBEEF | undefined

const canonicalArrayIndexPattern = /^(?:0|[1-9]\d*)$/
const canonicalOutpointPattern = /^([0-9a-f]{64})\.(0|[1-9]\d*)$/i
const canonicalBase64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const evenHexPattern = /^(?:[0-9a-f]{2})*$/i
const txidPattern = /^[0-9a-f]{64}$/i

type ActionRecord = Record<string, unknown>

interface IntrinsicOwnerSnapshot {
  owner: object
  keys: PropertyKey[]
  descriptors: PropertyDescriptor[]
}

function captureSharedIntrinsicState(): IntrinsicOwnerSnapshot[] {
  const owners: object[] = [
    Array.prototype,
    Map.prototype,
    Set.prototype,
    WeakMap.prototype,
    WeakSet.prototype,
    Object,
    Object.prototype,
    Number,
    RegExp.prototype,
    String.prototype,
    Uint8ArrayPrototype,
    typedArrayPrototype
  ]
  const snapshots = new ArrayConstructor<IntrinsicOwnerSnapshot>(owners.length)
  for (let ownerIndex = 0; ownerIndex < owners.length; ownerIndex++) {
    const owner = owners[ownerIndex]
    const keys = reflectOwnKeys(owner)
    const descriptors = new ArrayConstructor<PropertyDescriptor>(keys.length)
    for (let keyIndex = 0; keyIndex < keys.length; keyIndex++) {
      descriptors[keyIndex] = objectGetOwnPropertyDescriptor(owner, keys[keyIndex])!
    }
    snapshots[ownerIndex] = { owner, keys, descriptors }
  }
  return snapshots
}

function assertSharedIntrinsicsUnchanged(snapshots: IntrinsicOwnerSnapshot[]): void {
  for (let ownerIndex = 0; ownerIndex < snapshots.length; ownerIndex++) {
    const snapshot = snapshots[ownerIndex]
    if (reflectOwnKeys(snapshot.owner).length !== snapshot.keys.length) {
      throw new Error('Wallet callback modified shared JavaScript intrinsics')
    }
    for (let keyIndex = 0; keyIndex < snapshot.keys.length; keyIndex++) {
      const expected = snapshot.descriptors[keyIndex]
      const actual = objectGetOwnPropertyDescriptor(snapshot.owner, snapshot.keys[keyIndex])
      if (
        actual == null ||
        actual.configurable !== expected.configurable ||
        actual.enumerable !== expected.enumerable ||
        actual.writable !== expected.writable ||
        !objectIs(actual.value, expected.value) ||
        actual.get !== expected.get ||
        actual.set !== expected.set
      ) {
        throw new Error(
          `Wallet callback modified shared JavaScript intrinsics (${ownerIndex}:${StringConstructor(snapshot.keys[keyIndex])})`
        )
      }
    }
  }
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return objectGetOwnPropertyDescriptor(value, key) !== undefined
}

function isSafeInteger(value: unknown): value is number {
  return numberIsSafeInteger(value)
}

function matches(pattern: RegExp, value: string): boolean {
  return reflectApply(regexpTest, pattern, [value]) as boolean
}

function lower(value: string): string {
  return reflectApply(stringToLowerCase, value, []) as string
}

function toHex(script: Script): string {
  return reflectApply(scriptToHex, script, []) as string
}

function captureTransactionIntrinsics(): void {
  // Transaction imports this helper, so eager capture would observe an
  // uninitialized circular import. completeBoundAction calls this before the
  // first wallet callback and therefore before untrusted code can replace the
  // methods.
  transactionFromAtomicBEEF ??= Transaction.fromAtomicBEEF
  transactionId ??= Transaction.prototype.id
  transactionToAtomicBEEF ??= Transaction.prototype.toAtomicBEEF
}

function parseAtomicBEEF(beef: number[] | Uint8Array): Transaction {
  if (transactionFromAtomicBEEF == null) throw new Error('Transaction intrinsics are unavailable')
  return reflectApply(transactionFromAtomicBEEF, Transaction, [beef]) as Transaction
}

function atomicBEEF(transaction: Transaction): number[] {
  if (transactionToAtomicBEEF == null) throw new Error('Transaction intrinsics are unavailable')
  return reflectApply(transactionToAtomicBEEF, transaction, [true]) as number[]
}

function transactionID(transaction: Transaction): string {
  if (transactionId == null) throw new Error('Transaction intrinsics are unavailable')
  return reflectApply(transactionId, transaction, ['hex']) as string
}

function snapshotBudgetHas(budget: SnapshotBudget, value: object): boolean {
  return reflectApply(weakSetHas, budget.active, [value]) as boolean
}

function snapshotBudgetAdd(budget: SnapshotBudget, value: object): void {
  reflectApply(weakSetAdd, budget.active, [value])
}

function snapshotBudgetDelete(budget: SnapshotBudget, value: object): void {
  reflectApply(weakSetDelete, budget.active, [value])
}

function completedSnapshot(budget: SnapshotBudget, value: object): unknown {
  return reflectApply(weakMapGet, budget.completed, [value])
}

function rememberSnapshot(budget: SnapshotBudget, value: object, snapshot: unknown): void {
  reflectApply(weakMapSet, budget.completed, [value, snapshot])
}

interface SnapshotBudget {
  nodes: number
  active: WeakSet<object>
  completed: WeakMap<object, unknown>
  copiedBytes: number
}

export interface BoundActionOptions {
  /** Signers keyed by canonical `txid.vout` for requested inputs with an unlockingScriptLength. */
  inputSigners?: Record<
    string,
    (transaction: Transaction, inputIndex: number) => Promise<UnlockingScript | string>
  >
  /**
   * Bounded satoshi ranges keyed by requested-output index. The output's exact
   * locking script remains mandatory, but a wallet may replace a sentinel
   * amount with a fee-adjusted value inside the authorized range.
   */
  outputSatoshisRanges?: Record<string, { minimumSatoshis: number; maximumSatoshis: number }>
  /**
   * Explicit caller-installed policy for additional outputs. The result is
   * untrusted: authorize only outputs independently verified by local policy,
   * never fields or labels supplied by a remote wallet. Each authorization is
   * bound to one exact output index, script and amount before any input signer
   * runs. Omission retains the default external-input value restriction.
   */
  authorizeAdditionalOutputs?: (result: CreateActionResult) => BoundActionOutputAuthorization[]
}

export interface BoundActionOutputAuthorization {
  outputIndex: number
  lockingScript: string
  satoshis: number
}

interface OutputSatoshisRange {
  minimumSatoshis: number
  maximumSatoshis: number
}

function dataRecord(value: unknown, label: string, ignoreSymbolMetadata = false): ActionRecord {
  if (value == null || typeof value !== 'object' || arrayIsArray(value)) {
    throw new Error(`${label} must be a plain data object`)
  }
  const prototype = objectGetPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain data object`)
  }
  const keys = reflectOwnKeys(value)
  for (let keyIndex = 0; keyIndex < keys.length; keyIndex++) {
    const key = keys[keyIndex]
    const descriptor = objectGetOwnPropertyDescriptor(value, key)
    if (typeof key === 'symbol' && ignoreSymbolMetadata) {
      if (descriptor == null || !('value' in descriptor)) {
        throw new Error(`${label} symbol metadata must be a data property`)
      }
      continue
    }
    if (
      typeof key !== 'string' ||
      descriptor == null ||
      !descriptor.enumerable ||
      !('value' in descriptor)
    ) {
      throw new Error(`${label} must contain only string-keyed data properties`)
    }
  }
  return value as ActionRecord
}

function snapshotDenseByteArray(
  value: unknown[],
  label: string,
  remainingByteBudget = MAX_ACTION_TRANSACTION_BYTES
): number[] | undefined {
  if (objectGetPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} must contain only dense data arrays`)
  }
  const lengthDescriptor = objectGetOwnPropertyDescriptor(value, 'length')
  if (
    lengthDescriptor == null ||
    !('value' in lengthDescriptor) ||
    !isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    throw new Error(`${label} must contain only dense data arrays`)
  }
  const length = lengthDescriptor.value as number
  if (length > MAX_ACTION_TRANSACTION_BYTES) {
    throw new Error(`${label} exceeds the byte limit`)
  }
  const keys = reflectOwnKeys(value)
  if (keys.length !== length + 1) {
    throw new Error(`${label} must contain only dense data arrays`)
  }
  const exceedsAggregateBudget = length > remainingByteBudget
  const snapshot = exceedsAggregateBudget ? undefined : new ArrayConstructor<number>(length)
  for (let index = 0; index < length; index++) {
    const descriptor = objectGetOwnPropertyDescriptor(value, StringConstructor(index))
    if (descriptor == null || !descriptor.enumerable || !('value' in descriptor)) {
      throw new Error(`${label} must contain only dense data arrays`)
    }
    if (!numberIsInteger(descriptor.value) || descriptor.value < 0 || descriptor.value > 255) {
      return undefined
    }
    if (snapshot !== undefined) snapshot[index] = descriptor.value
  }
  if (exceedsAggregateBudget) throw new Error(`${label} exceeds the aggregate byte limit`)
  return snapshot!
}

function snapshotUint8Array(
  value: object,
  label: string,
  remainingByteBudget = MAX_ACTION_TRANSACTION_BYTES
): Uint8Array | undefined {
  if (
    typedArrayBufferGetter == null ||
    typedArrayLengthGetter == null ||
    typedArrayTagGetter == null
  ) {
    return undefined
  }
  let buffer: ArrayBufferLike
  let length: number
  let tag: string
  try {
    buffer = reflectApply(typedArrayBufferGetter, value, []) as ArrayBufferLike
    length = reflectApply(typedArrayLengthGetter, value, []) as number
    tag = reflectApply(typedArrayTagGetter, value, []) as string
  } catch {
    return undefined
  }
  if (tag !== 'Uint8Array') return undefined
  if (sharedArrayBufferByteLengthGetter != null) {
    let shared = false
    try {
      reflectApply(sharedArrayBufferByteLengthGetter, buffer, [])
      shared = true
    } catch {}
    if (shared) throw new Error(`${label} must not use shared byte storage`)
  }
  if (length > MAX_ACTION_TRANSACTION_BYTES) {
    throw new Error(`${label} exceeds the byte limit`)
  }
  if (length > remainingByteBudget) {
    throw new Error(`${label} exceeds the aggregate byte limit`)
  }
  const snapshot = new Uint8ArrayConstructor(length)
  try {
    reflectApply(typedArraySet, snapshot, [value])
  } catch {
    throw new Error(`${label} must contain only intrinsic byte arrays`)
  }
  return snapshot
}

function snapshotActionData(
  value: unknown,
  label: string,
  depth = 0,
  budget: SnapshotBudget = {
    nodes: 0,
    active: new WeakSet<object>(),
    completed: new WeakMap<object, unknown>(),
    copiedBytes: 0
  },
  ignoreSymbolMetadata = false
): unknown {
  if (depth > MAX_ACTION_GRAPH_DEPTH) throw new Error(`${label} exceeds the depth limit`)
  budget.nodes += 1
  if (budget.nodes > MAX_ACTION_GRAPH_NODES) throw new Error(`${label} exceeds the node limit`)
  if (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value
  }
  if (typeof value === 'number') {
    if (!numberIsFinite(value) || objectIs(value, -0)) {
      throw new Error(`${label} contains an ambiguous number`)
    }
    return value
  }
  if (typeof value !== 'object') throw new Error(`${label} contains unsupported data`)
  if (snapshotBudgetHas(budget, value)) throw new Error(`${label} contains a cycle`)
  const completed = completedSnapshot(budget, value)
  if (completed !== undefined) return completed
  const byteView = snapshotUint8Array(
    value,
    label,
    MAX_ACTION_TRANSACTION_BYTES - budget.copiedBytes
  )
  if (byteView !== undefined) {
    budget.copiedBytes += byteView.length
    reflectApply(weakSetAdd, ownedByteArrays, [byteView])
    rememberSnapshot(budget, value, byteView)
    return byteView
  }
  if (arrayIsArray(value)) {
    const byteSnapshot = snapshotDenseByteArray(
      value,
      label,
      MAX_ACTION_TRANSACTION_BYTES - budget.copiedBytes
    )
    if (byteSnapshot !== undefined) {
      budget.copiedBytes += byteSnapshot.length
      reflectApply(weakSetAdd, ownedByteArrays, [byteSnapshot])
      rememberSnapshot(budget, value, byteSnapshot)
      return byteSnapshot
    }
    const lengthDescriptor = objectGetOwnPropertyDescriptor(value, 'length')
    if (
      lengthDescriptor == null ||
      !('value' in lengthDescriptor) ||
      !isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0
    ) {
      throw new Error(`${label} must contain only dense data arrays`)
    }
    if (lengthDescriptor.value > MAX_ACTION_GRAPH_NODES) {
      throw new Error(`${label} exceeds the node limit`)
    }
  }
  snapshotBudgetAdd(budget, value)

  if (arrayIsArray(value)) {
    const descriptors = objectGetOwnPropertyDescriptors(value)
    const lengthDescriptor = (descriptors as Record<string, PropertyDescriptor>)['length']
    if (
      lengthDescriptor == null ||
      !('value' in lengthDescriptor) ||
      !isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0 ||
      lengthDescriptor.value > MAX_ACTION_GRAPH_NODES
    ) {
      throw new Error(`${label} must contain only dense data arrays`)
    }
    const length = lengthDescriptor.value as number
    const descriptorKeys = reflectOwnKeys(descriptors)
    if (descriptorKeys.length !== length + 1) {
      throw new Error(`${label} must contain only dense data arrays`)
    }
    for (let keyIndex = 0; keyIndex < descriptorKeys.length; keyIndex++) {
      const key = descriptorKeys[keyIndex]
      if (key === 'length') continue
      if (
        typeof key !== 'string' ||
        !matches(canonicalArrayIndexPattern, key) ||
        NumberConstructor(key) >= length
      ) {
        throw new Error(`${label} must contain only dense data arrays`)
      }
    }
    const out: unknown[] = new ArrayConstructor<unknown>(length)
    for (let index = 0; index < length; index++) {
      const key = StringConstructor(index)
      const descriptor = descriptors[key]
      if (descriptor == null || !descriptor.enumerable || !('value' in descriptor)) {
        throw new Error(`${label} must contain only dense data arrays`)
      }
      out[index] = snapshotActionData(descriptor.value, `${label}[${index}]`, depth + 1, budget)
    }
    snapshotBudgetDelete(budget, value)
    rememberSnapshot(budget, value, out)
    return out
  }

  const source = dataRecord(value, label, ignoreSymbolMetadata)
  if (snapshotBudgetHas(budget, source) && source !== value) {
    throw new Error(`${label} contains a cycle`)
  }
  const out: ActionRecord = objectCreate(null) as ActionRecord
  const descriptors = objectGetOwnPropertyDescriptors(source)
  const keys = objectKeys(descriptors)
  for (let keyIndex = 0; keyIndex < keys.length; keyIndex++) {
    const key = keys[keyIndex]
    const descriptor = descriptors[key]
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new Error(`${label} must contain only string-keyed data properties`)
    }
    objectDefineProperty(out, key, {
      value: snapshotActionData(descriptor.value, `${label}.${key}`, depth + 1, budget),
      enumerable: true,
      configurable: true,
      writable: true
    })
  }
  snapshotBudgetDelete(budget, value)
  rememberSnapshot(budget, value, out)
  return out
}

function bytes(value: unknown, label: string): number[] | Uint8Array {
  if (value != null && typeof value === 'object') {
    const isOwned = reflectApply(weakSetHas, ownedByteArrays, [value]) as boolean
    if (isOwned && arrayIsArray(value)) {
      const length = objectGetOwnPropertyDescriptor(value, 'length')?.value
      if (typeof length !== 'number' || length === 0) {
        throw new Error(`${label} must be a bounded non-empty byte array`)
      }
      return value as number[]
    }
    if (isOwned && typedArrayLengthGetter != null) {
      let length: number
      try {
        length = reflectApply(typedArrayLengthGetter, value, []) as number
      } catch {
        throw new Error(`${label} must be a bounded non-empty byte array`)
      }
      if (length === 0) {
        throw new Error(`${label} must be a bounded non-empty byte array`)
      }
      return value as Uint8Array
    }
    const byteView = snapshotUint8Array(value, label)
    if (byteView !== undefined) {
      if (byteView.length === 0) {
        throw new Error(`${label} must be a bounded non-empty byte array`)
      }
      return byteView
    }
  }
  if (!arrayIsArray(value)) {
    throw new Error(`${label} must be a bounded non-empty byte array`)
  }
  const snapshot = snapshotDenseByteArray(value, label)
  if (snapshot == null || snapshot.length === 0) {
    throw new Error(`${label} must be a bounded non-empty byte array`)
  }
  const byteView = new Uint8ArrayConstructor(snapshot.length)
  for (let index = 0; index < snapshot.length; index++) {
    byteView[index] = snapshot[index]
  }
  return byteView
}

function txid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !matches(txidPattern, value)) {
    throw new Error(`${label} must be a 32-byte hexadecimal transaction ID`)
  }
  return lower(value)
}

function hex(value: unknown, label: string): string {
  if (typeof value !== 'string' || !matches(evenHexPattern, value)) {
    throw new Error(`${label} must be an even-length hexadecimal string`)
  }
  return lower(value)
}

function outpoint(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a canonical outpoint`)
  const match = reflectApply(regexpExec, canonicalOutpointPattern, [
    value
  ]) as RegExpExecArray | null
  if (match == null) throw new Error(`${label} must be a canonical outpoint`)
  const outputIndex = NumberConstructor(match[2])
  if (!isSafeInteger(outputIndex) || outputIndex > 0xffffffff) {
    throw new Error(`${label} must be a canonical outpoint`)
  }
  return `${lower(match[1])}.${outputIndex}`
}

function inputOutpoint(transaction: Transaction, inputIndex: number): string {
  const input = transaction.inputs[inputIndex]
  if (
    input == null ||
    !isSafeInteger(input.sourceOutputIndex) ||
    input.sourceOutputIndex < 0 ||
    input.sourceOutputIndex > 0xffffffff
  ) {
    throw new Error('Wallet transaction input is malformed')
  }
  const embeddedTxid =
    input.sourceTransaction == null ? undefined : transactionID(input.sourceTransaction)
  if (
    input.sourceTXID !== undefined &&
    embeddedTxid !== undefined &&
    txid(input.sourceTXID, 'Wallet input source TXID') !==
      txid(embeddedTxid, 'Wallet input source transaction ID')
  ) {
    throw new Error('Wallet transaction input source mismatch')
  }
  return `${txid(
    input.sourceTXID ?? embeddedTxid,
    'Wallet input source TXID'
  )}.${input.sourceOutputIndex}`
}

function satoshis(value: unknown, label: string): number {
  if (typeof value !== 'number' || !isSafeInteger(value) || value < 0 || value > MAX_SATOSHIS) {
    throw new Error(`${label} must be a valid satoshi amount`)
  }
  return value
}

function addSatoshis(total: number, value: number, label: string): number {
  const next = total + value
  if (!isSafeInteger(next) || next > MAX_SATOSHIS) {
    throw new Error(`${label} exceeds the maximum transaction value`)
  }
  return next
}

function inputSatoshis(transaction: Transaction, inputIndex: number): number {
  const input = transaction.inputs[inputIndex]
  const sourceOutput = input?.sourceTransaction?.outputs[input.sourceOutputIndex]
  if (sourceOutput == null) {
    throw new Error('Wallet signable transaction omitted an input source output')
  }
  return satoshis(sourceOutput.satoshis, `Wallet input ${inputIndex} source output`)
}

function normalizeAdditionalOutputAuthorizations(value: unknown): BoundActionOutputAuthorization[] {
  const snapshot = snapshotActionData(value, 'Additional output authorizations')
  if (!arrayIsArray(snapshot)) throw new Error('Additional output authorizations must be an array')
  const result = new ArrayConstructor<BoundActionOutputAuthorization>(snapshot.length)
  for (let index = 0; index < snapshot.length; index++) {
    const entry = dataRecord(snapshot[index], `Additional output authorization ${index}`)
    const keys = objectKeys(entry)
    for (let keyIndex = 0; keyIndex < keys.length; keyIndex++) {
      if (
        keys[keyIndex] !== 'outputIndex' &&
        keys[keyIndex] !== 'lockingScript' &&
        keys[keyIndex] !== 'satoshis'
      ) {
        throw new Error(
          `Additional output authorization ${index} field ${keyIndex} must be index, script or amount`
        )
      }
    }
    const outputIndex = entry.outputIndex
    if (!isSafeInteger(outputIndex) || outputIndex < 0 || outputIndex > 0xffffffff) {
      throw new Error('Additional output authorization index is invalid')
    }
    result[index] = {
      outputIndex,
      lockingScript: hex(entry.lockingScript, `Additional output authorization ${index} script`),
      satoshis: satoshis(entry.satoshis, `Additional output authorization ${index} amount`)
    }
  }
  return result
}

function bindRequestedAction(
  args: CreateActionArgs,
  candidate: Transaction,
  outputSatoshisRanges: ReadonlyArray<OutputSatoshisRange | undefined>,
  additionalOutputs: ReadonlyArray<BoundActionOutputAuthorization>,
  trustedRequestedInputSatoshis?: readonly number[]
): number[] {
  if (candidate.version !== (args.version ?? 1)) {
    throw new Error('Wallet transaction substituted the requested version')
  }
  if (candidate.lockTime !== (args.lockTime ?? 0)) {
    throw new Error('Wallet transaction substituted the requested lock time')
  }

  const candidateOutpoints = new ArrayConstructor<string>(candidate.inputs.length)
  const candidateOutpointSet = objectCreate(null) as Record<string, true>
  for (let index = 0; index < candidate.inputs.length; index++) {
    const candidateOutpoint = inputOutpoint(candidate, index)
    if (hasOwn(candidateOutpointSet, candidateOutpoint)) {
      throw new Error('Wallet transaction contains a duplicate input outpoint')
    }
    candidateOutpoints[index] = candidateOutpoint
    candidateOutpointSet[candidateOutpoint] = true
  }
  const indexes: number[] = []
  const requestedOutpoints = objectCreate(null) as Record<string, true>
  for (let index = 0; index < (args.inputs?.length ?? 0); index++) {
    const requested = args.inputs![index]
    const requestedOutpoint = outpoint(requested.outpoint, `Requested input ${index} outpoint`)
    if (hasOwn(requestedOutpoints, requestedOutpoint)) {
      throw new Error('Action requests the same input outpoint more than once')
    }
    requestedOutpoints[requestedOutpoint] = true
    let candidateIndex = -1
    for (let index = 0; index < candidateOutpoints.length; index++) {
      if (candidateOutpoints[index] !== requestedOutpoint) continue
      if (candidateIndex !== -1) {
        throw new Error('Wallet transaction does not contain each requested input exactly once')
      }
      candidateIndex = index
    }
    if (candidateIndex === -1) {
      throw new Error('Wallet transaction does not contain each requested input exactly once')
    }
    indexes[index] = candidateIndex
    if (
      (candidate.inputs[candidateIndex].sequence ?? 0xffffffff) !==
      (requested.sequenceNumber ?? 0xffffffff)
    ) {
      throw new Error('Wallet transaction substituted a requested input sequence')
    }
    const candidateUnlockingScript = candidate.inputs[candidateIndex].unlockingScript
    if (
      requested.unlockingScript !== undefined &&
      (candidateUnlockingScript == null ? undefined : lower(toHex(candidateUnlockingScript))) !==
        hex(requested.unlockingScript, `Requested input ${index} unlocking script`)
    ) {
      throw new Error('Wallet transaction substituted a requested unlocking script')
    }
  }

  const candidateOutputs = new ArrayConstructor<{
    satoshis: number
    lockingScript: string
  }>(candidate.outputs.length)
  for (let index = 0; index < candidate.outputs.length; index++) {
    const output = candidate.outputs[index]
    candidateOutputs[index] = {
      satoshis: satoshis(output.satoshis, `Wallet output ${index}`),
      lockingScript: lower(toHex(output.lockingScript))
    }
  }
  const matchedCandidateOutputs = new ArrayConstructor<boolean>(candidateOutputs.length)
  const preserveOutputOrder = args.options?.randomizeOutputs === false
  let requestedOutputValue = 0
  const matchRequestedOutput = (index: number, range?: OutputSatoshisRange): void => {
    const output = args.outputs![index]
    const lockingScript = hex(output.lockingScript, `Requested output ${index} locking script`)
    const requestedSatoshis = satoshis(output.satoshis, `Requested output ${index}`)
    if (preserveOutputOrder) {
      const candidateOutput = candidateOutputs[index]
      const amountMatches =
        candidateOutput != null &&
        (range == null
          ? candidateOutput.satoshis === requestedSatoshis
          : candidateOutput.satoshis >= range.minimumSatoshis &&
            candidateOutput.satoshis <= range.maximumSatoshis)
      if (
        candidateOutput == null ||
        candidateOutput.lockingScript !== lockingScript ||
        !amountMatches
      ) {
        throw new Error('Wallet transaction substituted a requested output position')
      }
      matchedCandidateOutputs[index] = true
      requestedOutputValue = addSatoshis(
        requestedOutputValue,
        candidateOutput.satoshis,
        'Requested output value'
      )
      return
    }
    let matchedIndex = -1
    for (let candidateIndex = 0; candidateIndex < candidateOutputs.length; candidateIndex++) {
      const candidateOutput = candidateOutputs[candidateIndex]
      if (
        matchedCandidateOutputs[candidateIndex] === true ||
        candidateOutput.lockingScript !== lockingScript
      )
        continue
      const amountMatches =
        range == null
          ? candidateOutput.satoshis === requestedSatoshis
          : candidateOutput.satoshis >= range.minimumSatoshis &&
            candidateOutput.satoshis <= range.maximumSatoshis
      if (!amountMatches) continue
      if (range == null) {
        matchedIndex = candidateIndex
        break
      }
      if (matchedIndex !== -1) {
        throw new Error('Wallet transaction omitted or substituted a requested output')
      }
      matchedIndex = candidateIndex
    }
    if (matchedIndex === -1) {
      throw new Error('Wallet transaction omitted or substituted a requested output')
    }
    matchedCandidateOutputs[matchedIndex] = true
    requestedOutputValue = addSatoshis(
      requestedOutputValue,
      candidateOutputs[matchedIndex].satoshis,
      'Requested output value'
    )
  }
  for (let index = 0; index < (args.outputs?.length ?? 0); index++) {
    if (outputSatoshisRanges[index] === undefined) matchRequestedOutput(index)
  }
  for (let index = 0; index < (args.outputs?.length ?? 0); index++) {
    const range = outputSatoshisRanges[index]
    if (range != null) matchRequestedOutput(index, range)
  }

  let explicitInputValue = 0
  const explicitInputIndexes = new ArrayConstructor<boolean>(candidate.inputs.length)
  for (let requestedIndex = 0; requestedIndex < indexes.length; requestedIndex++) {
    const inputIndex = indexes[requestedIndex]
    explicitInputIndexes[inputIndex] = true
    explicitInputValue = addSatoshis(
      explicitInputValue,
      trustedRequestedInputSatoshis?.[requestedIndex] ?? inputSatoshis(candidate, inputIndex),
      'Requested input value'
    )
  }
  let walletInputValue = 0
  for (let inputIndex = 0; inputIndex < candidate.inputs.length; inputIndex++) {
    if (explicitInputIndexes[inputIndex] === true) continue
    walletInputValue = addSatoshis(
      walletInputValue,
      inputSatoshis(candidate, inputIndex),
      'Wallet-added input value'
    )
  }
  let candidateOutputValue = 0
  for (let index = 0; index < candidateOutputs.length; index++) {
    candidateOutputValue = addSatoshis(
      candidateOutputValue,
      candidateOutputs[index].satoshis,
      'Wallet output value'
    )
  }
  const candidateInputValue = addSatoshis(
    explicitInputValue,
    walletInputValue,
    'Wallet input value'
  )
  if (candidateOutputValue > candidateInputValue) {
    throw new Error('Wallet signable transaction spends more than its inputs')
  }
  let authorizedAdditionalOutputValue = 0
  for (let index = 0; index < additionalOutputs.length; index++) {
    const authorization = additionalOutputs[index]
    const output =
      authorization.outputIndex < candidateOutputs.length
        ? candidateOutputs[authorization.outputIndex]
        : undefined
    if (
      output == null ||
      matchedCandidateOutputs[authorization.outputIndex] === true ||
      output.lockingScript !== authorization.lockingScript ||
      output.satoshis !== authorization.satoshis
    ) {
      throw new Error(
        `Wallet transaction omitted, duplicated or substituted an authorized additional output at authorization ${index}`
      )
    }
    matchedCandidateOutputs[authorization.outputIndex] = true
    authorizedAdditionalOutputValue = addSatoshis(
      authorizedAdditionalOutputValue,
      output.satoshis,
      'Authorized additional output value'
    )
  }
  const additionalOutputValue =
    candidateOutputValue - requestedOutputValue - authorizedAdditionalOutputValue
  if (additionalOutputValue > walletInputValue) {
    throw new Error('Wallet used a requested input to fund an unrequested output')
  }
  return indexes
}

function assertSameTemplate(signable: Transaction, signed: Transaction): void {
  if (
    signable.version !== signed.version ||
    signable.lockTime !== signed.lockTime ||
    signable.inputs.length !== signed.inputs.length ||
    signable.outputs.length !== signed.outputs.length
  ) {
    throw new Error('Wallet signed transaction substituted the authorized template')
  }
  for (let index = 0; index < signable.inputs.length; index++) {
    if (
      inputOutpoint(signable, index) !== inputOutpoint(signed, index) ||
      (signable.inputs[index].sequence ?? 0xffffffff) !==
        (signed.inputs[index].sequence ?? 0xffffffff)
    ) {
      throw new Error('Wallet signed transaction substituted an authorized input')
    }
  }
  for (let index = 0; index < signable.outputs.length; index++) {
    if (
      signable.outputs[index].satoshis !== signed.outputs[index].satoshis ||
      toHex(signable.outputs[index].lockingScript) !== toHex(signed.outputs[index].lockingScript)
    ) {
      throw new Error('Wallet signed transaction substituted an authorized output')
    }
  }
}

async function abortBestEffort(
  wallet: WalletInterface,
  reference: string,
  originator?: string
): Promise<void> {
  try {
    await wallet.abortAction({ reference }, originator)
  } catch {
    // Preserve the primary failure; never expose the poisoned reference.
  }
}

/**
 * Complete a createAction/signAction flow while binding every caller-requested
 * input and output before signing, and binding the returned signed transaction
 * to that authorized partial template. Requested inputs may fund requested or
 * explicitly locally authorized outputs and transaction fees; wallet-added inputs
 * must fully fund every other output.
 */
export async function completeBoundAction(
  wallet: WalletInterface,
  createArgs: CreateActionArgs,
  options: BoundActionOptions = {},
  originator?: string,
  /** @internal Trusted source-output amounts retained by Transaction.completeWithWallet. */
  trustedRequestedInputSatoshis?: readonly number[]
): Promise<Transaction> {
  captureTransactionIntrinsics()
  const sharedIntrinsicState = captureSharedIntrinsicState()
  const authorizedArgs = snapshotActionData(
    createArgs,
    'Create action arguments'
  ) as CreateActionArgs
  const walletArgs = snapshotActionData(
    authorizedArgs,
    'Create action arguments'
  ) as CreateActionArgs
  const requestedInputs = authorizedArgs.inputs ?? []
  let ownedTrustedRequestedInputSatoshis: readonly number[] | undefined
  if (trustedRequestedInputSatoshis !== undefined) {
    const snapshot = snapshotActionData(
      trustedRequestedInputSatoshis,
      'Trusted requested input satoshis'
    )
    if (!arrayIsArray(snapshot) || snapshot.length !== requestedInputs.length) {
      throw new Error('Trusted requested input satoshis must match the requested inputs')
    }
    const amounts = new ArrayConstructor<number>(snapshot.length)
    for (let index = 0; index < snapshot.length; index++) {
      amounts[index] = satoshis(snapshot[index], `Trusted requested input ${index}`)
    }
    ownedTrustedRequestedInputSatoshis = amounts
  }
  const boundOptions = dataRecord(options, 'Bound action options')
  const boundOptionKeys = objectKeys(boundOptions)
  for (let keyIndex = 0; keyIndex < boundOptionKeys.length; keyIndex++) {
    const key = boundOptionKeys[keyIndex]
    if (
      key !== 'inputSigners' &&
      key !== 'outputSatoshisRanges' &&
      key !== 'authorizeAdditionalOutputs'
    ) {
      throw new Error(`Unknown bound action option "${key}"`)
    }
  }
  const authorizeAdditionalOutputs = objectGetOwnPropertyDescriptor(
    boundOptions,
    'authorizeAdditionalOutputs'
  )?.value
  if (
    authorizeAdditionalOutputs !== undefined &&
    typeof authorizeAdditionalOutputs !== 'function'
  ) {
    throw new Error('Additional output authorization must be a caller-installed function')
  }
  const inputSignersValue = objectGetOwnPropertyDescriptor(boundOptions, 'inputSigners')?.value
  const inputSigners = dataRecord(inputSignersValue ?? {}, 'Input signers') as Record<
    string,
    (transaction: Transaction, inputIndex: number) => Promise<UnlockingScript | string>
  >
  const normalizedSigners = objectCreate(null) as Record<
    string,
    (transaction: Transaction, inputIndex: number) => Promise<UnlockingScript | string>
  >
  let normalizedSignerCount = 0
  const inputSignerKeys = objectKeys(inputSigners)
  for (let keyIndex = 0; keyIndex < inputSignerKeys.length; keyIndex++) {
    const key = inputSignerKeys[keyIndex]
    const signer = objectGetOwnPropertyDescriptor(inputSigners, key)?.value
    const normalized = outpoint(key, 'Input signer outpoint')
    if (hasOwn(normalizedSigners, normalized) || typeof signer !== 'function') {
      throw new Error('Input signers must uniquely identify requested outpoints')
    }
    normalizedSigners[normalized] = signer as (
      transaction: Transaction,
      inputIndex: number
    ) => Promise<UnlockingScript | string>
    normalizedSignerCount++
  }
  const rangeValue = objectGetOwnPropertyDescriptor(boundOptions, 'outputSatoshisRanges')?.value
  const ranges = dataRecord(rangeValue ?? {}, 'Output satoshi ranges')
  const normalizedRanges = new ArrayConstructor<OutputSatoshisRange | undefined>(
    authorizedArgs.outputs?.length ?? 0
  )
  const rangeKeys = objectKeys(ranges)
  for (let keyIndex = 0; keyIndex < rangeKeys.length; keyIndex++) {
    const key = rangeKeys[keyIndex]
    const value = objectGetOwnPropertyDescriptor(ranges, key)?.value
    if (!matches(canonicalArrayIndexPattern, key)) {
      throw new Error('Output satoshi ranges must identify requested output indexes')
    }
    const index = NumberConstructor(key)
    if (!isSafeInteger(index) || index >= (authorizedArgs.outputs?.length ?? 0)) {
      throw new Error('Output satoshi ranges must identify requested output indexes')
    }
    const range = dataRecord(value, `Output satoshi range ${index}`)
    const outputRangeKeys = objectKeys(range)
    for (let rangeKeyIndex = 0; rangeKeyIndex < outputRangeKeys.length; rangeKeyIndex++) {
      const rangeKey = outputRangeKeys[rangeKeyIndex]
      if (rangeKey !== 'minimumSatoshis' && rangeKey !== 'maximumSatoshis') {
        throw new Error(`Unknown output satoshi range option "${rangeKey}"`)
      }
    }
    const minimumSatoshis = satoshis(
      objectGetOwnPropertyDescriptor(range, 'minimumSatoshis')?.value,
      `Output satoshi range ${index} minimum`
    )
    const maximumSatoshis = satoshis(
      objectGetOwnPropertyDescriptor(range, 'maximumSatoshis')?.value,
      `Output satoshi range ${index} maximum`
    )
    if (minimumSatoshis > maximumSatoshis) {
      throw new Error(`Output satoshi range ${index} minimum exceeds its maximum`)
    }
    normalizedRanges[index] = { minimumSatoshis, maximumSatoshis }
  }

  const rawCreateResult = await wallet.createAction(
    {
      ...walletArgs,
      options: {
        ...walletArgs.options,
        signAndProcess: false,
        returnTXIDOnly: false
      }
    },
    originator
  )
  assertSharedIntrinsicsUnchanged(sharedIntrinsicState)
  const createResult = dataRecord(
    snapshotActionData(rawCreateResult, 'Wallet createAction result', 0, undefined, true),
    'Wallet createAction result',
    true
  )
  assertSharedIntrinsicsUnchanged(sharedIntrinsicState)
  const signable = dataRecord(
    objectGetOwnPropertyDescriptor(createResult, 'signableTransaction')?.value,
    'Wallet signable transaction'
  )
  const reference = objectGetOwnPropertyDescriptor(signable, 'reference')?.value
  if (
    typeof reference !== 'string' ||
    reference.length === 0 ||
    reference.length > 4096 ||
    !matches(canonicalBase64Pattern, reference)
  ) {
    throw new Error('Wallet signable transaction reference is invalid')
  }

  try {
    const additionalOutputs =
      authorizeAdditionalOutputs === undefined
        ? []
        : normalizeAdditionalOutputAuthorizations(authorizeAdditionalOutputs(rawCreateResult))
    assertSharedIntrinsicsUnchanged(sharedIntrinsicState)
    const partial = parseAtomicBEEF(
      bytes(objectGetOwnPropertyDescriptor(signable, 'tx')?.value, 'Wallet signable transaction')
    )
    const boundInputIndexes = bindRequestedAction(
      authorizedArgs,
      partial,
      normalizedRanges,
      additionalOutputs,
      ownedTrustedRequestedInputSatoshis
    )
    const authorizedPartial = parseAtomicBEEF(atomicBEEF(partial))
    const spends: Record<number, { unlockingScript: string }> = {}
    const expectedScripts = new ArrayConstructor<string | undefined>(partial.inputs.length)
    const expectedScriptIndexes = new ArrayConstructor<number>()
    const usedSigners = objectCreate(null) as Record<string, true>
    let usedSignerCount = 0
    for (let index = 0; index < requestedInputs.length; index++) {
      const requested = requestedInputs[index]
      const requestedOutpoint = outpoint(requested.outpoint, `Requested input ${index} outpoint`)
      const inputIndex = boundInputIndexes[index]
      if (requested.unlockingScript !== undefined) {
        expectedScripts[inputIndex] = hex(
          requested.unlockingScript,
          `Requested input ${index} unlocking script`
        )
        expectedScriptIndexes[expectedScriptIndexes.length] = inputIndex
        continue
      }
      const signer = objectGetOwnPropertyDescriptor(normalizedSigners, requestedOutpoint)?.value
      if (requested.unlockingScriptLength === undefined || signer == null) {
        throw new Error(`Requested input ${index} has no authorized signer`)
      }
      const signed = await signer(partial, inputIndex)
      assertSharedIntrinsicsUnchanged(sharedIntrinsicState)
      assertSameTemplate(authorizedPartial, partial)
      const unlockingScript = hex(
        typeof signed === 'string' ? signed : toHex(signed),
        `Requested input ${index} signed unlocking script`
      )
      spends[inputIndex] = { unlockingScript }
      expectedScripts[inputIndex] = unlockingScript
      expectedScriptIndexes[expectedScriptIndexes.length] = inputIndex
      if (!hasOwn(usedSigners, requestedOutpoint)) {
        usedSigners[requestedOutpoint] = true
        usedSignerCount++
      }
    }
    if (usedSignerCount !== normalizedSignerCount) {
      throw new Error('An input signer does not match a requested signable input')
    }

    const signOptions: SignActionOptions = {
      acceptDelayedBroadcast: authorizedArgs.options?.acceptDelayedBroadcast,
      returnTXIDOnly: false,
      noSend: authorizedArgs.options?.noSend,
      sendWith: authorizedArgs.options?.sendWith
    }
    const rawSignResult = await wallet.signAction(
      { reference, spends, options: signOptions },
      originator
    )
    assertSharedIntrinsicsUnchanged(sharedIntrinsicState)
    const signResult = dataRecord(
      snapshotActionData(rawSignResult, 'Wallet signAction result', 0, undefined, true),
      'Wallet signAction result',
      true
    )
    assertSharedIntrinsicsUnchanged(sharedIntrinsicState)
    const signed = parseAtomicBEEF(
      bytes(objectGetOwnPropertyDescriptor(signResult, 'tx')?.value, 'Wallet signed transaction')
    )
    assertSameTemplate(partial, signed)
    for (let index = 0; index < expectedScriptIndexes.length; index++) {
      const inputIndex = expectedScriptIndexes[index]
      const expected = expectedScripts[inputIndex]
      const unlockingScript = signed.inputs[inputIndex]?.unlockingScript
      if (unlockingScript == null || lower(toHex(unlockingScript)) !== expected) {
        throw new Error('Wallet signed transaction substituted an authorized unlocking script')
      }
    }
    const signedTxid = objectGetOwnPropertyDescriptor(signResult, 'txid')?.value
    if (
      signedTxid !== undefined &&
      txid(signedTxid, 'Wallet signed transaction ID') !== lower(transactionID(signed))
    ) {
      throw new Error('Wallet signed transaction ID does not match its transaction data')
    }
    return signed
  } catch (error) {
    await abortBestEffort(wallet, reference, originator)
    throw error
  }
}

// A property on the existing function permits legacy-peer feature detection
// without importing the entire SDK namespace (or a missing named ESM export).
completeBoundAction.outputAuthorizationVersion = BOUND_ACTION_OUTPUT_AUTHORIZATION_VERSION
