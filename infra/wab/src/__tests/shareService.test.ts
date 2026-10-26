// Set up test encryption key BEFORE any imports
// This must be at the very top of the file
process.env.SHARE_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

import { readShareEncryptionKey, ShareService } from '../services/ShareService'
import { UserService } from '../services/UserService'

describe('ShareService', () => {
  describe('Encryption/Decryption', () => {
    it.each(['', '00'.repeat(31), '00'.repeat(32) + '0', '00'.repeat(32) + 'zz', 'gg'.repeat(32)])(
      'rejects a missing or noncanonical server encryption key',
      value => {
        expect(() => readShareEncryptionKey(value)).toThrow('SHARE_ENCRYPTION_KEY')
      }
    )

    it('rejects a missing server encryption key', () => {
      const previous = process.env.SHARE_ENCRYPTION_KEY
      delete process.env.SHARE_ENCRYPTION_KEY
      try {
        expect(() => readShareEncryptionKey()).toThrow('SHARE_ENCRYPTION_KEY')
      } finally {
        process.env.SHARE_ENCRYPTION_KEY = previous
      }
    })

    it('accepts exactly 32 hexadecimal key bytes', () => {
      expect(readShareEncryptionKey('ab'.repeat(32))).toEqual(Buffer.from('ab'.repeat(32), 'hex'))
    })

    it('should encrypt and decrypt a share correctly', () => {
      const originalShare = '1.7KvWLhJ3rQ9FnBZxYmUdNpTsR6CwEiAoH8bVfGjDkM2.2.5XyZ'

      const { encrypted, nonce, tag } = ShareService.encryptShare(originalShare)

      expect(encrypted).toBeInstanceOf(Buffer)
      expect(nonce).toHaveLength(24) // 12 bytes = 24 hex chars
      expect(tag).toHaveLength(32) // 16 bytes = 32 hex chars

      const decrypted = ShareService.decryptShare(encrypted, nonce, tag)
      expect(decrypted).toBe(originalShare)
    })

    it('should produce different nonces for same input', () => {
      const share = 'test.share.2.abc'

      const result1 = ShareService.encryptShare(share)
      const result2 = ShareService.encryptShare(share)

      expect(result1.nonce).not.toBe(result2.nonce)
    })

    it('should fail decryption with wrong tag', () => {
      const share = 'test.share.2.abc'
      const { encrypted, nonce } = ShareService.encryptShare(share)
      const wrongTag = '00000000000000000000000000000000'

      expect(() => {
        ShareService.decryptShare(encrypted, nonce, wrongTag)
      }).toThrow()
    })

    it('should fail decryption with wrong nonce', () => {
      const share = 'test.share.2.abc'
      const { encrypted, tag } = ShareService.encryptShare(share)
      const wrongNonce = '000000000000000000000000'

      expect(() => {
        ShareService.decryptShare(encrypted, wrongNonce, tag)
      }).toThrow()
    })

    it.each([
      { nonce: '00'.repeat(11), tag: '00'.repeat(16), field: 'nonce' },
      { nonce: '00'.repeat(12), tag: '00'.repeat(4), field: 'authentication tag' },
      { nonce: 'zz'.repeat(12), tag: '00'.repeat(16), field: 'nonce' },
      { nonce: '00'.repeat(12), tag: 'zz'.repeat(16), field: 'authentication tag' }
    ])('rejects a malformed or truncated $field before decryption', ({ nonce, tag, field }) => {
      expect(() => ShareService.decryptShare(Buffer.from('ciphertext'), nonce, tag)).toThrow(field)
    })
  })

  describe('Share CRUD operations', () => {
    let testUserId: number
    let testUserIdHash: string

    beforeEach(async () => {
      // Create a test user with userIdHash
      testUserIdHash = 'testhash_' + Date.now() + Math.random().toString(36)
      const user = await UserService.createUserWithUserIdHash(testUserIdHash)
      testUserId = user.id
    })

    afterEach(async () => {
      // Clean up - ignore errors if already deleted
      try {
        await ShareService.deleteShare(testUserId)
      } catch {
        // Ignore
      }
      try {
        await UserService.deleteUserByUserIdHash(testUserIdHash)
      } catch {
        // Ignore
      }
    })

    it('should store a new share', async () => {
      const share = '1.testsharedata.2.integrity'

      const result = await ShareService.storeShare(testUserId, share)

      expect(result.userId).toBe(testUserId)
      expect(result.shareVersion).toBe(1)
      expect(result.shareEncrypted).toBeDefined()
      expect(result.shareNonce).toBeDefined()
      expect(result.shareTag).toBeDefined()
    })

    it('should retrieve a decrypted share', async () => {
      const share = '2.anothershare.2.check'
      await ShareService.storeShare(testUserId, share)

      const retrieved = await ShareService.retrieveDecryptedShare(testUserId)

      expect(retrieved).toBe(share)
    })

    it('should return null for non-existent share', async () => {
      const retrieved = await ShareService.retrieveDecryptedShare(999999)

      expect(retrieved).toBeNull()
    })

    it('should throw when storing duplicate share', async () => {
      const share = '1.first.2.share'
      await ShareService.storeShare(testUserId, share)

      await expect(ShareService.storeShare(testUserId, '2.second.2.share')).rejects.toThrow(
        'User already has a stored share'
      )
    })

    it('should update an existing share', async () => {
      const originalShare = '1.original.2.data'
      const newShare = '1.updated.2.data'

      await ShareService.storeShare(testUserId, originalShare)
      const updated = await ShareService.updateShare(testUserId, newShare)

      expect(updated.shareVersion).toBe(2)

      const retrieved = await ShareService.retrieveDecryptedShare(testUserId)
      expect(retrieved).toBe(newShare)
    })

    it('should throw when updating non-existent share', async () => {
      await expect(ShareService.updateShare(999999, '1.new.2.share')).rejects.toThrow(
        'No existing share found for user'
      )
    })

    it('should delete a share', async () => {
      const share = '1.todelete.2.share'
      await ShareService.storeShare(testUserId, share)

      await ShareService.deleteShare(testUserId)

      const retrieved = await ShareService.retrieveDecryptedShare(testUserId)
      expect(retrieved).toBeNull()
    })
  })

  describe('Access logging', () => {
    let testUserId: number
    let testUserIdHash: string

    beforeEach(async () => {
      testUserIdHash = 'logtest_' + Date.now() + Math.random().toString(36)
      const user = await UserService.createUserWithUserIdHash(testUserIdHash)
      testUserId = user.id
    })

    afterEach(async () => {
      try {
        await UserService.deleteUserByUserIdHash(testUserIdHash)
      } catch {
        // Ignore
      }
    })

    it('should log successful access', async () => {
      await ShareService.logAccess(testUserId, '127.0.0.1', 'retrieve', true)

      const logs = await ShareService.getAccessLogs(testUserId)
      expect(logs.length).toBeGreaterThan(0)
      // TypeORM exposes this field as a boolean while SQLite persists it
      // as 1/0. Assert the semantic contract across both representations.
      expect(logs[0].success).toBeTruthy()
      expect(logs[0].action).toBe('retrieve')
    })

    it('should log failed access with reason', async () => {
      await ShareService.logAccess(
        testUserId,
        '192.168.1.1',
        'store',
        false,
        'OTP verification failed'
      )

      const logs = await ShareService.getAccessLogs(testUserId)
      expect(logs[0].success).toBeFalsy()
      expect(logs[0].failureReason).toBe('OTP verification failed')
    })
  })

  describe('Rate limiting', () => {
    let testUserId: number
    let testUserIdHash: string
    const testIp = '10.0.0.1'

    beforeEach(async () => {
      testUserIdHash = 'ratelimit_' + Date.now() + Math.random().toString(36)
      const user = await UserService.createUserWithUserIdHash(testUserIdHash)
      testUserId = user.id
    })

    afterEach(async () => {
      try {
        await UserService.deleteUserByUserIdHash(testUserIdHash)
      } catch {
        // Ignore
      }
    })

    it('should not rate limit with no failed attempts', async () => {
      const result = await ShareService.isRateLimited(testUserId, testIp, 'retrieve')
      expect(result.limited).toBe(false)
    })

    it('should not count successful attempts toward limit', async () => {
      await ShareService.logAccess(testUserId, testIp, 'retrieve', true)
      await ShareService.logAccess(testUserId, testIp, 'retrieve', true)
      await ShareService.logAccess(testUserId, testIp, 'retrieve', true)

      const result = await ShareService.isRateLimited(testUserId, testIp, 'retrieve')
      expect(result.limited).toBe(false)
    })

    it('should log failed attempts correctly', async () => {
      await ShareService.logAccess(testUserId, testIp, 'retrieve', false, 'test failure')

      const logs = await ShareService.getAccessLogs(testUserId)
      expect(logs.length).toBeGreaterThan(0)
      expect(logs[0].success).toBeFalsy()
      expect(logs[0].failureReason).toBe('test failure')
    })
  })
})
