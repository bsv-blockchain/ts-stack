import { CallType } from './substrates/WalletWireCalls.js'
import { MAXIMUM_SEND_WITH_TRANSACTIONS } from './validationHelpers.js'
import { MAX_WALLET_WIRE_FRAME_BYTES } from './substrates/WalletWire.js'
import ExactByteCache from './ExactByteCache.js'
import {
  parseWalletResultAtomicBEEF,
  parseWalletResultBEEF,
  type WalletResultBEEF,
  type WalletResultTransaction
} from './WalletResultBEEF.js'
import { isCanonicalDERSignature, isValidCompressedPublicKey } from './Secp256k1Validation.js'
import {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  hexToBytes,
  utf8Bytes
} from './WalletByteEncoding.js'
import { isUnsafeRecordKey } from '../primitives/SafeRecord.js'

const IntrinsicNumber = Number
const IntrinsicString = String
const IntrinsicUint8Array = Uint8Array
const IntrinsicURL = URL
const intrinsicArrayPrototype = Array.prototype
const intrinsicArrayIsArray = Array.isArray
const intrinsicDateParse = Date.parse
const intrinsicNumberMaxSafeInteger = Number.MAX_SAFE_INTEGER
const intrinsicNumberIsFinite = Number.isFinite
const intrinsicNumberIsInteger = Number.isInteger
const intrinsicNumberIsSafeInteger = Number.isSafeInteger
const intrinsicObjectPrototype = Object.prototype
const intrinsicObjectHasOwnProperty = Object.prototype.hasOwnProperty
const intrinsicObjectCreate = Object.create
const intrinsicObjectDefineProperty = Object.defineProperty
const intrinsicObjectFreeze = Object.freeze
const intrinsicObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor
const intrinsicObjectGetPrototypeOf = Object.getPrototypeOf
const intrinsicObjectKeys = Object.keys
const intrinsicReflectOwnKeys = Reflect.ownKeys
const intrinsicRegExpExec = RegExp.prototype.exec
const intrinsicRegExpTest = RegExp.prototype.test
const intrinsicStringSplit = String.prototype.split
const intrinsicStringToLowerCase = String.prototype.toLowerCase
const intrinsicStringTrim = String.prototype.trim
const intrinsicStringReplace = String.prototype.replace
const intrinsicStringNormalize = String.prototype.normalize
const intrinsicStringIndexOf = String.prototype.indexOf
const intrinsicStringSlice = String.prototype.slice
const IntrinsicRegExp = RegExp
const intrinsicURLProtocolGetter = intrinsicObjectGetOwnPropertyDescriptor(
  URL.prototype,
  'protocol'
)?.get
const intrinsicTypedArrayPrototype = intrinsicObjectGetPrototypeOf(Uint8Array.prototype) as object
const intrinsicTypedArrayBufferGetter = intrinsicObjectGetOwnPropertyDescriptor(
  intrinsicTypedArrayPrototype,
  'buffer'
)?.get
const intrinsicTypedArrayLengthGetter = intrinsicObjectGetOwnPropertyDescriptor(
  intrinsicTypedArrayPrototype,
  'length'
)?.get
const intrinsicTypedArrayTagGetter = intrinsicObjectGetOwnPropertyDescriptor(
  intrinsicTypedArrayPrototype,
  Symbol.toStringTag
)?.get
const intrinsicUint8ArraySet = Uint8Array.prototype.set
const intrinsicSharedArrayBufferByteLengthGetter =
  typeof SharedArrayBuffer === 'undefined'
    ? undefined
    : intrinsicObjectGetOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength')?.get
const IntrinsicMap = Map
const IntrinsicSet = Set
const IntrinsicWeakMap = WeakMap
const IntrinsicWeakSet = WeakSet
const intrinsicMapGet = Map.prototype.get
const intrinsicMapSet = Map.prototype.set
const intrinsicMapHas = Map.prototype.has
const intrinsicMapForEach = Map.prototype.forEach
const intrinsicSetAdd = Set.prototype.add
const intrinsicSetHas = Set.prototype.has
const intrinsicSetSize = intrinsicObjectGetOwnPropertyDescriptor(Set.prototype, 'size')!.get!
const intrinsicWeakMapGet = WeakMap.prototype.get
const intrinsicWeakMapSet = WeakMap.prototype.set
const intrinsicWeakSetAdd = WeakSet.prototype.add
const intrinsicWeakSetHas = WeakSet.prototype.has
const intrinsicApply = Reflect.apply

function arrayIsArray(value: unknown): value is unknown[] {
  return intrinsicArrayIsArray(value)
}

function numberValue(value: unknown): number {
  return IntrinsicNumber(value)
}

function stringValue(value: unknown): string {
  return IntrinsicString(value)
}

function lower(value: string): string {
  return intrinsicApply(intrinsicStringToLowerCase, value, []) as string
}

function split(value: string, separator: string): string[] {
  return intrinsicApply(intrinsicStringSplit, value, [separator]) as string[]
}

function regexTest(pattern: RegExp, value: string): boolean {
  return intrinsicApply(intrinsicRegExpTest, pattern, [value]) as boolean
}

function regexExec(pattern: RegExp, value: string): RegExpExecArray | null {
  return intrinsicApply(intrinsicRegExpExec, pattern, [value]) as RegExpExecArray | null
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return intrinsicApply(intrinsicObjectHasOwnProperty, value, [key]) as boolean
}

function typedArrayDetails(
  value: object
): { buffer: ArrayBufferLike; length: number; tag: string | undefined } | undefined {
  if (
    intrinsicTypedArrayBufferGetter == null ||
    intrinsicTypedArrayLengthGetter == null ||
    intrinsicTypedArrayTagGetter == null
  ) {
    return undefined
  }
  try {
    return {
      buffer: intrinsicApply(intrinsicTypedArrayBufferGetter, value, []) as ArrayBufferLike,
      length: intrinsicApply(intrinsicTypedArrayLengthGetter, value, []) as number,
      tag: intrinsicApply(intrinsicTypedArrayTagGetter, value, []) as string | undefined
    }
  } catch {
    return undefined
  }
}

function isUint8Array(value: object): value is Uint8Array {
  return typedArrayDetails(value)?.tag === 'Uint8Array'
}

function isSharedArrayBuffer(value: ArrayBufferLike): boolean {
  if (intrinsicSharedArrayBufferByteLengthGetter == null) return false
  try {
    intrinsicApply(intrinsicSharedArrayBufferByteLengthGetter, value, [])
    return true
  } catch {
    return false
  }
}

function mapGet<K, V>(map: Map<K, V>, key: K): V | undefined {
  return intrinsicApply(intrinsicMapGet, map, [key]) as V | undefined
}

function mapSet<K, V>(map: Map<K, V>, key: K, value: V): void {
  intrinsicApply(intrinsicMapSet, map, [key, value])
}

function mapHas<K, V>(map: Map<K, V>, key: K): boolean {
  return intrinsicApply(intrinsicMapHas, map, [key]) as boolean
}

function mapForEach<K, V>(map: Map<K, V>, callback: (value: V, key: K) => void): void {
  intrinsicApply(intrinsicMapForEach, map, [callback])
}

function setAdd<T>(set: Set<T>, value: T): void {
  intrinsicApply(intrinsicSetAdd, set, [value])
}

function setHas<T>(set: Set<T>, value: T): boolean {
  return intrinsicApply(intrinsicSetHas, set, [value]) as boolean
}

function setSize<T>(set: Set<T>): number {
  return intrinsicApply(intrinsicSetSize, set, []) as number
}

function weakMapGet<K extends object, V>(map: WeakMap<K, V>, key: K): V | undefined {
  return intrinsicApply(intrinsicWeakMapGet, map, [key]) as V | undefined
}

function weakMapSet<K extends object, V>(map: WeakMap<K, V>, key: K, value: V): void {
  intrinsicApply(intrinsicWeakMapSet, map, [key, value])
}

function weakSetAdd<T extends object>(set: WeakSet<T>, value: T): void {
  intrinsicApply(intrinsicWeakSetAdd, set, [value])
}

function weakSetHas<T extends object>(set: WeakSet<T>, value: T): boolean {
  return intrinsicApply(intrinsicWeakSetHas, set, [value]) as boolean
}

const actionStatuses = new IntrinsicSet<string>()
setAdd(actionStatuses, 'completed')
setAdd(actionStatuses, 'unprocessed')
setAdd(actionStatuses, 'sending')
setAdd(actionStatuses, 'unproven')
setAdd(actionStatuses, 'unsigned')
setAdd(actionStatuses, 'nosend')
setAdd(actionStatuses, 'nonfinal')
setAdd(actionStatuses, 'failed')
const sendWithStatuses = new IntrinsicSet<string>()
setAdd(sendWithStatuses, 'unproven')
setAdd(sendWithStatuses, 'sending')
setAdd(sendWithStatuses, 'failed')
const maxObjectGraphNodes = 1_000_000
// A dense array at the node limit has one array node, `length`, and one key
// for every entry. Keep the property budget large enough to admit that exact
// documented boundary while still rejecting the next entry before traversal.
const maxObjectGraphProperties = maxObjectGraphNodes + 2
const maxCertificateBytes = 16 * 1024 * 1024
const anyonePublicKey = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const validatedAtomicTransactions = new ExactByteCache<WalletResultTransaction>()
const createActionSourceEvidence = Symbol('createActionSourceEvidence')
const byteBudgetExceeded = Symbol('byteBudgetExceeded')
const ownedByteArrays = new IntrinsicWeakSet<object>()

type UnknownRecord = Record<string, unknown>
type SourceValueEvidence = Readonly<Record<string, number>>

const emptySourceValueEvidence = intrinsicObjectFreeze(
  intrinsicObjectCreate(null) as Record<string, number>
) as SourceValueEvidence

function snapshotArray(value: unknown): unknown[] | undefined {
  if (!arrayIsArray(value)) return undefined
  const lengthDescriptor = intrinsicObjectGetOwnPropertyDescriptor(value, 'length')
  if (
    lengthDescriptor == null ||
    !('value' in lengthDescriptor) ||
    !intrinsicNumberIsSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > maxObjectGraphNodes
  ) {
    throw new Error('Wallet request arrays must have a bounded own length')
  }
  const length = lengthDescriptor.value as number
  const keys = intrinsicReflectOwnKeys(value)
  if (keys.length !== length + 1) {
    throw new Error('Wallet request arrays must contain only dense data properties')
  }
  const snapshot: unknown[] = []
  snapshot.length = length
  for (let index = 0; index < length; index++) {
    const descriptor = intrinsicObjectGetOwnPropertyDescriptor(value, stringValue(index))
    if (descriptor == null || !('value' in descriptor)) {
      throw new Error('Wallet request arrays must contain only dense data properties')
    }
    snapshot[index] = descriptor.value
  }
  return snapshot
}

function snapshotRecord(value: unknown): UnknownRecord | undefined {
  const source = requestRecord(value)
  if (source == null) return undefined
  const snapshot = intrinsicObjectCreate(null) as UnknownRecord
  const keys = intrinsicReflectOwnKeys(source)
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]
    if (typeof key !== 'string') continue
    const descriptor = intrinsicObjectGetOwnPropertyDescriptor(source, key)
    if (descriptor != null && 'value' in descriptor) snapshot[key] = descriptor.value
  }
  return snapshot
}

