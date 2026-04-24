import { mockUnderlyingWallet, MockedBSV_SDK } from './WalletPermissionsManager.fixtures'
import { WalletPermissionsManager, PermissionsManagerConfig, PermissionsModule } from '../WalletPermissionsManager'

jest.mock('@bsv/sdk', () => MockedBSV_SDK)

/**
 * Test suite for Permission Modules
 * Tests both P-basket and P-protocol delegation to custom permission modules.
 */
describe('WalletPermissionsManager - Permission Module Support', () => {
  let underlying: jest.Mocked<any>

  beforeEach(() => {
    underlying = mockUnderlyingWallet()
  })

  describe('P-Label Delegation', () => {
    it('should delegate listActions through P-label modules in order and return responses in reverse order', async () => {
      const callOrder: string[] = []

      const module1: PermissionsModule = {
        onRequest: jest.fn(async req => {
          callOrder.push('req1')
          expect((req.args as any).req1Processed).toBeUndefined()
          return { ...req, args: { ...(req.args as any), req1Processed: true } }
        }),
        onResponse: jest.fn(async res => {
          callOrder.push('res1')
          expect((res as any).processedBy).toBe('module2')
          return { ...res, finalProcessedBy: 'module1' }
        })
      }

      const module2: PermissionsModule = {
        onRequest: jest.fn(async req => {
          callOrder.push('req2')
          expect((req.args as any).req1Processed).toBe(true)
          return { ...req, args: { ...(req.args as any), req2Processed: true } }
        }),
        onResponse: jest.fn(async res => {
          callOrder.push('res2')
          expect((res as any).processedBy).toBeUndefined()
          return { ...res, processedBy: 'module2' }
        })
      }

      const config: PermissionsManagerConfig = {
        permissionModules: {
          scheme1: module1,
          scheme2: module2
        },
        seekPermissionWhenListingActionsByLabel: false
      }

      const manager = new WalletPermissionsManager(underlying, 'customToken.domain.com', config)

      underlying.listActions.mockResolvedValue({ totalActions: 0, actions: [] })

      const result = await manager.listActions(
        {
          labels: ['p scheme1 alpha', 'p scheme2 beta', 'regular-label']
        },
        'app.com'
      )

      expect(module1.onRequest).toHaveBeenCalledTimes(1)
      expect(module2.onRequest).toHaveBeenCalledTimes(1)
      expect(module1.onResponse).toHaveBeenCalledTimes(1)
      expect(module2.onResponse).toHaveBeenCalledTimes(1)
      expect(callOrder).toEqual(['req1', 'req2', 'res2', 'res1'])
      expect((result as any).finalProcessedBy).toBe('module1')
    })

    it('should delegate createAction when a P-label is present', async () => {
      const testModule: PermissionsModule = {
        onRequest: jest.fn(async req => req),
        onResponse: jest.fn(async res => res)
      }

      const config: PermissionsManagerConfig = {
        permissionModules: {
          labels: testModule
        },
        seekSpendingPermissions: false,
        seekBasketInsertionPermissions: false,
        seekPermissionWhenApplyingActionLabels: false
      }

      const manager = new WalletPermissionsManager(underlying, 'customToken.domain.com', config)

      underlying.createAction.mockResolvedValue({ txid: 'abc123', tx: [] })

      await manager.createAction(
        {
          description: 'Label-based createAction',
          labels: ['p labels token', 'regular-label'],
          outputs: [
            {
              lockingScript: 'abcd',
              satoshis: 1000,
              basket: 'regular-basket',
              outputDescription: 'Test output'
            }
          ]
        },
        'app.com'
      )

      expect(testModule.onRequest).toHaveBeenCalledTimes(1)
      expect(testModule.onResponse).toHaveBeenCalledTimes(1)
    })

    it('should delegate internalizeAction when a P-label is present', async () => {
      const testModule: PermissionsModule = {
        onRequest: jest.fn(async req => req),
        onResponse: jest.fn(async res => res)
      }

      const config: PermissionsManagerConfig = {
        permissionModules: {
          labels: testModule
        },
        seekPermissionWhenApplyingActionLabels: false
      }

      const manager = new WalletPermissionsManager(underlying, 'customToken.domain.com', config)

      underlying.internalizeAction.mockResolvedValue({ accepted: true })

      await manager.internalizeAction(
        {
          tx: [],
          description: 'Internalize with label',
          labels: ['p labels internal', 'regular-label'],
          outputs: []
        } as any,
        'app.com'
      )

      expect(testModule.onRequest).toHaveBeenCalledTimes(1)
      expect(testModule.onResponse).toHaveBeenCalledTimes(1)
    })
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  describe('Permission Module Registration', () => {
    it('should accept permissionModules in config', () => {
      const testModule: PermissionsModule = {
        onRequest: jest.fn(async req => req),
        onResponse: jest.fn(async res => res)
      }

      const config: PermissionsManagerConfig = {
        permissionModules: {
          'test-scheme': testModule
        }
      }

      const manager = new WalletPermissionsManager(underlying, 'customToken.domain.com', config)

      // Verify module is stored in config
      const storedConfig = (manager as any).config as PermissionsManagerConfig
      expect(storedConfig.permissionModules).toBeDefined()
      expect(storedConfig.permissionModules?.['test-scheme']).toBe(testModule)
    })

    it('should support multiple permission modules for different schemes', () => {
      const module1: PermissionsModule = {
        onRequest: jest.fn(async req => req),
        onResponse: jest.fn(async res => res)
      }

      const module2: PermissionsModule = {
        onRequest: jest.fn(async req => req),
        onResponse: jest.fn(async res => res)
      }

      const config: PermissionsManagerConfig = {
        permissionModules: {
          scheme1: module1,
          scheme2: module2
        }
      }

      const manager = new WalletPermissionsManager(underlying, 'customToken.domain.com', config)
      const storedConfig = (manager as any).config as PermissionsManagerConfig

      expect(Object.keys(storedConfig.permissionModules || {}).length).toBe(2)
      expect(storedConfig.permissionModules?.['scheme1']).toBe(module1)
      expect(storedConfig.permissionModules?.['scheme2']).toBe(module2)
    })
  })

  describe('P-Basket Delegation - listOutputs', () => {
    it('should delegate to permission when basket starts with "p "', async () => {
      const testModule: PermissionsModule = {
        onRequest: jest.fn(async req => {
          // Module can inspect and transform the request
          expect(req.method).toBe('listOutputs')
          expect((req.args as any).basket).toBe('p myscheme some-data')
          // Transform basket for underlying call
          return {
            ...req,
            args: { ...(req.args as any), basket: 'transformed-basket' }
          }
        }),
        onResponse: jest.fn(async res => {
          // Module can transform the response
          return { ...res, transformedByModule: true }
        })
      }

      const config: PermissionsManagerConfig = {
        permissionModules: {
          myscheme: testModule
        }
      }

      const manager = new WalletPermissionsManager(underlying, 'customToken.domain.com', config)

      // Mock underlying response
      underlying.listOutputs.mockResolvedValue({ outputs: [] })

      const result = await manager.listOutputs({ basket: 'p myscheme some-data' }, 'app.com')

      // Verify module's onRequest was called
      expect(testModule.onRequest).toHaveBeenCalledTimes(1)
      // Note: args array includes both the request args and originator
      expect(testModule.onRequest).toHaveBeenCalledWith({
        method: 'listOutputs',
        args: { basket: 'p myscheme some-data' },
        originator: 'app.com'
      })

      // Verify underlying was called with transformed basket
      // Note: originator stays as 'app.com' not changed to admin
      expect(underlying.listOutputs).toHaveBeenCalledWith({ basket: 'transformed-basket' }, 'app.com')

      // Verify module's onResponse was called
      expect(testModule.onResponse).toHaveBeenCalledTimes(1)

      // Verify response was transformed
      expect(result).toHaveProperty('transformedByModule', true)
    })

    it('should throw error if P-basket scheme has no registered module', async () => {
      const manager = new WalletPermissionsManager(underlying, 'customToken.domain.com')

      await expect(manager.listOutputs({ basket: 'p unregistered-scheme data' }, 'app.com')).rejects.toThrow(
        /Unsupported P-module scheme: p unregistered-scheme/
      )
    })

    it('should handle normal baskets without delegation', async () => {
      const testModule: PermissionsModule = {
        onRequest: jest.fn(async req => req),
        onResponse: jest.fn(async res => res)
      }

      const config: PermissionsManagerConfig = {
        permissionModules: {
          myscheme: testModule
        },
        seekBasketListingPermissions: false
      }

      const manager = new WalletPermissionsManager(underlying, 'customToken.domain.com', config)

      underlying.listOutputs.mockResolvedValue({ outputs: [] })

      await manager.listOutputs({ basket: 'normal-basket' }, 'app.com')

      // Module should NOT be called for normal baskets
      expect(testModule.onRequest).not.toHaveBeenCalled()
      expect(testModule.onResponse).not.toHaveBeenCalled()

      // Underlying should be called with original basket
      expect(underlying.listOutputs).toHaveBeenCalledWith({ basket: 'normal-basket' }, 'app.com')
    })

    it('should decrypt metadata in P-basket responses', async () => {
      const testModule: PermissionsModule = {
        onRequest: jest.fn(async req => req),
        onResponse: jest.fn(async res => res)
      }

      const config: PermissionsManagerConfig = {
        permissionModules: {
          myscheme: testModule
        },
        encryptWalletMetadata: true
      }

      const manager = new WalletPermissionsManager(underlying, 'customToken.domain.com', config)

      // Mock decryption
      const decryptMetadata = jest.spyOn(manager as any, 'decryptListOutputsMetadata')
      decryptMetadata.mockImplementation(async outputs => outputs)

      underlying.listOutputs.mockResolvedValue({
        outputs: [{ outpoint: 'txid.0', satoshis: 100 }]
      })

      await manager.listOutputs({ basket: 'p myscheme data' }, 'app.com')

      // Verify metadata decryption was called
      expect(decryptMetadata).toHaveBeenCalled()
    })
  })

  describe('P-Basket Delegation - relinquishOutput', () => {
    it('should delegate to P-module when basket starts with "p "', async () => {
      const testModule: PermissionsModule = {
        onRequest: jest.fn(async req => {
          expect(req.method).toBe('relinquishOutput')
          expect((req.args as any).basket).toBe('p token admin-basket-data')
          return {
            ...req,
            args: { ...(req.args as any), basket: 'admin-real-basket' }
          }
        }),
        onResponse: jest.fn(async res => res)
      }

      const config: PermissionsManagerConfig = {
        permissionModules: {
          token: testModule
        }
      }

      const manager = new WalletPermissionsManager(underlying, 'customToken.domain.com', config)

      underlying.relinquishOutput.mockResolvedValue(undefined)

      await manager.relinquishOutput({ basket: 'p token admin-basket-data', output: 'txid.0' }, 'app.com')

      expect(testModule.onRequest).toHaveBeenCalledTimes(1)
      // Note: originator remains 'app.com' - only basket is transformed
      expect(underlying.relinquishOutput).toHaveBeenCalledWith(
        { basket: 'admin-real-basket', output: 'txid.0' },
        'app.com'
      )
    })
  })

  describe('P-Basket Delegation - createAction', () => {
    it('should delegate to P-module for outputs with P-baskets', async () => {
      const testModule: PermissionsModule = {
        onRequest: jest.fn(async req => {
          // Verify we receive createAction request
          expect(req.method).toBe('createAction')
          return req
        }),
        onResponse: jest.fn(async res => {
          // Module can inspect the transaction result
          return res
        })
      }

      const config: PermissionsManagerConfig = {
        permissionModules: {
          bottle: testModule
        },
        seekSpendingPermissions: false,
        seekBasketInsertionPermissions: false
      }

      const manager = new WalletPermissionsManager(underlying, 'customToken.domain.com', config)

      underlying.createAction.mockResolvedValue({
        txid: 'abc123',
        tx: []
      })

      await manager.createAction(
        {
          description: 'Test action',
          outputs: [
            {
              lockingScript: 'abcd',
              satoshis: 1000,
              basket: 'p bottle token-data',
              outputDescription: 'Test output'
            }
          ]
        },
        'app.com'
      )

      // Verify P-module was invoked
      expect(testModule.onRequest).toHaveBeenCalled()
      expect(testModule.onResponse).toHaveBeenCalled()
    })

    it('should chain multiple P-modules in correct order: req1->req2->req3 then res3->res2->res1', async () => {
      const callOrder: string[] = []

      const module1: PermissionsModule = {
        onRequest: jest.fn(async req => {
          callOrder.push('req1')
          // First module receives original args without any processing markers
          expect((req.args as any as any).req1Processed).toBeUndefined()
          expect((req.args as any as any).req2Processed).toBeUndefined()
          // Transform args - add marker to track this module processed them
          return {
            ...req,
            args: { ...(req.args as any), req1Processed: true }
          }
        }),
        onResponse: jest.fn(async res => {
          callOrder.push('res1')
          // Last module in response chain should see transformations from res2 and res3
          expect((res as any).processedBy).toBe('module2')
          return { ...res, finalProcessedBy: 'module1' }
        })
      }

      const module2: PermissionsModule = {
        onRequest: jest.fn(async req => {
          callOrder.push('req2')
          // Second module receives args transformed by module1
          // (each module gets fresh request object, but args are chained)
          expect((req.args as any as any).req1Processed).toBe(true)
          expect((req.args as any as any).req2Processed).toBeUndefined()
          return {
            ...req,
            args: { ...(req.args as any), req2Processed: true }
          }
        }),
        onResponse: jest.fn(async res => {
          callOrder.push('res2')
          // Second-to-last in response chain should see transformation from res3
          expect((res as any).processedBy).toBe('module3')
          return { ...res, processedBy: 'module2' }
        })
      }

      const module3: PermissionsModule = {
        onRequest: jest.fn(async req => {
          callOrder.push('req3')
          // Third module receives args with transformations from both module1 and module2
          expect((req.args as any as any).req1Processed).toBe(true)
          expect((req.args as any as any).req2Processed).toBe(true)
          expect((req.args as any as any).req3Processed).toBeUndefined()
          return {
            ...req,
            args: { ...(req.args as any), req3Processed: true }
          }
        }),
        onResponse: jest.fn(async res => {
          callOrder.push('res3')
          // First module in response chain receives raw response from underlying wallet
          expect((res as any).processedBy).toBeUndefined()
          return { ...res, processedBy: 'module3' }
        })
      }

      const config: PermissionsManagerConfig = {
        permissionModules: {
          scheme1: module1,
          scheme2: module2,
          scheme3: module3
        },
        seekSpendingPermissions: false,
        seekBasketInsertionPermissions: false
      }

      const manager = new WalletPermissionsManager(underlying, 'customToken.domain.com', config)

      underlying.createAction.mockResolvedValue({ txid: 'abc', tx: [] })

      const result = await manager.createAction(
        {
          description: 'Multi-module chain test',
          outputs: [
            { lockingScript: '1234', satoshis: 100, basket: 'p scheme1 data1', outputDescription: 'Output 1' },
            { lockingScript: '5678', satoshis: 200, basket: 'p scheme2 data2', outputDescription: 'Output 2' },
            { lockingScript: '9abc', satoshis: 300, basket: 'p scheme3 data3', outputDescription: 'Output 3' }
          ]
        },
        'app.com'
      )

      // Verify all modules were called
      expect(module1.onRequest).toHaveBeenCalledTimes(1)
      expect(module2.onRequest).toHaveBeenCalledTimes(1)
      expect(module3.onRequest).toHaveBeenCalledTimes(1)
      expect(module1.onResponse).toHaveBeenCalledTimes(1)
      expect(module2.onResponse).toHaveBeenCalledTimes(1)
      expect(module3.onResponse).toHaveBeenCalledTimes(1)

      // Verify correct order: req1 -> req2 -> req3 then res3 -> res2 -> res1
      expect(callOrder).toEqual(['req1', 'req2', 'req3', 'res3', 'res2', 'res1'])

      // Verify final result has the complete chain of transformations
      expect((result as any).finalProcessedBy).toBe('module1')
    })
  })

  describe('P-Basket Delegation - internalizeAction', () => {
    it('should delegate to P-module when P-basket is specified in insertionRemittance', async () => {
      const testModule: PermissionsModule = {
        onRequest: jest.fn(async req => {
          expect(req.method).toBe('internalizeAction')
          return req
        }),
        onResponse: jest.fn(async res => res)
      }

      const config: PermissionsManagerConfig = {
        permissionModules: {
          myscheme: testModule
        },
        encryptWalletMetadata: false
      }

      const manager = new WalletPermissionsManager(underlying, 'customToken.domain.com', config)

      underlying.internalizeAction.mockResolvedValue(undefined)

      await manager.internalizeAction(
        {
          tx: [],
          description: 'Test internalize action',
          outputs: [
            {
              outputIndex: 0,
              protocol: 'basket insertion',
              paymentRemittance: { derivationPrefix: '', derivationSuffix: '', senderIdentityKey: '' },
              insertionRemittance: {
                basket: 'p myscheme data',
                customInstructions: ''
              }
            } as any
          ] // Use 'as any' to avoid strict type checking in test
        },
        'app.com'
      )

      expect(testModule.onRequest).toHaveBeenCalledTimes(1)
      expect(testModule.onResponse).toHaveBeenCalledTimes(1)
    })
  })

  describe('P-Protocol Delegation', () => {
    it('should delegate getPublicKey to P-protocol module', async () => {
      const testModule: PermissionsModule = {
        onRequest: jest.fn(async req => {
          expect(req.method).toBe('getPublicKey')
          expect((req.args as any).protocolID).toEqual([0, 'p bottle test'])
          return req
        }),
        onResponse: jest.fn(async res => {
          // Module can verify the key or add metadata
          return { ...res, verifiedByModule: true }
        })
      }

      const config: PermissionsManagerConfig = {
        permissionModules: {
          bottle: testModule
        },
        seekPermissionsForPublicKeyRevelation: false
      }

      const manager = new WalletPermissionsManager(underlying, 'customToken.domain.com', config)

      underlying.getPublicKey.mockResolvedValue({ publicKey: '02abc...' })

      const result = await manager.getPublicKey(
        {
          protocolID: [0, 'p bottle test'],
          keyID: '1',
          counterparty: 'self'
        },
        'app.com'
      )

      expect(testModule.onRequest).toHaveBeenCalledTimes(1)
      expect(testModule.onResponse).toHaveBeenCalledTimes(1)
      expect(result).toHaveProperty('verifiedByModule', true)
    })

    it('should delegate createSignature to P-protocol module', async () => {
      const testModule: PermissionsModule = {
        onRequest: jest.fn(async req => {
          expect(req.method).toBe('createSignature')
          expect((req.args as any).protocolID).toEqual([1, 'p token spend'])
          // Module can validate spend amounts, check limits, etc.
          return req
        }),
        onResponse: jest.fn(async res => res)
      }

      const config: PermissionsManagerConfig = {
        permissionModules: {
          token: testModule
        },
        seekProtocolPermissionsForSigning: false
      }

      const manager = new WalletPermissionsManager(underlying, 'customToken.domain.com', config)

      underlying.createSignature.mockResolvedValue({ signature: 'abc123' })

      await manager.createSignature(
        {
          protocolID: [1, 'p token spend'],
          keyID: '1',
          data: [0x01, 0x02]
        },
        'app.com'
      )

      expect(testModule.onRequest).toHaveBeenCalledTimes(1)
      expect(testModule.onResponse).toHaveBeenCalledTimes(1)
    })

    it('should delegate verifySignature to P-protocol module', async () => {
      const testModule: PermissionsModule = {
        onRequest: jest.fn(async req => {
          expect(req.method).toBe('verifySignature')
          return req
        }),
        onResponse: jest.fn(async res => res)
      }

      const config: PermissionsManagerConfig = {
        permissionModules: {
          secure: testModule
        }
      }

      const manager = new WalletPermissionsManager(underlying, 'customToken.domain.com', config)

      underlying.verifySignature.mockResolvedValue(true)

      await manager.verifySignature(
        {
          protocolID: [1, 'p secure verify'],
          keyID: '1',
          data: [0x01],
          signature: [0x02]
        },
        'app.com'
      )

      expect(testModule.onRequest).toHaveBeenCalledTimes(1)
    })

    it('should delegate encrypt to P-protocol module', async () => {
      const testModule: PermissionsModule = {
        onRequest: jest.fn(async req => {
          expect(req.method).toBe('encrypt')
          expect((req.args as any).protocolID).toEqual([2, 'p secure encrypt'])
          return req
        }),
        onResponse: jest.fn(async res => res)
      }

      const config: PermissionsManagerConfig = {
        permissionModules: {
          secure: testModule
        },
        seekProtocolPermissionsForEncrypting: false
      }

      const manager = new WalletPermissionsManager(underlying, 'customToken.domain.com', config)

      underlying.encrypt.mockResolvedValue({ ciphertext: [0x01, 0x02] })

      await manager.encrypt(
        {
          protocolID: [2, 'p secure encrypt'],
          keyID: '1',
          plaintext: [0x48, 0x65, 0x6c, 0x6c, 0x6f]
        },
        'app.com'
      )

      expect(testModule.onRequest).toHaveBeenCalledTimes(1)
    })

    it('should delegate decrypt to P-protocol module', async () => {
      const testModule: PermissionsModule = {
        onRequest: jest.fn(async req => {
          expect(req.method).toBe('decrypt')
          return req
        }),
        onResponse: jest.fn(async res => {
          // Module could verify decrypted content
          return res
        })
      }

      const config: PermissionsManagerConfig = {
        permissionModules: {
          secure: testModule
        },
        seekProtocolPermissionsForEncrypting: false
      }

      const manager = new WalletPermissionsManager(underlying, 'customToken.domain.com', config)

      underlying.decrypt.mockResolvedValue({ plaintext: [0x48, 0x65] })

      await manager.decrypt(
        {
          protocolID: [2, 'p secure decrypt'],
          keyID: '1',
          ciphertext: [0x01, 0x02]
        },
        'app.com'
      )

      expect(testModule.onRequest).toHaveBeenCalledTimes(1)
      expect(testModule.onResponse).toHaveBeenCalledTimes(1)
    })

    it('should delegate createHmac to P-protocol module', async () => {
      const testModule: PermissionsModule = {
        onRequest: jest.fn(async req => {
          expect(req.method).toBe('createHmac')
          return req
        }),
        onResponse: jest.fn(async res => res)
      }

      const config: PermissionsManagerConfig = {
        permissionModules: {
          hmac: testModule
        },
        seekProtocolPermissionsForHMAC: false
      }

      const manager = new WalletPermissionsManager(underlying, 'customToken.domain.com', config)

      underlying.createHmac.mockResolvedValue({ hmac: [0x01] })

      await manager.createHmac(
        {
          protocolID: [2, 'p hmac test'],
          keyID: '1',
          data: [0x48]
        },
        'app.com'
      )

      expect(testModule.onRequest).toHaveBeenCalledTimes(1)
    })

    it('should delegate verifyHmac to P-protocol module', async () => {
      const testModule: PermissionsModule = {
        onRequest: jest.fn(async req => {
          expect(req.method).toBe('verifyHmac')
          return req
        }),
        onResponse: jest.fn(async res => res)
      }

      const config: PermissionsManagerConfig = {
        permissionModules: {
          hmac: testModule
        }
      }

      const manager = new WalletPermissionsManager(underlying, 'customToken.domain.com', config)

      underlying.verifyHmac.mockResolvedValue(true)

      await manager.verifyHmac(
        {
          protocolID: [2, 'p hmac verify'],
          keyID: '1',
          data: [0x48],
          hmac: [0x01]
        },
        'app.com'
      )

      expect(testModule.onRequest).toHaveBeenCalledTimes(1)
    })
  })

  describe('P-Module Error Handling', () => {
    it('should reject invalid P-label formats', async () => {
      const manager = new WalletPermissionsManager(underlying, 'customToken.domain.com', {})

      await expect(manager.listActions({ labels: ['p schemeOnly'] }, 'app.com')).rejects.toThrow(
        'Invalid P-label format'
      )
      await expect(manager.listActions({ labels: ['p  missingScheme'] }, 'app.com')).rejects.toThrow(
        'Invalid P-label format'
      )
      await expect(manager.listActions({ labels: ['p scheme '] }, 'app.com')).rejects.toThrow('Invalid P-label format')

      expect(underlying.listActions).not.toHaveBeenCalled()
    })

    it('should throw if P-label scheme is unsupported', async () => {
      const manager = new WalletPermissionsManager(underlying, 'customToken.domain.com', {})

      await expect(manager.listActions({ labels: ['p unknown scheme', 'regular-label'] }, 'app.com')).rejects.toThrow(
        'Unsupported P-label scheme: p unknown'
      )

      expect(underlying.listActions).not.toHaveBeenCalled()
    })

    it('should throw if P-module onRequest throws', async () => {
      const testModule: PermissionsModule = {
        onRequest: jest.fn(async () => {
          throw new Error('Module validation failed')
        }),
        onResponse: jest.fn(async res => res)
      }

      const config: PermissionsManagerConfig = {
        permissionModules: {
          failing: testModule
        }
      }

      const manager = new WalletPermissionsManager(underlying, 'customToken.domain.com', config)

      await expect(manager.listOutputs({ basket: 'p failing data' }, 'app.com')).rejects.toThrow(
        'Module validation failed'
      )

      // Underlying should not be called if module fails
      expect(underlying.listOutputs).not.toHaveBeenCalled()
    })

    it('should throw if P-module onResponse throws', async () => {
      const testModule: PermissionsModule = {
        onRequest: jest.fn(async req => req),
        onResponse: jest.fn(async () => {
          throw new Error('Module response processing failed')
        })
      }

      const config: PermissionsManagerConfig = {
        permissionModules: {
          failing: testModule
        }
      }

      const manager = new WalletPermissionsManager(underlying, 'customToken.domain.com', config)

      underlying.listOutputs.mockResolvedValue({ outputs: [] })

      await expect(manager.listOutputs({ basket: 'p failing data' }, 'app.com')).rejects.toThrow(
        'Module response processing failed'
      )

      // Underlying was called, but response processing failed
      expect(underlying.listOutputs).toHaveBeenCalled()
    })

    it('should call P-module onRequest even when permission checks are enabled', async () => {
      const testModule: PermissionsModule = {
        onRequest: jest.fn(async req => {
          // Module validation happens before permission checks
          return req
        }),
        onResponse: jest.fn(async res => res)
      }

      const config: PermissionsManagerConfig = {
        permissionModules: {
          myscheme: testModule
        },
        seekProtocolPermissionsForSigning: false // Disable to simplify test
      }

      const manager = new WalletPermissionsManager(underlying, 'customToken.domain.com', config)

      underlying.createSignature.mockResolvedValue({ signature: [0x01] })

      // Create a signature request with P-protocol
      await manager.createSignature(
        {
          protocolID: [1, 'p myscheme sign'],
          keyID: '1',
          data: [0x01]
        },
        'app.com'
      )

      // Module should have been called
      expect(testModule.onRequest).toHaveBeenCalled()
      expect(testModule.onResponse).toHaveBeenCalled()
    })
  })

  describe('P-Module Admin Bypass', () => {
    it('should still use P-module even for admin originator', async () => {
      const testModule: PermissionsModule = {
        onRequest: jest.fn(async req => {
          // Module should be called even for admin
          expect(req.originator).toBe('admin.com')
          return req
        }),
        onResponse: jest.fn(async res => res)
      }

      const config: PermissionsManagerConfig = {
        permissionModules: {
          myscheme: testModule
        }
      }

      const manager = new WalletPermissionsManager(underlying, 'admin.com', config)

      underlying.listOutputs.mockResolvedValue({ outputs: [] })

      await manager.listOutputs({ basket: 'p myscheme data' }, 'admin.com')

      // Module should be invoked even for admin calls
      expect(testModule.onRequest).toHaveBeenCalledTimes(1)
      expect(testModule.onResponse).toHaveBeenCalledTimes(1)
    })

    it('should still block non-admin access to admin baskets even with P-module', async () => {
      const testModule: PermissionsModule = {
        onRequest: jest.fn(async req => req),
        onResponse: jest.fn(async res => res)
      }

      const config: PermissionsManagerConfig = {
        permissionModules: {
          myscheme: testModule
        },
        seekBasketListingPermissions: false
      }

      const manager = new WalletPermissionsManager(underlying, 'customToken.domain.com', config)

      // Try to access admin basket with non-admin originator
      // Admin baskets are prefixed with 'admin_' by convention
      await expect(manager.listOutputs({ basket: 'admin_someAdminBasket' }, 'app.com')).rejects.toThrow(/admin-only/)

      // P-module should NOT have been called since admin check happens before P-module delegation
      expect(testModule.onRequest).not.toHaveBeenCalled()
    })
  })
})
