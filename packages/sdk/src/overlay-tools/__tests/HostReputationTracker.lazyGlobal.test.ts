describe('global overlay host reputation tracker', () => {
  test('reads localStorage on first use, not when the module is imported', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    let reads = 0
    const items = new Map<string, string>()
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => {
        reads++
        return {
          getItem: (key: string) => items.get(key) ?? null,
          setItem: (key: string, value: string) => items.set(key, value)
        }
      }
    })
    try {
      jest.isolateModules(() => {
        const { getOverlayHostReputationTracker } = require('../HostReputationTracker')
        expect(reads).toBe(0)
        const tracker = getOverlayHostReputationTracker()
        expect(reads).toBeGreaterThan(0)
        expect(getOverlayHostReputationTracker()).toBe(tracker)
      })
    } finally {
      if (original != null) Object.defineProperty(globalThis, 'localStorage', original)
      else delete (globalThis as any).localStorage
    }
  })
})