function snapshotFields(
  source: UnknownRecord,
  fields: readonly string[],
  arrayFields: readonly string[] = []
): UnknownRecord {
  const snapshot = intrinsicObjectCreate(null) as UnknownRecord
  for (let fieldIndex = 0; fieldIndex < fields.length; fieldIndex++) {
    const field = fields[fieldIndex]
    let isArrayField = false
    for (let index = 0; index < arrayFields.length; index++) {
      if (arrayFields[index] === field) {
        isArrayField = true
        break
      }
    }
    snapshot[field] = isArrayField ? snapshotArray(source[field]) : source[field]
  }
  return snapshot
}

function sourceValueEvidenceFromCreateActionRequest(request: unknown): SourceValueEvidence {
  const source = requestRecord(request)
  if (source == null) return emptySourceValueEvidence
  const snapshotEvidence = intrinsicObjectGetOwnPropertyDescriptor(
    source,
    createActionSourceEvidence
  )?.value
  if (snapshotEvidence != null) return snapshotEvidence as SourceValueEvidence

  const inputBEEF = source.inputBEEF
  const inputs = source.inputs
  if (inputBEEF === undefined || !arrayIsArray(inputs) || inputs.length === 0) {
    return emptySourceValueEvidence
  }

  const encoded = bytes(inputBEEF, 'createAction', 'request.inputBEEF')
  let envelope: WalletResultBEEF
  try {
    envelope = parseWalletResultBEEF(encoded)
  } catch {
    invalid('createAction', 'request.inputBEEF', 'an exactly framed BEEF envelope')
  }

  const evidence = intrinsicObjectCreate(null) as Record<string, number>
  for (let index = 0; index < inputs.length; index++) {
    const value = inputs[index]
    const input = requestRecord(value)
    if (input == null || typeof input.outpoint !== 'string') continue
    const match = regexExec(/^([0-9a-fA-F]{64})\.(0|[1-9]\d*)$/, input.outpoint)
    if (match == null) continue
    const outputIndex = numberValue(match[2])
    if (outputIndex > 0xffffffff) continue
    const txid = lower(match[1])
    const output = mapGet(envelope.transactions, txid)?.outputs[outputIndex]
    if (output !== undefined) evidence[`${txid}.${outputIndex}`] = output.satoshis
  }
  return intrinsicObjectFreeze(evidence) as SourceValueEvidence
}

/**
 * Capture only the immutable request fields used to bind a later wallet
 * result. A caller, bridge, or direct substrate must not be able to change the
 * authorization/filter context while an asynchronous wallet call is pending.
 */
export function snapshotWalletResultRequest(call: CallType, request: unknown): unknown {
  const source = requestRecord(request)
  if (source == null) return request
  const options = requestRecord(source.options)
  switch (call) {
    case 'createAction': {
      const snapshot: UnknownRecord = {
        inputs: arrayIsArray(source.inputs)
          ? (() => {
              const inputs: unknown[] = []
              inputs.length = source.inputs.length
              for (let index = 0; index < source.inputs.length; index++) {
                const value = source.inputs[index]
                const input = requestRecord(value)
                inputs[index] =
                  input == null
                    ? value
                    : snapshotFields(input, ['outpoint', 'unlockingScript', 'sequenceNumber'])
              }
              return inputs
            })()
          : source.inputs,
        outputs: arrayIsArray(source.outputs)
          ? (() => {
              const outputs: unknown[] = []
              outputs.length = source.outputs.length
              for (let index = 0; index < source.outputs.length; index++) {
                const value = source.outputs[index]
                const output = requestRecord(value)
                outputs[index] =
                  output == null ? value : snapshotFields(output, ['satoshis', 'lockingScript'])
              }
              return outputs
            })()
          : source.outputs,
        version: source.version,
        lockTime: source.lockTime,
        options:
          options == null
            ? {
                signAndProcess: undefined,
                returnTXIDOnly: undefined,
                sendWith: undefined,
                randomizeOutputs: undefined,
                knownTxids: undefined
              }
            : snapshotFields(
                options,
                ['signAndProcess', 'returnTXIDOnly', 'sendWith', 'randomizeOutputs', 'knownTxids'],
                ['sendWith', 'knownTxids']
              )
      }
      intrinsicObjectDefineProperty(snapshot, createActionSourceEvidence, {
        value: sourceValueEvidenceFromCreateActionRequest(source),
        writable: false,
        configurable: false,
        enumerable: false
      })
      return snapshot
    }
    case 'signAction': {
      const spends = requestRecord(source.spends)
      const spendSnapshot: UnknownRecord = intrinsicObjectCreate(null)
      if (spends != null) {
        const indexes = intrinsicObjectKeys(spends)
        for (let entryIndex = 0; entryIndex < indexes.length; entryIndex++) {
          const index = indexes[entryIndex]
          const value = spends[index]
          const spend = requestRecord(value)
          spendSnapshot[index] =
            spend == null ? value : snapshotFields(spend, ['unlockingScript', 'sequenceNumber'])
        }
      }
      return {
        spends: spendSnapshot,
        options:
          options == null
            ? { returnTXIDOnly: undefined, sendWith: undefined }
            : snapshotFields(options, ['returnTXIDOnly', 'sendWith'], ['sendWith'])
      }
    }
    case 'listActions':
      return snapshotFields(
        source,
        [
          'labels',
          'labelQueryMode',
          'includeLabels',
          'includeInputs',
          'includeInputSourceLockingScripts',
          'includeInputUnlockingScripts',
          'includeOutputs',
          'includeOutputLockingScripts',
          'limit'
        ],
        ['labels']
      )
    case 'listOutputs':
      return snapshotFields(
        source,
        [
          'basket',
          'tags',
          'tagQueryMode',
          'include',
          'includeCustomInstructions',
          'includeTags',
          'includeLabels',
          'limit'
        ],
        ['tags']
      )
    case 'listCertificates':
      return snapshotFields(source, ['limit', 'certifiers', 'types'], ['certifiers', 'types'])
    case 'discoverByIdentityKey':
      return snapshotFields(source, ['limit', 'identityKey'])
    case 'discoverByAttributes': {
      const attributes = requestRecord(source.attributes)
      return {
        limit: source.limit,
        attributes: attributes == null ? source.attributes : { ...attributes }
      }
    }
    case 'revealCounterpartyKeyLinkage':
      return snapshotFields(source, ['verifier', 'counterparty'])
    case 'revealSpecificKeyLinkage':
      return snapshotFields(
        source,
        ['verifier', 'counterparty', 'protocolID', 'keyID'],
        ['protocolID']
      )
    case 'acquireCertificate':
      return {
        ...snapshotFields(source, [
          'acquisitionProtocol',
          'type',
          'certifier',
          'serialNumber',
          'revocationOutpoint',
          'signature'
        ]),
        fields: snapshotRecord(source.fields)
      }
    case 'proveCertificate':
      return {
        fieldsToReveal: snapshotArray(source.fieldsToReveal),
        verifier: source.verifier,
        certificate: (() => {
          const certificate = requestRecord(source.certificate)
          return certificate == null
            ? source.certificate
            : {
                ...snapshotFields(certificate, [
                  'type',
                  'serialNumber',
                  'subject',
                  'certifier',
                  'revocationOutpoint',
                  'signature'
                ]),
                fields: snapshotRecord(certificate.fields)
              }
        })()
      }
    default:
      return request
  }
}

function invalid(call: string, field: string, expectation: string): never {
  throw new Error(`Invalid ${call} result ${field}: expected ${expectation}`)
}

function ownArrayLength(value: unknown[]): number | undefined {
  const descriptor = intrinsicObjectGetOwnPropertyDescriptor(value, 'length')
  return descriptor != null &&
    'value' in descriptor &&
    intrinsicNumberIsSafeInteger(descriptor.value) &&
    descriptor.value >= 0
    ? (descriptor.value as number)
    : undefined
}

function snapshotDenseByteArray(
  value: unknown[],
  length: number,
  maximumLength: number,
  remainingByteBudget = maximumLength
): number[] | typeof byteBudgetExceeded | undefined {
  if (length > maximumLength) return undefined
  const keys = intrinsicReflectOwnKeys(value)
  if (keys.length !== length + 1) return undefined
  for (let keyIndex = 0; keyIndex < keys.length; keyIndex++) {
    const key = keys[keyIndex]
    if (key === 'length') continue
    if (
      typeof key !== 'string' ||
      !intrinsicNumberIsInteger(numberValue(key)) ||
      numberValue(key) < 0 ||
      numberValue(key) >= length ||
      stringValue(numberValue(key)) !== key
    ) {
      return undefined
    }
  }
  const snapshot: number[] | undefined = length <= remainingByteBudget ? [] : undefined
  if (snapshot !== undefined) snapshot.length = length
  for (let index = 0; index < length; index++) {
    const descriptor = intrinsicObjectGetOwnPropertyDescriptor(value, stringValue(index))
    if (
      descriptor == null ||
      descriptor.enumerable !== true ||
      !('value' in descriptor) ||
      !intrinsicNumberIsInteger(descriptor.value) ||
      descriptor.value < 0 ||
      descriptor.value > 255
    ) {
      return undefined
    }
    if (snapshot !== undefined) snapshot[index] = descriptor.value
  }
  return snapshot ?? byteBudgetExceeded
}

function snapshotHistoricalByteRecord(
  value: object,
  maximumLength: number,
  remainingByteBudget: number
): number[] | typeof byteBudgetExceeded | undefined {
  const prototype = intrinsicObjectGetPrototypeOf(value)
  if (prototype !== intrinsicObjectPrototype && prototype !== null) return undefined
  const keys = intrinsicReflectOwnKeys(value)
  if (keys.length === 0 || keys.length > maximumLength) return undefined
  const snapshot: number[] | undefined = keys.length <= remainingByteBudget ? [] : undefined
  if (snapshot !== undefined) snapshot.length = keys.length
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]
    if (key !== stringValue(index)) return undefined
    const descriptor = intrinsicObjectGetOwnPropertyDescriptor(value, key)
    if (
      descriptor == null ||
      descriptor.enumerable !== true ||
      !('value' in descriptor) ||
      !intrinsicNumberIsInteger(descriptor.value) ||
      descriptor.value < 0 ||
      descriptor.value > 255
    ) {
      return undefined
    }
    if (snapshot !== undefined) snapshot[index] = descriptor.value
  }
  return snapshot ?? byteBudgetExceeded
}

function isHistoricalWalletByteField(field: string | undefined): boolean {
  // Keep this list aligned with the typed-boundary recovery performed by
  // normalizeBRC100WalletByteFields. Numeric-key objects are valid opaque
  // application data everywhere else and must retain their record shape.
  switch (field) {
    case 'BEEF':
    case 'atomicBEEF':
    case 'beef':
    case 'ciphertext':
    case 'competingBeef':
    case 'data':
    case 'encryptedLinkage':
    case 'encryptedLinkageProof':
    case 'hashToDirectlySign':
    case 'hashToDirectlyVerify':
    case 'hmac':
    case 'inputBEEF':
    case 'payload':
    case 'plaintext':
    case 'signature':
    case 'transaction':
    case 'tx':
      return true
    default:
      return false
  }
}

