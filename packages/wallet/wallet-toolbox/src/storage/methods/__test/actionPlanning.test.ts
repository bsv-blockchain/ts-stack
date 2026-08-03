import { CanonicalChangeSelector, selectCanonicalChange } from '../actionPlanning'

describe('CanonicalChangeSelector', () => {
  test('matches the stateless canonical policy across allocation and release cycles', () => {
    const candidates = Array.from({ length: 200 }, (_, index) => ({
      outputId: index + 1,
      satoshis: ((index * 37) % 23 + 1) * 100
    }))
    const selector = new CanonicalChangeSelector(candidates)
    const remaining = new Set(candidates.map(candidate => candidate.outputId))
    const allocated: number[] = []
    const requests = Array.from({ length: 180 }, (_, index) => ({
      target: ((index * 61) % 29 + 1) * 90,
      exact: index % 7 === 0 ? ((index * 17) % 23 + 1) * 100 : undefined
    }))

    for (let index = 0; index < requests.length; index++) {
      if (index > 0 && index % 11 === 0 && allocated.length > 0) {
        const released = allocated.shift()!
        remaining.add(released)
        selector.release(released)
      }
      const request = requests[index]
      const expected = selectCanonicalChange(
        candidates.filter(candidate => remaining.has(candidate.outputId)),
        request.target,
        request.exact
      )
      const actual = selector.take(request.target, request.exact)
      expect(actual).toEqual(expected)
      if (expected != null) {
        remaining.delete(expected.outputId)
        allocated.push(expected.outputId)
      }
    }
  })

  test('preserves exact, least-over, and largest-under tie ordering', () => {
    const candidates = [
      { outputId: 4, satoshis: 100 },
      { outputId: 2, satoshis: 100 },
      { outputId: 3, satoshis: 200 },
      { outputId: 1, satoshis: 200 }
    ]
    const selector = new CanonicalChangeSelector(candidates)

    expect(selector.take(150, 100)?.outputId).toBe(2)
    expect(selector.take(150)?.outputId).toBe(1)
    expect(selector.take(250)?.outputId).toBe(3)
    expect(selector.take(250)?.outputId).toBe(4)
    expect(selector.take(1)).toBeUndefined()
  })
})
