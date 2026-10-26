import { stringifyBRC100 } from '@bsv/sdk/wallet/BRC100ByteEncoding'

export const DEFAULT_MAX_EVENT_PAYLOAD_BYTES = 1024 * 1024
const MAX_EVENT_NAME_BYTES = 256
const MAX_EVENT_DEPTH = 64
const MAX_EVENT_NODES = 100_000
const RESERVED_EVENT_NAMES = new Set([
  '_unknown',
  'connect',
  'connect_error',
  'disconnect',
  'disconnecting',
  'newListener',
  'removeListener'
])
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export function resolveMaxEventPayloadBytes(value: number | undefined): number {
  const resolved = value ?? DEFAULT_MAX_EVENT_PAYLOAD_BYTES
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError('maxEventPayloadBytes must be a positive safe integer')
  }
  return resolved
}

function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function assertEventName(eventName: unknown): asserts eventName is string {
  if (
    typeof eventName !== 'string' ||
    eventName.length === 0 ||
    eventName.length > MAX_EVENT_NAME_BYTES ||
    utf8Bytes(eventName).length > MAX_EVENT_NAME_BYTES ||
    RESERVED_EVENT_NAMES.has(eventName)
  ) {
    throw new TypeError('Event name is empty, reserved, or exceeds its limit')
  }
  for (const character of eventName) {
    const code = character.codePointAt(0)!
    if (
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      throw new TypeError('Event name contains control or bidirectional formatting characters')
    }
  }
}

function isUint8Array(value: unknown): value is Uint8Array {
  return (
    value != null &&
    typeof value === 'object' &&
    typeof ArrayBuffer !== 'undefined' &&
    ArrayBuffer.isView(value) &&
    Object.prototype.toString.call(value) === '[object Uint8Array]'
  )
}

function snapshotBoundedJsonValue(value: unknown, maxBytes: number): unknown {
  const seen = new WeakSet<object>()
  let snapshot: unknown
  const pending: Array<{
    value: unknown
    depth: number
    assign: (resolved: unknown) => void
  }> = [{ value, depth: 0, assign: resolved => (snapshot = resolved) }]
  let bytes = 0
  let nodes = 0

  while (pending.length > 0) {
    const current = pending.pop()!
    nodes += 1
    if (nodes > MAX_EVENT_NODES || current.depth > MAX_EVENT_DEPTH) {
      throw new TypeError('Event data exceeds its structural limit')
    }
    const candidate = current.value
    if (candidate === null || typeof candidate === 'boolean') {
      bytes += 4
      current.assign(candidate)
    } else if (candidate === undefined) {
      throw new TypeError('Event data must contain only JSON values')
    } else if (typeof candidate === 'string') {
      if (candidate.length > maxBytes) throw new TypeError('Event data exceeds its byte limit')
      bytes += utf8Bytes(candidate).length + 2
      current.assign(candidate)
    } else if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate) || Object.is(candidate, -0)) {
        throw new TypeError('Event data numbers must be finite and unambiguous')
      }
      bytes += 24
      current.assign(candidate)
    } else if (typeof candidate === 'object') {
      if (seen.has(candidate)) throw new TypeError('Event data must not contain cycles')
      seen.add(candidate)
      if (isUint8Array(candidate)) {
        if (Reflect.ownKeys(candidate).length !== candidate.byteLength) {
          throw new TypeError('Event byte arrays must not contain extra properties')
        }
        bytes += candidate.byteLength * 4 + 2
        const copy = Array.from({ length: candidate.byteLength }, () => 0)
        Object.setPrototypeOf(copy, null)
        for (let index = 0; index < candidate.byteLength; index++) copy[index] = candidate[index]
        current.assign(copy)
      } else if (Array.isArray(candidate)) {
        if (candidate.length > MAX_EVENT_NODES) {
          throw new TypeError('Event array exceeds its item limit')
        }
        if (Reflect.ownKeys(candidate).length !== candidate.length + 1) {
          throw new TypeError('Event arrays must not contain extra properties')
        }
        const copy: unknown[] = Array.from({ length: candidate.length })
        Object.setPrototypeOf(copy, null)
        current.assign(copy)
        for (let index = 0; index < candidate.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(candidate, index)
          if (descriptor == null || !Object.hasOwn(descriptor, 'value')) {
            throw new TypeError('Event data must not contain sparse arrays')
          }
          pending.push({
            value: descriptor.value,
            depth: current.depth + 1,
            assign: resolved => {
              copy[index] = resolved
            }
          })
        }
      } else {
        const prototype = Object.getPrototypeOf(candidate)
        if (prototype !== Object.prototype && prototype !== null) {
          throw new TypeError('Event data must contain only JSON objects')
        }
        const copy: Record<string, unknown> = Object.create(null)
        current.assign(copy)
        const fields: Array<{ key: string; value: unknown }> = []
        for (const key of Reflect.ownKeys(candidate)) {
          if (typeof key !== 'string' || UNSAFE_KEYS.has(key)) {
            throw new TypeError('Event data contains an unsafe property key')
          }
          const descriptor = Object.getOwnPropertyDescriptor(candidate, key)
          if (descriptor == null || !Object.hasOwn(descriptor, 'value')) {
            throw new TypeError('Event data must not contain accessors')
          }
          if (descriptor.enumerable !== true) {
            throw new TypeError('Event data must not contain hidden properties')
          }
          if (key.length > maxBytes) throw new TypeError('Event data exceeds its byte limit')
          bytes += utf8Bytes(key).length + 3
          fields.push({ key, value: descriptor.value })
        }
        for (let index = fields.length - 1; index >= 0; index--) {
          const field = fields[index]
          pending.push({
            value: field.value,
            depth: current.depth + 1,
            assign: resolved => {
              copy[field.key] = resolved
            }
          })
        }
      }
    } else {
      throw new TypeError('Event data contains an unsupported value')
    }
    if (bytes > maxBytes) throw new TypeError('Event data exceeds its byte limit')
  }
  return snapshot
}