function snapshotUint8Array(value: object, call: string, remainingByteBudget: number): Uint8Array {
  const details = typedArrayDetails(value)
  if (details?.tag !== 'Uint8Array') {
    invalid(call, 'byte array', 'an intrinsic Uint8Array')
  }
  const { buffer, length } = details
  if (isSharedArrayBuffer(buffer)) {
    invalid(call, 'byte array', 'an unshared Uint8Array')
  }
  if (length > MAX_WALLET_WIRE_FRAME_BYTES) {
    invalid(call, 'byte array', `at most ${MAX_WALLET_WIRE_FRAME_BYTES} bytes`)
  }
  if (length > remainingByteBudget) {
    invalid(call, 'byte arrays', `at most ${MAX_WALLET_WIRE_FRAME_BYTES} total bytes`)
  }
  const snapshot = new IntrinsicUint8Array(length)
  try {
    intrinsicApply(intrinsicUint8ArraySet, snapshot, [value])
  } catch {
    invalid(call, 'byte array', 'an intrinsic Uint8Array')
  }
  return snapshot
}

interface SnapshotFrame {
  source: object
  target: UnknownRecord | unknown[]
  array: boolean
}

function snapshotSafeObjectGraph(
  value: unknown,
  call: string,
  recoverHistoricalWalletByteFields = false
): unknown {
  const pending: SnapshotFrame[] = []
  const seen = new IntrinsicWeakMap<object, unknown>()
  const seenHistoricalByteRecords = new IntrinsicWeakMap<object, number[]>()
  let nodes = 0
  let copiedBytes = 0

  const snapshotValue = (candidate: unknown, field?: string): unknown => {
    if (candidate == null || typeof candidate !== 'object') {
      if (typeof candidate === 'function') invalid(call, 'value', 'data without functions')
      return candidate
    }

    if (
      !arrayIsArray(candidate) &&
      !isUint8Array(candidate) &&
      recoverHistoricalWalletByteFields &&
      isHistoricalWalletByteField(field)
    ) {
      const previousBytes = weakMapGet(seenHistoricalByteRecords, candidate)
      if (previousBytes !== undefined) return previousBytes
      const historicalSnapshot = snapshotHistoricalByteRecord(
        candidate,
        MAX_WALLET_WIRE_FRAME_BYTES,
        MAX_WALLET_WIRE_FRAME_BYTES - copiedBytes
      )
      if (historicalSnapshot === byteBudgetExceeded) {
        invalid(call, 'byte arrays', `at most ${MAX_WALLET_WIRE_FRAME_BYTES} total bytes`)
      }
      if (historicalSnapshot !== undefined) {
        nodes++
        if (nodes > maxObjectGraphNodes) invalid(call, 'object graph', 'a bounded result')
        if (historicalSnapshot.length > MAX_WALLET_WIRE_FRAME_BYTES - copiedBytes) {
          invalid(call, 'byte arrays', `at most ${MAX_WALLET_WIRE_FRAME_BYTES} total bytes`)
        }
        copiedBytes += historicalSnapshot.length
        weakSetAdd(ownedByteArrays, historicalSnapshot)
        weakMapSet(seenHistoricalByteRecords, candidate, historicalSnapshot)
        return historicalSnapshot
      }
    }

    const previous = weakMapGet(seen, candidate)
    if (previous !== undefined) return previous

    nodes++
    if (nodes > maxObjectGraphNodes) invalid(call, 'object graph', 'a bounded result')

    if (isUint8Array(candidate)) {
      const snapshot = snapshotUint8Array(
        candidate,
        call,
        MAX_WALLET_WIRE_FRAME_BYTES - copiedBytes
      )
      copiedBytes += typedArrayDetails(snapshot)!.length
      weakSetAdd(ownedByteArrays, snapshot)
      weakMapSet(seen, candidate, snapshot)
      return snapshot
    }

    if (arrayIsArray(candidate)) {
      const prototype = intrinsicObjectGetPrototypeOf(candidate)
      if (prototype !== intrinsicArrayPrototype) {
        invalid(call, 'array prototype', 'the intrinsic Array.prototype')
      }
      const candidateLength = ownArrayLength(candidate)
      if (candidateLength === undefined) {
        invalid(call, 'array length', 'an own integer data property')
      }
      const byteSnapshot = snapshotDenseByteArray(
        candidate,
        candidateLength,
        MAX_WALLET_WIRE_FRAME_BYTES,
        MAX_WALLET_WIRE_FRAME_BYTES - copiedBytes
      )
      if (byteSnapshot === byteBudgetExceeded) {
        invalid(call, 'byte arrays', `at most ${MAX_WALLET_WIRE_FRAME_BYTES} total bytes`)
      }
      if (byteSnapshot !== undefined) {
        copiedBytes += byteSnapshot.length
        weakSetAdd(ownedByteArrays, byteSnapshot)
        weakMapSet(seen, candidate, byteSnapshot)
        return byteSnapshot
      }
      if (candidateLength > maxObjectGraphNodes) {
        invalid(call, 'array length', `at most ${maxObjectGraphNodes} entries`)
      }
      const target: unknown[] = []
      target.length = candidateLength
      weakMapSet(seen, candidate, target)
      pending[pending.length] = { source: candidate, target, array: true }
      return target
    }

    const prototype = intrinsicObjectGetPrototypeOf(candidate)
    if (prototype !== null && prototype !== intrinsicObjectPrototype) {
      invalid(call, 'object prototype', 'Object.prototype or null')
    }
    // Preserve the source record's ordinary-object contract for public wallet
    // results while still copying only validated own data properties. Internal
    // schema decisions use record(), whose null-prototype view ignores anything
    // inherited from Object.prototype.
    const target = (prototype === null ? intrinsicObjectCreate(null) : {}) as UnknownRecord
    weakMapSet(seen, candidate, target)
    pending[pending.length] = { source: candidate, target, array: false }
    return target
  }

  const root = snapshotValue(value)
  while (pending.length > 0) {
    const frame = pending[pending.length - 1]!
    pending.length -= 1
    const keys = intrinsicReflectOwnKeys(frame.source)
    if (frame.array) {
      nodes += keys.length
      if (nodes > maxObjectGraphProperties) invalid(call, 'object graph', 'a bounded result')
      // A hostile array can install its own entries()/iterator and cause the
      // schema loops below to inspect no elements. Requiring exactly length
      // plus every canonical index also rejects sparse arrays without looping
      // over an attacker-controlled length.
      const source = frame.source as unknown[]
      const length = (frame.target as unknown[]).length
      if (keys.length !== length + 1) {
        invalid(call, 'array shape', 'a dense standard array without extra properties')
      }
      for (let keyIndex = 0; keyIndex < keys.length; keyIndex++) {
        const key = keys[keyIndex]
        if (typeof key !== 'string') invalid(call, 'array key', 'a string')
        if (isUnsafeRecordKey(key)) invalid(call, `array key ${key}`, 'a safe array key')
        if (key !== 'length') {
          const index = numberValue(key)
          if (
            !intrinsicNumberIsInteger(index) ||
            index < 0 ||
            index >= length ||
            stringValue(index) !== key
          ) {
            invalid(call, `array key ${key}`, 'a canonical in-range array index')
          }
        }
        const descriptor = intrinsicObjectGetOwnPropertyDescriptor(source, key)
        if (descriptor == null || !('value' in descriptor)) {
          invalid(call, `array property ${key}`, 'a data property')
        }
        if (key !== 'length') {
          intrinsicObjectDefineProperty(frame.target, key, {
            value: snapshotValue(descriptor.value),
            enumerable: descriptor.enumerable,
            configurable: true,
            writable: true
          })
        }
      }
      continue
    }

    nodes += keys.length
    if (nodes > maxObjectGraphProperties) invalid(call, 'object graph', 'a bounded result')
    for (let keyIndex = 0; keyIndex < keys.length; keyIndex++) {
      const key = keys[keyIndex]
      if (typeof key !== 'string') invalid(call, 'object key', 'a string')
      if (isUnsafeRecordKey(key)) invalid(call, `object key ${key}`, 'a safe record key')
      const descriptor = intrinsicObjectGetOwnPropertyDescriptor(frame.source, key)
      if (descriptor == null || !('value' in descriptor)) {
        invalid(call, `object property ${key}`, 'a data property')
      }
      intrinsicObjectDefineProperty(frame.target, key, {
        value: snapshotValue(descriptor.value, key),
        enumerable: descriptor.enumerable,
        configurable: true,
        writable: true
      })
    }
  }
  return root
}

export function assertSafeWalletValue<T>(value: T, context: string): T {
  return snapshotSafeObjectGraph(value, context) as T
}

/**
 * Snapshot a parsed HTTP wallet response while recovering the numeric-key
 * objects emitted by historical JSON serialization of wallet byte fields.
 * Generic wallet values deliberately do not apply this field-name heuristic.
 */
export function assertSafeWalletJSONValue<T>(value: T, context: string): T {
  return snapshotSafeObjectGraph(value, context, true) as T
}

function record(value: unknown, call: string, field = 'value'): UnknownRecord {
  if (value == null || typeof value !== 'object' || arrayIsArray(value)) {
    invalid(call, field, 'an object')
  }
  // Validate against an own-data-only view. Plain wallet result objects inherit
  // from Object.prototype, which another same-realm substrate can pollute with
  // apparently affirmative verdicts or well-formed scalar fields.
  const result = intrinsicObjectCreate(null) as UnknownRecord
  const keys = intrinsicReflectOwnKeys(value)
  for (let keyIndex = 0; keyIndex < keys.length; keyIndex++) {
    const key = keys[keyIndex]
    if (typeof key !== 'string') invalid(call, `${field} key`, 'a string')
    const descriptor = intrinsicObjectGetOwnPropertyDescriptor(value, key)
    if (descriptor == null || !('value' in descriptor)) {
      invalid(call, `${field}.${key}`, 'a data property')
    }
    result[key] = descriptor.value
  }
  return result
}

function bytes(
  value: unknown,
  call: string,
  field: string,
  exactLength?: number,
  maximumLength = MAX_WALLET_WIRE_FRAME_BYTES
): number[] | Uint8Array {
  let normalized: number[] | Uint8Array | undefined
  if (value != null && typeof value === 'object' && isUint8Array(value)) {
    const candidate = weakSetHas(ownedByteArrays, value)
      ? value
      : snapshotUint8Array(value, call, MAX_WALLET_WIRE_FRAME_BYTES)
    if (typedArrayDetails(candidate)!.length <= maximumLength) normalized = candidate
  } else if (arrayIsArray(value)) {
    const length = ownArrayLength(value)
    if (length === undefined) invalid(call, field, 'an own integer array length')
    if (length > maximumLength) {
      invalid(call, field, `at most ${maximumLength} bytes`)
    }
    if (weakSetHas(ownedByteArrays, value)) {
      normalized = value as number[]
    } else {
      const snapshot = snapshotDenseByteArray(value, length, maximumLength)
      if (snapshot === byteBudgetExceeded) invalid(call, field, `at most ${maximumLength} bytes`)
      normalized = snapshot
    }
  }
  if (normalized == null) invalid(call, field, 'an array of bytes')
  const normalizedLength = arrayIsArray(normalized)
    ? normalized.length
    : typedArrayDetails(normalized)!.length
  if (normalizedLength > maximumLength) {
    invalid(call, field, `at most ${maximumLength} bytes`)
  }
  if (exactLength !== undefined && normalizedLength !== exactLength) {
    invalid(call, field, `${exactLength} bytes`)
  }
  return normalized
}

