import { WalletAdvertiser } from '../WalletAdvertiser'
import { isTokenSignatureCorrectlyLinked } from '../utils/isTokenSignatureCorrectlyLinked'
import { PrivateKey, Transaction, PushDrop, Utils, PublicKey, ProtoWallet, WalletInterface, LockingScript } from '@bsv/sdk'
import { Engine } from '@bsv/overlay'
import { jest } from '@jest/globals'

const mockWallet: WalletInterface = new ProtoWallet(new PrivateKey(42)) as any as WalletInterface
mockWallet.createAction = jest.fn(() => ({
  tx: new Transaction(3, [], [], 0).toAtomicBEEF(),
  txid: new Transaction(3, [], [], 0).id('hex'),
  signableTransaction: {
    tx: new Transaction(1, [], [], 0).toAtomicBEEF(),
    reference: 'mock_ref'
  }
})) as any
mockWallet.signAction = jest.fn(() => ({ tx: new Transaction(2, [], [], 0).toAtomicBEEF() })) as any
mockWallet.getNetwork = jest.fn(() => ({ network: 'mainnet' })) as any

jest.mock('@bsv/wallet-toolbox-client', () => {
  return {
    Services: jest.fn().mockImplementation(() => {
      return {
      }
    }),
    WalletSigner: jest.fn().mockImplementation(() => {
      return {
      }
    }),
    Wallet: jest.fn().mockImplementation(() => {
      return mockWallet
    }),
    StorageClient: jest.fn().mockImplementation(() => {
      return {
        makeAvailable: jest.fn().mockResolvedValue(undefined as never)
      }
    }),
    WalletStorageManager: jest.fn().mockImplementation((identityKey: unknown) => {
      return {
        addWalletStorageProvider: jest.fn().mockResolvedValue(undefined as never),
        identityKey
      }
    }),
    alletStorageManager: jest.fn().mockImplementation(() => {
      return {
      }
    })
  }
})

describe('WalletAdvertiser', () => {
  let testPrivateKeyHex = ''
  let advertiser: WalletAdvertiser

  beforeAll(() => {
    const testKey = new PrivateKey(42)
    testPrivateKeyHex = testKey.toHex()
  })

  describe('Constructor', () => {
    it('throws if provided a non-advertisable URI', () => {
      expect(() => {
        new WalletAdvertiser('test', testPrivateKeyHex, 'https://fake-storage-url.com', 'xyz://bad-protocol.com')
      }).toThrow('Refusing to initialize with non-advertisable URI')
    })

    it('constructs properly with a valid URI', () => {
      expect(() => {
        advertiser = new WalletAdvertiser(
          'test',
          testPrivateKeyHex,
          'https://fake-storage-url.com',
          'https://advertise-me.com'
        )
      }).not.toThrow()
    })
  })

  describe('init', () => {
    it('throws if used before init is called', async () => {
      // The advertiser is constructed but not yet initialized.
      await expect(advertiser.findAllAdvertisements('SHIP')).rejects.toThrow(
        'Initialize the Advertiser using init() before use.'
      )
    })

    it('initializes properly', async () => {
      await expect(advertiser.init()).resolves.not.toThrow()
    })
  })

  describe('createAdvertisements', () => {
    it('creates a valid SHIP advertisement that passes the signature check', async () => {
      // Now that we've constructed and initialized:
      // We'll create a single advertisement for 'SHIP'.
      const adsData = [
        {
          protocol: 'SHIP' as 'SHIP',
          topicOrServiceName: 'tm_meter'
        }
      ]

      // This should create a transaction that includes a properly signed PushDrop output.
      const taggedBeef = await advertiser.createAdvertisements(adsData)

      expect(taggedBeef).toHaveProperty('beef')
      expect(taggedBeef.topics).toEqual(['tm_ship'])

      // Decode the transaction from the returned BEEF
      const tx = (mockWallet.createAction as any).mock.calls[0][0]
      expect(tx.outputs.length).toBe(1)

      const out = tx.outputs[0]
      expect(out.satoshis).toBe(1)
      expect(out.outputDescription).toEqual('SHIP advertisement of tm_meter')

      // Decode the output with PushDrop
      const decodeResult = PushDrop.decode(LockingScript.fromHex(out.lockingScript))
      // We expect 4 original fields from the code plus the appended signature = 5 total
      expect(decodeResult.fields.length).toBe(5)

      // Confirm the token is valid
      const isValid = await isTokenSignatureCorrectlyLinked(decodeResult.lockingPublicKey, decodeResult.fields)
      expect(isValid).toBe(true)
    })

    it('throws if trying to create advertisement with invalid topic/service name', async () => {
      // For example, a topic name with special characters might fail.
      const adsData = [
        {
          protocol: 'SHIP' as 'SHIP',
          topicOrServiceName: '!@#$invalid-topic'
        }
      ]
      await expect(advertiser.createAdvertisements(adsData)).rejects.toThrow(
        'Refusing to create SHIP advertisement with invalid topic or service name'
      )
    })
  })

  describe('parseAdvertisement', () => {
    it('Properly parses an advertisement script', async () => {
      const adsData = [
        {
          protocol: 'SHIP' as 'SHIP',
          topicOrServiceName: 'tm_meter'
        }
      ]
      await advertiser.createAdvertisements(adsData)
      const tx = (mockWallet.createAction as any).mock.calls[0][0]
      const script = LockingScript.fromHex(tx.outputs[0].lockingScript)
      expect(advertiser.parseAdvertisement(script)).toEqual({
        protocol: 'SHIP',
        topicOrService: 'tm_meter',
        domain: 'https://advertise-me.com',
        identityKey: '02fe8d1eb1bcb3432b1db5833ff5f2226d9cb5e65cee430558c18ed3a3c86ce1af'
      })
    })

    // TODO: Sad testing
  })

  describe('findAllAdvertisements', () => {
    it('returns an empty array if the Engine lookup is an empty output-list', async () => {
      // We already have a mocked engine returning empty 'output-list'
      // so we can just call:
      const found = await advertiser.findAllAdvertisements('SHIP')
      expect(found).toEqual([])
    })

    // TODO: Complete testing of finding nd parsing
  })

  describe('revokeAdvertisements', () => {
    it('throws if given an empty array of advertisements', async () => {
      await expect(advertiser.revokeAdvertisements([])).rejects.toThrow(
        'Must provide advertisements to revoke!'
      )
    })

    // TODO: Complete testing of revocation.
  })
})
