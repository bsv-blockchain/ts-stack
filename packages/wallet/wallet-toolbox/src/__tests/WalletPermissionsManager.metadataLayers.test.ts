import { mockUnderlyingWallet, MockedBSV_SDK } from './WalletPermissionsManager.fixtures'
import { PermissionsModule, WalletPermissionsManager } from '../WalletPermissionsManager'

jest.mock('@bsv/sdk', () => MockedBSV_SDK)

/**
 * Issue 785: internalizeAction encrypted normal-basket customInstructions once
 * before permission modules, then again after any registered p-label or p-basket
 * caused modules to run. listOutputs decrypts a single layer, so the stored
 * value came back as ciphertext. createAction encrypts every output once,
 * before modules. Every row below must reach the underlying wallet with
 * exactly one encryption layer.
 */
describe('WalletPermissionsManager customInstructions encryption layers', () => {
  const plaintext = 'pay-the-note'
  const rows = [
    { call: 'internalizeAction', basket: 'normal', label: false },
    { call: 'internalizeAction', basket: 'normal', label: true },
    { call: 'internalizeAction', basket: 'p', label: false },
    { call: 'internalizeAction', basket: 'p', label: true },
    { call: 'createAction', basket: 'normal', label: false },
    { call: 'createAction', basket: 'normal', label: true },
    { call: 'createAction', basket: 'p', label: false },
    { call: 'createAction', basket: 'p', label: true }
  ] as const

  function encryptionLayers(stored: string): number {
    let current = stored
    let layers = 0
    while (current !== plaintext) {
      const decoded = Buffer.from(current, 'base64').toString('utf8')
      if (!decoded.startsWith('enc(') || !decoded.endsWith(')')) {
        throw new Error(`customInstructions are not a single metadata encryption of the plaintext: ${stored}`)
      }
      current = decoded.slice(4, -1)
      layers += 1
      if (layers > 4) throw new Error(`customInstructions were encrypted more than once: ${stored}`)
    }
    return layers
  }

  function basketName(kind: 'normal' | 'p'): string {
    return kind === 'normal' ? 'savings' : 'p test notes'
  }

  async function storedCustomInstructions(
    call: 'internalizeAction' | 'createAction',
    basket: 'normal' | 'p',
    label: boolean
  ): Promise<{ stored: string; moduleRequests: number }> {
    const underlying = mockUnderlyingWallet()
    underlying.encrypt.mockImplementation(async (args: { plaintext: number[] }) => ({
      ciphertext: [...Buffer.from(`enc(${Buffer.from(args.plaintext).toString('utf8')})`, 'utf8')]
    }))
    const permissionModule: PermissionsModule = {
      onRequest: jest.fn(async request => request),
      onResponse: jest.fn(async response => response)
    }
    const manager = new WalletPermissionsManager(underlying, 'admin.example.com', {
      encryptWalletMetadata: true,
      seekBasketInsertionPermissions: false,
      seekPermissionWhenApplyingActionLabels: false,
      seekSpendingPermissions: false,
      permissionModules: { test: permissionModule }
    })
    const labels = label ? ['p test marker'] : undefined
    const basketValue = basketName(basket)

    if (call === 'internalizeAction') {
      await manager.internalizeAction(
        {
          tx: [],
          description: 'Store custom instructions',
          labels,
          outputs: [
            {
              outputIndex: 0,
              protocol: 'basket insertion',
              insertionRemittance: {
                basket: basketValue,
                customInstructions: plaintext
              }
            }
          ]
        },
        'app.example.com'
      )
      const stored = underlying.internalizeAction.mock.calls[0][0].outputs[0].insertionRemittance
        .customInstructions as string
      return { stored, moduleRequests: permissionModule.onRequest.mock.calls.length }
    }

    underlying.createAction.mockResolvedValue({ txid: 'abc123', tx: [1] })
    await manager.createAction(
      {
        description: 'Store custom instructions',
        labels,
        outputs: [
          {
            lockingScript: '51',
            satoshis: 1000,
            outputDescription: 'Saved output',
            basket: basketValue,
            customInstructions: plaintext
          }
        ]
      },
      'app.example.com'
    )
    const stored = underlying.createAction.mock.calls[0][0].outputs[0].customInstructions as string
    return { stored, moduleRequests: permissionModule.onRequest.mock.calls.length }
  }

  it.each(rows)('$call encrypts a $basket basket once when a p-label is $label', async ({ call, basket, label }) => {
    const { stored, moduleRequests } = await storedCustomInstructions(call, basket, label)
    expect(encryptionLayers(stored)).toBe(1)
    expect(moduleRequests).toBe(basket === 'p' || label ? 1 : 0)
  })
})