function string(value: unknown, call: string, field: string, min = 0, max?: number): string {
  if (typeof value !== 'string') invalid(call, field, 'a string')
  const length = utf8Bytes(value).length
  if (length < min || (max !== undefined && length > max)) {
    invalid(call, field, `${min}${max === undefined ? '+' : `–${max}`} UTF-8 bytes`)
  }
  return value
}

function hex(value: unknown, call: string, field: string, exactBytes?: number): string {
  const result = string(value, call, field)
  if (!regexTest(/^(?:[0-9a-fA-F]{2})*$/, result)) {
    invalid(call, field, 'an even-length hex string')
  }
  if (exactBytes !== undefined && result.length !== exactBytes * 2) {
    invalid(call, field, `${exactBytes} hexadecimal bytes`)
  }
  return result
}

function publicKey(value: unknown, call: string, field: string): void {
  const encoded = hex(value, call, field, 33)
  if (!isValidCompressedPublicKey(encoded)) {
    invalid(call, field, 'a valid compressed secp256k1 public key')
  }
}

function uint(value: unknown, call: string, field: string, maximum = 0xffffffff): number {
  if (
    !intrinsicNumberIsSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > maximum
  ) {
    invalid(call, field, `an integer from 0 to ${maximum}`)
  }
  return value as number
}

function rangedInteger(
  value: unknown,
  call: string,
  field: string,
  minimum: number,
  maximum: number
): number {
  if (
    !intrinsicNumberIsSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    invalid(call, field, `an integer from ${minimum} to ${maximum}`)
  }
  return value as number
}

function affirmative(value: UnknownRecord, call: string, field: string): void {
  if (value[field] !== true) invalid(call, field, 'true')
}

function boolean(value: UnknownRecord, call: string, field: string): void {
  if (typeof value[field] !== 'boolean') invalid(call, field, 'a boolean')
}

function optionalArray(value: unknown, call: string, field: string): unknown[] | undefined {
  if (value === undefined) return undefined
  if (!arrayIsArray(value)) invalid(call, field, 'an array')
  if (value.length > 100_000) invalid(call, field, 'at most 100000 entries')
  return value
}

function stringArray(
  value: unknown,
  call: string,
  field: string,
  minLength: number,
  maxLength: number
): void {
  const values = optionalArray(value, call, field)
  if (values == null) return
  for (let index = 0; index < values.length; index++) {
    string(values[index], call, `${field}[${index}]`, minLength, maxLength)
  }
}

function isoTimestamp(value: unknown, call: string, field: string): void {
  const timestamp = string(value, call, field, 1, 64)
  if (!regexTest(/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/, timestamp)) {
    invalid(call, field, 'an ISO timestamp with a timezone')
  }
  const parsed = intrinsicDateParse(timestamp)
  if (!intrinsicNumberIsFinite(parsed)) invalid(call, field, 'a valid ISO timestamp')
}

function httpUrl(value: unknown, call: string, field: string, maxLength: number): void {
  const encoded = string(value, call, field, 1, maxLength)
  try {
    const parsed = new IntrinsicURL(encoded)
    if (intrinsicURLProtocolGetter == null) throw new Error()
    const protocol = intrinsicApply(intrinsicURLProtocolGetter, parsed, []) as string
    if (protocol !== 'https:' && protocol !== 'http:') throw new Error()
  } catch {
    invalid(call, field, 'an absolute HTTP(S) URL')
  }
}

function validateSendWithResults(value: unknown, call: string): void {
  const results = optionalArray(value, call, 'sendWithResults')
  if (results == null) return
  if (results.length > MAXIMUM_SEND_WITH_TRANSACTIONS + 1) {
    invalid(
      call,
      'sendWithResults',
      `at most ${MAXIMUM_SEND_WITH_TRANSACTIONS + 1} transaction results`
    )
  }
  for (let index = 0; index < results.length; index++) {
    const item = results[index]
    const field = `sendWithResults[${index}]`
    const result = record(item, call, field)
    hex(result.txid, call, `${field}.txid`, 32)
    if (!setHas(sendWithStatuses, result.status as string)) {
      invalid(call, `${field}.status`, 'a supported status')
    }
  }
}

function transactionInputOutpoint(
  transaction: WalletResultTransaction,
  inputIndex: number,
  call: string,
  field: string
): string {
  const input = transaction.inputs[inputIndex]
  if (input == null) invalid(call, field, 'a transaction input')
  const normalizedTxid = lower(hex(input.sourceTXID, call, `${field}.sourceTXID`, 32))
  const sourceOutputIndex = uint(input.sourceOutputIndex, call, `${field}.sourceOutputIndex`)
  return `${normalizedTxid}.${sourceOutputIndex}`
}

function validateCreateActionTransaction(
  transaction: WalletResultTransaction,
  call: string,
  request: unknown,
  sourceEvidence: SourceValueEvidence,
  allowUnresolvedSources: boolean
): void {
  const args = requestRecord(request)
  if (args == null) {
    validateTransactionValueConservation(transaction, call, sourceEvidence, allowUnresolvedSources)
    return
  }

  const requestedVersion =
    args.version === undefined ? 1 : uint(args.version, call, 'request.version')
  const requestedLockTime =
    args.lockTime === undefined ? 0 : uint(args.lockTime, call, 'request.lockTime')
  if (transaction.version !== requestedVersion) {
    invalid(call, 'tx.version', 'the requested transaction version')
  }
  if (transaction.lockTime !== requestedLockTime) {
    invalid(call, 'tx.lockTime', 'the requested transaction lock time')
  }

  const candidateInputs = new IntrinsicMap<string, number>()
  for (let index = 0; index < transaction.inputs.length; index++) {
    const outpoint = transactionInputOutpoint(transaction, index, call, `tx.inputs[${index}]`)
    if (mapHas(candidateInputs, outpoint)) {
      invalid(call, `tx.inputs[${index}]`, 'a unique transaction input outpoint')
    }
    mapSet(candidateInputs, outpoint, index)
  }
  const requestedInputs =
    args.inputs === undefined ? [] : optionalArray(args.inputs, call, 'request.inputs')!
  const seenRequestedInputs = new IntrinsicSet<string>()
  for (let index = 0; index < requestedInputs.length; index++) {
    const value = requestedInputs[index]
    const field = `request.inputs[${index}]`
    const requested = record(value, call, field)
    const outpointParts = requireOutpoint(requested.outpoint, call, `${field}.outpoint`)
    const outpoint = `${outpointParts.txid}.${outpointParts.outputIndex}`
    if (setHas(seenRequestedInputs, outpoint)) {
      invalid(call, `${field}.outpoint`, 'a unique requested input')
    }
    setAdd(seenRequestedInputs, outpoint)
    const candidateIndex = mapGet(candidateInputs, outpoint)
    if (candidateIndex === undefined) {
      invalid(call, 'tx.inputs', 'every requested input exactly once')
    }
    const candidate = transaction.inputs[candidateIndex]
    const requestedSequence =
      requested.sequenceNumber === undefined
        ? 0xffffffff
        : uint(requested.sequenceNumber, call, `${field}.sequenceNumber`)
    if ((candidate.sequence ?? 0xffffffff) !== requestedSequence) {
      invalid(call, `tx.inputs[${candidateIndex}].sequence`, 'the requested input sequence')
    }
    if (requested.unlockingScript !== undefined) {
      const requestedScript = lower(
        hex(requested.unlockingScript, call, `${field}.unlockingScript`)
      )
      if (lower(bytesToHex(candidate.unlockingScript)) !== requestedScript) {
        invalid(
          call,
          `tx.inputs[${candidateIndex}].unlockingScript`,
          'the requested unlocking script'
        )
      }
    }
  }

  const requestedOutputs =
    args.outputs === undefined ? [] : optionalArray(args.outputs, call, 'request.outputs')!
  const requestedOptions = requestRecord(args.options)
  const preserveOutputOrder = requestedOptions?.randomizeOutputs === false
  const availableOutputs = new IntrinsicMap<string, number>()
  for (let index = 0; index < transaction.outputs.length; index++) {
    const output = transaction.outputs[index]
    const amount = uint(output.satoshis, call, `tx.outputs[${index}].satoshis`, 21e14)
    if (requestedOutputs.length > 0) {
      const key = `${amount}:${lower(bytesToHex(output.lockingScript))}`
      mapSet(availableOutputs, key, (mapGet(availableOutputs, key) ?? 0) + 1)
    }
  }
  for (let index = 0; index < requestedOutputs.length; index++) {
    const value = requestedOutputs[index]
    const field = `request.outputs[${index}]`
    const requested = record(value, call, field)
    const amount = uint(requested.satoshis, call, `${field}.satoshis`, 21e14)
    const lockingScript = lower(hex(requested.lockingScript, call, `${field}.lockingScript`))
    if (preserveOutputOrder) {
      const candidate = transaction.outputs[index]
      if (
        candidate == null ||
        candidate.satoshis !== amount ||
        lower(bytesToHex(candidate.lockingScript)) !== lockingScript
      ) {
        invalid(call, `tx.outputs[${index}]`, 'the requested output at the requested position')
      }
      continue
    }
    const key = `${amount}:${lockingScript}`
    const remaining = mapGet(availableOutputs, key) ?? 0
    if (remaining === 0) {
      invalid(call, 'tx.outputs', 'every requested output with its requested amount and script')
    }
    mapSet(availableOutputs, key, remaining - 1)
  }

  validateTransactionValueConservation(transaction, call, sourceEvidence, allowUnresolvedSources)
}

