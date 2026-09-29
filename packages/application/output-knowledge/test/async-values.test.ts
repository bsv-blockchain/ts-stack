import { describe, it, expect } from '@jest/globals'
import { asyncValues } from '../src/internal/asyncValues.js'

describe('asynchronous pulls of synchronous values', () => {
  it('pulls lazily, preserves order and closes the source on early exit', async () => {
    const trace: string[] = []
    function* values() {
      try {
        trace.push('first')
        yield 1
        trace.push('second')
        yield 2
      } finally {
        trace.push('closed')
      }
    }
    const source = asyncValues(values())
    expect(trace).toEqual([])
    for await (const value of source) {
      expect(value).toBe(1)
      expect(trace).toEqual(['first'])
      break
    }
    expect(trace).toEqual(['first', 'closed'])
  })

  it('never reads a host value as a thenable and supports ordinary iterators', async () => {
    const value = new Proxy(
      { name: 'host' },
      {
        get(target, property, receiver) {
          if (property === 'then') throw new Error('Unexpected thenable assimilation')
          return Reflect.get(target, property, receiver)
        }
      }
    )
    const iterator = asyncValues([value])[Symbol.asyncIterator]()
    expect((await iterator.next()).value).toBe(value)
    expect(await iterator.next()).toEqual({ done: true, value: undefined })
    expect(await iterator.return!()).toEqual({ done: true, value: undefined })
  })

  it('rejects with the original iteration and closure errors', async () => {
    const failure = new Error('iteration failed')
    const source: Iterable<number> = {
      [Symbol.iterator]() {
        return {
          next() {
            throw failure
          },
          return() {
            throw failure
          }
        }
      }
    }
    const iterator = asyncValues(source)[Symbol.asyncIterator]()
    await expect(iterator.next()).rejects.toBe(failure)
    await expect(iterator.return!()).rejects.toBe(failure)
  })
})
