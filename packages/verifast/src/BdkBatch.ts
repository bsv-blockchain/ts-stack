import { mapVerifyFlags } from './flags.js'
import {
  BdkErrorDomain,
  BdkVerificationError,
  type BdkVerificationResult
} from './BdkVerifierTypes.js'

export interface PackedArrays<T extends Uint8Array | Int32Array | Uint32Array> {
  values: T
  offsets: Uint32Array
}

export function flagsForInputCount(
  inputCount: number,
  verifyFlags?: string | string[],
  customFlags?: readonly number[] | Uint32Array
): Uint32Array {
  if (customFlags !== undefined) {
    if (customFlags.length !== 0 && customFlags.length !== inputCount) {
      throw new RangeError('Custom flag count must be zero or match the input count')
    }
    return Uint32Array.from(customFlags)
  }
  if (verifyFlags === undefined) return new Uint32Array()
  return new Uint32Array(inputCount).fill(mapVerifyFlags(verifyFlags))
}

export function packArrays<T extends Uint8Array | Int32Array | Uint32Array>(
  arrays: readonly T[],
  make: (length: number) => T
): PackedArrays<T> {
  const offsets = new Uint32Array(arrays.length + 1)
  let length = 0
  for (let index = 0; index < arrays.length; index++) {
    length += arrays[index].length
    if (length > 0xffffffff) throw new RangeError('Packed BDK batch exceeds 4 GiB offset space')
    offsets[index + 1] = length
  }
  const values = make(length)
  let position = 0
  for (const array of arrays) {
    values.set(array, position)
    position += array.length
  }
  return { values, offsets }
}

export function decodeResults(flat: Int32Array, count: number): BdkVerificationResult[] {
  if (flat.length !== count * 2) {
    throw new BdkVerificationError({ domain: BdkErrorDomain.EXCEPTION, code: 0 })
  }
  return Array.from({ length: count }, (_, index) => ({
    domain: flat[index * 2],
    code: flat[index * 2 + 1]
  }))
}

export function verdict(result: BdkVerificationResult): boolean {
  if (result.domain === BdkErrorDomain.OK) return true
  if (result.domain === BdkErrorDomain.SCRIPT || result.domain === BdkErrorDomain.DOS) return false
  throw new BdkVerificationError(result)
}
