import { AuthPayload } from '../auth-methods/AuthMethod'
import { BigNumber, Utils } from '@bsv/sdk'

const HEX_256 = /^[0-9a-fA-F]{64}$/
const AUTH_METHOD_TYPE = /^[a-zA-Z0-9_-]{1,64}$/
const BASE58_FIELD = /^[1-9A-HJ-NP-Za-km-z]{1,64}$/
const INTEGRITY_TAG = /^[0-9a-f]{8}$/
const UMP_OUTPOINT = /^[0-9a-fA-F]{64}\.(?:0|[1-9]\d*)$/
const MAX_REQUEST_DEPTH = 64
const MAX_REQUEST_NODES = 100_000
const INVALID_REQUEST_VALUE = Symbol('invalid request value')

type RequestValue = null | boolean | number | string | RequestValue[] | RequestRecord
type RequestRecord = { [key: string]: RequestValue }

interface RequestSnapshotState {
  nodes: number
  ancestors: WeakSet<object>
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function isAuthPayload(value: unknown): value is AuthPayload {
  return isRecord(value)
}

export function isAuthMethodType(value: unknown): value is string {
  return typeof value === 'string' && AUTH_METHOD_TYPE.test(value)
}

export function isHexIdentifier(value: unknown): value is string {
  return typeof value === 'string' && HEX_256.test(value)
}

export function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export function isUMPOutpoint(value: unknown): value is string {
  if (typeof value !== 'string' || !UMP_OUTPOINT.test(value)) return false
  const outputIndex = Number(value.slice(value.lastIndexOf('.') + 1))
  return Number.isSafeInteger(outputIndex) && outputIndex >= 0 && outputIndex <= 0xffffffff
}

/**
 * Snapshot a parsed JSON request before validation or authorization reads it.
 * Only enumerable own data properties are copied, so inherited values and
 * accessors cannot provide security-sensitive fields. Records are recreated
 * without a prototype and nested values are snapshotted recursively.
 */
export function snapshotRequestBody(value: unknown): Record<string, unknown> | undefined {
  try {
    const snapshot = snapshotRequestValue(value, 0, {
      nodes: 0,
      ancestors: new WeakSet<object>()
    })
    return snapshot === INVALID_REQUEST_VALUE || !isRecord(snapshot) ? undefined : snapshot
  } catch {
    // Exotic objects (for example, throwing proxies) are not valid parsed JSON.
    return undefined
  }
}

/**
 * Snapshot the demo request before translating the legacy phone-method alias.
 * This keeps inherited or accessor-backed methodType values from being copied
 * into an own property that downstream request validation would trust.
 */
export function snapshotDemoRequestBody(value: unknown): Record<string, unknown> | undefined {
  const body = snapshotRequestBody(value)
  if (body == null) return undefined
  if (body.methodType === 'TwilioPhone') body.methodType = 'DemoPhone'
  return body
}

function snapshotRequestValue(
  value: unknown,
  depth: number,
  state: RequestSnapshotState
): RequestValue | typeof INVALID_REQUEST_VALUE {
  if (depth > MAX_REQUEST_DEPTH || ++state.nodes > MAX_REQUEST_NODES) {
    return INVALID_REQUEST_VALUE
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : INVALID_REQUEST_VALUE
  if (typeof value !== 'object') return INVALID_REQUEST_VALUE
  if (state.ancestors.has(value)) return INVALID_REQUEST_VALUE

  state.ancestors.add(value)
  const snapshot = Array.isArray(value)
    ? snapshotRequestArray(value, depth, state)
    : snapshotRequestRecord(value, depth, state)
  state.ancestors.delete(value)
  return snapshot
}

function snapshotRequestArray(
  value: unknown[],
  depth: number,
  state: RequestSnapshotState
): RequestValue[] | typeof INVALID_REQUEST_VALUE {
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Reflect.ownKeys(descriptors)
  if (keys.some(key => typeof key !== 'string')) return INVALID_REQUEST_VALUE

  const lengthDescriptor = ownDataDescriptor(descriptors, 'length')
  const length = lengthDescriptor?.value
  if (
    lengthDescriptor == null ||
    lengthDescriptor.enumerable ||
    !Number.isSafeInteger(length) ||
    (length as number) < 0 ||
    (length as number) > MAX_REQUEST_NODES ||
    keys.length !== (length as number) + 1
  ) {
    return INVALID_REQUEST_VALUE
  }

  const snapshot = Array.from({ length: length as number }, () => null as RequestValue)
  for (let index = 0; index < snapshot.length; index++) {
    const descriptor = ownDataDescriptor(descriptors, String(index))
    if (descriptor == null || !descriptor.enumerable) return INVALID_REQUEST_VALUE
    const item = snapshotRequestValue(descriptor.value, depth + 1, state)
    if (item === INVALID_REQUEST_VALUE) return item
    Object.defineProperty(snapshot, String(index), {
      value: item,
      enumerable: true,
      configurable: true,
      writable: true
    })
  }
  return snapshot
}

function snapshotRequestRecord(
  value: object,
  depth: number,
  state: RequestSnapshotState
): RequestRecord | typeof INVALID_REQUEST_VALUE {
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return INVALID_REQUEST_VALUE

  const descriptors = Object.getOwnPropertyDescriptors(value)
  const snapshot: RequestRecord = Object.create(null) as RequestRecord
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') return INVALID_REQUEST_VALUE
    const descriptor = ownDataDescriptor(descriptors, key)
    if (descriptor == null || !descriptor.enumerable) return INVALID_REQUEST_VALUE
    const propertyValue = snapshotRequestValue(descriptor.value, depth + 1, state)
    if (propertyValue === INVALID_REQUEST_VALUE) return propertyValue
    Object.defineProperty(snapshot, key, {
      value: propertyValue,
      enumerable: true,
      configurable: true,
      writable: true
    })
  }
  return snapshot
}

function ownDataDescriptor(
  descriptors: object,
  key: PropertyKey
): { value: unknown; enumerable: boolean } | undefined {
  const descriptorContainer = Object.getOwnPropertyDescriptor(descriptors, key)
  if (descriptorContainer == null || !('value' in descriptorContainer)) return undefined
  const descriptor = descriptorContainer.value as PropertyDescriptor
  const valueDescriptor = Object.getOwnPropertyDescriptor(descriptor, 'value')
  const enumerableDescriptor = Object.getOwnPropertyDescriptor(descriptor, 'enumerable')
  if (
    valueDescriptor == null ||
    !('value' in valueDescriptor) ||
    enumerableDescriptor == null ||
    !('value' in enumerableDescriptor)
  ) {
    return undefined
  }
  return {
    value: valueDescriptor.value,
    enumerable: enumerableDescriptor.value === true
  }
}

/**
 * Validate the SDK KeyShares backup representation without parsing attacker
 * input into large numeric objects. The SDK performs full integrity validation
 * when shares are recombined; WAB only needs a bounded storage contract.
 */
export function isShamirShare(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 256) return false
  const [x, y, thresholdText, integrity, extra] = value.split('.')
  if (
    extra !== undefined ||
    x === undefined ||
    y === undefined ||
    thresholdText === undefined ||
    integrity === undefined
  ) {
    return false
  }
  if (!isCanonicalBase58Field(x) || !isCanonicalBase58Field(y)) return false
  if (!/^(?:[2-9]|[1-9]\d|1\d\d|2[0-4]\d|25[0-5])$/.test(thresholdText)) return false
  const threshold = Number.parseInt(thresholdText, 10)
  return threshold >= 2 && threshold <= 255 && INTEGRITY_TAG.test(integrity)
}

function isCanonicalBase58Field(value: string): boolean {
  if (!BASE58_FIELD.test(value)) return false
  try {
    return Utils.toBase58(new BigNumber(Utils.fromBase58(value)).toArray()) === value
  } catch {
    return false
  }
}
