import { compareCodeUnits } from '../code-unit-order'

const canonical = ['', '10', '2', 'A', 'Z', 'a', 'z', 'ä', '\ud800', '😀', '\ue000']

describe('canonical certificate field order', () => {
  it('preserves historical code-unit order across reversed and duplicate field lists', () => {
    expect([...canonical].reverse().sort(compareCodeUnits)).toEqual(canonical)
    expect([...canonical, ...canonical].sort(compareCodeUnits)).toEqual(
      canonical.flatMap(key => [key, key])
    )
  })

  it('is reflexive, antisymmetric and transitive for every canonical pair', () => {
    for (let left = 0; left < canonical.length; left++) {
      for (let right = 0; right < canonical.length; right++) {
        expect(compareCodeUnits(canonical[left], canonical[right])).toBe(Math.sign(left - right))
        for (let last = right; last < canonical.length; last++) {
          if (left <= right)
            expect(compareCodeUnits(canonical[left], canonical[last])).toBeLessThanOrEqual(0)
        }
      }
    }
  })
})
