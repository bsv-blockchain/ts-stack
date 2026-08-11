import { LockingScript, PushDrop } from '@bsv/sdk'
import { WalletPermissionsManager } from '../WalletPermissionsManager'

describe('WalletPermissionsManager permission settlement', () => {
  afterEach(() => jest.restoreAllMocks())

  it('queues a single durable permission token without inheriting broadcast latency', async () => {
    const createAction = jest.fn(async () => ({ txid: 'single-permission-token' }))
    const manager = Object.create(WalletPermissionsManager.prototype) as WalletPermissionsManager
    const internals = manager as any
    internals.adminOriginator = 'admin.com'
    internals.underlying = {}
    internals.createAction = createAction
    internals.buildPushdropFields = jest.fn().mockResolvedValue([])
    internals.buildTagsForRequest = jest.fn().mockReturnValue([])
    jest.spyOn(PushDrop.prototype, 'lock').mockResolvedValue(LockingScript.fromHex('51'))

    await internals.createPermissionOnChain({ type: 'basket', originator: 'todo.example', basket: 'todo tokens' }, 0)

    expect(createAction).toHaveBeenCalledWith(
      expect.objectContaining({
        options: { acceptDelayedBroadcast: true }
      }),
      'admin.com'
    )
  })

  it('queues grouped permission tokens without inheriting network-broadcast latency', async () => {
    const createAction = jest.fn(async () => ({ txid: 'permission-token-transaction' }))
    const manager = Object.create(WalletPermissionsManager.prototype) as WalletPermissionsManager
    const internals = manager as any
    internals.adminOriginator = 'admin.com'
    internals.createAction = createAction
    internals.buildPermissionOutput = jest.fn(async ({ request }: any) => ({
      request,
      output: {
        lockingScript: '51',
        satoshis: 1,
        outputDescription: 'basket permission token',
        basket: 'admin basket-access',
        tags: []
      }
    }))

    const granted = await internals.createPermissionTokensBestEffort(
      [
        {
          request: { type: 'basket', originator: 'todo.example', basket: 'todo tokens' },
          expiry: 0
        }
      ],
      true
    )

    expect(granted).toHaveLength(1)
    expect(createAction).toHaveBeenCalledWith(
      expect.objectContaining({
        options: { acceptDelayedBroadcast: true }
      }),
      expect.any(String)
    )
  })
})
