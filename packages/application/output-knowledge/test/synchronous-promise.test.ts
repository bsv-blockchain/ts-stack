import { describe, it, expect } from '@jest/globals'
import { synchronousPromise } from '../src/internal/synchronousPromise.js'

describe('synchronous driver Promise adaptation', () => {
  it('performs work exactly once before returning, with asynchronous promise reactions', async () => {
    const order: string[] = []
    const promise = synchronousPromise(() => {
      order.push('work')
      return 7
    })
    const reaction = promise.then(value => {
      order.push('reaction')
      return value
    })
    order.push('returned')
    expect(order).toEqual(['work', 'returned'])
    expect(await reaction).toBe(7)
    expect(order).toEqual(['work', 'returned', 'reaction'])
  })

  it('turns the original synchronous failure into a rejection without throwing from the port', async () => {
    const error = new Error('Storage failed')
    let result: Promise<never> | undefined
    expect(() => {
      result = synchronousPromise(() => {
        throw error
      })
    }).not.toThrow()
    await expect(result).rejects.toBe(error)
  })
})
