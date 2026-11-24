import { jest } from '@jest/globals'
import { CachedKeyDeriver, PrivateKey } from '@bsv/sdk'
import type { SecurityLevel, WalletInterface } from '@bsv/sdk'
import { WalletPermissionsManager } from '@bsv/wallet-toolbox-client'
import { parsePoint33, SigmaPermissionModule, verifySchnorr } from '../index.js'
import type { SigmaAuthorizationHandler } from '../index.js'

const app = 'app.example'
const admin = 'admin.example'
const protocolID: [0, string] = [0, 'p sigma schnorr example payout']
const keyID = 'member 1'
const refused = /not permitted in the p sigma namespace/

/** Every method the underlying wallet was asked to run. */
const underlyingCalls: string[] = []

/** An underlying wallet whose every method fails, so any call that reaches it is visible. */
const underlying = new Proxy({} as WalletInterface, {
  get: (_target, prop) =>
    prop === 'then'
      ? undefined
      : async () => {
          underlyingCalls.push(String(prop))
          throw new Error(`underlying wallet must not be called: ${String(prop)}`)
        }
})

const withModule = (authorize?: SigmaAuthorizationHandler): WalletPermissionsManager =>
  new WalletPermissionsManager(underlying, admin, {
    // Leave action metadata as given, so createAction needs nothing from the underlying wallet.
    encryptWalletMetadata: false,
    permissionModules: {
      sigma: new SigmaPermissionModule({
        keyDeriver: new CachedKeyDeriver(new PrivateKey(2)),
        authorize
      })
    }
  })

beforeEach(() => {
  underlyingCalls.length = 0
})

describe('host dispatch through WalletPermissionsManager', () => {
  it('routes encrypt under p sigma schnorr to the module, which returns a verifiable proof', async () => {
    const manager = withModule()
    const ctx = [1, 2, 3]
    const { ciphertext: P33 } = await manager.encrypt(
      { protocolID: [0, 'p sigma key example payout'], keyID, plaintext: [] },
      app
    )
    const { ciphertext: proof } = await manager.encrypt({ protocolID, keyID, plaintext: ctx }, app)
    expect(proof).toHaveLength(96)
    expect(verifySchnorr(parsePoint33(P33, 'P'), ctx, proof)).toBe(true)
  })

  it.each<[string, (manager: WalletPermissionsManager) => Promise<unknown>]>([
    ['decrypt', async m => await m.decrypt({ protocolID, keyID, ciphertext: [1, 2, 3] }, app)],
    ['getPublicKey', async m => await m.getPublicKey({ protocolID, keyID }, app)],
    ['createSignature', async m => await m.createSignature({ protocolID, keyID, data: [1] }, app)],
    ['createHmac', async m => await m.createHmac({ protocolID, keyID, data: [1] }, app)],
    [
      'verifyHmac',
      async m =>
        await m.verifyHmac(
          { protocolID, keyID, data: [1], hmac: Array.from({ length: 32 }, () => 0) },
          app
        )
    ],
    [
      'verifySignature',
      async m => await m.verifySignature({ protocolID, keyID, data: [1], signature: [1] }, app)
    ]
  ])('the module refuses %s under a p sigma protocol', async (_method, invoke) => {
    await expect(invoke(withModule())).rejects.toThrow(refused)
  })

  it('the module refuses createAction with a p sigma label', async () => {
    await expect(
      withModule().createAction(
        { description: 'test action', labels: ['p sigma schnorr example'], outputs: [] },
        app
      )
    ).rejects.toThrow(refused)
  })

  it('the module refuses createAction with a p sigma basket', async () => {
    await expect(
      withModule().createAction(
        {
          description: 'test action',
          outputs: [
            {
              lockingScript: '51',
              satoshis: 1,
              outputDescription: 'test output',
              basket: 'p sigma abc'
            }
          ]
        },
        app
      )
    ).rejects.toThrow(refused)
  })

  it('a manager without the module refuses encrypt under p sigma as an unsupported scheme', async () => {
    const manager = new WalletPermissionsManager(underlying, admin, {})
    await expect(
      manager.encrypt({ protocolID: [0, 'p sigma key example payout'], keyID, plaintext: [] }, app)
    ).rejects.toThrow(/Unsupported P-module scheme: p sigma/)
  })
})

describe.each<[SecurityLevel, Record<string, string>]>([
  [1, {}],
  [2, { counterparty: new PrivateKey(3).toPublicKey().toString() }]
])('module enforcement through WalletPermissionsManager at level %i', (level, scope) => {
  const ctx = [4, 5, 6]
  const prove = async (
    manager: WalletPermissionsManager,
    seekPermission?: boolean
  ): Promise<{ ciphertext: number[] }> =>
    await manager.encrypt(
      {
        protocolID: [level, 'p sigma schnorr example payout'],
        keyID,
        plaintext: ctx,
        ...scope,
        ...(seekPermission === undefined ? {} : { seekPermission })
      },
      app
    )

  it('refuses a schnorr request with seekPermission false without asking or reaching the wallet', async () => {
    const authorize = jest.fn(async () => true)
    await expect(prove(withModule(authorize), false)).rejects.toThrow(
      'Sigma: permission is required and seekPermission is false'
    )
    expect(authorize).not.toHaveBeenCalled()
    expect(underlyingCalls).toEqual([])
  })

  it('refuses a schnorr request the authorization handler denies', async () => {
    const authorize = jest.fn(async () => false)
    await expect(prove(withModule(authorize))).rejects.toThrow('Sigma: user denied permission')
    expect(authorize).toHaveBeenCalledTimes(1)
    expect(underlyingCalls).toEqual([])
  })

  it('returns a verifiable schnorr proof once the authorization handler approves', async () => {
    const authorize = jest.fn(async () => true)
    const manager = withModule(authorize)
    const { ciphertext: P33 } = await manager.encrypt(
      { protocolID: [level, 'p sigma key example payout'], keyID, plaintext: [], ...scope },
      app
    )
    const { ciphertext: proof } = await prove(manager)
    expect(verifySchnorr(parsePoint33(P33, 'P'), ctx, proof)).toBe(true)
    expect(authorize).toHaveBeenCalledTimes(2)
    expect(underlyingCalls).toEqual([])
  })
})
