import { ExpressTransport } from '../index'

describe('ExpressTransport configuration', () => {
  it('exposes allowUnauthenticated and preserves the legacy alias', () => {
    const transport = new ExpressTransport(true)

    expect(transport.allowUnauthenticated).toBe(true)
    expect(transport.allowAuthenticated).toBe(true)

    transport.allowAuthenticated = false
    expect(transport.allowUnauthenticated).toBe(false)
  })

  it('uses allowUnauthenticated when requests have no authentication headers', () => {
    const transport = new ExpressTransport(true)
    const req: any = {}
    const res: any = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis()
    }
    const next = jest.fn()

    ;(transport as any).handleUnauthenticated(req, res, next)

    expect(req.auth).toEqual({ identityKey: 'unknown' })
    expect(next).toHaveBeenCalledTimes(1)
    expect(res.status).not.toHaveBeenCalled()
  })
})
