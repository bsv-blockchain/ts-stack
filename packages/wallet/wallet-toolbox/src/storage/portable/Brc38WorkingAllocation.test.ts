import { Brc38WorkingAllocation, brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'

describe('combined original BRC-38 working allowance', () => {
  it('counts idle component reservations and refuses before changing the balance', () => {
    const owner = new Brc38WorkingAllocation(65536)
    const first = owner.claim(8192),
      second = owner.claim(8192),
      grammar = owner.claim(32768)
    expect(() => owner.claim(16385)).toThrow(SnapshotResourceLimitError)
    expect(owner.used).toBe(49152)
    grammar.resize(4096)
    const next = owner.claim(32768)
    expect(owner.used).toBe(53248)
    first.close()
    first.close()
    second.close()
    grammar.close()
    next.close()
    expect(owner.used).toBe(0)
    expect(() => first.resize(1)).toThrow('closed')
  })
  it('retains the original ceiling and rejects copied resource descriptors', () => {
    const owner = new Brc38WorkingAllocation(4096)
    expect(brc38WorkingAllocation(owner)).toBe(owner)
    expect(() => brc38WorkingAllocation({ ...owner } as Brc38WorkingAllocation)).toThrow(TypeError)
    expect(() => owner.claim(4097)).toThrow(SnapshotResourceLimitError)
    expect(owner.maximum).toBe(4096)
    expect(owner.used).toBe(0)
  })
})

test('small original positive ceilings are resource refusals rather than rewritten policies', () => {
  const owner = new Brc38WorkingAllocation(1)
  expect(owner.maximum).toBe(1)
  expect(() => owner.claim(4096)).toThrow(SnapshotResourceLimitError)
  expect(owner.used).toBe(0)
})
