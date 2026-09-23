import { base64ToArray } from '@bsv/sdk/primitives/utils'

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** BRC-29 receive boundary only: reject noncanonical or oversized text before decoding. */
export function decodePeerPayTransaction(value: string, maximumBytes: number): number[] {
  const invalid = (): never => {
    throw new TypeError('Incoming payment transaction must be bounded canonical base64')
  }
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    value.length > Math.ceil(maximumBytes / 3) * 4
  )
    invalid()
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  const decodedLength = (value.length / 4) * 3 - padding
  if (decodedLength === 0 || decodedLength > maximumBytes) invalid()
  let last = 0
  for (let index = 0; index < value.length - padding; index++) {
    last = alphabet.indexOf(value[index])
    if (last < 0) invalid()
  }
  if ((padding === 2 && (last & 15) !== 0) || (padding === 1 && (last & 3) !== 0)) invalid()
  return base64ToArray(value)
}
