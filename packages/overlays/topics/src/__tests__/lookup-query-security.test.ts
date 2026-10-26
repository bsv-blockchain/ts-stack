import { jest } from '@jest/globals'
import { StorageUtils } from '@bsv/sdk'
import type { Collection, Db } from 'mongodb'
import { IdentityLookupService } from '../identity/IdentityLookupService.js'
import { IdentityStorageManager } from '../identity/IdentityStorageManager.js'
import { UHRPLookupService } from '../uhrp/UHRPLookupService.js'
import { Bsv21LookupService } from '../bsv21/Bsv21LookupService.js'
import { Bsv21StorageManager } from '../bsv21/Bsv21StorageManager.js'
import { BasketMapLookupService } from '../basketmap/BasketMapLookupService.js'
import { BasketMapStorageManager } from '../basketmap/BasketMapStorageManager.js'
import { requireTokenId } from '../shared/queryValidation.js'

const IDENTITY_KEY = `02${'11'.repeat(32)}`
const CERTIFIER_KEY = `03${'22'.repeat(32)}`
const SERIAL = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE='
const TXID = 'ab'.repeat(32)

function uhrpHarness(): {
  service: UHRPLookupService
  find: jest.Mock
  findOne: jest.Mock
  replaceOne: jest.Mock
  limit: jest.Mock
  skip: jest.Mock
} {
  const toArray = jest.fn(async () => [{ txid: TXID, outputIndex: 1 }])
  const limit = jest.fn(() => cursor)
  const skip = jest.fn(() => cursor)
  const cursor = {
    project: jest.fn(() => cursor),
    sort: jest.fn(() => cursor),
    limit,
    skip,
    toArray
  }
  const find = jest.fn(() => cursor)
  const findOne = jest.fn(async () => ({ txid: TXID, outputIndex: 1 }))
  const replaceOne = jest.fn()
  const collection = { find, findOne, replaceOne } as unknown as Collection
  const db = { collection: jest.fn(() => collection) } as unknown as Db
  return { service: new UHRPLookupService(db), find, findOne, replaceOne, limit, skip }
}

