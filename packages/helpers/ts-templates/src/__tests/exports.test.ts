import { MandalaToken, MandalaAdmin } from '../../mod.js'

describe('package exports', () => {
  it('exposes the Mandala templates from the package entrypoint', () => {
    expect(typeof MandalaToken).toBe('function')
    expect(typeof MandalaAdmin).toBe('function')
    expect(typeof MandalaAdmin.canonicalize).toBe('function')
  })
})
