import { mockUnderlyingWallet, MockedBSV_SDK } from './WalletPermissionsManager.fixtures'
import { WalletPermissionsManager, type PermissionToken } from '../WalletPermissionsManager'

jest.mock('@bsv/sdk', () => MockedBSV_SDK)

describe('WalletPermissionsManager spending authorization security', () => {
  const originator = 'shopper.example.com'
  const token: PermissionToken = {
    tx: [],
    txid: 'dsap-token',
    outputIndex: 0,
    outputScript: 'scriptHex',
    satoshis: 1,
    originator,
    authorizedAmount: 500,
    expiry: 0
  }

  it('recalculates monthly usage for repeated equal-value spends', async () => {
    const underlying = mockUnderlyingWallet()
    const manager = new WalletPermissionsManager(underlying, 'admin.example.com', {
      seekGroupedPermission: false
    })
    jest.spyOn(manager as any, 'findSpendingToken').mockResolvedValue(token)
    const query = jest.spyOn(manager, 'querySpentSince').mockResolvedValueOnce(400).mockResolvedValueOnce(500)

    await expect(
      manager.ensureSpendingAuthorization({ originator, satoshis: 100, seekPermission: false })
    ).resolves.toBe(true)
    await expect(
      manager.ensureSpendingAuthorization({ originator, satoshis: 100, seekPermission: false })
    ).rejects.toThrow(/insufficient/)

    expect(query).toHaveBeenCalledTimes(2)
  })

  it('requires a distinct approval for each concurrent spending request', async () => {
    const underlying = mockUnderlyingWallet()
    const manager = new WalletPermissionsManager(underlying, 'admin.example.com', {
      seekGroupedPermission: false
    })
    jest.spyOn(manager as any, 'findSpendingToken').mockResolvedValue(undefined)

    const requestIDs: string[] = []
    manager.bindCallback('onSpendingAuthorizationRequested', request => {
      requestIDs.push(request.requestID)
    })

    const first = manager.ensureSpendingAuthorization({ originator, satoshis: 100 })
    const second = manager.ensureSpendingAuthorization({ originator, satoshis: 100 })

    await new Promise(resolve => setImmediate(resolve))
    expect(requestIDs).toHaveLength(2)
    expect(new Set(requestIDs).size).toBe(2)

    let secondSettled = false
    void second.finally(() => {
      secondSettled = true
    })

    await manager.grantPermission({ requestID: requestIDs[0], ephemeral: true })
    await expect(first).resolves.toBe(true)
    await Promise.resolve()
    expect(secondSettled).toBe(false)

    await manager.grantPermission({ requestID: requestIDs[1], ephemeral: true })
    await expect(second).resolves.toBe(true)
  })

  it('counts every page of monthly actions', async () => {
    const underlying = mockUnderlyingWallet()
    underlying.listActions.mockImplementation(async ({ limit, offset }: { limit?: number; offset?: number }) => {
      expect(limit).toBe(10000)
      if (offset === 0) {
        return {
          totalActions: 12,
          actions: Array.from({ length: 10 }, () => ({ satoshis: -1 }))
        }
      }
      if (offset === 10) {
        return {
          totalActions: 12,
          actions: [{ satoshis: -2 }, { satoshis: -2 }]
        }
      }
      throw new Error(`unexpected offset ${offset}`)
    })

    const manager = new WalletPermissionsManager(underlying, 'admin.example.com')
    await expect(manager.querySpentSince(token)).resolves.toBe(14)
    expect(underlying.listActions).toHaveBeenCalledTimes(2)
  })
})