describe('public lookup query security boundaries', () => {
  it('never forwards Mongo operators or arbitrary fields from a UHRP query', async () => {
    const { service, find } = uhrpHarness()

    await expect(
      service.lookup({
        service: 'ls_uhrp',
        query: { hostIdentityKey: CERTIFIER_KEY, $where: 'while(true){}' }
      })
    ).rejects.toThrow('unexpected field $where')
    expect(find).not.toHaveBeenCalled()
  })

  it('constructs a bounded UHRP filter rather than forwarding the request object', async () => {
    const { service, find, limit, skip } = uhrpHarness()

    await expect(
      service.lookup({
        service: 'ls_uhrp',
        query: { hostIdentityKey: CERTIFIER_KEY, expiryTime: 123, limit: 25, offset: 4 }
      })
    ).resolves.toEqual([{ txid: TXID, outputIndex: 1 }])

    expect(find).toHaveBeenCalledWith({
      hostIdentityKey: CERTIFIER_KEY,
      expiryTime: 123
    })
    expect(skip).toHaveBeenCalledWith(4)
    expect(limit).toHaveBeenCalledWith(25)
  })

  it('rejects unbounded pagination and malformed UHRP outpoints before Mongo', async () => {
    const { service, find, findOne } = uhrpHarness()

    await expect(
      service.lookup({ service: 'ls_uhrp', query: { hostIdentityKey: CERTIFIER_KEY, limit: 0 } })
    ).rejects.toThrow('limit must be an integer from 1 to 200')
    await expect(
      service.lookup({ service: 'ls_uhrp', query: { outpoint: `${TXID}.1.trailing` } })
    ).rejects.toThrow('canonical outpoint')
    expect(find).not.toHaveBeenCalled()
    expect(findOne).not.toHaveBeenCalled()
  })

  it('serves exact UHRP outpoints without falling through to a collection scan', async () => {
    const { service, find, findOne } = uhrpHarness()

    await expect(
      service.lookup({ service: 'ls_uhrp', query: { outpoint: `${TXID.toUpperCase()}.1` } })
    ).resolves.toEqual([{ txid: TXID, outputIndex: 1 }])
    expect(findOne).toHaveBeenCalledWith({ txid: TXID, outputIndex: 1 })
    expect(find).not.toHaveBeenCalled()

    findOne.mockResolvedValueOnce(null)
    await expect(
      service.lookup({ service: 'ls_uhrp', query: { outpoint: `${TXID}.2` } })
    ).resolves.toEqual([])
  })

  it('normalizes UHRP URLs and constructs only typed filters', async () => {
    const { service, find } = uhrpHarness()
    const url = StorageUtils.getURLForHash(Array.from({ length: 32 }, () => 1))

    await service.lookup({
      service: 'ls_uhrp',
      query: { uhrpUrl: url, hostIdentityKey: CERTIFIER_KEY, expiryTime: 123 }
    })
    expect(find).toHaveBeenCalledWith({
      uhrpUrl: StorageUtils.normalizeURL(url),
      hostIdentityKey: CERTIFIER_KEY,
      expiryTime: 123
    })
  })

  it.each([
    ['an invalid UHRP URL', { uhrpUrl: 'not-uhrp' }, 'uhrpUrl is invalid'],
    ['a malformed host key', { hostIdentityKey: '02deadbeef' }, 'compressed public key'],
    [
      'an invalid compressed point',
      { hostIdentityKey: `02${'11'.repeat(32)}` },
      'valid public key'
    ],
    ['no selector', {}, 'must specify either outpoint']
  ])('rejects %s before scanning Mongo', async (_label, query, message) => {
    const { service, find, findOne } = uhrpHarness()

    await expect(service.lookup({ service: 'ls_uhrp', query })).rejects.toThrow(message as string)
    expect(find).not.toHaveBeenCalled()
    expect(findOne).not.toHaveBeenCalled()
  })

  it.each([
    ['a malformed txid', 'bad', 0],
    ['a fractional output index', TXID, 1.5],
    ['a negative output index', TXID, -1],
    ['an excessive output index', TXID, 0x1_0000_0000]
  ])(
    'rejects UHRP admission with %s before token decoding or storage',
    async (_label, txid, outputIndex) => {
      const { service, replaceOne } = uhrpHarness()

      await expect(
        service.outputAdmittedByTopic({
          mode: 'locking-script',
          topic: 'tm_uhrp',
          txid,
          outputIndex,
          lockingScript: {} as never
        })
      ).rejects.toThrow('Invalid UHRP admission outpoint')
      expect(replaceOne).not.toHaveBeenCalled()
    }
  )

  it('rejects Mongo path injection and non-string identity attributes', async () => {
    const storage = {
      findByAttribute: jest.fn()
    } as unknown as IdentityStorageManager
    const service = new IdentityLookupService(storage)

    await expect(
      service.lookup({
        service: 'ls_identity',
        query: { attributes: { 'name.$regex': '.*' } }
      })
    ).rejects.toThrow('attribute names must be safe MongoDB field segments')
    await expect(
      service.lookup({ service: 'ls_identity', query: { attributes: { name: { $ne: '' } } } })
    ).rejects.toThrow('attribute values must be strings')
    expect(storage.findByAttribute).not.toHaveBeenCalled()
  })

  it('validates identity selectors and bounds pagination before storage access', async () => {
    const storage = {
      findByCertificateSerialNumber: jest.fn(async () => [{ txid: TXID, outputIndex: 0 }]),
      findByIdentityKey: jest.fn(async () => [{ txid: TXID, outputIndex: 0 }])
    } as unknown as IdentityStorageManager
    const service = new IdentityLookupService(storage)

    await expect(
      service.lookup({
        service: 'ls_identity',
        query: { serialNumber: SERIAL, limit: 20, offset: 3 }
      })
    ).resolves.toEqual([{ txid: TXID, outputIndex: 0 }])
    expect(storage.findByCertificateSerialNumber).toHaveBeenCalledWith(SERIAL, 20, 3)

    await expect(
      service.lookup({
        service: 'ls_identity',
        query: { identityKey: IDENTITY_KEY, certifiers: [CERTIFIER_KEY], limit: 101 }
      })
    ).rejects.toThrow('limit must be an integer from 1 to 100')
    expect(storage.findByIdentityKey).not.toHaveBeenCalled()
  })

  it('rejects getters, inherited query state, and prototype-sensitive fields before Mongo', async () => {
    const { service, find } = uhrpHarness()
    const getterQuery: Record<string, unknown> = {}
    Object.defineProperty(getterQuery, 'hostIdentityKey', {
      enumerable: true,
      get: () => CERTIFIER_KEY
    })

    await expect(service.lookup({ service: 'ls_uhrp', query: getterQuery })).rejects.toThrow(
      'field hostIdentityKey must be data'
    )

    const inheritedQuery = Object.create({ hostIdentityKey: CERTIFIER_KEY })
    inheritedQuery.url = 'uhrp:test'
    await expect(service.lookup({ service: 'ls_uhrp', query: inheritedQuery })).rejects.toThrow(
      'query must be a plain object'
    )

    await expect(
      service.lookup({
        service: 'ls_uhrp',
        query: JSON.parse('{"hostIdentityKey":"' + CERTIFIER_KEY + '","__proto__":"x"}')
      })
    ).rejects.toThrow('unexpected field __proto__')
    expect(find).not.toHaveBeenCalled()
  })

  it('binds token queries to their declared service and rejects typed-selector injection', async () => {
    const storage = {
      findByTokenId: jest.fn(async () => [{ txid: TXID, outputIndex: 0 }]),
      findByOwner: jest.fn(),
      findByOutpoint: jest.fn()
    } as unknown as Bsv21StorageManager
    const service = new Bsv21LookupService({ storage })

    await expect(
      service.lookup({ service: 'ls_other', query: { tokenId: `${TXID}_0` } })
    ).rejects.toThrow('Lookup service not supported')
    await expect(
      service.lookup({
        service: 'ls_bsv21',
        query: { ownerHash160: { $ne: '' } }
      })
    ).rejects.toThrow('ownerHash160 must be a string')
    await expect(
      service.lookup({ service: 'ls_bsv21', query: { tokenId: `${TXID}_0`, limit: 0 } })
    ).rejects.toThrow('limit must be an integer from 1 to 100')
    expect(storage.findByTokenId).not.toHaveBeenCalled()
  })

  it('validates registry operator arrays before constructing $in filters', async () => {
    const storage = {
      findById: jest.fn(async () => [{ txid: TXID, outputIndex: 0 }]),
      findByName: jest.fn()
    } as unknown as BasketMapStorageManager
    const service = new BasketMapLookupService(storage)

    await expect(
      service.lookup({
        service: 'ls_basketmap',
        query: { basketID: 'payments', registryOperators: [{ $ne: null }] }
      })
    ).rejects.toThrow('registryOperators[0] must be a non-empty bounded string')
    await expect(
      service.lookup({
        service: 'ls_basketmap',
        query: { basketID: 'payments', registryOperators: [CERTIFIER_KEY] }
      })
    ).resolves.toEqual([{ txid: TXID, outputIndex: 0 }])
    expect(storage.findById).toHaveBeenCalledWith('payments', [CERTIFIER_KEY])
  })
})

