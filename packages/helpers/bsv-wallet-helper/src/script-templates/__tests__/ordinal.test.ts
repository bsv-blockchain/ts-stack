import { describe, expect, test } from '@jest/globals'
import {
  LockingScript,
  PrivateKey,
  Transaction,
  Script,
  MerklePath,
  WalletProtocol,
  WalletCounterparty
} from '@bsv/sdk'
import OrdP2PKH, { applyInscription, Inscription, MAP } from '../ordinal'
import { makeMockWallet } from '../../utils/mockWallet'

// Transaction.fee() with no args resolves to the SDK's LivePolicy, which fetches the live ARC
// policy endpoint. Intercept just that URL with a deterministic 100 sat/kb stub.
const realFetch = global.fetch
beforeAll(() => {
  global.fetch = jest.fn(async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : (input?.url ?? '')
    if (url.includes('arc.gorillapool.io/v1/policy')) {
      return {
        ok: true,
        json: async () => ({ policy: { miningFee: { satoshis: 1, bytes: 10 } } })
      } as any
    }
    return realFetch(input, init)
  }) as any
})
afterAll(() => {
  global.fetch = realFetch
})

describe('OrdP2PKH locking script', () => {
  describe('lock with public key string', () => {
    test('should create a valid ordinal locking script from a public key hex string', async () => {
      const privateKey = new PrivateKey(1)
      const publicKey = privateKey.toPublicKey()
      const publicKeyHex = publicKey.toString()

      const ordP2pkh = new OrdP2PKH()
      const lockingScript = await ordP2pkh.lock({ publicKey: publicKeyHex })

      // Verify the script contains P2PKH structure
      const scriptAsm = lockingScript.toASM()
      expect(scriptAsm).toContain('OP_DUP')
      expect(scriptAsm).toContain('OP_HASH160')
      expect(scriptAsm).toContain('OP_EQUALVERIFY')
      expect(scriptAsm).toContain('OP_CHECKSIG')
    })

    test('should create a valid ordinal locking script with inscription', async () => {
      const privateKey = new PrivateKey(2)
      const publicKey = privateKey.toPublicKey()
      const publicKeyHex = publicKey.toString()

      const inscription: Inscription = {
        dataB64: Buffer.from('Hello, World!').toString('base64'),
        contentType: 'text/plain'
      }

      const ordP2pkh = new OrdP2PKH()
      const lockingScript = await ordP2pkh.lock({ publicKey: publicKeyHex, inscription })

      // Verify the script contains ordinal envelope
      const scriptAsm = lockingScript.toASM()
      expect(scriptAsm).toContain('OP_0')
      expect(scriptAsm).toContain('OP_IF')
      expect(scriptAsm).toContain('OP_ENDIF')
      // Verify it still has P2PKH
      expect(scriptAsm).toContain('OP_DUP')
      expect(scriptAsm).toContain('OP_CHECKSIG')
    })

    test('should create a valid ordinal locking script with MAP metadata', async () => {
      const privateKey = new PrivateKey(3)
      const publicKey = privateKey.toPublicKey()
      const publicKeyHex = publicKey.toString()

      const metaData: MAP = {
        app: 'testapp',
        type: 'profile',
        name: 'test-user'
      }

      const ordP2pkh = new OrdP2PKH()
      const lockingScript = await ordP2pkh.lock({ publicKey: publicKeyHex, metadata: metaData })

      // Verify the script contains MAP metadata
      const scriptAsm = lockingScript.toASM()
      expect(scriptAsm).toContain('OP_RETURN')
      // Verify it still has P2PKH
      expect(scriptAsm).toContain('OP_DUP')
      expect(scriptAsm).toContain('OP_CHECKSIG')
    })

    test('should create a valid ordinal locking script with both inscription and MAP metadata', async () => {
      const privateKey = new PrivateKey(4)
      const publicKey = privateKey.toPublicKey()
      const publicKeyHex = publicKey.toString()

      const inscription: Inscription = {
        dataB64: Buffer.from('Test image data').toString('base64'),
        contentType: 'image/png'
      }

      const metaData: MAP = {
        app: 'gallery',
        type: 'artwork',
        artist: 'satoshi'
      }

      const ordP2pkh = new OrdP2PKH()
      const lockingScript = await ordP2pkh.lock({
        publicKey: publicKeyHex,
        inscription,
        metadata: metaData
      })

      // Verify the script contains all components
      const scriptAsm = lockingScript.toASM()
      expect(scriptAsm).toContain('OP_IF') // Ordinal envelope
      expect(scriptAsm).toContain('OP_DUP') // P2PKH
      expect(scriptAsm).toContain('OP_RETURN') // MAP metadata
    })

    test('should reject MAP metadata without required fields', async () => {
      const privateKey = new PrivateKey(5)
      const publicKey = privateKey.toPublicKey()
      const publicKeyHex = publicKey.toString()

      const invalidMetaData = {
        app: 'testapp'
        // Missing 'type' field
      } as MAP

      const ordP2pkh = new OrdP2PKH()
      await expect(
        ordP2pkh.lock({ publicKey: publicKeyHex, metadata: invalidMetaData })
      ).rejects.toThrow('metadata.type is required and must be a string')
    })

    test('should support every direct locking target', async () => {
      const publicKey = new PrivateKey(9).toPublicKey()
      const ordP2pkh = new OrdP2PKH()

      const byHash = await ordP2pkh.lock({ pubkeyhash: publicKey.toHash() as number[] })
      const byAddress = await ordP2pkh.lock({ address: publicKey.toAddress().toString() })

      expect(byHash.toHex()).toBe(byAddress.toHex())
    })

    test('should reject every malformed inscription and metadata shape', async () => {
      const publicKey = new PrivateKey(10).toPublicKey().toString()
      const ordP2pkh = new OrdP2PKH()
      const scenarios: Array<{ params: any; message: string }> = [
        {
          params: { publicKey, inscription: null },
          message: 'inscription must be an object with dataB64 and contentType properties'
        },
        {
          params: { publicKey, inscription: 1 },
          message: 'inscription must be an object with dataB64 and contentType properties'
        },
        {
          params: { publicKey, inscription: {} },
          message: 'inscription.dataB64 is required and must be a base64 string'
        },
        {
          params: { publicKey, inscription: { dataB64: 1, contentType: 'text/plain' } },
          message: 'inscription.dataB64 is required and must be a base64 string'
        },
        {
          params: { publicKey, inscription: { dataB64: 'eA==' } },
          message: 'inscription.contentType is required and must be a string (MIME type)'
        },
        {
          params: { publicKey, inscription: { dataB64: 'eA==', contentType: 1 } },
          message: 'inscription.contentType is required and must be a string (MIME type)'
        },
        {
          params: { publicKey, metadata: null },
          message: 'metadata must be an object'
        },
        {
          params: { publicKey, metadata: 1 },
          message: 'metadata must be an object'
        },
        {
          params: { publicKey, metadata: { type: 'profile' } },
          message: 'metadata.app is required and must be a string'
        },
        {
          params: { publicKey, metadata: { app: 1, type: 'profile' } },
          message: 'metadata.app is required and must be a string'
        },
        {
          params: { publicKey, metadata: { app: 'testapp' } },
          message: 'metadata.type is required and must be a string'
        },
        {
          params: { publicKey, metadata: { app: 'testapp', type: 1 } },
          message: 'metadata.type is required and must be a string'
        }
      ]

      for (const scenario of scenarios) {
        await expect(ordP2pkh.lock(scenario.params)).rejects.toThrow(scenario.message)
      }
      await expect(ordP2pkh.lock({} as any)).rejects.toThrow(
        'One of pubkeyhash, address, publicKey, or walletParams is required'
      )
    })

    test('should reject malformed direct envelopes and preserve separator and MAP command semantics', () => {
      const lockingScript = LockingScript.fromASM('OP_TRUE')

      expect(() =>
        applyInscription(lockingScript, { dataB64: '====', contentType: 'text/plain' })
      ).toThrow('Invalid file data')
      expect(() => applyInscription(lockingScript, { dataB64: 'eA==', contentType: '' })).toThrow(
        'Invalid media type'
      )
      expect(() => applyInscription(lockingScript, undefined, { app: 'testapp' } as MAP)).toThrow(
        'MAP.app and MAP.type are required fields'
      )

      const decorated = applyInscription(
        lockingScript,
        { dataB64: 'eA==', contentType: 'text/plain' },
        { app: 'testapp', type: 'profile', cmd: 'SET' },
        true
      )
      expect(decorated.toASM()).toContain('OP_CODESEPARATOR')
      expect(decorated.toASM()).toContain('OP_RETURN')

      const metadataOnly = applyInscription(LockingScript.fromASM(''), undefined, {
        app: 'testapp',
        type: 'profile'
      })
      expect(metadataOnly.toASM()).toContain('OP_RETURN')
    })
  })

  describe('lock with BRC-100 wallet', () => {
    test('should create a valid ordinal locking script using wallet', async () => {
      const privateKey = new PrivateKey(6)
      const wallet = await makeMockWallet(privateKey)

      const ordP2pkh = new OrdP2PKH(wallet)
      const lockingScript = await ordP2pkh.lock({
        walletParams: {
          protocolID: [2, 'p2pkh'] as WalletProtocol,
          keyID: '0',
          counterparty: 'self' as WalletCounterparty
        }
      })

      // Verify the script structure
      const scriptAsm = lockingScript.toASM()
      expect(scriptAsm).toContain('OP_DUP')
      expect(scriptAsm).toContain('OP_HASH160')
      expect(scriptAsm).toContain('OP_EQUALVERIFY')
      expect(scriptAsm).toContain('OP_CHECKSIG')
    })

    test('should create ordinal with inscription using wallet', async () => {
      const privateKey = new PrivateKey(7)
      const wallet = await makeMockWallet(privateKey)

      const inscription: Inscription = {
        dataB64: Buffer.from('Wallet inscription').toString('base64'),
        contentType: 'text/plain'
      }

      const ordP2pkh = new OrdP2PKH(wallet)
      const lockingScript = await ordP2pkh.lock({
        walletParams: {
          protocolID: [2, 'p2pkh'] as WalletProtocol,
          keyID: '0',
          counterparty: 'self' as WalletCounterparty
        },
        inscription
      })

      // Verify the script contains ordinal envelope and P2PKH
      const scriptAsm = lockingScript.toASM()
      expect(scriptAsm).toContain('OP_IF')
      expect(scriptAsm).toContain('OP_DUP')
    })

    test('should create the same locking script as direct public key', async () => {
      const privateKey = new PrivateKey(8)
      const wallet = await makeMockWallet(privateKey)

      const protocolID = [2, 'p2pkh'] as WalletProtocol
      const keyID = '0'
      const counterparty = 'self' as WalletCounterparty

      // Get public key from wallet
      const { publicKey } = await wallet.getPublicKey({
        protocolID,
        keyID,
        counterparty
      })

      const ordP2pkhWithWallet = new OrdP2PKH(wallet)
      const ordP2pkhWithoutWallet = new OrdP2PKH()

      // Lock with wallet
      const lockingScriptFromWallet = await ordP2pkhWithWallet.lock({
        walletParams: {
          protocolID,
          keyID,
          counterparty
        }
      })

      // Lock with public key string
      const lockingScriptFromPubKey = await ordP2pkhWithoutWallet.lock({ publicKey })

      // Both should produce identical scripts
      expect(lockingScriptFromWallet.toHex()).toBe(lockingScriptFromPubKey.toHex())
    })
  })
})

