import { mockUnderlyingWallet, MockedBSV_SDK } from './WalletPermissionsManager.fixtures'
import {
  WalletPermissionsManager,
  PermissionsManagerConfig,
  PermissionsModule,
  type PermissionsModuleRequest
} from '../WalletPermissionsManager'
import { specOpBasketPrefixOutputs } from '../sdk/types'

jest.mock('@bsv/sdk', () => MockedBSV_SDK)

/**
 * The key deriver and the SDK identifier validation trim and lowercase every
 * protocol, basket and label name. The manager must classify a name by that
 * same canonical form, or a spelling variant passes as an ordinary name and
 * then becomes the reserved name below the manager.
 */
function spellings(name: string): string[] {
  return [
    name.toUpperCase(),
    `${name[0].toUpperCase()}${name.slice(1)}`,
    ` ${name}`,
    `${name} `,
    `\t${name}\n`,
    `  ${name.toUpperCase()}  `
  ]
}

/** Every prompt class is off, so a name that passes the gate reaches the wallet silently. */
const SILENT: PermissionsManagerConfig = {
  seekProtocolPermissionsForSigning: false,
  seekProtocolPermissionsForEncrypting: false,
  seekProtocolPermissionsForHMAC: false,
  seekPermissionsForKeyLinkageRevelation: false,
  seekPermissionsForPublicKeyRevelation: false,
  seekPermissionsForIdentityKeyRevelation: false,
  seekBasketInsertionPermissions: false,
  seekBasketRemovalPermissions: false,
  seekBasketListingPermissions: false,
  seekPermissionWhenApplyingActionLabels: false,
  seekPermissionWhenListingActionsByLabel: false,
  seekSpendingPermissions: false,
  encryptWalletMetadata: false
}

const ADMIN = 'admin.domain.com'
const APP = 'app.com'

function recordingModule(): { module: PermissionsModule; requests: PermissionsModuleRequest[] } {
  const requests: PermissionsModuleRequest[] = []
  const module: PermissionsModule = {
    onRequest: jest.fn(async req => {
      requests.push(req)
      return req
    }),
    onResponse: jest.fn(async res => res)
  }
  return { module, requests }
}

function argument(request: PermissionsModuleRequest, name: string): any {
  return Reflect.get(request.args, name)
}

