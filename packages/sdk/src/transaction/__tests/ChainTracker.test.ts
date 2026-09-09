import ChainTracker, { isChainTracker } from '../ChainTracker'

describe('isChainTracker', () => {
  const tracker: ChainTracker = {
    isValidRootForHeight: async () => true,
    currentHeight: async () => 0
  }

  it('accepts an object with the required methods', () => {
    expect(isChainTracker(tracker)).toBe(true)
    if (isChainTracker(tracker)) {
      expect(typeof tracker.isValidRootForHeight).toBe('function')
      expect(typeof tracker.currentHeight).toBe('function')
    }
  })

  it('rejects nullish and non-object values', () => {
    expect(isChainTracker(null)).toBe(false)
    expect(isChainTracker(undefined)).toBe(false)
    expect(isChainTracker('tracker')).toBe(false)
    expect(isChainTracker(1)).toBe(false)
  })

  it('rejects objects missing a required method', () => {
    expect(isChainTracker({})).toBe(false)
    expect(isChainTracker({ isValidRootForHeight: async () => true })).toBe(false)
    expect(isChainTracker({ currentHeight: async () => 0 })).toBe(false)
  })
})
