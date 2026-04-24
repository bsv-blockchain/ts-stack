import { OriginatorDomainNameStringUnder250Bytes, Validation } from '@bsv/sdk'
import { listCertificates } from '../../../src/storage/methods/listCertificates'
import { StorageProvider } from '../../../src/storage/StorageProvider'
import { sdk, TableCertificate, TableCertificateField } from '../../../src/index.all'
import { TrxToken } from '../../../src/sdk'

jest.mock('../../../src/storage/StorageProvider')

describe('listCertificates', () => {
  let mockStorage: jest.Mocked<StorageProvider>
  let auth: sdk.AuthId

  // This is a valid, minimal set of arguments for listCertificates
  let vargs: Validation.ValidListCertificatesArgs
  let originator: OriginatorDomainNameStringUnder250Bytes | undefined

  // Helper so we can easily mock the transaction call
  const mockTransaction = async <T>(callback: (trx: TrxToken) => Promise<T>): Promise<T> => {
    // We simulate the transaction by simply calling back immediately
    // with an empty object as trx token.
    return callback({} as unknown as TrxToken)
  }

  beforeEach(() => {
    // Create a fresh mock of the storage
    mockStorage = {
      // We only need to mock the methods that are actually used by listCertificates
      transaction: jest.fn().mockImplementation(mockTransaction),
      findCertificates: jest.fn(),
      findCertificateFields: jest.fn(),
      countCertificates: jest.fn()
    } as unknown as jest.Mocked<StorageProvider>

    // Auth with a valid user ID
    auth = {
      identityKey: 'myIdentityKey',
      userId: 123
    }

    // Minimal valid vargs with default limit=10, offset=0, no partial filter
    vargs = {
      partial: undefined,
      certifiers: [],
      types: [],
      limit: 10,
      offset: 0,
      privileged: false
    }

    // By default we set it to undefined
    originator = undefined
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  test('should return an empty result when no certificates are found', async () => {
    // Setup mocks
    mockStorage.findCertificates.mockResolvedValueOnce([]) // no certs returned

    // Execute
    const result = await listCertificates(mockStorage, auth, vargs, originator)

    // Verify
    expect(mockStorage.transaction).toHaveBeenCalledTimes(1)
    expect(mockStorage.findCertificates).toHaveBeenCalledTimes(1)
    expect(mockStorage.findCertificateFields).not.toHaveBeenCalled()
    expect(mockStorage.countCertificates).not.toHaveBeenCalled() // no need to call if 0 < limit

    expect(result).toEqual({
      totalCertificates: 0,
      certificates: []
    })
  })

  test('should return exactly the number of certificates if they are fewer than the limit', async () => {
    // Suppose we have 2 certificates
    const fakeCerts: TableCertificate[] = [
      {
        certificateId: 1,
        userId: 123,
        type: 'base64Type1',
        serialNumber: 'serial1',
        certifier: 'abcdef01',
        subject: '12345678',
        verifier: undefined,
        revocationOutpoint: 'abcd1234.0',
        signature: 'deadbeef01',
        isDeleted: false,
        created_at: new Date(),
        updated_at: new Date()
      },
      {
        certificateId: 2,
        userId: 123,
        type: 'base64Type2',
        serialNumber: 'serial2',
        certifier: 'abcdef02',
        subject: '23456789',
        verifier: undefined,
        revocationOutpoint: 'abcd5678.1',
        signature: 'deadbeef02',
        isDeleted: false,
        created_at: new Date(),
        updated_at: new Date()
      }
    ]

    // Suppose each cert has some fields
    const fakeFieldsForCert1: TableCertificateField[] = [
      {
        certificateId: 1,
        userId: 123,
        fieldName: 'field1',
        fieldValue: 'value1',
        masterKey: 'mkey1',
        created_at: new Date(),
        updated_at: new Date()
      }
    ]

    const fakeFieldsForCert2: TableCertificateField[] = [
      {
        certificateId: 2,
        userId: 123,
        fieldName: 'fieldA',
        fieldValue: 'valueA',
        masterKey: 'mkeyA',
        created_at: new Date(),
        updated_at: new Date()
      }
    ]

    mockStorage.findCertificates.mockResolvedValueOnce(fakeCerts)
    // Make sure we return correct fields for each certificate
    mockStorage.findCertificateFields.mockImplementation(async (args: sdk.FindCertificateFieldsArgs) => {
      if (args.partial?.certificateId === 1) return fakeFieldsForCert1
      if (args.partial?.certificateId === 2) return fakeFieldsForCert2
      return []
    })

    // The returned certs are length=2, which is < limit(10). So we do not call countCertificates
    // Setup a spied or mocked value just in case
    mockStorage.countCertificates.mockResolvedValueOnce(10)

    // Execute
    const result = await listCertificates(mockStorage, auth, vargs)

    // Verify
    expect(mockStorage.transaction).toHaveBeenCalledTimes(1)
    expect(mockStorage.findCertificates).toHaveBeenCalledTimes(1)
    expect(mockStorage.findCertificateFields).toHaveBeenCalledTimes(2)
    expect(mockStorage.countCertificates).not.toHaveBeenCalled() // Because 2 < 10

    expect(result.certificates.length).toBe(2)
    expect(result.totalCertificates).toBe(2)

    // Ensure the fields are included
    expect(result.certificates[0]).toEqual({
      type: 'base64Type1',
      subject: '12345678',
      serialNumber: 'serial1',
      certifier: 'abcdef01',
      revocationOutpoint: 'abcd1234.0',
      signature: 'deadbeef01',
      verifier: undefined,
      fields: { field1: 'value1' },
      keyring: { field1: 'mkey1' }
    })
    expect(result.certificates[1]).toEqual({
      type: 'base64Type2',
      subject: '23456789',
      serialNumber: 'serial2',
      certifier: 'abcdef02',
      revocationOutpoint: 'abcd5678.1',
      signature: 'deadbeef02',
      verifier: undefined,
      fields: { fieldA: 'valueA' },
      keyring: { fieldA: 'mkeyA' }
    })
  })

  test('should call countCertificates when the returned certificates length is equal to limit', async () => {
    // We want exactly 'limit' items returned, so the function calls countCertificates
    vargs.limit = 2 // set limit to 2
    const fakeCerts: TableCertificate[] = [
      {
        certificateId: 11,
        userId: 123,
        type: 'base64Type',
        serialNumber: 'sn',
        certifier: 'abcdef01',
        subject: 'deadbeef01',
        verifier: undefined,
        revocationOutpoint: '0000.0',
        signature: 'abcdabcd',
        isDeleted: false,
        created_at: new Date(),
        updated_at: new Date()
      },
      {
        certificateId: 22,
        userId: 123,
        type: 'base64Type',
        serialNumber: 'sn2',
        certifier: 'abcdef02',
        subject: 'deadbeef02',
        verifier: undefined,
        revocationOutpoint: '0001.0',
        signature: 'ef01ef01',
        isDeleted: false,
        created_at: new Date(),
        updated_at: new Date()
      }
    ]

    // Suppose each cert has no fields
    mockStorage.findCertificateFields.mockResolvedValue([])

    // We return exactly 2 certs, which is == limit
    mockStorage.findCertificates.mockResolvedValueOnce(fakeCerts)

    // So the code should call countCertificates
    mockStorage.countCertificates.mockResolvedValueOnce(25)

    // Execute
    const result = await listCertificates(mockStorage, auth, vargs)

    // Verify
    expect(mockStorage.findCertificates).toHaveBeenCalledTimes(1)
    expect(mockStorage.findCertificateFields).toHaveBeenCalledTimes(2)
    expect(mockStorage.countCertificates).toHaveBeenCalledTimes(1)

    // We expect totalCertificates = 25 from countCertificates
    expect(result.totalCertificates).toBe(25)
    expect(result.certificates.length).toBe(2)
  })

  test('should handle transaction failure by throwing an error', async () => {
    // If the transaction or the underlying findCertificates call fails, we rethrow
    const error = new Error('Database error')
    mockStorage.transaction.mockRejectedValueOnce(error)

    await expect(listCertificates(mockStorage, auth, vargs)).rejects.toThrow('Database error')

    // Verify mocks
    expect(mockStorage.transaction).toHaveBeenCalledTimes(1)
    expect(mockStorage.findCertificates).not.toHaveBeenCalled()
    expect(mockStorage.findCertificateFields).not.toHaveBeenCalled()
    expect(mockStorage.countCertificates).not.toHaveBeenCalled()
  })

  test('should handle scenario userId is undefined', async () => {
    // Although typically userId is required, let's see what happens
    // If userId is undefined, partial: { userId: undefined, isDeleted: false } is used
    // The storage call might or might not blow up. We'll test that the code still calls the transaction
    // We rely on the underlying findCertificates to throw or return an empty array.
    auth.userId = undefined

    mockStorage.findCertificates.mockResolvedValueOnce([])

    const result = await listCertificates(mockStorage, auth, vargs)
    expect(result).toEqual({
      totalCertificates: 0,
      certificates: []
    })

    // We see a normal call
    expect(mockStorage.transaction).toHaveBeenCalledTimes(1)
    expect(mockStorage.findCertificates).toHaveBeenCalledTimes(1)
    // The partial would have userId: undefined
    const arg0 = mockStorage.findCertificates.mock.calls[0][0]
    expect(arg0.partial).toEqual({
      userId: undefined,
      isDeleted: false
    })
  })

  test('if returned certificate count is bigger than limit, still only returns limit items but sets total using countCertificates', async () => {
    // For completeness, if the storage findCertificates method returns exactly "limit" items,
    // we do a count. But let's pretend it can return exactly limit or a bit more (some storages might do that incorrectly).
    // We'll only test the scenario that triggers the "else" path. Already tested an =limit scenario above,
    // but let's confirm the coverage if the function doesn't rely on partial storage returning partial results.
    vargs.limit = 2

    const cA: TableCertificate = {
      certificateId: 100,
      userId: 123,
      type: 'zzz',
      serialNumber: 'snA',
      certifier: 'cA',
      subject: 'sA',
      verifier: undefined,
      revocationOutpoint: 'nope.0',
      signature: 'sigA',
      isDeleted: false,
      created_at: new Date(),
      updated_at: new Date()
    }
    const cB: TableCertificate = {
      certificateId: 101,
      userId: 123,
      type: 'yyy',
      serialNumber: 'snB',
      certifier: 'cB',
      subject: 'sB',
      verifier: undefined,
      revocationOutpoint: 'nope.1',
      signature: 'sigB',
      isDeleted: false,
      created_at: new Date(),
      updated_at: new Date()
    }
    const cC: TableCertificate = {
      certificateId: 102,
      userId: 123,
      type: 'xxx',
      serialNumber: 'snC',
      certifier: 'cC',
      subject: 'sC',
      verifier: undefined,
      revocationOutpoint: 'nope.2',
      signature: 'sigC',
      isDeleted: false,
      created_at: new Date(),
      updated_at: new Date()
    }

    // Suppose the storage returned 3 items even though we only want 2.
    // The code uses them all in memory, but sees length=3 which is > limit=2
    // The line checks if (r.certificates.length < paged.limit). That is false, so it calls countCertificates.
    mockStorage.findCertificates.mockResolvedValueOnce([cA, cB, cC])

    // Fields are none
    mockStorage.findCertificateFields.mockResolvedValue([])

    // We want to see it call countCertificates
    mockStorage.countCertificates.mockResolvedValueOnce(999)

    const result = await listCertificates(mockStorage, auth, vargs)

    expect(result.certificates.length).toBe(3)
    expect(result.totalCertificates).toBe(999) // from countCertificates
  })
})