function assertBoundedJsonValue(value: unknown, maxBytes: number): void {
  void snapshotBoundedJsonValue(value, maxBytes)
}

function assertDenseBytes(payload: unknown, maxBytes: number): asserts payload is number[] {
  if (!Array.isArray(payload) || payload.length > maxBytes) {
    throw new TypeError('Event payload must be a bounded byte array')
  }
  for (let index = 0; index < payload.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(payload, index)
    if (
      descriptor == null ||
      !Object.hasOwn(descriptor, 'value') ||
      !Number.isInteger(descriptor.value) ||
      descriptor.value < 0 ||
      descriptor.value > 255
    ) {
      throw new TypeError('Event payload must be an exact dense byte array')
    }
  }
}

export function encodeAuthSocketEventPayload(
  eventName: string,
  data: unknown,
  maxBytes: number
): number[] {
  assertEventName(eventName)
  const envelope = data === undefined ? { eventName } : { eventName, data }
  const snapshot = snapshotBoundedJsonValue(envelope, maxBytes)
  const encoded = utf8Bytes(stringifyBRC100(snapshot))
  if (encoded.length > maxBytes) throw new TypeError('Encoded event payload exceeds its byte limit')
  return Array.from(encoded)
}

export function parseAuthSocketEventPayload(
  payload: unknown,
  maxBytes: number
): { eventName: string; data: unknown } {
  assertDenseBytes(payload, maxBytes)
  const decodedText = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(payload))
  const decoded: unknown = JSON.parse(decodedText)
  assertBoundedJsonValue(decoded, maxBytes)
  if (decoded == null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new TypeError('Event payload must contain an object envelope')
  }
  const record = decoded as Record<string, unknown>
  const keys = Object.keys(record)
  if (
    !Object.hasOwn(record, 'eventName') ||
    keys.some(key => key !== 'eventName' && key !== 'data')
  ) {
    throw new TypeError('Event payload has an invalid envelope')
  }
  assertEventName(record.eventName)
  return { eventName: record.eventName, data: record.data }
}
