import { describe, it, expect } from '@jest/globals'
import UMPTopicManager from '../topic-managers/UMPTopicManager.js'
import { Transaction, Utils, PrivateKey, LockingScript } from '@bsv/sdk'

// Builds a PushDrop-formatted locking script without needing a real wallet
function buildPushDropScript(fields: number[][]): LockingScript {
  const pubKeyBytes = PrivateKey.fromRandom().toPublicKey().toDER() as number[]

  const encodeChunk = (data: number[]): { op: number; data?: number[] } => {
    if (data.length === 0) return { op: 0 }
    if (data.length === 1 && data[0] === 0) return { op: 0 }
    if (data.length === 1 && data[0] > 0 && data[0] <= 16) return { op: 0x50 + data[0] }
    if (data.length === 1 && data[0] === 0x81) return { op: 0x4f }
    if (data.length <= 75) return { op: data.length, data }
    if (data.length <= 255) return { op: 0x4c, data }
    return { op: 0x4d, data }
  }

  const chunks: { op: number; data?: number[] }[] = [
    { op: pubKeyBytes.length, data: pubKeyBytes },
    { op: 0xac } // OP_CHECKSIG
  ]

  for (const field of fields) chunks.push(encodeChunk(field))

  let notYetDropped = fields.length
  while (notYetDropped > 1) { chunks.push({ op: 0x6d }); notYetDropped -= 2 } // OP_2DROP
  if (notYetDropped !== 0) chunks.push({ op: 0x75 }) // OP_DROP

  return new LockingScript(chunks)
}

