// Shared schema building blocks are internal. Public parsers below this layer
// always normalize/bound the entire message before applying nested schemas.
import { outputAssert } from './OutputProtocolError.js'
import {
  closedOutputObject,
  createClosedOutputObjectValidator,
  decodeOutputBytes,
  outputHex32,
  outputString,
  outputU32,
  outputU64
} from './OutputProtocol.js'
import {
  OUTPUT_JSON_LIMITS,
  ownOutputJSONValue,
  ownOutputJSONWithInlineStrings,
  parseOutputJSON,
  type OutputJSON,
  type OutputJSONObject
} from './OutputProtocolJSON.js'

export type Schema<T> = (value: unknown) => T
type Shape = Record<string, Schema<unknown>>
type Fields<S extends Shape> = { [K in keyof S]: ReturnType<S[K]> }

/** Mutable grammar remains dynamic unless the internal fixed builder opts in. */
export function object<R extends Shape, O extends Shape = Record<never, never>>(
  required: R,
  optional = {} as O,
  fixed?: boolean
): Schema<Fields<R> & Partial<Fields<O>>> {
  const fields = fixed && Object.entries(required),
    extras = fixed && Object.entries(optional)
  const close: (value: unknown) => asserts value is Record<string, unknown> = fixed
    ? createClosedOutputObjectValidator(Object.keys(required), Object.keys(optional))
    : value => closedOutputObject(value, Object.keys(required), Object.keys(optional))
  return value => {
    close(value)
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const [key, schema] of fields || Object.entries(required)) result[key] = schema(value[key])
    for (const [key, schema] of extras || Object.entries(optional)) {
      if (Object.hasOwn(value, key)) result[key] = schema(value[key])
    }
    return result as Fields<R> & Partial<Fields<O>>
  }
}

/** Own a fixed grammar; no supplied value or validation result is retained. */
export function fixedObject<R extends Shape, O extends Shape = Record<never, never>>(
  required: R,
  optional?: O
): Schema<Fields<R> & Partial<Fields<O>>> {
  return object(required, optional, true)
}

export function array<T>(element: Schema<T>, maximum = 4096, minimum = 0): Schema<T[]> {
  return value => {
    outputAssert(Array.isArray(value), 'Expected protocol array')
    outputAssert(value.length >= minimum && value.length <= maximum, 'Protocol array bounds')
    return value.map(element)
  }
}

export function literal<const T extends readonly (string | number | boolean | null)[]>(
  ...values: T
): Schema<T[number]> {
  return value => {
    outputAssert(values.includes(value as T[number]), 'Unexpected protocol tag')
    return value as T[number]
  }
}

export function nullable<T>(schema: Schema<T>): Schema<T | null> {
  return value => (value === null ? null : schema(value))
}

export function tagged<K extends string, S extends Shape>(
  key: K,
  variants: S
): Schema<ReturnType<S[keyof S]>> {
  return value => {
    outputAssert(
      value !== null && typeof value === 'object' && !Array.isArray(value),
      'Expected tagged object'
    )
    const tag: unknown = (value as Record<string, unknown>)[key]
    outputAssert(
      typeof tag === 'string' && Object.hasOwn(variants, tag),
      'Unknown protocol variant'
    )
    return variants[tag](value) as ReturnType<S[keyof S]>
  }
}

export const json: Schema<OutputJSON> = value => value as OutputJSON
export const jsonMap: Schema<OutputJSONObject> = value => {
  outputAssert(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'Expected JSON map'
  )
  return value as OutputJSONObject
}
export const text = outputString
export const hex = outputHex32
export { outputIdentity as identity } from './OutputProtocol.js'
export const u32 = outputU32
export const u64: Schema<string> = value => {
  outputU64(value)
  return value as string
}
export const bytes: Schema<string> = value => {
  decodeOutputBytes(value)
  return value as string
}
export const bool = literal(true, false)
export const iri: Schema<string> = value => {
  const result = text(value)
  outputAssert(/^[A-Za-z][A-Za-z0-9+.-]*:/.test(result), 'Expected absolute IRI')
  return result
}
export const requestId: Schema<string> = value => {
  outputAssert(
    typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value),
    'Invalid request ID'
  )
  return value
}
export const chain = fixedObject({ network: text, genesisHash: hex })
export const outpoint = fixedObject({ chain, txid: hex, outputIndex: u32 })
export const scope = fixedObject({
  chain,
  provider: text,
  service: text,
  queryDigest: hex,
  rulesDigest: hex,
  access: text,
  epoch: text
})
export const evidence = fixedObject({ txid: hex, outputIndex: u32, beef: bytes })
export const extensions = { extensions: jsonMap, critical: array(iri, 32) }
export const policy = fixedObject({ id: iri, digest: hex })

export function normalized<T>(input: unknown, schema: Schema<T>, maximumBytes = 4194304): T {
  // Only fixed default bounds are shared. Every supplied override and input
  // still receives its own complete validation and normalization.
  const limits =
    maximumBytes === OUTPUT_JSON_LIMITS.bytes ? OUTPUT_JSON_LIMITS : { bytes: maximumBytes }
  const value =
    typeof input === 'string' || input instanceof Uint8Array
      ? parseOutputJSON(input, limits)
      : ownOutputJSONValue(input, limits)
  return schema(value)
}

/** Stable bytewise UTF-8 ordering (different from JCS's UTF-16 key ordering). */
export function compareUTF8(a: string, b: string): number {
  const encoder = new TextEncoder()
  const left = encoder.encode(a),
    right = encoder.encode(b)
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i] - right[i]
  }
  return left.length - right.length
}

export function sortedUnique<T>(values: readonly T[], compare: (a: T, b: T) => number): void {
  for (let i = 1; i < values.length; i++) {
    outputAssert(compare(values[i - 1], values[i]) < 0, 'Expected sorted unique list')
  }
}

/** Purchase object ownership is fresh and bounded; text/bytes retain the general parser. */
export function normalizedWithInlineStrings<T>(
  input: unknown,
  schema: Schema<T>,
  maximumBytes = 4194304
): T {
  const limits =
    maximumBytes === OUTPUT_JSON_LIMITS.bytes ? OUTPUT_JSON_LIMITS : { bytes: maximumBytes }
  const value =
    typeof input === 'string' || input instanceof Uint8Array
      ? parseOutputJSON(input, limits)
      : ownOutputJSONWithInlineStrings(input, limits).value
  return schema(value)
}
