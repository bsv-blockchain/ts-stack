import { describe, expect, it } from '@jest/globals'
import { safeLegacyLogArguments } from './logger.js'

describe('diagnostic containment', () => {
  it('keeps fixed scalar signals without inspecting arbitrary caught objects', () => {
    let accessorReads = 0
    const hostile = Object.defineProperty({}, 'message', {
      enumerable: true,
      get: () => {
        accessorReads += 1
        return 'secret database query'
      }
    })

    expect(safeLegacyLogArguments(['fixed signal', hostile, 42, true])).toEqual([
      'fixed signal',
      42,
      true
    ])
    expect(accessorReads).toBe(0)
  })
})
