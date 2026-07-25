import { ExpressTransport } from '../index'

describe('ExpressTransport configuration', () => {
  it('exposes allowUnauthenticated and preserves the legacy alias', () => {
    const transport = new ExpressTransport(true)

    expect(transport.allowUnauthenticated).toBe(true)
    expect(transport.allowAuthenticated).toBe(true)

    transport.allowAuthenticated = false
    expect(transport.allowUnauthenticated).toBe(false)
  })
})
