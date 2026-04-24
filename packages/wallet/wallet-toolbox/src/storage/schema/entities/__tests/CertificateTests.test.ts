import { createSyncMap, sdk, TableCertificate } from '../../../../../src'
import { TestUtilsWalletStorage as _tu, TestWalletNoSetup } from '../../../../../test/utils/TestUtilsWalletStorage'
import { EntityCertificate } from '../EntityCertificate'

describe('Certificate class method tests', () => {
  jest.setTimeout(99999999)

  const env = _tu.getEnv('test')
  const ctxs: TestWalletNoSetup[] = []
  const ctxs2: TestWalletNoSetup[] = []

  beforeAll(async () => {
    if (env.runMySQL) {
      ctxs.push(await _tu.createLegacyWalletMySQLCopy('CertificateTests'))
      ctxs2.push(await _tu.createLegacyWalletMySQLCopy('CertificateTests2'))
    }
    ctxs.push(await _tu.createLegacyWalletSQLiteCopy('CertificateTests'))
    ctxs2.push(await _tu.createLegacyWalletSQLiteCopy('CertificateTests2'))
  })

  afterAll(async () => {
    for (const ctx of ctxs) {
      await ctx.storage.destroy()
    }
    for (const ctx of ctxs2) {
      await ctx.storage.destroy()
    }
  })
  test('0_equals identifies matching Certificate entities', async () => {
    for (const { activeStorage } of ctxs) {
      // Insert initial Certificate record
      const now = new Date()
      const certificateId = 500 // Unique ID for this test
      const certificateData: TableCertificate = {
        certificateId,
        created_at: now,
        updated_at: now,
        userId: 1,
        type: Buffer.from('exampleType').toString('base64'), // Base64-encoded string
        serialNumber: Buffer.from('serial123').toString('base64'), // Base64-encoded string
        certifier: '02c123eabcdeff1234567890abcdef1234567890abcdef1234567890abcdef1234', // PubKeyHex
        subject: '02c123eabcdeff1234567890abcdef1234567890abcdef1234567890abcdef5678', // PubKeyHex
        revocationOutpoint: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890:0', // OutpointString
        signature: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890', // HexString
        isDeleted: false
      }

      await activeStorage.insertCertificate(certificateData)

      // Create two Certificate entities from the same data
      const entity1 = new EntityCertificate(certificateData)
      const entity2 = new EntityCertificate(certificateData)

      // Validate equals returns true for identical entities
      expect(entity1.equals(entity2.toApi())).toBe(true)
    }
  })

  test('1_equals identifies non-matching Certificate entities', async () => {
    for (const { activeStorage } of ctxs) {
      // Insert initial Certificate record
      const now = new Date()
      const certificateId1 = 501
      const certificateId2 = 502
      const certificateData1: TableCertificate = {
        certificateId: certificateId1,
        created_at: now,
        updated_at: now,
        userId: 1,
        type: Buffer.from('exampleType1').toString('base64'), // Unique Base64-encoded string
        serialNumber: Buffer.from('serial123-1').toString('base64'), // Unique Base64-encoded string
        certifier: '02c123eabcdeff1234567890abcdef1234567890abcdef1234567890abcdef1234', // Same PubKeyHex
        subject: '02c123eabcdeff1234567890abcdef1234567890abcdef1234567890abcdef5678', // Same PubKeyHex
        revocationOutpoint: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890:0', // Same OutpointString
        signature: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890', // Same HexString
        isDeleted: false
      }
      const certificateData2: TableCertificate = {
        certificateId: certificateId2,
        created_at: now,
        updated_at: now,
        userId: 1,
        type: Buffer.from('exampleType2').toString('base64'), // Unique Base64-encoded string
        serialNumber: Buffer.from('serial123-2').toString('base64'), // Unique Base64-encoded string
        certifier: '02c123eabcdeff1234567890abcdef1234567890abcdef1234567890abcdef5678', // Same PubKeyHex
        subject: '02c123eabcdeff1234567890abcdef1234567890abcdef1234567890abcdef5678', // Same PubKeyHex
        revocationOutpoint: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890:1', // Unique OutpointString
        signature: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890', // Same HexString
        isDeleted: false
      }

      await activeStorage.insertCertificate(certificateData1)
      await activeStorage.insertCertificate(certificateData2)

      // Create Certificate entities with mismatched data
      const entity1 = new EntityCertificate(certificateData1)
      const entity2 = new EntityCertificate(certificateData2)

      // Validate equals returns false for mismatched entities
      expect(entity1.equals(entity2.toApi())).toBe(false)

      // Test each mismatched field individually
      const mismatchedEntities: Partial<TableCertificate>[] = [
        { type: 'differentType' },
        { subject: 'differentSubject' },
        { serialNumber: 'differentSerialNumber' },
        { revocationOutpoint: 'differentOutpoint:0' },
        { signature: 'differentSignature' },
        { verifier: 'differentVerifier' },
        { isDeleted: !certificateData1.isDeleted }
      ]

      for (const mismatch of mismatchedEntities) {
        const mismatchedEntity = new EntityCertificate({
          ...certificateData1,
          ...mismatch
        })
        expect(entity1.equals(mismatchedEntity.toApi())).toBe(false)
      }
    }
  })

  test('2_mergeExisting updates entity and database when ei.updated_at > this.updated_at', async () => {
    for (const { activeStorage } of ctxs) {
      // Insert a valid Certificate to satisfy foreign key constraints
      const now = new Date()
      const certificateId = 600
      const certificateData: TableCertificate = {
        certificateId,
        created_at: now,
        updated_at: now,
        userId: 1,
        type: Buffer.from('exampleTypeMerge').toString('base64'),
        serialNumber: Buffer.from('serialMerge123').toString('base64'),
        certifier: '02c123eabcdeff1234567890abcdef1234567890abcdef1234567890abcdef1234',
        subject: '02c123eabcdeff1234567890abcdef1234567890abcdef1234567890abcdef5678',
        revocationOutpoint: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890:0',
        signature: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        isDeleted: false
      }

      await activeStorage.insertCertificate(certificateData)

      // Create a Certificate entity from the initial data
      const entity = new EntityCertificate(certificateData)

      // Simulate the `ei` argument with a later `updated_at`
      const updatedData: TableCertificate = {
        ...certificateData,
        updated_at: new Date(now.getTime() + 1000), // Later timestamp
        type: 'updatedType',
        subject: 'updatedSubject',
        serialNumber: 'updatedSerialNumber',
        revocationOutpoint: 'updatedOutpoint:1',
        signature: 'updatedSignature',
        verifier: 'updatedVerifier',
        isDeleted: true
      }

      const syncMap = createSyncMap()
      syncMap.certificate.idMap[certificateId] = certificateId

      // Call mergeExisting
      const wasMergedRaw = await entity.mergeExisting(
        activeStorage,
        undefined, // `since` is not used in this method
        updatedData,
        syncMap,
        undefined // `trx` is not used
      )

      const wasMerged = Boolean(wasMergedRaw)

      // Verify that wasMerged is true
      expect(wasMerged).toBe(true)

      // Verify that the entity is updated
      expect(entity.type).toBe('updatedType')
      expect(entity.subject).toBe('updatedSubject')
      expect(entity.serialNumber).toBe('updatedSerialNumber')
      expect(entity.revocationOutpoint).toBe('updatedOutpoint:1')
      expect(entity.signature).toBe('updatedSignature')
      expect(entity.verifier).toBe('updatedVerifier')
      expect(entity.isDeleted).toBe(1)

      // Verify that the database is updated
      const updatedRecord = await activeStorage.findCertificates({
        partial: { certificateId }
      })
      expect(updatedRecord.length).toBe(1)
      expect(updatedRecord[0]).toBeDefined()
      expect(updatedRecord[0].type).toBe('updatedType')
      expect(updatedRecord[0].subject).toBe('updatedSubject')
      expect(updatedRecord[0].serialNumber).toBe('updatedSerialNumber')
      expect(updatedRecord[0].revocationOutpoint).toBe('updatedOutpoint:1')
      expect(updatedRecord[0].signature).toBe('updatedSignature')
      expect(updatedRecord[0].verifier).toBe('updatedVerifier')
      expect(updatedRecord[0].isDeleted).toBe(true)
    }
  })

  test('3_mergeExisting does not update entity when ei.updated_at <= this.updated_at', async () => {
    for (const { activeStorage } of ctxs) {
      // Insert a valid Certificate to satisfy foreign key constraints
      const now = new Date()
      const certificateId = 601
      const certificateData: TableCertificate = {
        certificateId,
        created_at: now,
        updated_at: now,
        userId: 1,
        type: 'exampleType',
        serialNumber: 'exampleSerialNumber',
        certifier: '02c123eabcdeff1234567890abcdef1234567890abcdef1234567890abcdef1234',
        subject: '02c123eabcdeff1234567890abcdef1234567890abcdef1234567890abcdef5678',
        revocationOutpoint: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890:0',
        signature: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        isDeleted: false
      }

      await activeStorage.insertCertificate(certificateData)

      // Create a Certificate entity from the initial data
      const entity = new EntityCertificate(certificateData)

      // Simulate the `ei` argument with the same or earlier `updated_at`
      const sameUpdatedData: TableCertificate = {
        ...certificateData,
        updated_at: now, // Same timestamp
        type: 'unchangedType',
        subject: 'unchangedSubject',
        serialNumber: 'unchangedSerialNumber',
        revocationOutpoint: 'unchangedOutpoint:0',
        signature: 'unchangedSignature',
        verifier: 'unchangedVerifier',
        isDeleted: false
      }

      const syncMap = createSyncMap()
      syncMap.certificate.idMap[certificateId] = certificateId

      // Call mergeExisting
      const wasMergedRaw = await entity.mergeExisting(
        activeStorage,
        undefined, // `since` is not used
        sameUpdatedData,
        syncMap,
        undefined // `trx` is not used
      )

      const wasMerged = Boolean(wasMergedRaw)

      // Verify that wasMerged is false
      expect(wasMerged).toBe(false)

      // Verify that the entity is not updated
      expect(entity.type).toBe('exampleType')
      expect(entity.subject).toBe('02c123eabcdeff1234567890abcdef1234567890abcdef1234567890abcdef5678')
      expect(entity.serialNumber).toBe('exampleSerialNumber')
      expect(entity.revocationOutpoint).toBe('abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890:0')
      expect(entity.signature).toBe('abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890')
      expect(entity.isDeleted).toBe(0)

      // Verify that the database is not updated
      const unchangedRecord = await activeStorage.findCertificates({
        partial: { certificateId }
      })
      expect(unchangedRecord.length).toBe(1)
      expect(unchangedRecord[0]).toBeDefined()
      expect(unchangedRecord[0].type).toBe('exampleType')
      expect(unchangedRecord[0].subject).toBe('02c123eabcdeff1234567890abcdef1234567890abcdef1234567890abcdef5678')
      expect(unchangedRecord[0].serialNumber).toBe('exampleSerialNumber')
      expect(unchangedRecord[0].revocationOutpoint).toBe(
        'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890:0'
      )
      expect(unchangedRecord[0].signature).toBe('abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890')
      expect(unchangedRecord[0].isDeleted).toBe(false)
    }
  })

  test('4_Certificate class getters and setters', async () => {
    for (const { activeStorage } of ctxs) {
      const now = new Date()

      // Initial test data
      const initialData: TableCertificate = {
        certificateId: 701,
        created_at: now,
        updated_at: now,
        userId: 1,
        type: 'initialType',
        subject: 'initialSubject',
        verifier: 'initialVerifier',
        serialNumber: 'initialSerialNumber',
        certifier: 'initialCertifier',
        revocationOutpoint: 'initialOutpoint:0',
        signature: 'initialSignature',
        isDeleted: false
      }

      // Create the Certificate entity
      const entity = new EntityCertificate(initialData)

      // Validate getters
      expect(entity.certificateId).toBe(initialData.certificateId)
      expect(entity.created_at).toEqual(initialData.created_at)
      expect(entity.updated_at).toEqual(initialData.updated_at)
      expect(entity.userId).toBe(initialData.userId)
      expect(entity.type).toBe(initialData.type)
      expect(entity.subject).toBe(initialData.subject)
      expect(entity.verifier).toBe(initialData.verifier)
      expect(entity.serialNumber).toBe(initialData.serialNumber)
      expect(entity.certifier).toBe(initialData.certifier)
      expect(entity.revocationOutpoint).toBe(initialData.revocationOutpoint)
      expect(entity.signature).toBe(initialData.signature)
      expect(entity.isDeleted).toBe(initialData.isDeleted)
      expect(entity.id).toBe(initialData.certificateId)
      expect(entity.entityName).toBe('certificate')
      expect(entity.entityTable).toBe('certificates')

      // Validate setters
      entity.certificateId = 800
      entity.created_at = new Date('2025-01-01')
      entity.updated_at = new Date('2025-01-02')
      entity.userId = 2
      entity.type = 'updatedType'
      entity.subject = 'updatedSubject'
      entity.verifier = 'updatedVerifier'
      entity.serialNumber = 'updatedSerialNumber'
      entity.certifier = 'updatedCertifier'
      entity.revocationOutpoint = 'updatedOutpoint:1'
      entity.signature = 'updatedSignature'
      entity.isDeleted = true
      entity.id = 900

      // Validate updated values via getters
      expect(entity.certificateId).toBe(900)
      expect(entity.created_at).toEqual(new Date('2025-01-01'))
      expect(entity.updated_at).toEqual(new Date('2025-01-02'))
      expect(entity.userId).toBe(2)
      expect(entity.type).toBe('updatedType')
      expect(entity.subject).toBe('updatedSubject')
      expect(entity.verifier).toBe('updatedVerifier')
      expect(entity.serialNumber).toBe('updatedSerialNumber')
      expect(entity.certifier).toBe('updatedCertifier')
      expect(entity.revocationOutpoint).toBe('updatedOutpoint:1')
      expect(entity.signature).toBe('updatedSignature')
      expect(entity.isDeleted).toBe(true)
      expect(entity.id).toBe(900)
      expect(entity.entityName).toBe('certificate')
      expect(entity.entityTable).toBe('certificates')
    }
  })
})