describe('UMPTopicManager', () => {
  const manager = new UMPTopicManager()

  // Helper to create a mock UMP token transaction
  const createMockUMPTransaction = (fields: number[][]): number[] => {
    // Create a minimal transaction with UMP token output
    const tx = new Transaction(1, [], [])

    // Create PushDrop locking script
    const mockLockingScript = buildPushDropScript(fields)

    tx.addOutput({
      satoshis: 1,
      lockingScript: mockLockingScript
    })

    return tx.toBEEF()
  }

  // Helper to create core UMP fields (fields 0-10)
  const createCoreFields = (): number[][] => {
    return [
      Utils.toArray('passwordSalt', 'utf8'),                    // 0
      Utils.toArray('passwordPresentationPrimary', 'utf8'),     // 1
      Utils.toArray('passwordRecoveryPrimary', 'utf8'),         // 2
      Utils.toArray('presentationRecoveryPrimary', 'utf8'),     // 3
      Utils.toArray('passwordPrimaryPrivileged', 'utf8'),       // 4
      Utils.toArray('presentationRecoveryPrivileged', 'utf8'),  // 5
      Utils.toArray('presentationHash', 'utf8'),                // 6
      Utils.toArray('recoveryHash', 'utf8'),                    // 7
      Utils.toArray('presentationKeyEncrypted', 'utf8'),        // 8
      Utils.toArray('passwordKeyEncrypted', 'utf8'),            // 9
      Utils.toArray('recoveryKeyEncrypted', 'utf8')             // 10
    ]
  }

  describe('Legacy Token Validation', () => {
    it('should admit valid legacy token with 11 core fields', async () => {
      const fields = createCoreFields()
      const beef = createMockUMPTransaction(fields)

      const result = await manager.identifyAdmissibleOutputs(beef, [])

      expect(result.outputsToAdmit).toEqual([0])
      expect(result.coinsToRetain).toEqual([])
    })

    it('should admit legacy token with profiles (field 11)', async () => {
      const fields = createCoreFields()
      fields.push(Utils.toArray('encryptedProfiles', 'utf8')) // field 11

      const beef = createMockUMPTransaction(fields)

      const result = await manager.identifyAdmissibleOutputs(beef, [])

      expect(result.outputsToAdmit).toEqual([0])
    })

    it('should reject token with fewer than 11 fields', async () => {
      const fields = createCoreFields().slice(0, 10) // Only 10 fields
      const beef = createMockUMPTransaction(fields)

      const result = await manager.identifyAdmissibleOutputs(beef, [])

      expect(result.outputsToAdmit).toEqual([])
      expect(result.coinsToRetain).toEqual([])
    })
  })

  describe('Version 3 Token Validation', () => {
    it('should admit valid v3 token with Argon2id', async () => {
      const fields = createCoreFields()
      fields.push(Utils.toArray('encryptedProfiles', 'utf8')) // field 11 (optional)
      fields.push([3]) // field 12: umpVersion = 3
      fields.push(Utils.toArray('argon2id', 'utf8')) // field 13: kdfAlgorithm
      const kdfParams = JSON.stringify({
        iterations: 7,
        memoryKiB: 131072,
        parallelism: 1,
        hashLength: 32
      })
      fields.push(Utils.toArray(kdfParams, 'utf8')) // field 14: kdfParams

      const beef = createMockUMPTransaction(fields)

      const result = await manager.identifyAdmissibleOutputs(beef, [])

      expect(result.outputsToAdmit).toEqual([0])
    })

    it('should admit valid v3 token with PBKDF2', async () => {
      const fields = createCoreFields()
      fields.push([3]) // field 12: umpVersion = 3 (no profiles)
      fields.push(Utils.toArray('pbkdf2-sha512', 'utf8')) // field 13
      const kdfParams = JSON.stringify({ iterations: 7777 })
      fields.push(Utils.toArray(kdfParams, 'utf8')) // field 14

      const beef = createMockUMPTransaction(fields)

      const result = await manager.identifyAdmissibleOutputs(beef, [])

      expect(result.outputsToAdmit).toEqual([0])
    })

    it('should reject v3 token with invalid umpVersion', async () => {
      const fields = createCoreFields()
      fields.push([5]) // Invalid version
      fields.push(Utils.toArray('argon2id', 'utf8'))
      fields.push(Utils.toArray(JSON.stringify({ iterations: 7 }), 'utf8'))

      const beef = createMockUMPTransaction(fields)

      const result = await manager.identifyAdmissibleOutputs(beef, [])

      expect(result.outputsToAdmit).toEqual([])
    })

    it('should reject v3 token with missing kdfAlgorithm', async () => {
      const fields = createCoreFields()
      fields.push([3]) // umpVersion
      // Missing field 13 (kdfAlgorithm)

      const beef = createMockUMPTransaction(fields)

      const result = await manager.identifyAdmissibleOutputs(beef, [])

      expect(result.outputsToAdmit).toEqual([])
    })

    it('should reject v3 token with unsupported kdfAlgorithm', async () => {
      const fields = createCoreFields()
      fields.push([3])
      fields.push(Utils.toArray('scrypt', 'utf8')) // Unsupported
      fields.push(Utils.toArray(JSON.stringify({ iterations: 7 }), 'utf8'))

      const beef = createMockUMPTransaction(fields)

      const result = await manager.identifyAdmissibleOutputs(beef, [])

      expect(result.outputsToAdmit).toEqual([])
    })

    it('should reject v3 token with missing kdfParams', async () => {
      const fields = createCoreFields()
      fields.push([3])
      fields.push(Utils.toArray('argon2id', 'utf8'))
      // Missing field 14 (kdfParams)

      const beef = createMockUMPTransaction(fields)

      const result = await manager.identifyAdmissibleOutputs(beef, [])

      expect(result.outputsToAdmit).toEqual([])
    })

    it('should reject v3 token with malformed kdfParams JSON', async () => {
      const fields = createCoreFields()
      fields.push([3])
      fields.push(Utils.toArray('argon2id', 'utf8'))
      fields.push(Utils.toArray('not valid json', 'utf8'))

      const beef = createMockUMPTransaction(fields)

      const result = await manager.identifyAdmissibleOutputs(beef, [])

      expect(result.outputsToAdmit).toEqual([])
    })

    it('should reject v3 token with invalid kdfParams iterations', async () => {
      const fields = createCoreFields()
      fields.push([3])
      fields.push(Utils.toArray('argon2id', 'utf8'))
      fields.push(Utils.toArray(JSON.stringify({ iterations: 0 }), 'utf8')) // Invalid: must be positive

      const beef = createMockUMPTransaction(fields)

      const result = await manager.identifyAdmissibleOutputs(beef, [])

      expect(result.outputsToAdmit).toEqual([])
    })
  })

  describe('Metadata', () => {
    it('should return correct metadata', async () => {
      const metadata = await manager.getMetaData()

      expect(metadata.name).toBe('User Management Protocol')
      expect(metadata.shortDescription).toBe('Manages CWI-style wallet account descriptors.')
    })

    it('should return documentation', async () => {
      const docs = await manager.getDocumentation()

      expect(docs).toContain('User Management Protocol')
      expect(docs).toContain('Version 3')
    })
  })
})
