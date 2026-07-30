import { MockUtils, mockUnderlyingWallet } from './WalletPermissionsManager.fixtures'

describe('WalletPermissionsManager fixtures', () => {
  test('decodes hexadecimal fixture values by complete byte pairs', () => {
    expect(MockUtils.toArray('00a5ff', 'hex')).toEqual([0, 0xa5, 0xff])
  })

  test('models processed and signable createAction responses', async () => {
    const wallet = mockUnderlyingWallet()

    await expect(
      wallet.createAction({
        outputs: [],
        options: { signAndProcess: true }
      })
    ).resolves.toEqual({ tx: expect.any(Array) })

    await expect(wallet.createAction({ outputs: [] })).resolves.toEqual({
      signableTransaction: {
        tx: expect.any(Array),
        reference: 'mockReference'
      }
    })
  })
})
