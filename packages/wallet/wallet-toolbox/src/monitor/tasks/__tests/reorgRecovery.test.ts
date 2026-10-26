import { ReorgRecovery } from '../../reorgRecovery'

describe('bounded durable reorg recovery ranges', () => {
  test('round trips maximum-height fragmentation under the monitor event bound without losing work', () => {
    const queue = new ReorgRecovery()
    const heights = Array.from({ length: 1000 }, (_, i) => (i === 0 ? 0 : 2_000_000_000 + i * 2))
    for (const height of heights) queue.add(height, height)
    expect(queue.ranges.length).toBeLessThanOrEqual(128)
    const details = JSON.stringify(queue)
    expect(details.length).toBeLessThan(8192)
    const restored = ReorgRecovery.parse(details)!
    for (const height of heights)
      expect(restored.ranges.some(([min, max]) => min <= height && height <= max)).toBe(true)
  })

  test('rotates failures behind waiting heights and preserves above-tip work', () => {
    const queue = new ReorgRecovery()
    queue.add(10, 20)
    expect(queue.next(20, 2)).toEqual([10, 11])
    queue.complete([10, 11], [10])
    expect(queue.next(20, 2)).toEqual([12, 13])
    const restored = ReorgRecovery.parse(JSON.stringify(queue))!
    expect(restored.next(11, 2)).toEqual([10, 10])
    restored.complete([10, 10], [])
    expect(restored.next(11, 2)).toBeUndefined()
    expect(restored.next(20, 0)).toBeUndefined()
    expect(restored.next(20, 2)).toEqual([12, 13])
  })

  test('splitting a full range queue remains bounded even with no failures', () => {
    const queue = new ReorgRecovery()
    for (let i = 0; i < 128; i++) queue.add(i * 100, i * 100 + 20)
    queue.complete([5, 10], [])
    expect(queue.ranges.length).toBeLessThanOrEqual(128)
    expect(ReorgRecovery.parse(JSON.stringify(queue))).toBeDefined()
    expect(queue.ranges.some(([min, max]) => min <= 0 && max >= 0)).toBe(true)
    expect(queue.ranges.some(([min, max]) => min <= 20 && max >= 20)).toBe(true)
  })

  test('maximum height wraps the fairness cursor safely', () => {
    const queue = new ReorgRecovery()
    queue.add(2_147_483_647, 2_147_483_647)
    queue.complete([2_147_483_647, 2_147_483_647], [2_147_483_647])
    expect(queue.cursor).toBe(0)
    expect(queue.next(2_147_483_647, 1)).toEqual([2_147_483_647, 2_147_483_647])
  })

  test.each([
    '[]',
    '{}',
    '{',
    JSON.stringify({ ranges: [[-1, 2]], cursor: 0 }),
    JSON.stringify({ ranges: [[2, 1]], cursor: 0 }),
    JSON.stringify({ ranges: [[1, 2.5]], cursor: 0 }),
    JSON.stringify({ ranges: [[1, 2]], cursor: -1 }),
    JSON.stringify({ ranges: Array(129).fill([1, 2]), cursor: 0 }),
    JSON.stringify({ ranges: [], cursor: 0, reviewedHash: 1 }),
    ' '.repeat(8193)
  ])('rejects malformed checkpoint %s', details => {
    expect(ReorgRecovery.parse(details)).toBeUndefined()
  })
})