function validateTransactionValueConservation(
  transaction: WalletResultTransaction,
  call: string,
  sourceEvidence: SourceValueEvidence = emptySourceValueEvidence,
  allowUnresolvedSources = false
): void {
  let inputValue = 0
  let hasUnknownValue = false
  const seenOutpoints = new IntrinsicSet<string>()
  for (let index = 0; index < transaction.inputs.length; index++) {
    const input = transaction.inputs[index]
    const outpoint = transactionInputOutpoint(transaction, index, call, `tx.inputs[${index}]`)
    if (setHas(seenOutpoints, outpoint)) {
      invalid(call, `tx.inputs[${index}]`, 'a unique transaction input outpoint')
    }
    setAdd(seenOutpoints, outpoint)
    const sourceSatoshis = input.sourceSatoshis ?? sourceEvidence[outpoint]
    if (sourceSatoshis === undefined) {
      if (!allowUnresolvedSources) {
        invalid(
          call,
          `tx.inputs[${index}].sourceSatoshis`,
          'source transaction evidence for every completed transaction input'
        )
      }
      // A deferred createAction result may historically contain only its
      // subject transaction. Its final createAction/signAction result must
      // supply, or be paired with request evidence for, every source value.
      hasUnknownValue = true
      continue
    }
    inputValue += uint(sourceSatoshis, call, `tx.inputs[${index}].sourceSatoshis`, 21e14)
    if (!intrinsicNumberIsSafeInteger(inputValue) || inputValue > 21e14) {
      invalid(call, 'tx.inputs', 'a valid total input value')
    }
  }
  let outputValue = 0
  for (let index = 0; index < transaction.outputs.length; index++) {
    const output = transaction.outputs[index]
    outputValue += uint(output.satoshis, call, `tx.outputs[${index}].satoshis`, 21e14)
    if (!intrinsicNumberIsSafeInteger(outputValue) || outputValue > 21e14) {
      invalid(call, 'tx.outputs', 'a valid total output value')
    }
  }
  if (!hasUnknownValue && outputValue > inputValue) {
    invalid(call, 'tx.outputs', 'a total value no greater than the transaction inputs')
  }
}

function validateSignActionTransaction(
  transaction: WalletResultTransaction,
  call: string,
  request: unknown
): void {
  const spends = requestRecord(requestRecord(request)?.spends)
  if (spends == null) return
  const spendIndexes = intrinsicObjectKeys(spends)
  for (let entryIndex = 0; entryIndex < spendIndexes.length; entryIndex++) {
    const inputIndexText = spendIndexes[entryIndex]
    const value = spends[inputIndexText]
    const field = `request.spends.${inputIndexText}`
    if (!regexTest(/^(?:0|[1-9]\d*)$/, inputIndexText)) {
      invalid(call, field, 'a canonical input index')
    }
    const inputIndex = numberValue(inputIndexText)
    const input = transaction.inputs[inputIndex]
    if (!intrinsicNumberIsSafeInteger(inputIndex) || input == null) {
      invalid(call, `tx.inputs[${inputIndexText}]`, 'the requested input index')
    }
    const spend = record(value, call, field)
    const unlockingScript = lower(hex(spend.unlockingScript, call, `${field}.unlockingScript`))
    if (lower(bytesToHex(input.unlockingScript)) !== unlockingScript) {
      invalid(call, `tx.inputs[${inputIndex}]`, 'the requested unlocking script')
    }
    if (
      spend.sequenceNumber !== undefined &&
      input.sequence !== uint(spend.sequenceNumber, call, `${field}.sequenceNumber`)
    ) {
      invalid(call, `tx.inputs[${inputIndex}].sequence`, 'the requested input sequence')
    }
  }
}

function validateActionResult(result: UnknownRecord, call: string, request?: unknown): void {
  const sourceEvidence =
    call === 'createAction'
      ? sourceValueEvidenceFromCreateActionRequest(request)
      : emptySourceValueEvidence
  const resultTxid = result.txid === undefined ? undefined : hex(result.txid, call, 'txid', 32)
  const envelope =
    result.tx === undefined ? undefined : actionBeefTransaction(result.tx, call, 'tx', resultTxid)
  const envelopeTxid = envelope?.txid
  if (
    resultTxid !== undefined &&
    envelopeTxid !== undefined &&
    !sameString(resultTxid, envelopeTxid)
  ) {
    invalid(call, 'tx', 'a BEEF transaction matching txid')
  }
  const noSendChange = optionalArray(result.noSendChange, call, 'noSendChange')
  if (noSendChange != null) {
    for (let index = 0; index < noSendChange.length; index++) {
      requireOutpoint(noSendChange[index], call, `noSendChange[${index}]`)
    }
  }
  validateSendWithResults(result.sendWithResults, call)
  let signableTransaction: WalletResultTransaction | undefined
  if (result.signableTransaction !== undefined) {
    if (call !== 'createAction') invalid(call, 'signableTransaction', 'an absent field')
    if (result.txid !== undefined || result.tx !== undefined) {
      invalid(call, 'signableTransaction', 'exclusive of txid and tx')
    }
    const signable = record(result.signableTransaction, call, 'signableTransaction')
    signableTransaction = actionBeefTransaction(signable.tx, call, 'signableTransaction.tx')
    base64(signable.reference, call, 'signableTransaction.reference')
  }
  const actionRequest = requestRecord(request)
  if (actionRequest !== undefined && call === 'createAction') {
    const requestedInputs =
      actionRequest.inputs === undefined
        ? []
        : optionalArray(actionRequest.inputs, call, 'request.inputs')!
    const requestedOutputs =
      actionRequest.outputs === undefined
        ? []
        : optionalArray(actionRequest.outputs, call, 'request.outputs')!
    const requestedOptions = requestRecord(actionRequest.options)
    const sendWith = arrayIsArray(requestedOptions?.sendWith) ? requestedOptions.sendWith : []
    const createsTransaction =
      requestedInputs.length > 0 || requestedOutputs.length > 0 || sendWith.length === 0
    let hasUnsignedRequestedInput = false
    for (let index = 0; index < requestedInputs.length; index++) {
      if (requestRecord(requestedInputs[index])?.unlockingScript === undefined) {
        hasUnsignedRequestedInput = true
        break
      }
    }
    const requiresDeferredSigning =
      createsTransaction &&
      (requestedOptions?.signAndProcess === false || hasUnsignedRequestedInput)
    if (createsTransaction && requiresDeferredSigning && signableTransaction === undefined) {
      invalid(call, 'signableTransaction', 'the requested deferred-signing transaction')
    }
    if (createsTransaction && !requiresDeferredSigning && resultTxid === undefined) {
      invalid(call, 'txid', 'the requested completed transaction')
    }
    if (createsTransaction && !requiresDeferredSigning && signableTransaction !== undefined) {
      invalid(call, 'signableTransaction', 'absent for a completed transaction request')
    }
  }
  if (actionRequest !== undefined && call === 'signAction' && resultTxid === undefined) {
    invalid(call, 'txid', 'the completed signed transaction')
  }
  if (call === 'createAction') {
    if (envelope !== undefined) {
      validateCreateActionTransaction(envelope, call, request, sourceEvidence, false)
    }
    if (signableTransaction !== undefined) {
      validateCreateActionTransaction(signableTransaction, call, request, sourceEvidence, true)
    }
  } else if (envelope !== undefined) {
    validateSignActionTransaction(envelope, call, request)
    validateTransactionValueConservation(envelope, call)
  }
  const signableTxid = signableTransaction?.txid
  const subjectTxid = resultTxid ?? signableTxid
  if (noSendChange != null) {
    if (subjectTxid === undefined) invalid(call, 'noSendChange', 'associated with a transaction')
    for (let index = 0; index < noSendChange.length; index++) {
      const outpoint = noSendChange[index]
      if (!sameString(split(stringValue(outpoint), '.')[0], subjectTxid)) {
        invalid(call, `noSendChange[${index}]`, 'an outpoint of the returned transaction')
      }
    }
  }
  const requestOptions = requestRecord(requestRecord(request)?.options)
  const allowedSendWithTxids = new IntrinsicSet<string>()
  if (subjectTxid !== undefined) setAdd(allowedSendWithTxids, lower(subjectTxid))
  if (arrayIsArray(requestOptions?.sendWith)) {
    for (let index = 0; index < requestOptions.sendWith.length; index++) {
      setAdd(allowedSendWithTxids, lower(stringValue(requestOptions.sendWith[index])))
    }
  }
  if (arrayIsArray(result.sendWithResults)) {
    const seen = new IntrinsicSet<string>()
    for (let index = 0; index < result.sendWithResults.length; index++) {
      const item = result.sendWithResults[index]
      const field = `sendWithResults[${index}].txid`
      const txid = lower(stringValue(record(item, call, `sendWithResults[${index}]`).txid))
      if (setHas(seen, txid)) invalid(call, field, 'a unique transaction')
      setAdd(seen, txid)
      if (setSize(allowedSendWithTxids) > 0 && !setHas(allowedSendWithTxids, txid)) {
        invalid(call, field, 'a submitted or returned transaction')
      }
    }
  }
  if (result.tx !== undefined && result.txid === undefined) invalid(call, 'txid', 'present with tx')
  if (
    requestRecord(request) !== undefined &&
    result.txid !== undefined &&
    result.tx === undefined &&
    requestRecord(requestRecord(request)?.options)?.returnTXIDOnly !== true
  ) {
    invalid(call, 'tx', 'transaction evidence unless returnTXIDOnly was explicitly requested')
  }
  if (call === 'signAction' && result.noSendChange !== undefined) {
    invalid(call, 'noSendChange', 'an absent field')
  }
  if (
    result.txid === undefined &&
    result.signableTransaction === undefined &&
    (!arrayIsArray(result.sendWithResults) || result.sendWithResults.length === 0)
  ) {
    invalid(call, 'outcome', 'a transaction, signable transaction, or batch-send result')
  }
}

function actionBeefTransaction(
  value: unknown,
  call: string,
  field: string,
  expectedTxid?: string
): WalletResultTransaction {
  const encoded = bytes(value, call, field)
  const cached = expectedTxid === undefined ? validatedAtomicTransactions.get(encoded) : undefined
  if (cached != null) return cached
  try {
    const transaction = parseWalletResultAtomicBEEF(encoded)
    if (expectedTxid === undefined) validatedAtomicTransactions.set(encoded, transaction)
    return transaction
  } catch {
    // Legacy producers may emit partial Atomic BEEF, and ordinary BEEF has
    // always been a valid wallet transport. Keep exact framing and subject
    // binding while allowing either representation.
  }
  try {
    return parseWalletResultAtomicBEEF(encoded, true)
  } catch {
    // Continue with an ordinary BEEF envelope.
  }
  try {
    const envelope = parseWalletResultBEEF(encoded)
    const requestedTxid = expectedTxid === undefined ? undefined : lower(expectedTxid)
    let fallbackTxid: string | undefined
    mapForEach(envelope.transactions, (transaction, txid) => {
      if (transaction !== undefined) fallbackTxid = txid
    })
    const selectedTxid =
      (requestedTxid !== undefined && mapGet(envelope.transactions, requestedTxid) !== undefined
        ? requestedTxid
        : undefined) ??
      envelope.atomicTxid ??
      fallbackTxid
    const transaction =
      selectedTxid === undefined ? undefined : mapGet(envelope.transactions, lower(selectedTxid))
    if (transaction === undefined) throw new Error('BEEF subject transaction is missing')
    return transaction
  } catch {
    invalid(call, field, 'a complete, exactly framed BEEF transaction')
  }
}

function beef(value: unknown, call: string, field: string): WalletResultBEEF {
  const encoded = bytes(value, call, field)
  try {
    return parseWalletResultBEEF(encoded)
  } catch {
    invalid(call, field, 'a complete, exactly framed BEEF envelope')
  }
}

