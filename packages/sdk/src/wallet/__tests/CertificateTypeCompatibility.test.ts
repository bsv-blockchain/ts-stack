import {
  validateListCertificatesArgs,
  validateRelinquishCertificateArgs,
  validateProveCertificateArgs,
  validateAcquireDirectCertificateArgs
} from '../validationHelpers'
import { toBase64 } from '../../primitives/utils'

const type = toBase64(Array.from({ length: 16 }, () => 3))
const serialNumber = toBase64(Array.from({ length: 32 }, () => 2))
const certifier = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'

test('existing-certificate listing accepts the original legacy type', () => {
  expect(validateListCertificatesArgs({ types: [type], certifiers: [] }).types).toEqual([type])
})
test('stored-certificate relinquishment accepts the original legacy reference', () => {
  expect(validateRelinquishCertificateArgs({ type, serialNumber, certifier }).type).toBe(type)
})
test('new direct acquisition remains strict', () => {
  expect(() => validateAcquireDirectCertificateArgs({ type } as any)).toThrow()
})

test.each([16, 32])(
  'existing %i-byte references retain surrounding-whitespace normalization',
  length => {
    const canonical = toBase64(Array.from({ length }, () => 3))
    const padded = ` \t${canonical}\n`
    expect(validateListCertificatesArgs({ types: [padded], certifiers: [] }).types).toEqual([
      canonical
    ])
    expect(validateRelinquishCertificateArgs({ type: padded, serialNumber, certifier }).type).toBe(
      canonical
    )
    expect(
      validateProveCertificateArgs({
        certificate: { type: padded },
        verifier: certifier,
        fieldsToReveal: []
      }).type
    ).toBe(canonical)
  }
)
