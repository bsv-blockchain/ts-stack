import { LCH_LIMITS } from './constants.js'
import { lchAssert } from './errors.js'
import type { LCHValue, SignedObject } from './types.js'

interface SnapshotBudget {
  entries: number
  bytes: number
  maxBytes: number
  seen: WeakSet<object>
}

function dataDescriptor(value: object, key: PropertyKey, name: string): PropertyDescriptor {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  lchAssert(
    descriptor !== undefined && 'value' in descriptor,
    'ERR_LCH_FRAMING',
    `${name} must be an own data property`
  )
  return descriptor
}

/** Read a configuration or adapter field without consulting its prototype. */
export function ownDataValue(value: unknown, key: PropertyKey, name: string): unknown {
  lchAssert(
    value !== null && typeof value === 'object',
    'ERR_LCH_FRAMING',
    `${name} must be an object`
  )
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (descriptor === undefined) return undefined
  lchAssert('value' in descriptor, 'ERR_LCH_FRAMING', `${name}.${String(key)} must be data`)
  return descriptor.value
}

/** Require an own adapter/result field and return it without invoking accessors. */
export function requiredOwnDataValue(value: unknown, key: PropertyKey, name: string): unknown {
  lchAssert(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'ERR_LCH_FRAMING',
    `${name} must be an object`
  )
  return dataDescriptor(value, key, `${name}.${String(key)}`).value
}

function snapshotArray(
  value: LCHValue[],
  depth: number,
  budget: SnapshotBudget,
  name: string
): LCHValue[] {
  lchAssert(
    Object.getPrototypeOf(value) === Array.prototype &&
      Object.getOwnPropertySymbols(value).length === 0 &&
      Object.keys(value).length === value.length,
    'ERR_LCH_FRAMING',
    `${name} must be a dense ordinary array`
  )
  const result: LCHValue[] = []
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = dataDescriptor(value, String(index), `${name}[${index}]`)
    lchAssert(descriptor.enumerable === true, 'ERR_LCH_FRAMING', `${name} contains hidden data`)
    result.push(snapshotValue(descriptor.value as LCHValue, depth + 1, budget, name))
  }
  return result
}

export function snapshotBytes(value: Uint8Array, name: string): Uint8Array {
  lchAssert(value instanceof Uint8Array, 'ERR_LCH_FRAMING', `${name} must contain byte arrays`)
  const result = new Uint8Array(value.byteLength)
  Uint8Array.prototype.set.call(result, value)
  return result
}

function snapshotRecord(
  value: Record<string, LCHValue>,
  depth: number,
  budget: SnapshotBudget,
  name: string
): Record<string, LCHValue> {
  const prototype = Object.getPrototypeOf(value)
  lchAssert(
    (prototype === Object.prototype || prototype === null) &&
      Object.getOwnPropertySymbols(value).length === 0,
    'ERR_LCH_FRAMING',
    `${name} must contain only plain string-keyed maps`
  )
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const result: Record<string, LCHValue> = Object.create(null) as Record<string, LCHValue>
  for (const [key, descriptor] of Object.entries(descriptors)) {
    lchAssert(
      descriptor.enumerable === true && 'value' in descriptor,
      'ERR_LCH_FRAMING',
      `${name}.${key} must be enumerable own data`
    )
    result[key] = snapshotValue(descriptor.value as LCHValue, depth + 1, budget, name)
  }
  return result
}

export function snapshotValue(
  value: LCHValue,
  depth: number,
  budget: SnapshotBudget,
  name: string
): LCHValue {
  lchAssert(depth <= LCH_LIMITS.cborDepth, 'ERR_LCH_CBOR', 'LCH value nesting limit exceeded')
  budget.entries += 1
  lchAssert(
    budget.entries <= LCH_LIMITS.cborEntries,
    'ERR_LCH_CBOR',
    'LCH value item limit exceeded'
  )
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    typeof value === 'bigint'
  ) {
    return value
  }
  if (typeof value === 'number') {
    lchAssert(Number.isSafeInteger(value), 'ERR_LCH_CBOR', 'LCH numbers must be exact integers')
    return value
  }
  lchAssert(
    value !== undefined && typeof value === 'object',
    'ERR_LCH_FRAMING',
    `${name} contains an unsupported value`
  )
  lchAssert(!budget.seen.has(value), 'ERR_LCH_FRAMING', `${name} contains a cycle`)
  budget.seen.add(value)
  try {
    if (value instanceof Uint8Array) {
      budget.bytes += value.byteLength
      lchAssert(budget.bytes <= budget.maxBytes, 'ERR_LCH_CBOR', 'LCH byte-string limit exceeded')
      return snapshotBytes(value, name)
    }
    if (Array.isArray(value)) return snapshotArray(value, depth, budget, name)
    return snapshotRecord(value, depth, budget, name)
  } finally {
    budget.seen.delete(value)
  }
}

