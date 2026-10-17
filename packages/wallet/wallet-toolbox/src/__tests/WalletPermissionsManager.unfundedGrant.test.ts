/**
 * Grants made in a wallet that cannot fund the permission token.
 *
 * A permission token costs a little to mint. A wallet with no spendable coins
 * fails that mint with WERR_INSUFFICIENT_FUNDS, and the user's decision used to
 * be dropped with it: the next identical call prompted again, and a grouped
 * grant rejected the call that was waiting on it. These tests pin the fixed
 * behavior:
 *  - an unfunded grant is kept for the session, so the user is not asked again
 *  - the grant call still reports the funding error (nothing was persisted)
 *  - a grouped grant resumes its waiting call and is not asked again
 *  - spending authorizations are never kept without their token
 *  - any other mint failure still re-opens the prompt (see mintdedup tests)
 */
import { MockedBSV_SDK } from './WalletPermissionsManager.fixtures'

jest.mock('@bsv/sdk', () => MockedBSV_SDK)

import { WalletPermissionsManager } from '../WalletPermissionsManager'
import { WERR_INSUFFICIENT_FUNDS } from '../sdk/WERR_errors'
import { mockUnderlyingWallet } from './WalletPermissionsManager.fixtures'

const ORIGIN = 'app.example.com'
const PROTO = { originator: ORIGIN, protocolID: [1, 'testproto'] as [number, string], counterparty: 'self' }

const tick = async (ms = 20): Promise<void> => await new Promise(resolve => setTimeout(resolve, ms))

describe('WalletPermissionsManager grants in an unfunded wallet', () => {
  let underlying: jest.Mocked<any>
  let manager: WalletPermissionsManager
  let promptCount: number
  let requestIDs: string[]
  let groupRequestIDs: string[]

  const ensureProto = async (usageType: any = 'signing'): Promise<boolean> =>
    await manager.ensureProtocolPermission({
      ...PROTO,
      privileged: false,
      reason: 't',
      seekPermission: true,
      usageType
    })

  const mints = (): number => underlying.createAction.mock.calls.length

  beforeEach(() => {
    underlying = mockUnderlyingWallet()
    underlying.createAction.mockRejectedValue(new WERR_INSUFFICIENT_FUNDS(1001, 1001))
    manager = new WalletPermissionsManager(underlying, 'admin.test.com', {
      seekProtocolPermissionsForSigning: true,
      seekGroupedPermission: true
    })
    ;(manager as any).findProtocolToken = jest.fn().mockResolvedValue(undefined)
    ;(manager as any).findBasketToken = jest.fn().mockResolvedValue(undefined)
    ;(manager as any).findSpendingToken = jest.fn().mockResolvedValue(undefined)
    promptCount = 0
    requestIDs = []
    groupRequestIDs = []
    manager.bindCallback('onProtocolPermissionRequested', (req: any) => {
      promptCount++
      requestIDs.push(req.requestID)
    })
    manager.bindCallback('onGroupedPermissionRequested', (req: any) => {
      groupRequestIDs.push(req.requestID)
    })
  })

  afterEach(() => jest.restoreAllMocks())

  it('keeps an unfunded protocol grant for the session instead of asking again', async () => {
    const ensure1 = ensureProto()
    await tick()
    expect(promptCount).toBe(1)

    await expect(manager.grantPermission({ requestID: requestIDs[0] })).rejects.toThrow(WERR_INSUFFICIENT_FUNDS)
    await expect(ensure1).resolves.toBe(true)

    // The same permission is used again, past the short post-grant window.
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 60 * 1000)
    const ensure2 = ensureProto()
    await tick()
    expect(promptCount).toBe(1)
    await expect(ensure2).resolves.toBe(true)
    expect(mints()).toBe(1)
  })

  it('does not keep an unfunded grant past its expiry', async () => {
    const ensure1 = ensureProto()
    await tick()
    const expiry = Math.floor(Date.now() / 1000) + 60
    await expect(manager.grantPermission({ requestID: requestIDs[0], expiry })).rejects.toThrow(WERR_INSUFFICIENT_FUNDS)
    await ensure1

    jest.spyOn(Date, 'now').mockReturnValue((expiry + 1) * 1000)
    const ensure2 = ensureProto()
    await tick()
    expect(promptCount).toBe(2)
    await manager.denyPermission(requestIDs[1])
    await expect(ensure2).rejects.toThrow('Permission denied.')
  })

  it('resumes the call waiting on an unfunded grouped grant and does not ask again', async () => {
    jest.spyOn(manager as any, 'fetchManifestGroupPermissions').mockResolvedValue({
      protocolPermissions: [{ protocolID: [1, 'testproto'], description: 'sign' }],
      basketAccess: [{ basket: 'todo tokens', description: 'store' }]
    })

    const auth1 = manager.waitForAuthentication({}, ORIGIN)
    await tick()
    expect(groupRequestIDs).toHaveLength(1)

    await expect(
      manager.grantGroupedPermission({
        requestID: groupRequestIDs[0],
        granted: {
          protocolPermissions: [{ protocolID: [1, 'testproto'], description: 'sign' }],
          basketAccess: [{ basket: 'todo tokens', description: 'store' }]
        }
      })
    ).rejects.toThrow(WERR_INSUFFICIENT_FUNDS)
    await expect(auth1).resolves.toEqual({ authenticated: true })

    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 60 * 1000)
    const auth2 = manager.waitForAuthentication({}, ORIGIN)
    const ensure = ensureProto()
    await tick()
    expect(groupRequestIDs).toHaveLength(1)
    expect(promptCount).toBe(0)
    await expect(auth2).resolves.toEqual({ authenticated: true })
    await expect(ensure).resolves.toBe(true)
    await expect(
      manager.ensureBasketAccess({
        originator: ORIGIN,
        basket: 'todo tokens',
        seekPermission: false,
        usageType: 'insertion'
      })
    ).resolves.toBe(true)
    expect(groupRequestIDs).toHaveLength(1)
    expect(promptCount).toBe(0)
  })

  it('never keeps a spending authorization without its token', async () => {
    const spendingRequest = { type: 'spending', originator: ORIGIN, spending: { satoshis: 1000 }, renewal: false }
    ;(manager as any).activeRequests.set('spend-1', { request: spendingRequest, pending: [] })

    await expect(manager.grantPermission({ requestID: 'spend-1', amount: 1000 })).rejects.toThrow(
      WERR_INSUFFICIENT_FUNDS
    )
    expect((manager as any).sessionGrants.size).toBe(0)
  })
})
