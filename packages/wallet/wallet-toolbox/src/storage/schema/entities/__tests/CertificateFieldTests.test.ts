import { createSyncMap, sdk, SyncMap, TableCertificate, TableCertificateField } from '../../../../../src'
import { TestUtilsWalletStorage as _tu, TestWalletNoSetup } from '../../../../../test/utils/TestUtilsWalletStorage'
import { EntityCertificateField } from '../EntityCertificateField'

describe('CertificateField class method tests', () => {
  jest.setTimeout(99999999)

  const env = _tu.getEnv('test')
  const ctxs: TestWalletNoSetup[] = []
  const ctxs2: TestWalletNoSetup[] = []

  beforeAll(async () => {
    if (env.runMySQL) {
      ctxs.push(await _tu.createLegacyWalletMySQLCopy('CertificateFieldTests'))
      ctxs2.push(await _tu.createLegacyWalletMySQLCopy('CertificateFieldTests2'))
    }
    ctxs.push(await _tu.createLegacyWalletSQLiteCopy('CertificateFieldTests'))
    ctxs2.push(await _tu.createLegacyWalletSQLiteCopy('CertificateFieldTests2'))
  })

  afterAll(async () => {
    for (const ctx of ctxs) {
      await ctx.storage.destroy()
    }
    for (const ctx of ctxs2) {
      await ctx.storage.destroy()
    }
  })

  test('0_equals identifies matching CertificateField entities', async () => {
    for (const { activeStorage } of ctxs) {
      // Insert a valid Certificate to satisfy foreign key constraints
      const now = new Date()
      const certificateId = 300 // Ensure this ID is unique in the `certificates` table
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

      // Insert initial CertificateField record
      const initialData: TableCertificateField = {
        certificateId,
        created_at: now,
        updated_at: now,
        userId: 1,
        fieldName: 'field1',
        fieldValue: 'value1',
        masterKey: 'masterKey1'
      }
      await activeStorage.insertCertificateField(initialData)

      // Create two CertificateField entities from the same data
      const entity1 = new EntityCertificateField(initialData)
      const entity2 = new EntityCertificateField(initialData)

      // Create a valid SyncMap
      const syncMap = createSyncMap()
      syncMap.certificate.idMap[certificateId] = certificateId

      // Test: equals returns true for identical entities without SyncMap
      expect(entity1.equals(entity2.toApi())).toBe(true)

      // Test: equals returns true for identical entities with SyncMap
      expect(entity1.equals(entity2.toApi(), syncMap)).toBe(true)
    }
  })

  test('1_equals identifies non-matching CertificateField entities', async () => {
    for (const { activeStorage } of ctxs) {
      // Insert a valid Certificate to satisfy foreign key constraints
      const now = new Date()
      const certificateId1 = 301 // Ensure this ID is unique in the `certificates` table
      const certificateId2 = 302

      // Adjusted certificate data for uniqueness
      await activeStorage.insertCertificate({
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
      })

      await activeStorage.insertCertificate({
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
      })

      // Insert initial CertificateField record
      const initialData: TableCertificateField = {
        certificateId: certificateId1,
        created_at: now,
        updated_at: now,
        userId: 1,
        fieldName: 'field1',
        fieldValue: 'value1',
        masterKey: 'masterKey1'
      }
      await activeStorage.insertCertificateField(initialData)

      // Create a CertificateField entity from the initial data
      const entity1 = new EntityCertificateField(initialData)

      // Create mismatched entities and test each condition
      const mismatchedEntities: Partial<TableCertificateField>[] = [
        { certificateId: certificateId2 }, // Requires valid certificate
        { fieldName: 'field2' },
        { fieldValue: 'value2' },
        { masterKey: 'masterKey2' }
      ]

      for (const mismatch of mismatchedEntities) {
        const mismatchedEntity = new EntityCertificateField({
          ...initialData,
          ...mismatch
        })
        expect(entity1.equals(mismatchedEntity.toApi())).toBe(false)

        // Test with SyncMap, where certificateId is resolved
        const syncMap = createSyncMap()
        syncMap.certificate.idMap[certificateId1] = certificateId1
        syncMap.certificate.idMap[certificateId2] = certificateId2

        expect(entity1.equals(mismatchedEntity.toApi(), syncMap)).toBe(false)
      }
    }
  })

  test('mergeExisting updates entity and database when ei.updated_at > this.updated_at', async () => {
    for (const { activeStorage } of ctxs) {
      // Insert a valid Certificate to satisfy foreign key constraints
      const now = new Date()
      const certificateId = 400
      await activeStorage.insertCertificate({
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
      })

      // Insert the initial CertificateField record
      const initialData: TableCertificateField = {
        certificateId,
        created_at: now,
        updated_at: now,
        userId: 1,
        fieldName: 'field1',
        fieldValue: 'value1',
        masterKey: 'masterKey1'
      }
      await activeStorage.insertCertificateField(initialData)

      // Create a CertificateField entity from the initial data
      const entity = new EntityCertificateField(initialData)

      // Simulate the `ei` argument with a later `updated_at`
      const updatedData: TableCertificateField = {
        ...initialData,
        updated_at: new Date(now.getTime() + 1000), // Later timestamp
        fieldValue: 'updatedValue',
        masterKey: 'updatedMasterKey'
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
      expect(entity.fieldValue).toBe('updatedValue')
      expect(entity.masterKey).toBe('updatedMasterKey')

      // Verify that the database is updated
      const updatedRecord = await activeStorage.findCertificateFields({
        partial: { certificateId, fieldName: 'field1' }
      })
      expect(updatedRecord.length).toBe(1)
      expect(updatedRecord[0]).toBeDefined()
      expect(updatedRecord[0].fieldValue).toBe('updatedValue')
      expect(updatedRecord[0].masterKey).toBe('updatedMasterKey')
    }
  })

  test('mergeExisting does not update entity when ei.updated_at <= this.updated_at', async () => {
    for (const { activeStorage } of ctxs) {
      // Insert a valid Certificate to satisfy foreign key constraints
      const now = new Date()
      const certificateId = 401
      await activeStorage.insertCertificate({
        certificateId,
        created_at: now,
        updated_at: now,
        userId: 1,
        type: Buffer.from('exampleTypeNoMerge').toString('base64'),
        serialNumber: Buffer.from('serialNoMerge123').toString('base64'),
        certifier: '02c123eabcdeff1234567890abcdef1234567890abcdef1234567890abcdef1234',
        subject: '02c123eabcdeff1234567890abcdef1234567890abcdef1234567890abcdef5678',
        revocationOutpoint: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890:0',
        signature: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        isDeleted: false
      })

      // Insert the initial CertificateField record
      const initialData: TableCertificateField = {
        certificateId,
        created_at: now,
        updated_at: now,
        userId: 1,
        fieldName: 'field1',
        fieldValue: 'value1',
        masterKey: 'masterKey1'
      }
      await activeStorage.insertCertificateField(initialData)

      // Create a CertificateField entity from the initial data
      const entity = new EntityCertificateField(initialData)

      // Simulate the `ei` argument with the same `updated_at`
      const sameUpdatedData: TableCertificateField = {
        ...initialData,
        updated_at: now, // Same timestamp
        fieldValue: 'unchangedValue',
        masterKey: 'unchangedMasterKey'
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
      expect(entity.fieldValue).toBe('value1')
      expect(entity.masterKey).toBe('masterKey1')

      // Verify that the database is not updated
      const unchangedRecord = await activeStorage.findCertificateFields({
        partial: { certificateId, fieldName: 'field1' }
      })
      expect(unchangedRecord.length).toBe(1)
      expect(unchangedRecord[0]).toBeDefined()
      expect(unchangedRecord[0].fieldValue).toBe('value1')
      expect(unchangedRecord[0].masterKey).toBe('masterKey1')
    }
  })

  test('CertificateField getters and setters', async () => {
    const now = new Date()

    // Initial data for the test
    const initialData: TableCertificateField = {
      userId: 1,
      certificateId: 500,
      created_at: now,
      updated_at: now,
      fieldName: 'fieldName1',
      fieldValue: 'fieldValue1',
      masterKey: 'masterKey1'
    }

    // Create a CertificateField entity
    const entity = new EntityCertificateField(initialData)

    // Validate getters
    expect(entity.userId).toBe(1)
    expect(entity.certificateId).toBe(500)
    expect(entity.created_at).toEqual(now)
    expect(entity.updated_at).toEqual(now)
    expect(entity.fieldName).toBe('fieldName1')
    expect(entity.fieldValue).toBe('fieldValue1')
    expect(entity.masterKey).toBe('masterKey1')

    // Validate overridden properties
    expect(() => entity.id).toThrowError('entity has no "id" value')
    expect(entity.entityName).toBe('certificateField')
    expect(entity.entityTable).toBe('certificate_fields')

    // Validate setters
    const newDate = new Date(now.getTime() + 1000)
    entity.userId = 2
    entity.certificateId = 600
    entity.created_at = new Date('2025-01-01')
    entity.updated_at = newDate
    entity.fieldName = 'updatedFieldName'
    entity.fieldValue = 'updatedFieldValue'
    entity.masterKey = 'updatedMasterKey'

    // Assert the updated values
    expect(entity.userId).toBe(2)
    expect(entity.certificateId).toBe(600)
    expect(entity.created_at).toEqual(new Date('2025-01-01'))
    expect(entity.updated_at).toEqual(newDate)
    expect(entity.fieldName).toBe('updatedFieldName')
    expect(entity.fieldValue).toBe('updatedFieldValue')
    expect(entity.masterKey).toBe('updatedMasterKey')
  })
})
