// Shared schema building blocks are internal. Public parsers below this layer
// always normalize/bound the entire message before applying nested schemas.
import { outputAssert } from './OutputProtocolError.js'
import {
  closedOutputObject,
  createClosedOutputObjectValidator,
  decodeOutputBytes,
  outputHex32,
  outputIdentity,
  outputString,
  outputU32,
  outputU64
} from './OutputProtocol.js'
import {
  OUTPUT_JSON_LIMITS,
  ownOutputJSONValue,
  ownOutputJSONForSchema as ownOutputJSONWithInlineStrings,
  parseOutputJSON,
  parseOutputJSONWithOwnedRecords,
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
    typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$(?![^])/.test(value),
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
  // Portable text/byte inputs retain the general parser.
  const limits =
    maximumBytes === OUTPUT_JSON_LIMITS.bytes ? OUTPUT_JSON_LIMITS : { bytes: maximumBytes }
  const value =
    typeof input === 'string' || input instanceof Uint8Array
      ? parseOutputJSON(input, limits)
      : ownOutputJSONWithInlineStrings(input, limits).value
  return schema(value)
}

/** @internal Compose a child grammar only after the enclosing public parser has
 * freshly owned and bounded the complete graph. Embedded JSON text keeps its
 * complete parser. Only fixed callbacks are retained, never supplied values,
 * graphs, schema results, secrets or authority decisions. */
export function fromOwnedParent<T>(parse: Schema<T>, child: Schema<T>): Schema<T> {
  return value =>
    typeof value === 'string' || value instanceof Uint8Array ? parse(value) : child(value)
}

/** @internal Explicit encoded-record ownership for server packet companions.
 * Every call traverses and bounds the complete current input. Portable schema
 * companions keep their general text parser; object ownership is identical.
 * This stores no input, graph, secret or validation/authority result. */
export function normalizedWithOwnedRecords<T>(
  input: unknown,
  schema: Schema<T>,
  maximumBytes = 4194304
): T {
  const limits =
    maximumBytes === OUTPUT_JSON_LIMITS.bytes ? OUTPUT_JSON_LIMITS : { bytes: maximumBytes }
  const value =
    typeof input === 'string' || input instanceof Uint8Array
      ? parseOutputJSONWithOwnedRecords(input, limits)
      : ownOutputJSONWithInlineStrings(input, limits).value
  return schema(value)
}

/** @internal Server-only fixed grammar composition. The caller must use this
 * factory's complete normalizer; its ordinary returned callbacks remain safe
 * standalone schemas. Metadata holds grammar callbacks only, never input or
 * validation results. Portable schema builders keep their original paths. */
