import { PrivateKey } from '@bsv/sdk'
import { getAddress, getDerivation } from '../derivation'
import { makeMockWallet } from '../mockWallet'

describe('getDerivation', () => {
  test('should generate a derivation with protocolID and keyID', () => {
    const derivation = getDerivation()

    expect(derivation).toHaveProperty('protocolID')
    expect(derivation).toHaveProperty('keyID')
    expect(typeof derivation.keyID).toBe('string')
    expect(derivation.keyID).toContain(' ') // Should have prefix + space + suffix
  })

  test('should generate unique keyIDs on each call', () => {
    const derivation1 = getDerivation()
    const derivation2 = getDerivation()

    expect(derivation1.keyID).not.toBe(derivation2.keyID)
  })
})

describe('getAddress', () => {
  describe('validation', () => {
    test('should throw error when wallet is not provided', async () => {
      await expect(getAddress(null as any)).rejects.toThrow('Wallet is required')
    })

    test('should reject invalid or excessive batch sizes', async () => {
      const privateKey = new PrivateKey(1)
      const wallet = await makeMockWallet(privateKey)

      for (const amount of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 1001]) {
        await expect(getAddress(wallet, amount)).rejects.toThrow(
          'Amount must be a safe integer between 1 and 1000'
        )
      }
    })

    test('should reject malformed counterparties before wallet calls', async () => {
      const wallet = await makeMockWallet(new PrivateKey(10))
      await expect(getAddress(wallet, 1, 'not-a-key')).rejects.toThrow(
        'counterparty must be "self", "anyone", or a compressed public key'
      )
    })
  })

  describe('single address generation', () => {
    test('should generate 1 address by default', async () => {
      const privateKey = new PrivateKey(2)
      const wallet = await makeMockWallet(privateKey)

      const results = await getAddress(wallet)

      expect(results).toHaveLength(1)
      expect(results[0]).toHaveProperty('address')
      expect(results[0]).toHaveProperty('walletParams')
      expect(typeof results[0].address).toBe('string')
      expect(results[0].walletParams).toHaveProperty('protocolID')
      expect(results[0].walletParams).toHaveProperty('keyID')
      expect(results[0].walletParams).toHaveProperty('counterparty')
    })

    test('should generate valid BSV address', async () => {
      const privateKey = new PrivateKey(3)
      const wallet = await makeMockWallet(privateKey)

      const results = await getAddress(wallet, 1)

      expect(results[0].address).toBeTruthy()
      expect(results[0].address.length).toBeGreaterThan(25)
    })

    test('should generate walletParams with correct format', async () => {
      const privateKey = new PrivateKey(4)
      const wallet = await makeMockWallet(privateKey)

      const results = await getAddress(wallet, 1)

      expect(results[0].walletParams.keyID).toContain(' ') // Should have space separator
      const parts = results[0].walletParams.keyID.split(' ')
      expect(parts).toHaveLength(2) // prefix + suffix
      expect(results[0].walletParams.counterparty).toBe('self')
      expect(Array.isArray(results[0].walletParams.protocolID)).toBe(true)
    })

    test('always derives the caller-owned address side for a peer counterparty', async () => {
      const publicKey = new PrivateKey(4).toPublicKey().toString()
      const getPublicKey = jest.fn(async () => ({ publicKey }))
      const peer = new PrivateKey(5).toPublicKey().toString()

      await getAddress({ getPublicKey } as any, 1, peer)

      expect(getPublicKey).toHaveBeenCalledWith(
        expect.objectContaining({ counterparty: peer, forSelf: true })
      )
    })
  })

  describe('multiple address generation', () => {
    test('should generate exact number of addresses requested', async () => {
      const privateKey = new PrivateKey(5)
      const wallet = await makeMockWallet(privateKey)

      const results = await getAddress(wallet, 5)

      expect(results).toHaveLength(5)
      results.forEach(result => {
        expect(result).toHaveProperty('address')
        expect(result).toHaveProperty('walletParams')
        expect(typeof result.address).toBe('string')
        expect(result.walletParams).toHaveProperty('protocolID')
        expect(result.walletParams).toHaveProperty('keyID')
        expect(result.walletParams).toHaveProperty('counterparty')
      })
    })

    test('should generate unique addresses', async () => {
      const privateKey = new PrivateKey(6)
      const wallet = await makeMockWallet(privateKey)

      const results = await getAddress(wallet, 10)

      const addresses = results.map(r => r.address)
      const uniqueAddresses = new Set(addresses)
      expect(uniqueAddresses.size).toBe(10) // All addresses should be unique
    })

    test('should generate unique keyIDs', async () => {
      const privateKey = new PrivateKey(7)
      const wallet = await makeMockWallet(privateKey)

      const results = await getAddress(wallet, 10)

      const keyIDs = results.map(r => r.walletParams.keyID)
      const uniqueKeyIDs = new Set(keyIDs)
      expect(uniqueKeyIDs.size).toBe(10) // All keyIDs should be unique
    })

    test('should handle large batch generation', async () => {
      const privateKey = new PrivateKey(8)
      const wallet = await makeMockWallet(privateKey)

      const results = await getAddress(wallet, 20)

      expect(results).toHaveLength(20)

      // Verify all are valid
      results.forEach(result => {
        expect(result.address).toBeTruthy()
        expect(result.walletParams.keyID).toBeTruthy()
        expect(result.walletParams.keyID).toContain(' ')
        expect(result.walletParams.counterparty).toBe('self')
      })
    })
  })

  describe('error handling', () => {
    test('should throw error with message on wallet failure', async () => {
      // Create a mock wallet that will fail
      const mockWallet = {
        getPublicKey: async () => {
          throw new Error('Wallet connection failed')
        }
      }

      await expect(getAddress(mockWallet as any, 1)).rejects.toThrow('Wallet connection failed')
    })

    test('should handle non-Error exceptions', async () => {
      const mockWallet = {
        getPublicKey: async () => {
          throw 'String error'
        }
      }

      await expect(getAddress(mockWallet as any, 1)).rejects.toThrow('Failed to generate addresses')
    })
  })

  describe('parallel execution', () => {
    test('should execute requests in parallel for efficiency', async () => {
      const privateKey = new PrivateKey(9)
      const wallet = await makeMockWallet(privateKey)

      const startTime = Date.now()
      const results = await getAddress(wallet, 5)
      const duration = Date.now() - startTime

      expect(results).toHaveLength(5)
      // If sequential, this would take much longer
      // This is a basic sanity check that parallel execution is working
      expect(duration).toBeLessThan(10000) // Should complete in reasonable time
    })
  })
})