function requireOutpoint(
  value: unknown,
  call: string,
  field: string
): { txid: string; outputIndex: number } {
  const outpoint = string(value, call, field)
  const match = regexExec(/^([0-9a-fA-F]{64})\.(0|[1-9]\d*)$/, outpoint)
  if (match == null || numberValue(match[2]) > 0xffffffff) {
    invalid(call, field, 'a canonical transaction outpoint')
  }
  return { txid: lower(match[1]), outputIndex: numberValue(match[2]) }
}

function base64(value: unknown, call: string, field: string): string {
  const encoded = string(value, call, field, 1)
  if (!regexTest(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, encoded)) {
    invalid(call, field, 'a canonical base64 string')
  }
  return encoded
}

function compactSizeLength(value: number): number {
  return value < 253 ? 1 : value <= 0xffff ? 3 : value <= 0xffffffff ? 5 : 9
}

function stringRecord(
  value: unknown,
  call: string,
  field: string,
  encodedValues = false
): UnknownRecord {
  const values = record(value, call, field)
  const keys = intrinsicObjectKeys(values)
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]
    const item = values[key]
    const keyLength = utf8Bytes(key).length
    if (keyLength < 1 || keyLength > 50 || isUnsafeRecordKey(key)) {
      invalid(call, `${field} key`, 'a safe 1–50 byte field name')
    }
    if (encodedValues) base64(item, call, `${field}.${key}`)
    else string(item, call, `${field}.${key}`)
  }
  return values
}

function validateCertificate(value: unknown, call: string, field: string): UnknownRecord {
  const certificate = record(value, call, field)
  try {
    let encodedLength = 0
    const encodedFieldNames = ['type', 'serialNumber'] as const
    for (let index = 0; index < encodedFieldNames.length; index++) {
      const name = encodedFieldNames[index]
      const encoded = base64(certificate[name], call, `${field}.${name}`)
      const decoded = base64ToBytes(encoded)
      if (decoded.length !== 32 || bytesToBase64(decoded) !== encoded) throw new Error()
      encodedLength += decoded.length
    }
    const publicKeyFieldNames = ['subject', 'certifier'] as const
    for (let index = 0; index < publicKeyFieldNames.length; index++) {
      const name = publicKeyFieldNames[index]
      publicKey(certificate[name], call, `${field}.${name}`)
      encodedLength += 33
    }
    const outpoint = string(certificate.revocationOutpoint, call, `${field}.revocationOutpoint`)
    const parts = split(outpoint, '.')
    const outputIndex = parts[1] ?? '0'
    if (
      parts.length > 2 ||
      !regexTest(/^[0-9a-fA-F]{64}$/, parts[0]) ||
      !regexTest(/^(?:0|[1-9]\d*)$/, outputIndex) ||
      numberValue(outputIndex) > 0xffffffff
    ) {
      throw new Error()
    }
    encodedLength += 32 + compactSizeLength(numberValue(outputIndex))
    const fields = stringRecord(certificate.fields, call, `${field}.fields`)
    const names = intrinsicObjectKeys(fields)
    for (let index = 1; index < names.length; index++) {
      const name = names[index]
      let position = index
      while (position > 0 && names[position - 1] > name) {
        names[position] = names[position - 1]
        position--
      }
      names[position] = name
    }
    encodedLength += compactSizeLength(names.length)
    for (let index = 0; index < names.length; index++) {
      const name = names[index]
      const nameBytes = utf8Bytes(name)
      const valueBytes = utf8Bytes(fields[name] as string)
      encodedLength +=
        compactSizeLength(nameBytes.length) +
        nameBytes.length +
        compactSizeLength(valueBytes.length) +
        valueBytes.length
    }
    const signature = hex(certificate.signature, call, `${field}.signature`)
    const signatureBytes = hexToBytes(signature)
    if (!isCanonicalDERSignature(signatureBytes)) throw new Error()
    encodedLength += signatureBytes.length
    if (encodedLength > maxCertificateBytes) throw new Error()
  } catch {
    invalid(call, field, 'a canonical signed wallet certificate')
  }
  return certificate
}

function requestRecord(value: unknown): UnknownRecord | undefined {
  if (value == null || typeof value !== 'object' || arrayIsArray(value)) return undefined
  const source = value as object
  const result = intrinsicObjectCreate(null) as UnknownRecord
  const keys = intrinsicReflectOwnKeys(source)
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]
    const descriptor = intrinsicObjectGetOwnPropertyDescriptor(source, key)
    if (key === createActionSourceEvidence) {
      if (descriptor == null || !('value' in descriptor)) {
        throw new Error('Wallet result request records must contain only data properties')
      }
      intrinsicObjectDefineProperty(result, key, {
        value: descriptor.value,
        enumerable: false,
        configurable: false,
        writable: false
      })
      continue
    }
    if (typeof key !== 'string' || isUnsafeRecordKey(key)) {
      throw new Error('Wallet result request records must contain only safe string keys')
    }
    if (descriptor == null || !('value' in descriptor)) {
      throw new Error('Wallet result request records must contain only data properties')
    }
    result[key] = descriptor.value
  }
  return result
}

function sameString(actual: unknown, expected: unknown): boolean {
  return (
    typeof actual === 'string' && typeof expected === 'string' && lower(actual) === lower(expected)
  )
}

function normalizeIdentitySearch(value: string): string {
  const collapsed = intrinsicApply(intrinsicStringReplace, value, [/\s+/g, ' ']) as string
  return intrinsicApply(intrinsicStringTrim, collapsed, []) as string
}

function foldIdentityText(value: string): string {
  const decomposed = intrinsicApply(intrinsicStringNormalize, value, ['NFD']) as string
  return lower(intrinsicApply(intrinsicStringReplace, decomposed, [/\p{Mn}/gu, '']) as string)
}

function containsText(haystack: string, needle: string): boolean {
  return (intrinsicApply(intrinsicStringIndexOf, haystack, [needle]) as number) !== -1
}

/** Mirrors the identity overlay's fuzzy attribute regex (tokens in order, case-insensitive). */
function identityFuzzyMatches(actual: string, expected: string): boolean {
  const tokens = split(normalizeIdentitySearch(expected), ' ')
  let pattern = ''
  for (let index = 0; index < tokens.length; index++) {
    if (index > 0) pattern += '.*'
    pattern += intrinsicApply(intrinsicStringReplace, tokens[index], [/[.*+?^${}()|[\]\\]/g, '\\$&']) as string
  }
  return regexTest(new IntrinsicRegExp(pattern, 'i'), actual)
}

/**
 * Mirrors MongoDB `$text` over the overlay's searchable attributes: every quoted phrase
 * must appear, no `-term` may appear, and otherwise one term must appear. Word stemming
 * is not reproduced.
 */
