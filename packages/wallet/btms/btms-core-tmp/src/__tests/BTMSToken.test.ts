/**
 * BTMSToken Tests
 * 
 * Tests for the BTMSToken class which handles encoding and decoding
 * of BTMS PushDrop tokens according to the BTMSTopicManager protocol.
 */

import { BTMSToken } from '../BTMSToken.js'
import { LockingScript, Utils } from '@bsv/sdk'

describe('BTMSToken', () => {
  describe('decode', () => {
    it('should return invalid for non-PushDrop scripts', () => {
      // A simple P2PKH script is not a valid BTMS token
      const p2pkhScript = LockingScript.fromASM('OP_DUP OP_HASH160 ' + 'aa'.repeat(20) + ' OP_EQUALVERIFY OP_CHECKSIG')
      const result = BTMSToken.decode(p2pkhScript)

      expect(result.valid).toBe(false)
    })

    it('should return invalid for empty script', () => {
      const result = BTMSToken.decode('')
      expect(result.valid).toBe(false)
    })

    it('should return invalid for malformed hex', () => {
      const result = BTMSToken.decode('not-valid-hex')
      expect(result.valid).toBe(false)
    })
  })

  describe('isValidAssetId', () => {
    it('should accept valid asset ID format', () => {
      const validId = 'a'.repeat(64) + '.0'
      expect(BTMSToken.isValidAssetId(validId)).toBe(true)
    })

    it('should accept asset ID with higher output index', () => {
      const validId = 'b'.repeat(64) + '.5'
      expect(BTMSToken.isValidAssetId(validId)).toBe(true)
    })

    it('should reject ISSUE marker as asset ID', () => {
      expect(BTMSToken.isValidAssetId('ISSUE')).toBe(false)
    })

    it('should reject asset ID with invalid txid length', () => {
      expect(BTMSToken.isValidAssetId('abc123.0')).toBe(false)
    })

    it('should reject asset ID with non-hex txid', () => {
      const invalidId = 'g'.repeat(64) + '.0'
      expect(BTMSToken.isValidAssetId(invalidId)).toBe(false)
    })

    it('should reject asset ID with negative output index', () => {
      const invalidId = 'a'.repeat(64) + '.-1'
      expect(BTMSToken.isValidAssetId(invalidId)).toBe(false)
    })

    it('should reject asset ID without dot separator', () => {
      expect(BTMSToken.isValidAssetId('a'.repeat(64))).toBe(false)
    })

    it('should reject asset ID with non-numeric output index', () => {
      const invalidId = 'a'.repeat(64) + '.abc'
      expect(BTMSToken.isValidAssetId(invalidId)).toBe(false)
    })
  })

  describe('isIssuance', () => {
    it('should return true for issuance tokens', () => {
      const decoded = {
        valid: true as const,
        assetId: 'ISSUE',
        amount: 100,
        lockingPublicKey: '03' + 'a'.repeat(64)
      }
      expect(BTMSToken.isIssuance(decoded)).toBe(true)
    })

    it('should return false for transfer tokens', () => {
      const decoded = {
        valid: true as const,
        assetId: 'a'.repeat(64) + '.0',
        amount: 100,
        lockingPublicKey: '03' + 'a'.repeat(64)
      }
      expect(BTMSToken.isIssuance(decoded)).toBe(false)
    })
  })

  describe('computeAssetId', () => {
    it('should compute correct asset ID from txid and output index', () => {
      const txid = 'a'.repeat(64)
      expect(BTMSToken.computeAssetId(txid, 0)).toBe(txid + '.0')
      expect(BTMSToken.computeAssetId(txid, 5)).toBe(txid + '.5')
    })
  })
})