describe('WalletPermissionsManager - reserved names in every spelling', () => {
  let underlying: jest.Mocked<any>
  let manager: WalletPermissionsManager
  let module: PermissionsModule
  let requests: PermissionsModuleRequest[]

  beforeEach(() => {
    underlying = mockUnderlyingWallet()
    ;({ module, requests } = recordingModule())
    manager = new WalletPermissionsManager(underlying, ADMIN, { ...SILENT, permissionModules: { btms: module } })
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  const adminBaskets = ['default', 'admin example', specOpBasketPrefixOutputs]
  const adminBasketSpellings = adminBaskets.flatMap(name => [name, ...spellings(name)])
  const pBasketSpellings = ['p btms x', ...spellings('p btms x')]
  const pProtocolSpellings = ['p btms sign', ...spellings('p btms sign')]
  const adminProtocolSpellings = ['admin example', ...spellings('admin example')]
  const adminLabelSpellings = ['admin originator evil.com', ...spellings('admin originator evil.com')]
  const pLabelSpellings = ['p btms x', ...spellings('p btms x')]

  describe('admin-reserved baskets', () => {
    it.each(adminBasketSpellings)('refuses listOutputs for %j', async basket => {
      await expect(manager.listOutputs({ basket }, APP)).rejects.toThrow(/admin-only/)
      expect(underlying.listOutputs).not.toHaveBeenCalled()
    })

    it.each(adminBasketSpellings)('refuses relinquishOutput for %j', async basket => {
      await expect(manager.relinquishOutput({ basket, output: `${'a'.repeat(64)}.0` }, APP)).rejects.toThrow(
        /admin-only/
      )
      expect(underlying.relinquishOutput).not.toHaveBeenCalled()
    })

    it.each(adminBasketSpellings)('refuses a createAction output for %j', async basket => {
      await expect(
        manager.createAction(
          {
            description: 'Test action',
            outputs: [{ lockingScript: 'abcd', satoshis: 1000, basket, outputDescription: 'Test output' }]
          },
          APP
        )
      ).rejects.toThrow(/admin-only/)
      expect(underlying.createAction).not.toHaveBeenCalled()
    })

    it.each(adminBasketSpellings)('refuses an internalizeAction insertion for %j', async basket => {
      await expect(
        manager.internalizeAction(
          {
            tx: [],
            description: 'Test internalize action',
            outputs: [{ outputIndex: 0, protocol: 'basket insertion', insertionRemittance: { basket } }]
          },
          APP
        )
      ).rejects.toThrow(/admin-only/)
      expect(underlying.internalizeAction).not.toHaveBeenCalled()
    })
  })

  describe('permission-module baskets', () => {
    it.each(pBasketSpellings)('routes listOutputs for %j to the module under the canonical name', async basket => {
      underlying.listOutputs.mockResolvedValue({ totalOutputs: 0, outputs: [] })
      await manager.listOutputs({ basket }, APP)
      expect(requests).toHaveLength(1)
      expect(argument(requests[0], 'basket')).toBe('p btms x')
      expect(underlying.listOutputs.mock.calls[0][0].basket).toBe('p btms x')
    })

    it.each(pBasketSpellings)('routes relinquishOutput for %j to the module', async basket => {
      underlying.relinquishOutput.mockResolvedValue({ relinquished: true })
      await manager.relinquishOutput({ basket, output: `${'a'.repeat(64)}.0` }, APP)
      expect(requests).toHaveLength(1)
      expect(argument(requests[0], 'basket')).toBe('p btms x')
    })

    it.each(pBasketSpellings)('routes a createAction output for %j to the module', async basket => {
      underlying.createAction.mockResolvedValue({ txid: 'abc123', tx: [] })
      await manager.createAction(
        {
          description: 'Test action',
          outputs: [{ lockingScript: 'abcd', satoshis: 1000, basket, outputDescription: 'Test output' }]
        },
        APP
      )
      expect(requests).toHaveLength(1)
      expect(argument(requests[0], 'outputs')[0].basket).toBe('p btms x')
    })

    it.each(pBasketSpellings)('routes an internalizeAction insertion for %j to the module', async basket => {
      underlying.internalizeAction.mockResolvedValue({ accepted: true })
      await manager.internalizeAction(
        {
          tx: [],
          description: 'Test internalize action',
          outputs: [{ outputIndex: 0, protocol: 'basket insertion', insertionRemittance: { basket } }]
        },
        APP
      )
      expect(requests).toHaveLength(1)
      expect(argument(requests[0], 'outputs')[0].insertionRemittance.basket).toBe('p btms x')
    })

    it('refuses a variant spelling of a scheme with no installed module', async () => {
      await expect(manager.listOutputs({ basket: 'P nomodule x' }, APP)).rejects.toThrow(/Unsupported P-module scheme/)
      expect(underlying.listOutputs).not.toHaveBeenCalled()
    })
  })

  describe('labels', () => {
    it.each(adminLabelSpellings)('refuses createAction with the admin label %j', async label => {
      await expect(manager.createAction({ description: 'Test action', labels: [label] }, APP)).rejects.toThrow(
        /admin-only/
      )
      expect(underlying.createAction).not.toHaveBeenCalled()
    })

    it.each(adminLabelSpellings)('refuses listActions with the admin label %j', async label => {
      await expect(manager.listActions({ labels: [label] }, APP)).rejects.toThrow(/admin-only/)
      expect(underlying.listActions).not.toHaveBeenCalled()
    })

    it.each(pLabelSpellings)('routes listActions with the module label %j to the module', async label => {
      underlying.listActions.mockResolvedValue({ totalActions: 0, actions: [] })
      await manager.listActions({ labels: [label] }, APP)
      expect(requests).toHaveLength(1)
      expect(argument(requests[0], 'labels')).toEqual(['p btms x'])
    })

    it.each(pLabelSpellings)('routes createAction with the module label %j to the module', async label => {
      underlying.createAction.mockResolvedValue({ txid: 'abc123', tx: [] })
      await manager.createAction({ description: 'Test action', labels: [label] }, APP)
      expect(requests).toHaveLength(1)
      expect(argument(requests[0], 'labels')).toContain('p btms x')
    })
  })

  describe('protocols', () => {
    const keyMethods = [
      ['getPublicKey', { keyID: '1', counterparty: 'self' }],
      ['createSignature', { keyID: '1', data: [1] }],
      ['verifySignature', { keyID: '1', data: [1], signature: [1] }],
      ['createHmac', { keyID: '1', data: [1] }],
      ['verifyHmac', { keyID: '1', data: [1], hmac: [1] }],
      ['encrypt', { keyID: '1', plaintext: [1] }],
      ['decrypt', { keyID: '1', ciphertext: [1] }]
    ] as const
    const cases = keyMethods.flatMap(([method, args]) => pProtocolSpellings.map(name => [method, name, args] as const))
    const adminCases = keyMethods.flatMap(([method, args]) =>
      adminProtocolSpellings.map(name => [method, name, args] as const)
    )

    it.each(cases)('routes %s for protocol %j to the module under the canonical name', async (method, name, args) => {
      await (manager as any)[method]({ ...args, protocolID: [2, name] }, APP)
      expect(requests).toHaveLength(1)
      expect(requests[0].method).toBe(method)
      expect(argument(requests[0], 'protocolID')).toEqual([2, 'p btms sign'])
      expect(underlying[method].mock.calls[0][0].protocolID).toEqual([2, 'p btms sign'])
    })

    it.each(adminCases)('refuses %s for the admin protocol %j', async (method, name, args) => {
      await expect((manager as any)[method]({ ...args, protocolID: [2, name] }, APP)).rejects.toThrow(/admin-only/)
      expect(underlying[method]).not.toHaveBeenCalled()
    })

    it.each([...pProtocolSpellings, ...adminProtocolSpellings])(
      'refuses revealSpecificKeyLinkage for the reserved protocol %j',
      async name => {
        await expect(
          manager.revealSpecificKeyLinkage(
            { counterparty: `02${'a'.repeat(64)}`, verifier: `02${'b'.repeat(64)}`, protocolID: [2, name], keyID: '1' },
            APP
          )
        ).rejects.toThrow(/reserved/)
        expect(underlying.revealSpecificKeyLinkage).not.toHaveBeenCalled()
        expect(requests).toHaveLength(0)
      }
    )

    it('still lets the admin originator reveal linkage for a reserved protocol', async () => {
      await manager.revealSpecificKeyLinkage(
        {
          counterparty: `02${'a'.repeat(64)}`,
          verifier: `02${'b'.repeat(64)}`,
          protocolID: [2, 'admin example'],
          keyID: '1'
        },
        ADMIN
      )
      expect(underlying.revealSpecificKeyLinkage).toHaveBeenCalledTimes(1)
    })
  })

  describe('names that are not strings', () => {
    it.each(['default', 'admin example', 'p btms x'])('refuses a String object for the basket %j', async name => {
      const basket = new String(name) as unknown as string
      await expect(manager.listOutputs({ basket }, APP)).rejects.toThrow(/must be a string/)
      expect(underlying.listOutputs).not.toHaveBeenCalled()
      expect(requests).toHaveLength(0)
    })

    it('refuses a String object for a protocol name', async () => {
      const name = new String('admin example') as unknown as string
      await expect(manager.createHmac({ protocolID: [2, name], keyID: '1', data: [1] }, APP)).rejects.toThrow(
        /must be a string/
      )
      expect(underlying.createHmac).not.toHaveBeenCalled()
    })
  })

  describe('ordinary names', () => {
    it('forwards a mixed-case basket unchanged and without a module', async () => {
      underlying.listOutputs.mockResolvedValue({ totalOutputs: 0, outputs: [] })
      await manager.listOutputs({ basket: ' My Basket ' }, APP)
      expect(requests).toHaveLength(0)
      expect(underlying.listOutputs.mock.calls[0][0].basket).toBe(' My Basket ')
    })

    it('forwards a mixed-case protocol unchanged and without a module', async () => {
      await manager.createHmac({ protocolID: [2, 'Padmin Protocol'], keyID: '1', data: [1] }, APP)
      expect(requests).toHaveLength(0)
      expect(underlying.createHmac.mock.calls[0][0].protocolID).toEqual([2, 'Padmin Protocol'])
    })

    it('does not treat a name that only contains a reserved word as reserved', async () => {
      underlying.listOutputs.mockResolvedValue({ totalOutputs: 0, outputs: [] })
      await manager.listOutputs({ basket: 'my default' }, APP)
      await manager.listOutputs({ basket: 'pbtms x' }, APP)
      expect(requests).toHaveLength(0)
      expect(underlying.listOutputs).toHaveBeenCalledTimes(2)
    })
  })
})
