/**
 * Denial error-code regression tests.
 *
 * The permissions spec requires denied operations to fail with the canonical
 * ERR_PERMISSION_DENIED code. Historically the individual denyPermission path
 * rejected with a plain Error (message only) while denyGroupedPermission /
 * denyCounterpartyPermission attached the code — these tests pin parity.
 */
import { MockedBSV_SDK } from './WalletPermissionsManager.fixtures'

jest.mock('@bsv/sdk', () => MockedBSV_SDK)

import { WalletPermissionsManager } from '../WalletPermissionsManager'
import { mockUnderlyingWallet } from './WalletPermissionsManager.fixtures'

describe('denial error codes', () => {
  let underlying: jest.Mocked<any>
  let manager: WalletPermissionsManager
  let requestIDs: string[]

  beforeEach(() => {
    underlying = mockUnderlyingWallet()
    manager = new WalletPermissionsManager(underlying, 'admin.test.com')
    requestIDs = []
    manager.bindCallback('onProtocolPermissionRequested', (req: any) => {
      requestIDs.push(req.requestID)
    })
  })

  const ensure = () =>
    manager.ensureProtocolPermission({
      originator: 'app.example.com',
      privileged: false,
      protocolID: [1, 'denial test'],
      counterparty: 'self',
      reason: 't',
      seekPermission: true,
      usageType: 'generic'
    })

  it('individual denyPermission rejects with ERR_PERMISSION_DENIED', async () => {
    const call = ensure()
    await new Promise(r => setTimeout(r, 20))
    expect(requestIDs).toHaveLength(1)

    await manager.denyPermission(requestIDs[0])

    await expect(call).rejects.toMatchObject({
      message: expect.stringMatching(/Permission denied/i),
      code: 'ERR_PERMISSION_DENIED'
    })
  })

  it('denyGroupedPermission rejects with ERR_PERMISSION_DENIED (parity)', async () => {
    // Seed a grouped active request directly; the grouped prompt flow itself
    // is covered elsewhere — this pins the rejection shape.
    let rejection: unknown
    const pending = new Promise((_, reject) => {
      ;(manager as any).activeRequests.set('group-1', {
        request: { type: 'protocol', originator: 'app.example.com' },
        pending: [{ resolve: () => {}, reject }]
      })
    })
    pending.catch(e => { rejection = e })

    await (manager as any).denyGroupedPermission('group-1')
    await new Promise(r => setTimeout(r, 10))

    expect((rejection as any)?.code).toBe('ERR_PERMISSION_DENIED')
  })
})
