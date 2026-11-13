import { describe, expect, it } from '@jest/globals'
import { eachInOrder, mapInOrder } from '../inOrder.js'

const tick = async (): Promise<void> => await new Promise(resolve => setTimeout(resolve, 0))

describe('eachInOrder', () => {
  it('starts each step only after the previous one finishes', async () => {
    const events: string[] = []
    await eachInOrder([1, 2, 3], async item => {
      events.push(`start ${item}`)
      await tick()
      events.push(`end ${item}`)
    })
    expect(events).toEqual(['start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3'])
  })

  it('stops at the first throw and rejects with that error', async () => {
    const seen: number[] = []
    await expect(
      eachInOrder([1, 2, 3], async item => {
        seen.push(item)
        await tick()
        if (item >= 2) throw new Error(`refused ${item}`)
      })
    ).rejects.toThrow('refused 2')
    expect(seen).toEqual([1, 2])
  })

  it('accepts synchronous steps and empty input', async () => {
    const seen: number[] = []
    await eachInOrder(new Set([4, 5]), item => {
      seen.push(item)
    })
    await eachInOrder([], () => {
      throw new Error('never called')
    })
    expect(seen).toEqual([4, 5])
  })
})

describe('mapInOrder', () => {
  it('collects results in item order with their indexes', async () => {
    const results = await mapInOrder(['a', 'b', 'c'], async (item, index) => {
      await new Promise(resolve => setTimeout(resolve, 3 - index))
      return `${index}:${item}`
    })
    expect(results).toEqual(['0:a', '1:b', '2:c'])
  })

  it('rejects with the first step error', async () => {
    await expect(
      mapInOrder([1, 2], item => {
        if (item === 1) throw new Error('first')
        return item
      })
    ).rejects.toThrow('first')
  })
})
