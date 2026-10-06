import { OUTPUT_JSON_LIMITS, outputAssert } from '@bsv/sdk'

/** Node storage boundary: own canonical standard Base64 without a number-array copy.
 * Keep the SDK decoder's allocation limits, acceptance and refusal order exactly.
 * This establishes byte representation only, never custody or disclosure authority. */
export function nativeOutputBytes(
  input: unknown,
  maximumBytes: number = OUTPUT_JSON_LIMITS.bytes
): Buffer {
  outputAssert(
    Number.isSafeInteger(maximumBytes) &&
      maximumBytes >= 0 &&
      maximumBytes <= OUTPUT_JSON_LIMITS.bytes,
    'Invalid byte limit'
  )
  outputAssert(typeof input === 'string', 'Expected base64 bytes')
  outputAssert(input.length <= 4 * Math.ceil(maximumBytes / 3), 'Decoded byte limit', 'limited')
  outputAssert(
    input.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(input),
    'Noncanonical base64'
  )
  const result = Buffer.from(input, 'base64')
  outputAssert(result.byteLength <= maximumBytes, 'Decoded byte limit', 'limited')
  outputAssert(result.toString('base64') === input, 'Nonzero base64 padding bits')
  return result
}
