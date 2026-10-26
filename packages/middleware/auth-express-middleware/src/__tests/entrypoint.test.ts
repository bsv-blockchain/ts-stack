import {
  ExpressTransport,
  InMemoryCertificateApprovalStore,
  createAuthMiddleware
} from '../../mod.js'

describe('public entrypoint', () => {
  it('exports the authenticated transport, approval store, and middleware factory', () => {
    expect(ExpressTransport).toBeDefined()
    expect(InMemoryCertificateApprovalStore).toBeDefined()
    expect(createAuthMiddleware).toBeDefined()
  })
})
