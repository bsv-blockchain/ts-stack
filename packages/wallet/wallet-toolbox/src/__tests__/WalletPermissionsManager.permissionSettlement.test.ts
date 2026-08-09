import { WalletPermissionsManager } from '../WalletPermissionsManager'

describe('WalletPermissionsManager permission settlement', () => {
  it('finishes broadcasting grouped permission tokens before the grant returns', async () => {
    let finishBroadcast: (() => void) | undefined
    const broadcastFinished = new Promise<void>(resolve => {
      finishBroadcast = resolve
    })
    const createAction = jest.fn(async () => await broadcastFinished)
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

    let settled = false
    const grant = internals
      .createPermissionTokensBestEffort(
        [
          {
            request: { type: 'basket', originator: 'todo.example', basket: 'todo tokens' },
            expiry: 0
          }
        ],
        true
      )
      .then(() => {
        settled = true
      })

    await new Promise(resolve => setImmediate(resolve))
    expect(settled).toBe(false)
    expect(createAction).toHaveBeenCalledWith(
      expect.objectContaining({
        options: { acceptDelayedBroadcast: false }
      }),
      expect.any(String)
    )

    finishBroadcast?.()
    await grant
    expect(settled).toBe(true)
  })
})
