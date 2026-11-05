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
  it('revokes an unfunded session grant for the originator without a token transaction', async () => {
    const first = ensureProto()
    await tick()
    await expect(manager.grantPermission({ requestID: requestIDs[0] })).rejects.toThrow(WERR_INSUFFICIENT_FUNDS)
    await first
    await expect(manager.revokeAllForOriginator(ORIGIN)).resolves.toEqual([])
    await expect(
      manager.ensureProtocolPermission({ ...PROTO, privileged: false, usageType: 'signing', seekPermission: false })
    ).rejects.toThrow(/No protocol permission/)
    expect(mints()).toBe(1)
  })

  it('does not carry an unfunded grant into a new manager', async () => {
    const first = ensureProto()
    await tick()
    await expect(manager.grantPermission({ requestID: requestIDs[0] })).rejects.toThrow(WERR_INSUFFICIENT_FUNDS)
    await first
    const restarted = new WalletPermissionsManager(underlying, 'admin.test.com')
    ;(restarted as any).findProtocolToken = jest.fn().mockResolvedValue(undefined)
    await expect(
      restarted.ensureProtocolPermission({ ...PROTO, privileged: false, usageType: 'signing', seekPermission: false })
    ).rejects.toThrow(/No protocol permission/)
  })

  it.each([
    { originator: 'other.example.com' },
    { protocolID: [1, 'otherproto'] as [number, string] },
    { privileged: true }
  ])('does not broaden the approved protocol grant: %j', async changed => {
    const first = ensureProto()
    await tick()
    await expect(manager.grantPermission({ requestID: requestIDs[0] })).rejects.toThrow(WERR_INSUFFICIENT_FUNDS)
    await first
    await expect(
      manager.ensureProtocolPermission({
        ...PROTO,
        privileged: false,
        ...changed,
        usageType: 'signing',
        seekPermission: false
      })
    ).rejects.toThrow(/No protocol permission/)
  })

  it('does not turn an unfunded grouped spending authorization into standing permission', async () => {
    const granted = {
      protocolPermissions: [{ protocolID: [1, 'testproto'] as [number, string], description: 'sign' }],
      spendingAuthorization: { amount: 1000, description: 'spend' }
    }
    jest.spyOn(manager as any, 'fetchManifestGroupPermissions').mockResolvedValue(granted)
    const auth = manager.waitForAuthentication({}, ORIGIN)
    await tick()
    await expect(manager.grantGroupedPermission({ requestID: groupRequestIDs[0], granted })).rejects.toThrow(
      WERR_INSUFFICIENT_FUNDS
    )
    await expect(auth).resolves.toEqual({ authenticated: true })
    await expect(ensureProto()).resolves.toBe(true)
    await expect(
      manager.ensureSpendingAuthorization({ originator: ORIGIN, satoshis: 1, seekPermission: false })
    ).rejects.toThrow(/No spending authorization/)
  })

  it('resumes an unfunded counterparty grant only for the approved counterparty', async () => {
    const counterparty = '02' + '11'.repeat(32)
    const protocols = [{ protocolName: 'peerproto', description: 'sign' }]
    const requestID = 'pact-test'
    let resolve!: (value: boolean) => void
    let reject!: (error: unknown) => void
    const waiting = new Promise<boolean>((yes, no) => {
      resolve = yes
      reject = no
    })
    ;(manager as any).activeRequests.set(requestID, {
      request: { originator: ORIGIN, counterparty, permissions: { protocols } },
      pending: [{ resolve, reject }]
    })
    await expect(manager.grantCounterpartyPermission({ requestID, granted: { protocols } })).rejects.toThrow(
      WERR_INSUFFICIENT_FUNDS
    )
    await expect(waiting).resolves.toBe(true)
    const check = {
      originator: ORIGIN,
      privileged: false,
      protocolID: [2, 'peerproto'] as [number, string],
      counterparty,
      seekPermission: false,
      usageType: 'signing' as const
    }
    await expect(manager.ensureProtocolPermission(check)).resolves.toBe(true)
    await expect(manager.ensureProtocolPermission({ ...check, counterparty: '03' + '22'.repeat(32) })).rejects.toThrow(
      /No protocol permission/
    )
  })

  it('honors selective revocation and normalized originators for session grants', async () => {
    const granted = {
      protocolPermissions: [{ protocolID: [1, 'testproto'] as [number, string], description: 'sign' }],
      basketAccess: [{ basket: 'todo tokens', description: 'store' }]
    }
    jest.spyOn(manager as any, 'fetchManifestGroupPermissions').mockResolvedValue(granted)
    const auth = manager.waitForAuthentication({}, ORIGIN)
    await tick()
    await expect(manager.grantGroupedPermission({ requestID: groupRequestIDs[0], granted })).rejects.toThrow(
      WERR_INSUFFICIENT_FUNDS
    )
    await auth
    const basket = { originator: ORIGIN, basket: 'todo tokens', seekPermission: false, usageType: 'listing' as const }
    await manager.revokeAllForOriginator(ORIGIN.toUpperCase(), { protocol: false })
    await expect(ensureProto()).resolves.toBe(true)
    await expect(manager.ensureBasketAccess(basket)).rejects.toThrow(/No basket permission/)
    await manager.revokeAllForOriginator('other.example.com')
    await expect(ensureProto()).resolves.toBe(true)
  })

  it('keeps certificate disclosure limited to the approved fields', async () => {
    ;(manager as any).findCertificateToken = jest.fn().mockResolvedValue(undefined)
    const ids: string[] = []
    manager.bindCallback('onCertificateAccessRequested', request => {
      ids.push(request.requestID)
    })
    const args = {
      originator: ORIGIN,
      privileged: false,
      verifier: '02' + '11'.repeat(32),
      certType: 'test certificate',
      fields: ['name'],
      usageType: 'disclosure' as const
    }
    const first = manager.ensureCertificateAccess(args)
    await tick()
    await expect(manager.grantPermission({ requestID: ids[0] })).rejects.toThrow(WERR_INSUFFICIENT_FUNDS)
    await expect(first).resolves.toBe(true)
    await expect(manager.ensureCertificateAccess({ ...args, seekPermission: false })).resolves.toBe(true)
    await expect(
      manager.ensureCertificateAccess({ ...args, fields: ['name', 'email'], seekPermission: false })
    ).rejects.toThrow(/No certificate permission/)
  })
})
