import { describe, expect, it } from 'vitest'
import { GroupMessagingError } from '../../errors.js'
import {
  asPrivateKeyPackageBytes,
  decodePrivateKeyPackage,
  encodePrivateKeyPackage
} from '../key-package-codec.js'

const sample = {
  initPrivateKey: new Uint8Array(32).fill(1),
  hpkePrivateKey: new Uint8Array(32).fill(2),
  signaturePrivateKey: new Uint8Array(64).fill(3)
}

describe('private KeyPackage codec', () => {
  it('round-trips all three keys', () => {
    expect(decodePrivateKeyPackage(encodePrivateKeyPackage(sample))).toEqual(sample)
  })

  it('stamps a version byte so stored records can migrate', () => {
    expect(encodePrivateKeyPackage(sample)[0]).toBe(1)
  })

  it('rejects an unknown version rather than misreading it', () => {
    const bytes = encodePrivateKeyPackage(sample)
    bytes[0] = 99
    expect(() => decodePrivateKeyPackage(bytes)).toThrow(GroupMessagingError)
  })

  it('rejects truncated bytes', () => {
    const bytes = encodePrivateKeyPackage(sample)
    expect(() => decodePrivateKeyPackage(asPrivateKeyPackageBytes(bytes.slice(0, 20)))).toThrow(
      GroupMessagingError
    )
  })

  it('handles keys longer than 255 bytes', () => {
    const big = { ...sample, signaturePrivateKey: new Uint8Array(300).fill(9) }
    expect(decodePrivateKeyPackage(encodePrivateKeyPackage(big))).toEqual(big)
  })
})
