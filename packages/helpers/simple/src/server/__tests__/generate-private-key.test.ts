import { generatePrivateKey } from '../generate-private-key'

describe('generatePrivateKey', () => {
  it('returns a 64-char lowercase hex string', () => {
    const key = generatePrivateKey()
    expect(typeof key).toBe('string')
    expect(key).toHaveLength(64)
    expect(key).toMatch(/^[0-9a-f]{64}$/)
  })

  it('returns a different key on each invocation (random)', () => {
    const a = generatePrivateKey()
    const b = generatePrivateKey()
    const c = generatePrivateKey()
    // Astronomically unlikely to collide; if these match the impl is broken.
    expect(a).not.toBe(b)
    expect(b).not.toBe(c)
    expect(a).not.toBe(c)
  })
})