/**
 * Copy a signed object into an owned, accessor-free graph before any await.
 * The body clone has a null prototype, so inherited ambient fields can never
 * acquire signed semantics.
 */
export function snapshotSignedObject(value: unknown, name = 'Signed object'): SignedObject {
  lchAssert(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'ERR_LCH_SIGNATURE',
    `${name} envelope is invalid`
  )
  const body = dataDescriptor(value, 'body', `${name}.body`).value
  const signatures = dataDescriptor(value, 'signatures', `${name}.signatures`).value
  lchAssert(
    body !== null &&
      typeof body === 'object' &&
      !Array.isArray(body) &&
      !(body instanceof Uint8Array) &&
      Array.isArray(signatures) &&
      signatures.length <= 64 &&
      signatures.every(
        signature =>
          signature instanceof Uint8Array && signature.length > 0 && signature.length <= 4096
      ),
    'ERR_LCH_SIGNATURE',
    `${name} envelope is invalid`
  )
  const budget: SnapshotBudget = {
    entries: 0,
    bytes: 0,
    maxBytes: LCH_LIMITS.headerBytes,
    seen: new WeakSet()
  }
  const ownedBody = snapshotValue(body as LCHValue, 0, budget, `${name}.body`)
  lchAssert(
    ownedBody !== null &&
      typeof ownedBody === 'object' &&
      !Array.isArray(ownedBody) &&
      !(ownedBody instanceof Uint8Array),
    'ERR_LCH_SIGNATURE',
    `${name} body is invalid`
  )
  const ownedSignatures = snapshotValue(
    signatures as unknown as LCHValue,
    0,
    budget,
    `${name}.signatures`
  )
  lchAssert(Array.isArray(ownedSignatures), 'ERR_LCH_SIGNATURE', `${name} signatures are invalid`)
  return {
    body: ownedBody as Record<string, LCHValue>,
    signatures: ownedSignatures.map(signature => {
      lchAssert(
        signature instanceof Uint8Array,
        'ERR_LCH_SIGNATURE',
        `${name} signatures are invalid`
      )
      return signature
    })
  }
}

/** Copy an arbitrary LCH map into an owned, accessor-free graph. */
export function snapshotLCHRecord(value: unknown, name: string): Record<string, LCHValue> {
  const snapshot = snapshotValue(
    value as LCHValue,
    0,
    { entries: 0, bytes: 0, maxBytes: LCH_LIMITS.headerBytes, seen: new WeakSet() },
    name
  )
  lchAssert(
    snapshot !== null &&
      typeof snapshot === 'object' &&
      !Array.isArray(snapshot) &&
      !(snapshot instanceof Uint8Array),
    'ERR_LCH_FRAMING',
    `${name} must be a map`
  )
  return snapshot
}

export function snapshotStringArray(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined
  lchAssert(Array.isArray(value), 'ERR_LCH_FRAMING', `${name} must be an array`)
  const snapshot = snapshotValue(
    value as unknown as LCHValue,
    0,
    { entries: 0, bytes: 0, maxBytes: LCH_LIMITS.headerBytes, seen: new WeakSet() },
    name
  )
  lchAssert(
    Array.isArray(snapshot) && snapshot.every(item => typeof item === 'string'),
    'ERR_LCH_FRAMING',
    `${name} must contain strings`
  )
  return snapshot as string[]
}

export function snapshotStringSet(value: unknown, name: string): ReadonlySet<string> | undefined {
  if (value === undefined) return undefined
  lchAssert(
    value instanceof Set &&
      Object.getPrototypeOf(value) === Set.prototype &&
      Object.getOwnPropertySymbols(value).length === 0 &&
      Object.keys(value).length === 0,
    'ERR_LCH_FRAMING',
    `${name} must be a Set`
  )
  const result = new Set<string>()
  for (const entry of value) {
    lchAssert(result.size < LCH_LIMITS.cborEntries, 'ERR_LCH_FRAMING', `${name} is oversized`)
    lchAssert(typeof entry === 'string', 'ERR_LCH_FRAMING', `${name} must contain strings`)
    result.add(entry)
  }
  return result
}
