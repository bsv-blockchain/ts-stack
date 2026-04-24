import { describe, it, expect, beforeEach, jest } from '@jest/globals'
import createMessageBoxLookupService from '../lookup-services/MessageBoxLookupService.js'
import { PushDrop, Utils } from '@bsv/sdk'

jest.mock('@bsv/sdk', () => ({
  PushDrop: {
    decode: jest.fn()
  },
  Utils: {
    toHex: jest.fn(),
    toUTF8: jest.fn()
  }
}))

describe('MessageBoxLookupService', () => {
  const mockedDecode = PushDrop.decode as jest.Mock
  const mockedToHex = Utils.toHex as jest.Mock
  const mockedToUTF8 = Utils.toUTF8 as jest.Mock

  let service: ReturnType<typeof createMessageBoxLookupService>
  let storeRecordSpy: jest.SpiedFunction<typeof service.storage.storeRecord>
  let deleteRecordSpy: jest.SpiedFunction<typeof service.storage.deleteRecord>
  let findAdvertisementsSpy: jest.SpiedFunction<typeof service.storage.findAdvertisements>

  beforeEach(() => {
    jest.clearAllMocks()

    service = createMessageBoxLookupService({
      collection: jest.fn().mockReturnValue({
        insertOne: jest.fn(),
        deleteOne: jest.fn(),
        find: jest.fn()
      })
    } as any)

    storeRecordSpy = jest
      .spyOn(service.storage, 'storeRecord')
      .mockImplementation(async () => undefined)
    deleteRecordSpy = jest
      .spyOn(service.storage, 'deleteRecord')
      .mockImplementation(async () => undefined)
    findAdvertisementsSpy = jest
      .spyOn(service.storage, 'findAdvertisements')
      .mockImplementation(async () => [{ txid: 't1', outputIndex: 0 }])

    mockedToHex.mockReturnValue('identity-key')
    mockedToUTF8.mockReturnValue('https://host.example.com')
  })

  it('stores decoded advertisement for tm_messagebox topic', async () => {
    mockedDecode.mockReturnValue({
      fields: [[1, 2, 3], [4, 5, 6]]
    })

    await service.outputAdmittedByTopic({
      mode: 'locking-script',
      txid: 'tx-1',
      outputIndex: 2,
      topic: 'tm_messagebox',
      satoshis: 1,
      lockingScript: {} as any
    })

    expect(storeRecordSpy).toHaveBeenCalledWith(
      'identity-key',
      'https://host.example.com',
      'tx-1',
      2
    )
  })

  it('ignores non-messagebox topic on outputAdmittedByTopic', async () => {
    await service.outputAdmittedByTopic({
      mode: 'locking-script',
      txid: 'tx-1',
      outputIndex: 2,
      topic: 'tm_other',
      satoshis: 1,
      lockingScript: {} as any
    })

    expect(mockedDecode).not.toHaveBeenCalled()
    expect(storeRecordSpy).not.toHaveBeenCalled()
  })

  it('deletes record on outputSpent for tm_messagebox topic', async () => {
    await service.outputSpent({
      mode: 'none',
      txid: 'tx-2',
      outputIndex: 4,
      topic: 'tm_messagebox'
    })

    expect(deleteRecordSpy).toHaveBeenCalledWith('tx-2', 4)
  })

  it('ignores outputSpent for non-messagebox topic', async () => {
    await service.outputSpent({
      mode: 'none',
      txid: 'tx-2',
      outputIndex: 4,
      topic: 'tm_other'
    })

    expect(deleteRecordSpy).not.toHaveBeenCalled()
  })

  it('always deletes record on outputEvicted', async () => {
    await service.outputEvicted('tx-3', 1)

    expect(deleteRecordSpy).toHaveBeenCalledWith('tx-3', 1)
  })

  it('throws on unsupported lookup service', async () => {
    await expect(
      service.lookup({
        service: 'ls_other',
        query: { identityKey: 'abc' }
      } as any)
    ).rejects.toThrow('Unsupported lookup service')
  })

  it('throws when identityKey is missing from query', async () => {
    await expect(
      service.lookup({
        service: 'ls_messagebox',
        query: {}
      } as any)
    ).rejects.toThrow('identityKey query missing')
  })

  it('delegates lookup to storage with identityKey and host', async () => {
    const result = await service.lookup({
      service: 'ls_messagebox',
      query: {
        identityKey: 'abc',
        host: 'https://x.example.com'
      }
    } as any)

    expect(findAdvertisementsSpy).toHaveBeenCalledWith('abc', 'https://x.example.com')
    expect(result).toEqual([{ txid: 't1', outputIndex: 0 }])
  })

  it('delegates lookup with identityKey only (no host)', async () => {
    const result = await service.lookup({
      service: 'ls_messagebox',
      query: { identityKey: 'abc' }
    } as any)

    expect(findAdvertisementsSpy).toHaveBeenCalledWith('abc', undefined)
    expect(result).toEqual([{ txid: 't1', outputIndex: 0 }])
  })

  it('throws on invalid mode in outputAdmittedByTopic', async () => {
    await expect(
      service.outputAdmittedByTopic({
        mode: 'none',
        txid: 'tx-1',
        outputIndex: 0,
        topic: 'tm_messagebox',
        satoshis: 1,
        lockingScript: {} as any
      } as any)
    ).rejects.toThrow('Invalid payload')
  })

  it('throws on invalid mode in outputSpent', async () => {
    await expect(
      service.outputSpent({
        mode: 'locking-script',
        txid: 'tx-1',
        outputIndex: 0,
        topic: 'tm_messagebox'
      } as any)
    ).rejects.toThrow('Invalid payload')
  })

  it('handles decode failure gracefully in outputAdmittedByTopic', async () => {
    mockedDecode.mockImplementation(() => {
      throw new Error('decode error')
    })

    // Should not throw — error is caught internally
    await service.outputAdmittedByTopic({
      mode: 'locking-script',
      txid: 'tx-1',
      outputIndex: 0,
      topic: 'tm_messagebox',
      satoshis: 1,
      lockingScript: {} as any
    })

    expect(storeRecordSpy).not.toHaveBeenCalled()
  })

  it('getDocumentation returns a string', async () => {
    const docs = await service.getDocumentation()
    expect(typeof docs).toBe('string')
  })

  it('getMetaData returns name and shortDescription', async () => {
    const meta = await service.getMetaData()
    expect(meta).toEqual({
      name: 'MessageBox Lookup Service',
      shortDescription: 'Lookup overlay hosts for identity keys (MessageBox)'
    })
  })
})
