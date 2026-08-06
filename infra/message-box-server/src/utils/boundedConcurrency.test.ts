import { mapWithConcurrency } from './boundedConcurrency.js'

describe('mapWithConcurrency', () => {
  it('preserves order while bounding active work', async () => {
    let active = 0
    let maximumActive = 0
    const results = await mapWithConcurrency([3, 1, 2, 4], 2, async value => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await Promise.resolve()
      active -= 1
      return value * 2
    })

    expect(results).toEqual([6, 2, 4, 8])
    expect(maximumActive).toBe(2)
  })

  it('accepts the explicit unlimited opt-out and rejects invalid limits', async () => {
    await expect(mapWithConcurrency([1, 2], -1, async value => value)).resolves.toEqual([1, 2])
    await expect(mapWithConcurrency([1], 0, async value => value)).rejects.toThrow(
      'concurrency must be -1 or a positive safe integer'
    )
  })
})
