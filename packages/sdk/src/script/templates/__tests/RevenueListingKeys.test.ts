import PrivateKey from '../../../primitives/PrivateKey.js'
import PublicKey from '../../../primitives/PublicKey.js'
import { outputIdentity } from '../../../overlay-tools/OutputProtocol.js'
import { revenueListingChildPublicKey } from '../RevenueListingKeys.js'

const root = '037a9375ad6167ad54aa74c6348cc54d344cc5dc9487d847049d5eabb0fa03c8fb'
const child = '023b4c5ca0fc8a54ad054abd589ed847f4763e0427f2cb67d29c0c4abe9aae64e1'

test('reuses only the immutable public root/child calculation from the independent BRC-197 vector', () => {
  // Separate the existing curve-point validation cache from child derivation.
  outputIdentity(root)
  const parse = jest.spyOn(PublicKey, 'fromString')
  try {
    expect(revenueListingChildPublicKey(root)).toBe(child)
    expect(revenueListingChildPublicKey(root)).toBe(child)
    expect(parse).toHaveBeenCalledTimes(1)
    expect(parse).toHaveBeenCalledWith(root)
  } finally {
    parse.mockRestore()
  }
})

test('a retained valid public calculation cannot admit malformed or invalid curve points', () => {
  expect(revenueListingChildPublicKey(root)).toBe(child)
  for (const invalid of [
    '',
    '02',
    '00'.repeat(33),
    '04' + '11'.repeat(32),
    '02' + 'ff'.repeat(32)
  ]) {
    expect(() => revenueListingChildPublicKey(invalid)).toThrow()
    expect(() => revenueListingChildPublicKey(invalid)).toThrow()
  }
  expect(revenueListingChildPublicKey(root)).toBe(child)
})

test('public calculation retention stays bounded and eviction preserves the derived value', () => {
  // Generate independent valid roots before observing the derivation itself.
  const identities = Array.from({ length: 129 }, (_, index) =>
    new PrivateKey(1000 + index).toPublicKey().toString()
  )
  for (const identity of identities) outputIdentity(identity)
  const parse = jest.spyOn(PublicKey, 'fromString')
  try {
    const first = revenueListingChildPublicKey(identities[0])
    for (const identity of identities.slice(1)) revenueListingChildPublicKey(identity)
    expect(parse).toHaveBeenCalledTimes(129)
    const last = revenueListingChildPublicKey(identities[128])
    expect(parse).toHaveBeenCalledTimes(129)
    expect(revenueListingChildPublicKey(identities[0])).toBe(first)
    expect(parse).toHaveBeenCalledTimes(130)
    expect(revenueListingChildPublicKey(identities[128])).toBe(last)
    expect(parse).toHaveBeenCalledTimes(130)
  } finally {
    parse.mockRestore()
  }
})