describe('requireTokenId', () => {
  const TOKEN_ID = `${'ab'.repeat(32)}_0`

  it('accepts a lowercase 64-hex token id and returns it unchanged', () => {
    expect(requireTokenId(TOKEN_ID, 'tokenId')).toBe(TOKEN_ID)
  })

  it.each([
    ['uppercase hex', `${'AB'.repeat(32)}_0`],
    ['a non-zero vout', `${'ab'.repeat(32)}_1`],
    ['a dotted outpoint', `${'ab'.repeat(32)}.0`],
    ['a missing suffix', 'ab'.repeat(32)],
    ['a short txid', `${'ab'.repeat(31)}_0`],
    ['a long txid', `${'ab'.repeat(33)}_0`],
    ['non-hex characters', `${'zz'.repeat(32)}_0`],
    ['a trailing newline', `${TOKEN_ID}\n`],
    ['a leading space', ` ${TOKEN_ID}`],
    ['an empty string', ''],
    ['a number', 7],
    ['null', null],
    ['undefined', undefined],
    ['an object selector', { $ne: '' }],
    ['an array', [TOKEN_ID]]
  ])('refuses %s', (_label, value) => {
    expect(() => requireTokenId(value, 'metadataTokenId')).toThrow(
      'Invalid lookup query: metadataTokenId must be a token id (<64 lowercase hex>_0)'
    )
  })
})
