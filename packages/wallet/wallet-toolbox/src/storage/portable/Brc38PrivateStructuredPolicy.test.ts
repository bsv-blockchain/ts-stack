import { brc38PrivateStructuredPolicy, type Brc38PrivateStructuredPolicy } from './Brc38PrivateStructuredPolicy'

// Pure resource DATA capture; these cases acquire no source, native actor,
// filesystem, profile or semantic/import authority.
const selected = (): Brc38PrivateStructuredPolicy => ({
  privateIndexParent: '/private/brc38-index-fixture',
  maximumTemporaryIndexBytes: 1048576,
  maximumIndexMembers: 1000,
  maximumStructuredBytes: 1000000,
  maximumCanonicalBytes: 1000000
})

test('omitted limits preserve the original external-index policy and explicit bounds are immutable', () => {
  const legacy = brc38PrivateStructuredPolicy(selected())
  expect(legacy.maximumReadBytes).toBeUndefined()
  expect(legacy.maximumIndexAllocationBytes).toBeUndefined()
  const input = {
      ...selected(),
      maximumReadBytes: 1024,
      maximumIndexAllocationBytes: 65536,
      maximumGrammarAllocationBytes: 32768
    },
    policy = brc38PrivateStructuredPolicy(input)
  input.maximumReadBytes = 65536
  input.maximumIndexAllocationBytes = 16777216
  input.maximumGrammarAllocationBytes = 16777216
  expect(Object.isFrozen(policy)).toBe(true)
  expect(policy.maximumReadBytes).toBe(1024)
  expect(policy.maximumIndexAllocationBytes).toBe(65536)
  expect(policy.maximumGrammarAllocationBytes).toBe(32768)
})
test('explicit transfer and allocation bounds reject invalid data before any host operation', () => {
  for (const maximumReadBytes of [0, 63, 65537, 64.5, NaN, Infinity])
    expect(() => brc38PrivateStructuredPolicy({ ...selected(), maximumReadBytes })).toThrow(RangeError)
  for (const maximumIndexAllocationBytes of [0, 4095, 16777217, 8192.5, NaN, Infinity])
    expect(() => brc38PrivateStructuredPolicy({ ...selected(), maximumIndexAllocationBytes })).toThrow(RangeError)
  for (const maximumGrammarAllocationBytes of [0, 4095, 16777217, 8192.5, NaN, Infinity])
    expect(() => brc38PrivateStructuredPolicy({ ...selected(), maximumGrammarAllocationBytes })).toThrow(RangeError)
  expect(
    brc38PrivateStructuredPolicy({ ...selected(), maximumReadBytes: 64, maximumIndexAllocationBytes: 4096 })
      .maximumReadBytes
  ).toBe(64)
})

test('legacy spelling explicitly admits two indexes under the same aggregate byte ceiling', () => {
  expect(brc38PrivateStructuredPolicy(selected()).maximumOpenIndexes).toBeUndefined()
  const policy = brc38PrivateStructuredPolicy({
    ...selected(),
    maximumOpenIndexes: 2,
    maximumTemporaryIndexBytes: 2097152
  })
  expect(policy.maximumOpenIndexes).toBe(2)
  expect(policy.maximumTemporaryIndexBytes).toBe(2097152)
  expect(() => brc38PrivateStructuredPolicy({ ...selected(), maximumOpenIndexes: 2 })).toThrow(RangeError)
  for (const maximumOpenIndexes of [0, 3, 1.5, NaN, Infinity])
    expect(() =>
      brc38PrivateStructuredPolicy({ ...selected(), maximumOpenIndexes } as unknown as Brc38PrivateStructuredPolicy)
    ).toThrow(RangeError)
})
