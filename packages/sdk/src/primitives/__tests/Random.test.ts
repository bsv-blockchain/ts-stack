/* eslint-env jest */
import Random from '../../primitives/Random'

describe('Random', () => {
  it('Produces random bytes of correct length', () => {
    expect(Random(3).length).toBe(3)
    expect(Random(10).length).toBe(10)
  })
  it('Does not produce the same thing every time', () => {
    // While this test may fail once every few hundred trillion years or so,
    // I haven't seen it fail yet. If you see it fail, please let me know.
    expect(Random(32)).not.toEqual(Random(32))
  })
  it('Produces values in valid byte range (0-255)', () => {
    const bytes = Random(100)
    bytes.forEach(byte => {
      expect(byte).toBeGreaterThanOrEqual(0)
      expect(byte).toBeLessThanOrEqual(255)
    })
  })
  it('Works with various lengths including edge cases', () => {
    expect(Random(1).length).toBe(1)
    expect(Random(16).length).toBe(16)
    expect(Random(32).length).toBe(32)
    expect(Random(64).length).toBe(64)
    expect(Random(256).length).toBe(256)
  })
  it('Returns an array of numbers', () => {
    const bytes = Random(10)
    expect(Array.isArray(bytes)).toBe(true)
    bytes.forEach(byte => {
      expect(typeof byte).toBe('number')
    })
  })
})