export function createOwnedRecordSchema() {
  const ownedSchemaParsers = new WeakMap<Schema<unknown>, Schema<unknown>>()

  function rememberOwnedSchema<T>(schema: Schema<T>, owned: Schema<T>): Schema<T> {
    ownedSchemaParsers.set(schema, owned)
    return schema
  }

  function applyOwnedSchema<T>(schema: Schema<T>, value: unknown): T {
    const owned = ownedSchemaParsers.get(schema)
    return owned === undefined ? schema(value) : (owned(value) as T)
  }

  function fixedOwnedObject<R extends Shape, O extends Shape>(
    schema: Schema<Fields<R> & Partial<Fields<O>>>,
    fields: [string, Schema<unknown>][],
    extras: [string, Schema<unknown>][]
  ): Schema<Fields<R> & Partial<Fields<O>>> {
    const required = fields.map(([key]) => key),
      allowed = new Set([...required, ...extras.map(([key]) => key)])
    return rememberOwnedSchema(schema, value => {
      outputAssert(
        value !== null && typeof value === 'object' && !Array.isArray(value),
        'Expected object'
      )
      // This factory's complete normalizer constructed fresh private data-only records,
      // rejected symbols, hidden/accessor fields, cycles and resource excess,
      // and split repeated references into independent owned subtrees.
      // Required/unknown fields and every nested domain predicate remain fresh.
      const input = value as Record<string, unknown>
      for (const key of required) {
        if (!Object.hasOwn(input, key)) outputAssert(false, `Missing ${key}`)
      }
      for (const key of Object.getOwnPropertyNames(input)) {
        if (!allowed.has(key)) outputAssert(false, `Unknown ${key}`)
      }
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
      for (const [key, child] of fields) result[key] = applyOwnedSchema(child, input[key])
      for (const [key, child] of extras) {
        if (Object.hasOwn(input, key)) result[key] = applyOwnedSchema(child, input[key])
      }
      return result as Fields<R> & Partial<Fields<O>>
    })
  }

  function fixedObject<R extends Shape, O extends Shape = Record<never, never>>(
    required: R,
    optional = {} as O
  ): Schema<Fields<R> & Partial<Fields<O>>> {
    const fields = Object.entries(required),
      extras = Object.entries(optional)
    return fixedOwnedObject<R, O>(object(required, optional, true), fields, extras)
  }

  function array<T>(element: Schema<T>, maximum = 4096, minimum = 0): Schema<T[]> {
    const schema: Schema<T[]> = value => {
      outputAssert(Array.isArray(value), 'Expected protocol array')
      outputAssert(value.length >= minimum && value.length <= maximum, 'Protocol array bounds')
      return value.map(element)
    }
    if (!ownedSchemaParsers.has(element)) return schema
    return rememberOwnedSchema(schema, value => {
      outputAssert(Array.isArray(value), 'Expected protocol array')
      outputAssert(value.length >= minimum && value.length <= maximum, 'Protocol array bounds')
      return value.map(item => applyOwnedSchema(element, item))
    })
  }

  function ownedLiteral<const T extends readonly (string | number | boolean | null)[]>(
    ...values: T
  ): Schema<T[number]> {
    const schema = literal(...values)
    return rememberOwnedSchema(schema, schema)
  }

  function nullable<T>(schema: Schema<T>): Schema<T | null> {
    const ordinary: Schema<T | null> = value => (value === null ? null : schema(value))
    return ownedSchemaParsers.has(schema)
      ? rememberOwnedSchema(ordinary, value =>
          value === null ? null : applyOwnedSchema(schema, value)
        )
      : ordinary
  }

  function tagged<K extends string, S extends Shape>(
    key: K,
    variants: S
  ): Schema<ReturnType<S[keyof S]>> {
    const schema: Schema<ReturnType<S[keyof S]>> = value => {
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
    return rememberOwnedSchema(schema, value => {
      outputAssert(
        value !== null && typeof value === 'object' && !Array.isArray(value),
        'Expected tagged object'
      )
      const tag: unknown = (value as Record<string, unknown>)[key]
      outputAssert(
        typeof tag === 'string' && Object.hasOwn(variants, tag),
        'Unknown protocol variant'
      )
      return applyOwnedSchema(variants[tag], value) as ReturnType<S[keyof S]>
    })
  }

  const identity: Schema<string> = value => outputIdentity(value)
  // These callbacks read only their supplied private value and return a checked
  // scalar or owned JSON subtree; they neither mutate nor retain that value.
  for (const schema of [
    json,
    jsonMap,
    text,
    hex,
    identity,
    u32,
    u64,
    bytes,
    bool,
    iri,
    requestId
  ]) {
    rememberOwnedSchema<unknown>(schema, schema)
  }

  function fromOwnedParent<T>(parse: Schema<T>, child: Schema<T>): Schema<T> {
    const schema: Schema<T> = value =>
      typeof value === 'string' || value instanceof Uint8Array ? parse(value) : child(value)
    return ownedSchemaParsers.has(child)
      ? rememberOwnedSchema(schema, value =>
          typeof value === 'string' || value instanceof Uint8Array
            ? parse(value)
            : applyOwnedSchema(child, value)
        )
      : schema
  }

  const chain = fixedObject({ network: text, genesisHash: hex })
  const outpoint = fixedObject({ chain, txid: hex, outputIndex: u32 })
  function normalized<T>(input: unknown, schema: Schema<T>, maximumBytes = 4194304): T {
    const limits =
      maximumBytes === OUTPUT_JSON_LIMITS.bytes ? OUTPUT_JSON_LIMITS : { bytes: maximumBytes }
    const value =
      typeof input === 'string' || input instanceof Uint8Array
        ? parseOutputJSONWithOwnedRecords(input, limits)
        : ownOutputJSONWithInlineStrings(input, limits).value
    return applyOwnedSchema(schema, value)
  }
  return {
    fixedObject,
    array,
    literal: ownedLiteral,
    nullable,
    tagged,
    fromOwnedParent,
    json,
    jsonMap,
    text,
    hex,
    identity,
    u32,
    u64,
    bytes,
    bool,
    iri,
    requestId,
    chain,
    outpoint,
    normalized
  }
}
