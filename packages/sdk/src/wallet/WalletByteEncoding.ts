export { utf8Bytes } from '../primitives/UTF8.js'
const base64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const hexAlphabet = '0123456789abcdef'

export function bytesToHex(bytes: ArrayLike<number>): string {
  let result = ''
  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index]
    result += hexAlphabet[byte >> 4] + hexAlphabet[byte & 15]
  }
  return result
}

export function hexToBytes(value: string): number[] {
  if (typeof value !== 'string' || value.length % 2 !== 0 || !/^[0-9a-f]*$/iu.test(value)) {
    throw new TypeError('Invalid hexadecimal byte string')
  }
  const bytes = Array.from<number>({ length: value.length / 2 })
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

export function bytesToBase64(bytes: ArrayLike<number>): string {
  let result = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]
    const second = index + 1 < bytes.length ? bytes[index + 1] : 0
    const third = index + 2 < bytes.length ? bytes[index + 2] : 0
    result += base64Alphabet[first >> 2]
    result += base64Alphabet[((first & 3) << 4) | (second >> 4)]
    result += index + 1 < bytes.length ? base64Alphabet[((second & 15) << 2) | (third >> 6)] : '='
    result += index + 2 < bytes.length ? base64Alphabet[third & 63] : '='
  }
  return result
}

export function base64ToBytes(value: string): number[] {
  if (
    typeof value !== 'string' ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) {
    throw new TypeError('Invalid canonical base64 string')
  }
  if (value.endsWith('==') && (base64Alphabet.indexOf(value[value.length - 3]) & 15) !== 0) {
    throw new TypeError('Invalid canonical base64 string')
  }
  if (value.endsWith('=') && !value.endsWith('==') && (base64Alphabet.indexOf(value[value.length - 2]) & 3) !== 0) {
    throw new TypeError('Invalid canonical base64 string')
  }
  const bytes: number[] = []
  for (let index = 0; index < value.length; index += 4) {
    const first = base64Alphabet.indexOf(value[index])
    const second = base64Alphabet.indexOf(value[index + 1])
    const third = value[index + 2] === '=' ? 0 : base64Alphabet.indexOf(value[index + 2])
    const fourth = value[index + 3] === '=' ? 0 : base64Alphabet.indexOf(value[index + 3])
    bytes.push((first << 2) | (second >> 4))
    if (value[index + 2] !== '=') bytes.push(((second & 15) << 4) | (third >> 2))
    if (value[index + 3] !== '=') bytes.push(((third & 3) << 6) | fourth)
  }
  return bytes
}
