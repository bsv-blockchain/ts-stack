import PrivateKey from '../../primitives/PrivateKey'
import {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  hexToBytes,
  utf8Bytes
} from '../WalletByteEncoding'
import { isCanonicalDERSignature, isValidCompressedPublicKey } from '../Secp256k1Validation'

describe('wallet narrow byte encoding', () => {
  it.each([
    [[], ''],
    [[0], 'AA=='],
    [[0, 1], 'AAE='],
    [[0, 1, 2], 'AAEC'],
    [[0xff, 0xee, 0xdd, 0xcc], '/+7dzA==']
  ])('round trips canonical base64 bytes %#', (bytes, encoded) => {
    expect(bytesToBase64(bytes)).toBe(encoded)
    expect(base64ToBytes(encoded)).toEqual(bytes)
  })

  it.each(['A', 'AAA', 'A===', 'AA=A', 'AA-_', 'AB==', 'AAB='])('rejects non-canonical base64 %s', encoded => {
    expect(() => base64ToBytes(encoded)).toThrow(TypeError)
  })

  it('encodes UTF-8 and round trips hexadecimal bytes', () => {
    const bytes = Array.from(utf8Bytes('A€🙂'))
    expect(bytes).toEqual([0x41, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x99, 0x82])
    expect(bytesToHex(bytes)).toBe('41e282acf09f9982')
    expect(hexToBytes('41E282ACF09F9982')).toEqual(bytes)
  })

  it.each(['0', 'xyz0', '00 01'])('rejects malformed hexadecimal bytes %s', encoded => {
    expect(() => hexToBytes(encoded)).toThrow(TypeError)
  })
})

describe('wallet narrow secp256k1 validation', () => {
  const privateKey = PrivateKey.fromHex('1'.padStart(64, '0'))
  const publicKey = privateKey.toPublicKey().toDER('hex') as string

  it('accepts compressed public keys emitted by the SDK', () => {
    expect(isValidCompressedPublicKey(publicKey)).toBe(true)
    expect(isValidCompressedPublicKey(`${publicKey[1] === '2' ? '03' : '02'}${publicKey.slice(2)}`)).toBe(true)
  })

  it.each([
    '',
    '04' + '00'.repeat(64),
    '02' + '00'.repeat(32),
    '02fffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f',
    '02' + 'gg'.repeat(32)
  ])('rejects invalid compressed public key %s', encoded => {
    expect(isValidCompressedPublicKey(encoded)).toBe(false)
  })

  it('accepts DER signatures emitted by the SDK', () => {
    const signature = privateKey.sign('narrow validation').toDER() as number[]
    expect(isCanonicalDERSignature(signature)).toBe(true)
  })

  it.each([
    [0x30, 0x06, 0x02, 0x01, 0x00, 0x02, 0x01, 0x01],
    [0x30, 0x06, 0x02, 0x01, 0x80, 0x02, 0x01, 0x01],
    [0x30, 0x07, 0x02, 0x02, 0x00, 0x01, 0x02, 0x01, 0x01],
    [0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x00],
    [0x30, 0x07, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01, 0x00]
  ])('rejects malformed DER signature %#', signature => {
    expect(isCanonicalDERSignature(signature)).toBe(false)
  })

  it('rejects a DER scalar at the secp256k1 group order', () => {
    const order = hexToBytes('fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141')
    const signature = [0x30, 0x26, 0x02, 0x01, 0x01, 0x02, 0x21, 0x00, ...order]
    expect(isCanonicalDERSignature(signature)).toBe(false)
  })
})
