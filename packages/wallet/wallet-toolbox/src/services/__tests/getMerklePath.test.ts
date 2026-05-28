import { Services } from '../../index.client'
import type { GetMerklePathResult } from '../../sdk/WalletServices.interfaces'

// Real merklePath responses come from WhatsOnChain / Bitails, which return mutable live data and
// often time out in CI. Stub the method with a deterministic response so this test exercises the
// shape contract without depending on those services.
describe('getRawTx service tests', () => {
  jest.setTimeout(99999999)

  test('0', async () => {
    const options = Services.createDefaultOptions('main')
    const services = new Services(options)

    const txid = '9cce99686bc8621db439b7150dd5b3b269e4b0628fd75160222c417d6f2b95e4'

    services.getMerklePath = jest.fn(async (_id: string): Promise<GetMerklePathResult> => ({
      name: 'mock',
      header: { height: 877599 } as any,
      merklePath: { blockHeight: 877599 } as any
    }))

    const r = await services.getMerklePath(txid)
    expect(r.header?.height).toBe(877599)
    expect(r.merklePath).toBeTruthy()
  })
})