describe('OrdP2PKH unlocking and transaction verification', () => {
  test('should create a valid transaction with ordinal inscription', async () => {
    // Generate deterministic test key
    const userPriv = new PrivateKey(100)

    // Create mock wallet (hermetic, no network)
    const userWallet = await makeMockWallet(userPriv)

    const protocolID = [2, 'p2pkh'] as WalletProtocol
    const keyID = '0'
    const counterparty = 'self' as WalletCounterparty

    // Get the public key for locking
    const { publicKey: userLockingKey } = await userWallet.getPublicKey({
      protocolID,
      keyID,
      counterparty
    })

    // Step 1: Create source transaction with ordinal inscription
    const sourceTransaction = new Transaction()
    sourceTransaction.addInput({
      sourceTXID: '0000000000000000000000000000000000000000000000000000000000000000',
      sourceOutputIndex: 0,
      unlockingScript: Script.fromASM('OP_TRUE')
    })

    // Create ordinal with inscription
    const inscription: Inscription = {
      dataB64: Buffer.from('Test NFT').toString('base64'),
      contentType: 'text/plain'
    }

    const metaData: MAP = {
      app: 'nft-app',
      type: 'collectible',
      id: '001'
    }

    const ordP2pkhLock = new OrdP2PKH()
    const lockingScript = await ordP2pkhLock.lock({
      publicKey: userLockingKey,
      inscription,
      metadata: metaData
    })

    sourceTransaction.addOutput({
      lockingScript,
      satoshis: 1000
    })

    // Add merkle proof (required for inputs)
    sourceTransaction.merklePath = MerklePath.fromCoinbaseTxidAndHeight(
      sourceTransaction.id('hex'),
      1234
    )

    // Step 2: Create spending transaction
    const spendingTx = new Transaction()

    const ordP2pkhUnlock = new OrdP2PKH(userWallet)
    spendingTx.addInput({
      sourceTransaction,
      sourceOutputIndex: 0,
      unlockingScriptTemplate: ordP2pkhUnlock.unlock({
        protocolID,
        keyID,
        counterparty
      })
    })

    // Add output (send to same address)
    spendingTx.addOutput({
      lockingScript: await ordP2pkhLock.lock({ publicKey: userLockingKey }),
      satoshis: 900
    })

    // Step 3: Sign and verify the transaction
    await spendingTx.fee()
    await spendingTx.sign()

    const isValid = await spendingTx.verify('scripts only')

    expect(isValid).toBe(true)
  }, 30000)

  test('should correctly estimate unlocking script length', async () => {
    const userPriv = new PrivateKey(103)
    const userWallet = await makeMockWallet(userPriv)

    const protocolID = [2, 'p2pkh'] as WalletProtocol
    const keyID = '0'
    const counterparty = 'self' as WalletCounterparty

    const ordP2pkh = new OrdP2PKH(userWallet)
    const unlockTemplate = ordP2pkh.unlock({
      protocolID,
      keyID,
      counterparty
    })

    const estimatedLength = await unlockTemplate.estimateLength()

    // P2PKH unlocking script should be 108 bytes
    // (1 byte push + 73 bytes signature) + (1 byte push + 33 bytes compressed pubkey) = 108
    expect(estimatedLength).toBe(108)
  }, 30000)
})
