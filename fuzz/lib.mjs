import { isDeepStrictEqual } from 'node:util'

export function invariant(condition, message) {
  if (!condition) throw new Error(`Fuzz invariant failed: ${message}`)
}

export function equalBytes(actual, expected, message) {
  invariant(
    actual.length === expected.length &&
      actual.every((value, index) => value === expected[index]),
    message
  )
}

export function deepEqual(actual, expected, message) {
  invariant(isDeepStrictEqual(actual, expected), message)
}

export function attempt(operation) {
  try {
    return { ok: true, value: operation() }
  } catch {
    return { ok: false }
  }
}

export function utf8(data, maximumLength = 65_536) {
  return data.subarray(0, maximumLength).toString('utf8')
}
