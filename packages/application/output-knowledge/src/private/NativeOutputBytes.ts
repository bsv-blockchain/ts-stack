import { OUTPUT_JSON_LIMITS, outputAssert, validateOutputByteEncoding } from '@bsv/sdk'

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
  outputAssert(input.length % 4 === 0, 'Noncanonical base64')
  const result = Buffer.from(input, 'base64')
  const canonical = result.toString('base64')
  // The required native round-trip already proves alphabet, padding and shape
  // when equal. Otherwise retain syntax refusal before byte/padding refusal.
  // Decode allocation remains bounded by the checked encoded length above.
  outputAssert(canonical === input || /^[A-Za-z0-9+/]*={0,2}$/.test(input), 'Noncanonical base64')
  outputAssert(result.byteLength <= maximumBytes, 'Decoded byte limit', 'limited')
  outputAssert(canonical === input, 'Nonzero base64 padding bits')
  return result
}

/** Explicit Node framing companion. Check the complete current standard Base64
 * representation before native allocation. Noncanonical input retains the
 * original native decoder's exact refusal path; no input or verdict is retained.
 * This validates representation only, never custody or authentication. */
export function nativeValidatedOutputBytes(
  input: unknown,
  maximumBytes: number = OUTPUT_JSON_LIMITS.bytes
): Buffer {
  try {
    validateOutputByteEncoding(input, maximumBytes)
  } catch {
    // The original native entry remains the refusal oracle for every malformed
    // representation, including its native round-trip and error precedence.
    return nativeOutputBytes(input, maximumBytes)
  }
  return Buffer.from(input as string, 'base64')
}