function identityTextMatches(searchable: string, search: string): boolean {
  const text = foldIdentityText(searchable)
  const query = foldIdentityText(search)
  const phrasePattern = /"([^"]*)"/g
  const phrases: string[] = []
  let match = regexExec(phrasePattern, query)
  while (match != null) {
    const phrase = normalizeIdentitySearch(match[1])
    if (phrase.length > 0) phrases[phrases.length] = phrase
    match = regexExec(phrasePattern, query)
  }
  const words = split(
    normalizeIdentitySearch(intrinsicApply(intrinsicStringReplace, query, [/"[^"]*"/g, ' ']) as string),
    ' '
  )
  let anyTerm = false
  for (let index = 0; index < words.length; index++) {
    const word = words[index]
    if (word.length === 0) continue
    if (word[0] === '-') {
      if (word.length > 1 && containsText(text, intrinsicApply(intrinsicStringSlice, word, [1]) as string)) {
        return false
      }
    } else if (containsText(text, word)) {
      anyTerm = true
    }
  }
  if (phrases.length > 0) {
    for (let index = 0; index < phrases.length; index++) {
      if (!containsText(text, phrases[index])) return false
    }
    return true
  }
  return anyTerm
}

/** The overlay excludes these fields from its all-fields `any` index. */
function isSearchableIdentityField(fieldName: string): boolean {
  return fieldName !== 'profilePhoto' && fieldName !== 'icon'
}

/** `any` is the overlay's all-fields search, not a field name. */
function identityAnyMatches(decryptedFields: Record<string, string>, expected: unknown): boolean {
  if (typeof expected !== 'string') return false
  const normalized = normalizeIdentitySearch(expected)
  if (normalized.length < 2) return false
  const fieldNames = intrinsicObjectKeys(decryptedFields)
  let searchable = ''
  for (let index = 0; index < fieldNames.length; index++) {
    if (!isSearchableIdentityField(fieldNames[index])) continue
    if (searchable.length > 0) searchable += ' '
    searchable += decryptedFields[fieldNames[index]]
  }
  if (normalized.length === 2) return identityFuzzyMatches(searchable, normalized)
  return identityTextMatches(searchable, normalized)
}

/** The overlay matches userName exactly and every other named field fuzzily. */
function sameIdentityAttribute(fieldName: string, actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string') return false
  if (fieldName === 'userName') return actual === normalizeIdentitySearch(expected)
  return identityFuzzyMatches(actual, expected)
}

function sameOutpoint(actual: unknown, expected: unknown, call: string, field: string): boolean {
  const actualOutpoint = requireOutpoint(actual, call, field)
  const expectedOutpoint = requireOutpoint(expected, call, `request.${field}`)
  return (
    actualOutpoint.txid === expectedOutpoint.txid &&
    actualOutpoint.outputIndex === expectedOutpoint.outputIndex
  )
}

function sameStringRecord(actual: unknown, expected: unknown): boolean {
  const actualRecord = requestRecord(actual)
  const expectedRecord = requestRecord(expected)
  if (actualRecord == null || expectedRecord == null) return false
  const actualKeys = intrinsicObjectKeys(actualRecord)
  const expectedKeys = intrinsicObjectKeys(expectedRecord)
  if (actualKeys.length !== expectedKeys.length) return false
  for (let index = 0; index < expectedKeys.length; index++) {
    const key = expectedKeys[index]
    if (!hasOwn(actualRecord, key) || actualRecord[key] !== expectedRecord[key]) {
      return false
    }
  }
  return true
}

function bindCertificateToPartialRequest(
  certificate: UnknownRecord,
  request: unknown,
  call: string,
  field: string
): void {
  const expected = requestRecord(request)
  if (expected == null) return
  const exactFieldNames = ['type', 'serialNumber'] as const
  for (let index = 0; index < exactFieldNames.length; index++) {
    const key = exactFieldNames[index]
    if (expected[key] !== undefined && certificate[key] !== expected[key]) {
      invalid(call, `${field}.${key}`, `the requested certificate ${key}`)
    }
  }
  const identityFieldNames = ['subject', 'certifier', 'signature'] as const
  for (let index = 0; index < identityFieldNames.length; index++) {
    const key = identityFieldNames[index]
    if (expected[key] !== undefined && !sameString(certificate[key], expected[key])) {
      invalid(call, `${field}.${key}`, `the requested certificate ${key}`)
    }
  }
  if (
    expected.revocationOutpoint !== undefined &&
    !sameOutpoint(
      certificate.revocationOutpoint,
      expected.revocationOutpoint,
      call,
      `${field}.revocationOutpoint`
    )
  ) {
    invalid(call, `${field}.revocationOutpoint`, 'the requested certificate revocation outpoint')
  }
  if (expected.fields !== undefined && !sameStringRecord(certificate.fields, expected.fields)) {
    invalid(call, `${field}.fields`, 'the requested certificate fields')
  }
}

function validateCertificatesResult(result: UnknownRecord, call: string, request?: unknown): void {
  const certificates = validateListResult(
    result,
    call,
    'totalCertificates',
    'certificates',
    request
  )
  const requestArgs = requestRecord(request)
  let requestedCertifiers: Set<string> | undefined
  if (call === 'listCertificates' && arrayIsArray(requestArgs?.certifiers)) {
    requestedCertifiers = new IntrinsicSet<string>()
    for (let index = 0; index < requestArgs.certifiers.length; index++) {
      setAdd(requestedCertifiers, lower(stringValue(requestArgs.certifiers[index])))
    }
  }
  let requestedTypes: Set<string> | undefined
  if (call === 'listCertificates' && arrayIsArray(requestArgs?.types)) {
    requestedTypes = new IntrinsicSet<string>()
    for (let index = 0; index < requestArgs.types.length; index++) {
      setAdd(requestedTypes, stringValue(requestArgs.types[index]))
    }
  }
  for (let index = 0; index < certificates.length; index++) {
    const value = certificates[index]
    const field = `certificates[${index}]`
    const certificate = validateCertificate(value, call, field)
    if (requestedCertifiers != null && setSize(requestedCertifiers) > 0) {
      if (!setHas(requestedCertifiers, lower(stringValue(certificate.certifier)))) {
        invalid(call, `${field}.certifier`, 'one of the requested certifiers')
      }
    }
    if (requestedTypes != null && setSize(requestedTypes) > 0) {
      if (!setHas(requestedTypes, stringValue(certificate.type))) {
        invalid(call, `${field}.type`, 'one of the requested types')
      }
    }
    if (
      call === 'discoverByIdentityKey' &&
      requestArgs?.identityKey !== undefined &&
      !sameString(certificate.subject, requestArgs.identityKey)
    ) {
      invalid(call, `${field}.subject`, 'the requested identity key')
    }
    if (certificate.keyring !== undefined) {
      stringRecord(certificate.keyring, call, `${field}.keyring`, true)
    }
    if (certificate.verifier !== undefined) {
      publicKey(certificate.verifier, call, `${field}.verifier`)
    }
    if (call === 'discoverByIdentityKey' || call === 'discoverByAttributes') {
      const infoField = `${field}.certifierInfo`
      const info = record(certificate.certifierInfo, call, infoField)
      string(info.name, call, `${infoField}.name`, 1, 100)
      httpUrl(info.iconUrl, call, `${infoField}.iconUrl`, 500)
      string(info.description, call, `${infoField}.description`, 5, 50)
      rangedInteger(info.trust, call, `${infoField}.trust`, 1, 10)
      stringRecord(
        certificate.publiclyRevealedKeyring,
        call,
        `${field}.publiclyRevealedKeyring`,
        true
      )
      const decryptedFields = stringRecord(
        certificate.decryptedFields,
        call,
        `${field}.decryptedFields`
      )
      if (call === 'discoverByAttributes') {
        const requestedAttributes = requestRecord(requestArgs?.attributes)
        if (requestedAttributes != null) {
          if (hasOwn(requestedAttributes, 'any')) {
            if (!identityAnyMatches(decryptedFields, requestedAttributes.any)) {
              invalid(call, `${field}.decryptedFields`, 'a match for the requested any attribute')
            }
          } else {
            // The overlay ignores blank named attributes; with none usable it matches nothing.
            const fieldNames = intrinsicObjectKeys(requestedAttributes)
            let usable = 0
            for (let index = 0; index < fieldNames.length; index++) {
              const fieldName = fieldNames[index]
              const expectedValue = requestedAttributes[fieldName]
              if (typeof expectedValue !== 'string') {
                invalid(call, `request.attributes.${fieldName}`, 'a string')
              }
              if (normalizeIdentitySearch(expectedValue).length === 0) continue
              usable++
              if (!sameIdentityAttribute(fieldName, decryptedFields[fieldName], expectedValue)) {
                invalid(
                  call,
                  `${field}.decryptedFields.${fieldName}`,
                  'the requested public attribute'
                )
              }
            }
            if (usable === 0) invalid(call, `${field}.decryptedFields`, 'a usable requested attribute')
          }
        }
      }
    }
  }
}

function validateListResult(
  result: UnknownRecord,
  call: string,
  totalField: string,
  entriesField: string,
  request?: unknown
): unknown[] {
  const total = uint(result[totalField], call, totalField, intrinsicNumberMaxSafeInteger)
  const entries = optionalArray(result[entriesField], call, entriesField)
  if (entries == null) invalid(call, entriesField, 'an array')
  if (entries.length > total) invalid(call, totalField, `at least ${entries.length}`)
  const requestArgs = requestRecord(request)
  if (requestArgs != null) {
    const requestedLimit =
      requestArgs.limit === undefined ? 10 : uint(requestArgs.limit, call, 'limit', 10000)
    if (entries.length > requestedLimit) {
      invalid(call, entriesField, `at most the requested limit of ${requestedLimit}`)
    }
  }
  return entries
}

// Stored history may lack display metadata, particularly wallet-generated change.
// Keep creation-request requirements and nonempty result bounds unchanged.
function historyDescription(value: unknown, call: string, field: string): void {
  string(value, call, field, value === '' ? 0 : 5, 2000)
}

function validateListActions(result: UnknownRecord, call: string, request?: unknown): void {
  const actions = validateListResult(result, call, 'totalActions', 'actions', request)
  const requestArgs = requestRecord(request)
  const requestedLabels: string[] = []
  if (arrayIsArray(requestArgs?.labels)) {
    for (let index = 0; index < requestArgs.labels.length; index++) {
      requestedLabels[index] = stringValue(requestArgs.labels[index])
    }
  }
  const requestedLabelMode = requestArgs?.labelQueryMode === 'all' ? 'all' : 'any'
  for (let index = 0; index < actions.length; index++) {
    const item = actions[index]
    const field = `actions[${index}]`
    const action = record(item, call, field)
    hex(action.txid, call, `${field}.txid`, 32)
    rangedInteger(action.satoshis, call, `${field}.satoshis`, -21e14, 21e14)
    if (!setHas(actionStatuses, action.status as string)) {
      invalid(call, `${field}.status`, 'a supported action status')
    }
    if (typeof action.isOutgoing !== 'boolean') {
      invalid(call, `${field}.isOutgoing`, 'a boolean')
    }
    historyDescription(action.description, call, `${field}.description`)
    stringArray(action.labels, call, `${field}.labels`, 1, 300)
    if (requestArgs?.includeLabels === true && action.labels === undefined) {
      invalid(call, `${field}.labels`, 'the explicitly requested labels')
    }
    if (requestedLabels.length > 0 && arrayIsArray(action.labels)) {
      const actionLabels = new IntrinsicSet<unknown>()
      for (let labelIndex = 0; labelIndex < action.labels.length; labelIndex++) {
        setAdd(actionLabels, action.labels[labelIndex])
      }
      let matches = requestedLabelMode === 'all'
      for (let labelIndex = 0; labelIndex < requestedLabels.length; labelIndex++) {
        const present = setHas(actionLabels, requestedLabels[labelIndex])
        if (requestedLabelMode === 'all' && !present) {
          matches = false
          break
        }
        if (requestedLabelMode === 'any' && present) {
          matches = true
          break
        }
      }
      if (!matches) invalid(call, `${field}.labels`, 'the requested label query')
    }
    uint(action.version, call, `${field}.version`)
    uint(action.lockTime, call, `${field}.lockTime`)
    const inputs = optionalArray(action.inputs, call, `${field}.inputs`)
    if (
      (requestArgs?.includeInputs === true ||
        requestArgs?.includeInputSourceLockingScripts === true ||
        requestArgs?.includeInputUnlockingScripts === true) &&
      inputs === undefined
    ) {
      invalid(call, `${field}.inputs`, 'the explicitly requested inputs')
    }
    if (inputs != null) {
      for (let inputIndex = 0; inputIndex < inputs.length; inputIndex++) {
        const item = inputs[inputIndex]
        const inputField = `${field}.inputs[${inputIndex}]`
        const input = record(item, call, inputField)
        requireOutpoint(input.sourceOutpoint, call, `${inputField}.sourceOutpoint`)
        uint(input.sourceSatoshis, call, `${inputField}.sourceSatoshis`, 21e14)
        if (input.sourceLockingScript !== undefined) {
          hex(input.sourceLockingScript, call, `${inputField}.sourceLockingScript`)
        }
        if (input.unlockingScript !== undefined) {
          hex(input.unlockingScript, call, `${inputField}.unlockingScript`)
        }
        if (
          requestArgs?.includeInputSourceLockingScripts === true &&
          input.sourceLockingScript === undefined
        ) {
          invalid(
            call,
            `${inputField}.sourceLockingScript`,
            'the explicitly requested source locking script'
          )
        }
        if (
          requestArgs?.includeInputUnlockingScripts === true &&
          input.unlockingScript === undefined
        ) {
          invalid(
            call,
            `${inputField}.unlockingScript`,
            'the explicitly requested unlocking script'
          )
        }
        historyDescription(input.inputDescription, call, `${inputField}.inputDescription`)
        uint(input.sequenceNumber, call, `${inputField}.sequenceNumber`)
      }
    }
    const outputs = optionalArray(action.outputs, call, `${field}.outputs`)
    if (
      (requestArgs?.includeOutputs === true || requestArgs?.includeOutputLockingScripts === true) &&
      outputs === undefined
    ) {
      invalid(call, `${field}.outputs`, 'the explicitly requested outputs')
    }
    if (outputs != null) {
      for (let outputIndex = 0; outputIndex < outputs.length; outputIndex++) {
        const item = outputs[outputIndex]
        const outputField = `${field}.outputs[${outputIndex}]`
        const output = record(item, call, outputField)
        uint(output.satoshis, call, `${outputField}.satoshis`, 21e14)
        if (output.lockingScript !== undefined) {
          hex(output.lockingScript, call, `${outputField}.lockingScript`)
        }
        if (
          requestArgs?.includeOutputLockingScripts === true &&
          output.lockingScript === undefined
        ) {
          invalid(
            call,
            `${outputField}.lockingScript`,
            'the explicitly requested output locking script'
          )
        }
        boolean(output, call, 'spendable')
        if (output.customInstructions !== undefined) {
          string(output.customInstructions, call, `${outputField}.customInstructions`)
        }
        stringArray(output.tags, call, `${outputField}.tags`, 1, 300)
        uint(output.outputIndex, call, `${outputField}.outputIndex`)
        historyDescription(output.outputDescription, call, `${outputField}.outputDescription`)
        string(output.basket, call, `${outputField}.basket`, 0, 300)
      }
    }
  }
}

function validateListOutputs(result: UnknownRecord, call: string, request?: unknown): void {
  const outputs = validateListResult(result, call, 'totalOutputs', 'outputs', request)
  const parsedBeef = result.BEEF === undefined ? undefined : beef(result.BEEF, call, 'BEEF')
  const requestArgs = requestRecord(request)
  const requestedTags: string[] = []
  if (arrayIsArray(requestArgs?.tags)) {
    for (let index = 0; index < requestArgs.tags.length; index++) {
      requestedTags[index] = stringValue(requestArgs.tags[index])
    }
  }
  const requestedTagMode = requestArgs?.tagQueryMode === 'all' ? 'all' : 'any'
  if (outputs.length > 0 && requestArgs?.include === 'entire transactions' && parsedBeef == null) {
    invalid(call, 'BEEF', 'the requested complete output transactions')
  }
  const seenOutpoints = new IntrinsicSet<string>()
  for (let index = 0; index < outputs.length; index++) {
    const item = outputs[index]
    const field = `outputs[${index}]`
    const output = record(item, call, field)
    const outpoint = requireOutpoint(output.outpoint, call, `${field}.outpoint`)
    const outpointKey = `${outpoint.txid}.${outpoint.outputIndex}`
    if (setHas(seenOutpoints, outpointKey)) {
      invalid(call, `${field}.outpoint`, 'a unique output in the result page')
    }
    setAdd(seenOutpoints, outpointKey)
    const satoshis = uint(output.satoshis, call, `${field}.satoshis`, 21e14)
    if (typeof output.spendable !== 'boolean') {
      invalid(call, `${field}.spendable`, 'a boolean')
    }
    const lockingScript =
      output.lockingScript === undefined
        ? undefined
        : hex(output.lockingScript, call, `${field}.lockingScript`)
    if (requestArgs?.include === 'locking scripts' && lockingScript === undefined) {
      invalid(call, `${field}.lockingScript`, 'the requested locking script')
    }
    if (parsedBeef != null) {
      const transaction = mapGet(parsedBeef.transactions, outpoint.txid)
      const transactionOutput = transaction?.outputs[outpoint.outputIndex]
      if (transactionOutput == null) {
        invalid(call, `${field}.outpoint`, 'an output contained in BEEF')
      }
      if (transactionOutput.satoshis !== satoshis) {
        invalid(call, `${field}.satoshis`, 'the amount committed by BEEF')
      }
      if (
        lockingScript !== undefined &&
        lower(bytesToHex(transactionOutput.lockingScript)) !== lower(lockingScript)
      ) {
        invalid(call, `${field}.lockingScript`, 'the script committed by BEEF')
      }
    }
    if (output.customInstructions !== undefined) {
      string(output.customInstructions, call, `${field}.customInstructions`)
    }
    stringArray(output.tags, call, `${field}.tags`, 1, 300)
    stringArray(output.labels, call, `${field}.labels`, 1, 300)
    if (requestArgs?.includeTags === true && output.tags === undefined) {
      invalid(call, `${field}.tags`, 'the explicitly requested output tags')
    }
    if (requestArgs?.includeLabels === true && output.labels === undefined) {
      invalid(call, `${field}.labels`, 'the explicitly requested transaction labels')
    }
    if (requestedTags.length > 0 && arrayIsArray(output.tags)) {
      const outputTags = new IntrinsicSet<unknown>()
      for (let tagIndex = 0; tagIndex < output.tags.length; tagIndex++) {
        setAdd(outputTags, output.tags[tagIndex])
      }
      let matches = requestedTagMode === 'all'
      for (let tagIndex = 0; tagIndex < requestedTags.length; tagIndex++) {
        const present = setHas(outputTags, requestedTags[tagIndex])
        if (requestedTagMode === 'all' && !present) {
          matches = false
          break
        }
        if (requestedTagMode === 'any' && present) {
          matches = true
          break
        }
      }
      if (!matches) invalid(call, `${field}.tags`, 'the requested tag query')
    }
  }
}

function validateKeyLinkage(result: UnknownRecord, call: string): void {
  const keyFields = ['prover', 'verifier', 'counterparty'] as const
  for (let index = 0; index < keyFields.length; index++) {
    const field = keyFields[index]
    publicKey(result[field], call, field)
  }
  bytes(result.encryptedLinkage, call, 'encryptedLinkage')
  bytes(result.encryptedLinkageProof, call, 'encryptedLinkageProof')
}

/**
 * Validate values crossing a wallet substrate boundary before application code
 * treats them as authorization, cryptographic, identity, or financial facts.
 */
export function validateWalletResult<T>(call: CallType, value: T, request?: unknown): T {
  const ownedValue = snapshotSafeObjectGraph(value, call) as T
  const result = record(ownedValue, call)
  const requestArgs = requestRecord(request)

  switch (call) {
    case 'createAction':
    case 'signAction':
      validateActionResult(result, call, request)
      break
    case 'abortAction':
      boolean(result, call, 'aborted')
      break
    case 'internalizeAction':
      affirmative(result, call, 'accepted')
      break
    case 'relinquishOutput':
    case 'relinquishCertificate':
      affirmative(result, call, 'relinquished')
      break
    case 'verifyHmac':
    case 'verifySignature':
      affirmative(result, call, 'valid')
      break
    case 'isAuthenticated':
    case 'waitForAuthentication':
      affirmative(result, call, 'authenticated')
      break
    case 'getPublicKey':
      publicKey(result.publicKey, call, 'publicKey')
      break
    case 'encrypt':
      bytes(result.ciphertext, call, 'ciphertext')
      break
    case 'decrypt':
      bytes(result.plaintext, call, 'plaintext')
      break
    case 'createHmac':
      bytes(result.hmac, call, 'hmac', 32)
      break
    case 'createSignature': {
      const encoded = bytes(result.signature, call, 'signature', undefined, 72)
      if (!isCanonicalDERSignature(encoded)) {
        invalid(call, 'signature', 'a canonical DER-encoded ECDSA signature')
      }
      break
    }
    case 'revealCounterpartyKeyLinkage':
      validateKeyLinkage(result, call)
      isoTimestamp(result.revelationTime, call, 'revelationTime')
      if (
        requestArgs?.verifier !== undefined &&
        !sameString(result.verifier, requestArgs?.verifier)
      ) {
        invalid(call, 'verifier', 'the requested verifier')
      }
      if (
        requestArgs?.counterparty !== undefined &&
        !sameString(result.counterparty, requestArgs?.counterparty)
      ) {
        invalid(call, 'counterparty', 'the requested counterparty')
      }
      break
    case 'revealSpecificKeyLinkage':
      validateKeyLinkage(result, call)
      if (!arrayIsArray(result.protocolID) || result.protocolID.length !== 2) {
        invalid(call, 'protocolID', 'a [securityLevel, protocolName] tuple')
      }
      uint(result.protocolID[0], call, 'protocolID[0]', 2)
      string(result.protocolID[1], call, 'protocolID[1]', 5, 400)
      string(result.keyID, call, 'keyID', 1, 800)
      uint(result.proofType, call, 'proofType', 255)
      if (
        requestArgs?.verifier !== undefined &&
        !sameString(result.verifier, requestArgs?.verifier)
      ) {
        invalid(call, 'verifier', 'the requested verifier')
      }
      if (requestArgs?.counterparty === 'self') {
        if (!sameString(result.counterparty, result.prover)) {
          invalid(call, 'counterparty', "the prover's identity key for counterparty self")
        }
      } else if (requestArgs?.counterparty === 'anyone') {
        if (!sameString(result.counterparty, anyonePublicKey)) {
          invalid(call, 'counterparty', 'the canonical anyone public key')
        }
      } else if (
        typeof requestArgs?.counterparty === 'string' &&
        !sameString(result.counterparty, requestArgs.counterparty)
      ) {
        invalid(call, 'counterparty', 'the requested counterparty')
      }
      if (
        arrayIsArray(requestArgs?.protocolID) &&
        (result.protocolID[0] !== requestArgs.protocolID[0] ||
          result.protocolID[1] !== requestArgs.protocolID[1])
      ) {
        invalid(call, 'protocolID', 'the requested protocol')
      }
      if (requestArgs?.keyID !== undefined && result.keyID !== requestArgs?.keyID) {
        invalid(call, 'keyID', 'the requested key ID')
      }
      break
    case 'listActions':
      validateListActions(result, call, request)
      break
    case 'listOutputs':
      validateListOutputs(result, call, request)
      break
    case 'listCertificates':
    case 'discoverByIdentityKey':
    case 'discoverByAttributes':
      validateCertificatesResult(result, call, request)
      break
    case 'getHeight':
      rangedInteger(result.height, call, 'height', 1, 0xffffffff)
      break
    case 'getHeaderForHeight':
      hex(result.header, call, 'header', 80)
      break
    case 'getNetwork':
      if (result.network !== 'mainnet' && result.network !== 'testnet') {
        invalid(call, 'network', 'mainnet or testnet')
      }
      break
    case 'getVersion':
      string(result.version, call, 'version', 7, 30)
      break
    case 'acquireCertificate':
      validateCertificate(result, call, 'certificate')
      if (requestArgs?.type !== undefined && result.type !== requestArgs?.type) {
        invalid(call, 'certificate.type', 'the requested certificate type')
      }
      if (
        requestArgs?.certifier !== undefined &&
        !sameString(result.certifier, requestArgs?.certifier)
      ) {
        invalid(call, 'certificate.certifier', 'the requested certifier')
      }
      // Both direct and issuance requests carry caller-authorized fields.
      // Bind every field present on the request while allowing the issuer to
      // supply fields (serial, signature, revocation outpoint) that were not.
      bindCertificateToPartialRequest(result, requestArgs, call, 'certificate')
      break
    case 'proveCertificate':
      {
        const keyring = stringRecord(result.keyringForVerifier, call, 'keyringForVerifier', true)
        const requestedFields = arrayIsArray(requestArgs?.fieldsToReveal)
          ? (requestArgs.fieldsToReveal as unknown[])
          : []
        const expected = new IntrinsicSet<string>()
        for (let index = 0; index < requestedFields.length; index++) {
          setAdd(expected, stringValue(requestedFields[index]))
        }
        const actual = intrinsicObjectKeys(keyring)
        let fieldsMatch = actual.length === setSize(expected)
        for (let index = 0; fieldsMatch && index < actual.length; index++) {
          fieldsMatch = setHas(expected, actual[index])
        }
        if (!fieldsMatch) {
          invalid(call, 'keyringForVerifier', 'exactly the requested certificate fields')
        }
      }
      if (result.certificate !== undefined) {
        const certificate = validateCertificate(result.certificate, call, 'certificate')
        bindCertificateToPartialRequest(certificate, requestArgs?.certificate, call, 'certificate')
      }
      if (result.verifier !== undefined) publicKey(result.verifier, call, 'verifier')
      if (
        result.verifier !== undefined &&
        requestArgs?.verifier !== undefined &&
        !sameString(result.verifier, requestArgs?.verifier)
      ) {
        invalid(call, 'verifier', 'the requested verifier')
      }
      break
  }

  return ownedValue
}
