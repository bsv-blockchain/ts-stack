import { CachedKeyDeriver, PrivateKey, type WalletInterface } from '@bsv/sdk'
import { WalletPermissionsManager } from '@bsv/wallet-toolbox-client'
import { RabinPermissionModule } from '../index.js'

const APP = 'app.example'
const UNSUPPORTED = 'RABIN: p rabin baskets and labels are not supported'

/**
 * BRC-98 dispatch skips the manager's basket and label permission checks for P-baskets and
 * P-labels and hands them to the scheme's onRequest/onResponse. The Rabin scheme defines no
 * baskets or labels, so passing them through would let any app write and read them unchecked.
 */
const setup = () => {
  const reached: string[] = []
  const underlying = new Proxy(
    {},
    {
      get: (_target, method) => {
        if (method === 'then') return undefined
        return async () => {
          reached.push(String(method))
          return method === 'listActions' ? { totalActions: 0, actions: [] } : { accepted: true }
        }
      }
    }
  ) as WalletInterface
  const rabin = new RabinPermissionModule({
    keyDeriver: new CachedKeyDeriver(new PrivateKey(2)),
    authorize: async () => true
  })
  const manager = new WalletPermissionsManager(underlying, 'admin.example', {
    encryptWalletMetadata: false,
    seekBasketInsertionPermissions: false,
    seekPermissionsForLabelUsage: false,
    permissionModules: { rabin }
  } as never)
  return { manager, reached, rabin }
}

const action = (basket: string, labels: string[] = []) => ({
  description: 'test action here',
  outputs: [{ lockingScript: '51', satoshis: 1, outputDescription: 'out desc here', basket }],
  labels,
  options: { randomizeOutputs: false }
})

describe('p rabin baskets and labels', () => {
  it('rejects createAction with a p rabin basket before the wallet', async () => {
    const { manager, reached } = setup()
    await expect(manager.createAction(action('p rabin stash') as never, APP)).rejects.toThrow(
      UNSUPPORTED
    )
    expect(reached).toEqual([])
  })

  it('rejects createAction with a p rabin label before the wallet', async () => {
    const { manager, reached } = setup()
    await expect(
      manager.createAction(action('regular', ['p rabin label']) as never, APP)
    ).rejects.toThrow(UNSUPPORTED)
    expect(reached).toEqual([])
  })

  it('rejects internalizeAction into a p rabin basket or with a p rabin label', async () => {
    const { manager, reached } = setup()
    const internalize = (basket: string, labels: string[] = []) => ({
      tx: [1, 2, 3],
      description: 'internalize test',
      labels,
      outputs: [{ outputIndex: 0, protocol: 'basket insertion', insertionRemittance: { basket } }]
    })
    await expect(
      manager.internalizeAction(internalize('p rabin stash') as never, APP)
    ).rejects.toThrow(UNSUPPORTED)
    await expect(
      manager.internalizeAction(internalize('regular', ['p rabin label']) as never, APP)
    ).rejects.toThrow(UNSUPPORTED)
    expect(reached).toEqual([])
  })

  it('rejects listActions with a p rabin label before the wallet', async () => {
    const { manager, reached } = setup()
    await expect(manager.listActions({ labels: ['p rabin label'] } as never, APP)).rejects.toThrow(
      UNSUPPORTED
    )
    expect(reached).toEqual([])
  })

  it('rejects listOutputs and relinquishOutput on a p rabin basket', async () => {
    const { manager, reached } = setup()
    await expect(manager.listOutputs({ basket: 'p rabin stash' }, APP)).rejects.toThrow(
      'RABIN: listOutputs is not permitted'
    )
    await expect(
      manager.relinquishOutput({ basket: 'p rabin stash', output: `${'a'.repeat(64)}.0` }, APP)
    ).rejects.toThrow('RABIN: relinquishOutput is not permitted')
    expect(reached).toEqual([])
  })

  it('rejects the transformation hooks directly', async () => {
    const { rabin } = setup()
    await expect(
      rabin.onRequest({ method: 'createAction', args: {}, originator: APP })
    ).rejects.toThrow(UNSUPPORTED)
    await expect(rabin.onResponse({})).rejects.toThrow(UNSUPPORTED)
  })
})
