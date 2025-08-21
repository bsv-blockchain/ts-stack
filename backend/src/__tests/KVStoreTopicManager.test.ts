import KVStoreTopicManager from '../KVStoreTopicManager.js'
import { Transaction, Utils, PushDrop } from '@bsv/sdk'

describe('KVStoreTopicManager', () => {
  let topicManager: KVStoreTopicManager

  beforeEach(() => {
    topicManager = new KVStoreTopicManager()
  })

  describe('identifyAdmissibleOutputs', () => {
    it('should admit valid KVStore outputs', async () => {
      // Create mock KVStore fields
      const protectedKey = Buffer.alloc(32, 'test')
      const value = Buffer.from('test-value', 'utf8')
      
      // Create mock transaction with valid KVStore output
      const mockTransaction = {
        inputs: [{ sourceTXID: 'input-txid', sourceOutputIndex: 0 }],
        outputs: [
          {
            lockingScript: Buffer.from('mock-script')
          }
        ],
        id: jest.fn().mockReturnValue('test-txid-123')
      }

      // Mock Transaction.fromBEEF
      const originalFromBEEF = Transaction.fromBEEF
      Transaction.fromBEEF = jest.fn().mockReturnValue(mockTransaction)

      // Mock PushDrop.decode to return valid KVStore fields
      const originalDecode = PushDrop.decode
      PushDrop.decode = jest.fn().mockReturnValue({
        fields: [protectedKey, value]
      })

      const beef = [1, 2, 3] // Mock BEEF data
      const previousCoins = []

      const result = await topicManager.identifyAdmissibleOutputs(beef, previousCoins)

      expect(result.outputsToAdmit).toEqual([0])
      expect(result.coinsToRetain).toEqual([])

      // Restore original functions
      Transaction.fromBEEF = originalFromBEEF
      PushDrop.decode = originalDecode
    })

    it('should reject outputs with wrong field count', async () => {
      const mockTransaction = {
        inputs: [{ sourceTXID: 'input-txid', sourceOutputIndex: 0 }],
        outputs: [
          {
            lockingScript: Buffer.from('mock-script')
          }
        ],
        id: jest.fn().mockReturnValue('test-txid-123')
      }

      Transaction.fromBEEF = jest.fn().mockReturnValue(mockTransaction)

      // Mock PushDrop.decode to return wrong field count
      PushDrop.decode = jest.fn().mockReturnValue({
        fields: [Buffer.from('single-field')] // Only 1 field instead of 2
      })

      const beef = [1, 2, 3]
      const previousCoins = []

      const result = await topicManager.identifyAdmissibleOutputs(beef, previousCoins)

      expect(result.outputsToAdmit).toEqual([])
      expect(result.coinsToRetain).toEqual([])
    })

    it('should reject outputs with invalid protected key length', async () => {
      const mockTransaction = {
        inputs: [{ sourceTXID: 'input-txid', sourceOutputIndex: 0 }],
        outputs: [
          {
            lockingScript: Buffer.from('mock-script')
          }
        ],
        id: jest.fn().mockReturnValue('test-txid-123')
      }

      Transaction.fromBEEF = jest.fn().mockReturnValue(mockTransaction)

      // Mock PushDrop.decode with invalid protected key length
      PushDrop.decode = jest.fn().mockReturnValue({
        fields: [
          Buffer.alloc(16, 'short'), // 16 bytes instead of 32
          Buffer.from('test-value')
        ]
      })

      const beef = [1, 2, 3]
      const previousCoins = []

      const result = await topicManager.identifyAdmissibleOutputs(beef, previousCoins)

      expect(result.outputsToAdmit).toEqual([])
      expect(result.coinsToRetain).toEqual([])
    })

    it('should reject outputs with empty value field', async () => {
      const mockTransaction = {
        inputs: [{ sourceTXID: 'input-txid', sourceOutputIndex: 0 }],
        outputs: [
          {
            lockingScript: Buffer.from('mock-script')
          }
        ],
        id: jest.fn().mockReturnValue('test-txid-123')
      }

      Transaction.fromBEEF = jest.fn().mockReturnValue(mockTransaction)

      // Mock PushDrop.decode with empty value field
      PushDrop.decode = jest.fn().mockReturnValue({
        fields: [
          Buffer.alloc(32, 'test'), // Valid 32-byte protected key
          Buffer.alloc(0) // Empty value field
        ]
      })

      const beef = [1, 2, 3]
      const previousCoins = []

      const result = await topicManager.identifyAdmissibleOutputs(beef, previousCoins)

      expect(result.outputsToAdmit).toEqual([])
      expect(result.coinsToRetain).toEqual([])
    })

    it('should handle multiple outputs with mixed validity', async () => {
      const mockTransaction = {
        inputs: [{ sourceTXID: 'input-txid', sourceOutputIndex: 0 }],
        outputs: [
          { lockingScript: Buffer.from('mock-script-1') }, // Will be valid
          { lockingScript: Buffer.from('mock-script-2') }, // Will be invalid
          { lockingScript: Buffer.from('mock-script-3') }  // Will be valid
        ],
        id: jest.fn().mockReturnValue('test-txid-123')
      }

      Transaction.fromBEEF = jest.fn().mockReturnValue(mockTransaction)

      // Mock PushDrop.decode to return different results for different outputs
      let callCount = 0
      PushDrop.decode = jest.fn().mockImplementation(() => {
        callCount++
        if (callCount === 1) {
          // First output: valid KVStore
          return {
            fields: [Buffer.alloc(32, 'test1'), Buffer.from('value1')]
          }
        } else if (callCount === 2) {
          // Second output: invalid field count
          return {
            fields: [Buffer.from('single-field')]
          }
        } else {
          // Third output: valid KVStore
          return {
            fields: [Buffer.alloc(32, 'test3'), Buffer.from('value3')]
          }
        }
      })

      const beef = [1, 2, 3]
      const previousCoins = []

      const result = await topicManager.identifyAdmissibleOutputs(beef, previousCoins)

      expect(result.outputsToAdmit).toEqual([0, 2]) // First and third outputs
      expect(result.coinsToRetain).toEqual([])
    })
  })

  describe('getMetaData', () => {
    it('should return topic manager metadata', async () => {
      const metadata = await topicManager.getMetaData()
      
      expect(metadata).toEqual({
        name: 'KVStore Topic Manager',
        shortDescription: 'Admits PushDrop tokens representing KVStore key-value pairs into an overlay.',
        version: '0.1.0'
      })
    })
  })

  describe('getDocumentation', () => {
    it('should return documentation string', async () => {
      const docs = await topicManager.getDocumentation()
      
      expect(typeof docs).toBe('string')
      expect(docs).toContain('KVStore Topic Manager')
      expect(docs).toContain('Admissibility Rules')
    })
  })
})
