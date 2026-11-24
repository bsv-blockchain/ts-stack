import { CachedKeyDeriver, PrivateKey } from '@bsv/sdk'
import { SigmaPermissionModule } from '../index.js'
import { next } from './helpers.js'

const make = (): SigmaPermissionModule =>
  new SigmaPermissionModule({ keyDeriver: new CachedKeyDeriver(new PrivateKey(2)) })

describe('baskets and labels', () => {
  it.each(['createAction', 'internalizeAction', 'listActions', 'signAction'])(
    'onRequest and onResponse reject for %s',
    async method => {
      const request = {
        method,
        originator: 'app.example',
        args: { labels: ['p sigma schnorr example payout'] }
      }
      await expect(make().onRequest(request)).rejects.toThrow()
      await expect(
        make().onResponse({}, { method, originator: request.originator })
      ).rejects.toThrow()
    }
  )

  it.each(['listOutputs', 'relinquishOutput'])('handleRequest rejects %s', async method => {
    await expect(
      make().handleRequest(
        {
          method,
          originator: 'app.example',
          args: { basket: 'p sigma schnorr example payout', output: 'abc.0' }
        },
        next
      )
    ).rejects.toThrow()
  })
})
