/// <reference types="jest" />

import KVStoreTopicManager from '../KVStoreTopicManager.js'
import { Transaction, Utils, PushDrop } from '@bsv/sdk'

// Mock ProtoWallet at module level
jest.mock('@bsv/sdk', () => {
  const actual = jest.requireActual('@bsv/sdk')
  return {
    ...actual,
    ProtoWallet: jest.fn().mockImplementation(() => ({
      verifySignature: jest.fn()
    }))
  }
})

import { ProtoWallet } from '@bsv/sdk'
const MockedProtoWallet = ProtoWallet as jest.MockedClass<typeof ProtoWallet>

describe('KVStoreTopicManager', () => {
  let topicManager: KVStoreTopicManager

  beforeEach(() => {
    topicManager = new KVStoreTopicManager()
    // Reset mocks
    jest.clearAllMocks()
  })

  describe('identifyAdmissibleOutputs', () => {
    it('should admit valid KVStore outputs with signature verification', async () => {
      // Create mock KVStore fields matching new protocol: [protocolID, key, value, controller, signature]
      const mockProtocolID = Buffer.from(JSON.stringify([1, 'kvstore']), 'utf8')
      const mockKey = Buffer.from('test-key', 'utf8')
      const mockValue = Buffer.from('test-value', 'utf8')
      const mockController = Buffer.from('02f6e1e4c00f8a7e746f106a5d8a0b8a6b3e7c5f2d1e8b9a3c6f9e2d5b8a1f4e7c', 'hex')
      const mockSignature = Buffer.alloc(64, 'sig')

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

      // Mock PushDrop.decode to return valid KVStore fields with correct protocol structure
      const originalDecode = PushDrop.decode
      PushDrop.decode = jest.fn().mockReturnValue({
        fields: [
          mockProtocolID,  // field 0: protocolID
          mockKey,         // field 1: key
          mockValue,       // field 2: value
          mockController,  // field 3: controller
          mockSignature    // field 4: signature (will be popped for sig verification)
        ]
      })

      // Setup ProtoWallet mock to return valid signature
      const mockVerifySignature = jest.fn().mockResolvedValue({ valid: true })
      MockedProtoWallet.mockImplementation(() => ({
        verifySignature: mockVerifySignature
      } as any))

      const beef = [1, 2, 3] // Mock BEEF data
      const previousCoins = []

      const result = await topicManager.identifyAdmissibleOutputs(beef, previousCoins)

      expect(result.outputsToAdmit).toEqual([0])
      expect(result.coinsToRetain).toEqual([])

      // Verify signature verification was called with correct parameters
      expect(mockVerifySignature).toHaveBeenCalledWith({
        data: Array.from(Buffer.concat([mockProtocolID, mockKey, mockValue, mockController])),
        signature: mockSignature, // The actual implementation passes the Buffer directly
        counterparty: Utils.toHex(Array.from(mockController)),
        protocolID: [1, 'kvstore'],
        keyID: 'test-key'
      })

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

      // Mock PushDrop.decode to return wrong field count (only 3 fields instead of 5)
      PushDrop.decode = jest.fn().mockReturnValue({
        fields: [
          Buffer.from('protocol'),
          Buffer.from('key'),
          Buffer.from('value')
          // Missing controller and signature fields
        ]
      })

      const beef = [1, 2, 3]
      const previousCoins = []

      const result = await topicManager.identifyAdmissibleOutputs(beef, previousCoins)

      expect(result.outputsToAdmit).toEqual([])
      expect(result.coinsToRetain).toEqual([])
    })

    it('should reject outputs with invalid signature verification', async () => {
      const mockProtocolID = Buffer.from(JSON.stringify([1, 'kvstore']), 'utf8')
      const mockKey = Buffer.from('test-key', 'utf8')
      const mockValue = Buffer.from('test-value', 'utf8')
      const mockController = Buffer.from('02f6e1e4c00f8a7e746f106a5d8a0b8a6b3e7c5f2d1e8b9a3c6f9e2d5b8a1f4e7c', 'hex')
      const mockSignature = Buffer.alloc(64, 'invalid-sig')

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

      // Mock PushDrop.decode with valid field structure
      PushDrop.decode = jest.fn().mockReturnValue({
        fields: [mockProtocolID, mockKey, mockValue, mockController, mockSignature]
      })

      // Setup ProtoWallet mock to return invalid signature
      const mockVerifySignature = jest.fn().mockResolvedValue({ valid: false })
      MockedProtoWallet.mockImplementation(() => ({
        verifySignature: mockVerifySignature
      } as any))

      const beef = [1, 2, 3]
      const previousCoins = []

      const result = await topicManager.identifyAdmissibleOutputs(beef, previousCoins)

      expect(result.outputsToAdmit).toEqual([])
      expect(result.coinsToRetain).toEqual([])
    })

    it('should reject outputs with empty key or value fields', async () => {
      const mockProtocolID = Buffer.from(JSON.stringify([1, 'kvstore']), 'utf8')
      const mockController = Buffer.from('02f6e1e4c00f8a7e746f106a5d8a0b8a6b3e7c5f2d1e8b9a3c6f9e2d5b8a1f4e7c', 'hex')
      const mockSignature = Buffer.alloc(64, 'sig')

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

      // Mock PushDrop.decode with empty key or value field
      PushDrop.decode = jest.fn().mockReturnValue({
        fields: [
          mockProtocolID,
          Buffer.alloc(0),  // Empty key field
          Buffer.from('test-value'),
          mockController,
          mockSignature
        ]
      })

      const beef = [1, 2, 3]
      const previousCoins = []

      const result = await topicManager.identifyAdmissibleOutputs(beef, previousCoins)

      expect(result.outputsToAdmit).toEqual([])
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
