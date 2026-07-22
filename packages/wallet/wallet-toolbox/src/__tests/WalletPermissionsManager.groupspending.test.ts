import { mockUnderlyingWallet, MockedBSV_SDK } from './WalletPermissionsManager.fixtures'
import { WalletPermissionsManager, PermissionToken } from '../WalletPermissionsManager'

jest.mock('@bsv/sdk', () => MockedBSV_SDK)

/**
 * A standing spending authorization is a grant regardless of how much of the
 * monthly allowance has been used — renewal on exhaustion is handled at spend
 * time by ensureSpendingAuthorization. The grouped-permission filter must not
 * treat a partially used authorization as "not granted": doing so re-raises
 * the grouped prompt asking for spending the user already approved (and
 * approving it again mints a duplicate DSAP token).
 */
describe('WalletPermissionsManager - grouped flow spending re-request', () => {
  let underlying: jest.Mocked<any>
  let manager: WalletPermissionsManager

  const ORIGINATOR = 'app.example.com'

  const dsapToken: PermissionToken = {
    tx: [],
    txid: 'dsap-standing',
    outputIndex: 0,
    outputScript: 'scriptHex',
    satoshis: 1,
    originator: ORIGINATOR,
    authorizedAmount: 10000,
    expiry: 0
  }

  const groupPermissions = {
    description: 'test app',
    spendingAuthorization: { amount: 10000, description: 'monthly allowance' }
  }

  beforeEach(() => {
    underlying = mockUnderlyingWallet()
    manager = new WalletPermissionsManager(underlying, 'admin.com')
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  it('does not re-request spending after part of the monthly allowance is used', async () => {
    jest.spyOn(manager as any, 'findSpendingToken').mockResolvedValue(dsapToken)
    // Any nonzero usage made the old headroom check (spent + amount <= amount)
    // unsatisfiable, so the grouped flow re-requested spending forever.
    jest.spyOn(manager as any, 'querySpentSince').mockResolvedValue(500)

    const filtered = await (manager as any).filterAlreadyGrantedPermissions(ORIGINATOR, groupPermissions)

    expect(filtered.spendingAuthorization).toBeUndefined()
  })

  it('does not re-request spending even when the monthly allowance is exhausted', async () => {
    jest.spyOn(manager as any, 'findSpendingToken').mockResolvedValue(dsapToken)
    jest.spyOn(manager as any, 'querySpentSince').mockResolvedValue(10000)

    const filtered = await (manager as any).filterAlreadyGrantedPermissions(ORIGINATOR, groupPermissions)

    // Exhaustion is a renewal concern for the next spend, not grounds for a
    // second standing authorization.
    expect(filtered.spendingAuthorization).toBeUndefined()
  })

  it('still requests spending when no standing authorization exists', async () => {
    jest.spyOn(manager as any, 'findSpendingToken').mockResolvedValue(undefined)

    const filtered = await (manager as any).filterAlreadyGrantedPermissions(ORIGINATOR, groupPermissions)

    expect(filtered.spendingAuthorization).toEqual(groupPermissions.spendingAuthorization)
  })
})
