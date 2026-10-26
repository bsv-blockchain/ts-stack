import { eachInOrder } from '../inOrder.js'

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve = (): void => {}
  const promise = new Promise<void>(r => {
    resolve = r
  })
  return { promise, resolve }
}

describe('eachInOrder', () => {
  it('starts each step only after the previous one has finished', async () => {
    const log: string[] = []
    const gate = deferred()
    const run = eachInOrder(['a', 'b', 'c'], async item => {
      log.push(`start ${item}`)
      if (item === 'a') await gate.promise
      log.push(`end ${item}`)
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(log).toEqual(['start a'])
    gate.resolve()
    await run
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c'])
  })

  it('rejects with the first error itself and runs no later step', async () => {
    const failure = new Error('step b')
    const seen: string[] = []
    const run = eachInOrder(['a', 'b', 'c'], async item => {
      seen.push(item)
      if (item === 'b') throw failure
    })
    await expect(run).rejects.toBe(failure)
    expect(seen).toEqual(['a', 'b'])
  })

  it('accepts any iterable, synchronous steps and an empty input', async () => {
    const seen: number[] = []
    await eachInOrder(new Set([3, 1, 2]).values(), item => {
      seen.push(item)
    })
    await eachInOrder([], () => {
      throw new Error('never called')
    })
    expect(seen).toEqual([3, 1, 2])
  })
})
