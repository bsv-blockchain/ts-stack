import { jest } from '@jest/globals'
import { PrivateKey, ProtoWallet, PushDrop, Transaction, Utils, WalletInterface } from '@bsv/sdk'
import { SHIPLookupService } from '../SHIP/SHIPLookupService.js'
import { SHIPTopicManager } from '../SHIP/SHIPTopicManager.js'
import { SLAPLookupService } from '../SLAP/SLAPLookupService.js'
import { SLAPTopicManager } from '../SLAP/SLAPTopicManager.js'
import { isAdmissibleDiscoveryOutput } from '../utils/isAdmissibleDiscoveryOutput.js'

const validIdentityKey = '02fe8d1eb1bcb3432b1db5833ff5f2226d9cb5e65cee430558c18ed3a3c86ce1af'
const assetId = `${'0123456789abcdef'.repeat(4)}_0`

async function makeCustomAdvertisementScript(
  protocol: 'SHIP' | 'SLAP',
  fields: number[][]
) {
  const wallet = new ProtoWallet(new PrivateKey(42))
  return await new PushDrop(wallet as unknown as WalletInterface).lock(
    fields,
    [2, protocol === 'SHIP' ? 'service host interconnect' : 'service lookup availability'],
    '1',
    'anyone',
    true
  )
}

async function makeAdvertisementScript(
  protocol: 'SHIP' | 'SLAP',
  advertisedName: string,
  domain = 'https://example.com'
) {
  const wallet = new ProtoWallet(new PrivateKey(42))
  const { publicKey: identityKey } = await wallet.getPublicKey({ identityKey: true })
  return await makeCustomAdvertisementScript(protocol, [
    Utils.toArray(protocol, 'utf8'),
    Utils.toArray(identityKey, 'hex'),
    Utils.toArray(domain, 'utf8'),
    Utils.toArray(advertisedName, 'utf8')
  ])
}

function makeBEEF(
  ...lockingScripts: Awaited<ReturnType<typeof makeAdvertisementScript>>[]
): number[] {
  return new Transaction(
    1,
    [],
    lockingScripts.map(lockingScript => ({ lockingScript, satoshis: 1 })),
    0
  ).toBEEF()
}

describe('discovery topic managers', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
    jest.spyOn(console, 'log').mockImplementation(() => undefined)
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it.each([
    ['SHIP', 'tm_example', 'ls_wrong', SHIPTopicManager],
    ['SLAP', 'ls_example', 'tm_wrong', SLAPTopicManager]
  ] as const)(
    'admits only valid %s advertisements',
    async (protocol, validName, wrongPrefix, Manager) => {
      const valid = await makeAdvertisementScript(protocol, validName)
      const invalid = await makeAdvertisementScript(protocol, wrongPrefix)
      const result = await new Manager().identifyAdmissibleOutputs(makeBEEF(valid, invalid), [])

      expect(result).toEqual({ outputsToAdmit: [0], coinsToRetain: [] })
      expect(console.log).toHaveBeenCalled()
      expect(console.warn).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['SHIP', `tm_color_${assetId}`, SHIPTopicManager],
    ['SHIP', 'tm_uhrp_files', SHIPTopicManager],
    ['SLAP', `ls_color_${assetId}`, SLAPTopicManager],
    ['SLAP', 'ls_uhrp_files', SLAPTopicManager]
  ] as const)('admits %s advertisements for %s', async (protocol, name, Manager) => {
    const script = await makeAdvertisementScript(protocol, name)
    const result = await new Manager().identifyAdmissibleOutputs(makeBEEF(script), [])
    expect(result).toEqual({ outputsToAdmit: [0], coinsToRetain: [] })
  })

  it.each([
    ['SHIP', ['tm_', 'tm__x', 'tm_x_', 'tm_Color', 'tm_' + 'a'.repeat(297), `color_${assetId}`]],
    ['SLAP', ['ls_', 'ls__x', 'ls_x_', 'ls_Color', 'ls_' + 'a'.repeat(297), `color_${assetId}`]]
  ] as const)('refuses noncanonical %s advertisement names', async (protocol, names) => {
    const scripts = await Promise.all(
      names.map(async name => await makeAdvertisementScript(protocol, name))
    )
    await expect(
      Promise.all(scripts.map(async script => await isAdmissibleDiscoveryOutput(script, protocol)))
    ).resolves.toEqual(names.map(() => false))
  })

  it.each([
    ['SHIP', SHIPTopicManager],
    ['SLAP', SLAPTopicManager]
  ] as const)('retains malformed-input behavior for %s', async (_protocol, Manager) => {
    const manager = new Manager()

    await expect(manager.identifyAdmissibleOutputs([1], [])).resolves.toEqual({
      outputsToAdmit: [],
      coinsToRetain: []
    })
    expect(console.error).toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalled()

    jest.clearAllMocks()
    await expect(manager.identifyAdmissibleOutputs([1], [0])).resolves.toEqual({
      outputsToAdmit: [],
      coinsToRetain: []
    })
    expect(console.error).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalled()
  })

  it('exposes SHIP and SLAP documentation and metadata', async () => {
    const ship = new SHIPTopicManager()
    const slap = new SLAPTopicManager()

    await expect(ship.getDocumentation()).resolves.toContain('SHIP')
    await expect(slap.getDocumentation()).resolves.toContain('SLAP')
    await expect(ship.getMetaData()).resolves.toMatchObject({ name: 'SHIP Topic Manager' })
    await expect(slap.getMetaData()).resolves.toMatchObject({ name: 'SLAP Topic Manager' })
  })

  it('rejects malformed discovery envelopes before signature verification', async () => {
    const wallet = new ProtoWallet(new PrivateKey(42))
    const { publicKey: identityKey } = await wallet.getPublicKey({ identityKey: true })
    const identity = Utils.toArray(identityKey, 'hex')
    const validDomain = Utils.toArray('https://example.com', 'utf8')
    const validName = Utils.toArray('tm_example', 'utf8')
    const cases = [
      await makeCustomAdvertisementScript('SHIP', [
        Utils.toArray('SHIP', 'utf8'),
        identity,
        validDomain
      ]),
      await makeCustomAdvertisementScript('SHIP', [
        Utils.toArray('SLAP', 'utf8'),
        identity,
        validDomain,
        validName
      ]),
      await makeCustomAdvertisementScript('SHIP', [
        Utils.toArray('SHIP', 'utf8'),
        identity,
        Utils.toArray('javascript:alert(1)', 'utf8'),
        validName
      ]),
      await makeCustomAdvertisementScript('SHIP', [
        Utils.toArray('SHIP', 'utf8'),
        identity,
        validDomain,
        Utils.toArray('tm_Invalid', 'utf8')
      ])
    ]

    await expect(
      Promise.all(cases.map(async script => await isAdmissibleDiscoveryOutput(script, 'SHIP')))
    ).resolves.toEqual([false, false, false, false])
  })
})

describe('SHIP lookup service', () => {
  function makeService() {
    const storage = {
      deleteSHIPRecord: jest.fn(async () => undefined),
      findAll: jest.fn(async () => ({ type: 'output-list', outputs: [] })),
      findRecord: jest.fn(async () => ({ type: 'output-list', outputs: [] })),
      storeSHIPRecord: jest.fn(async () => undefined)
    }
    return { service: new SHIPLookupService(storage as never), storage }
  }

  it('routes legacy, paginated, and filtered lookups', async () => {
    const { service, storage } = makeService()

    await service.lookup({ service: 'ls_ship', query: 'findAll' } as never)
    expect(storage.findAll).toHaveBeenLastCalledWith(1000, 0, 'desc')

    await service.lookup({
      service: 'ls_ship',
      query: { findAll: true, limit: 2, skip: 1, sortOrder: 'desc' }
    } as never)
    expect(storage.findAll).toHaveBeenLastCalledWith(2, 1, 'desc')

    await service.lookup({
      service: 'ls_ship',
      query: {
        domain: 'https://example.com',
        topics: ['tm_a'],
        identityKey: validIdentityKey,
        limit: 3,
        skip: 2,
        sortOrder: 'asc'
      }
    } as never)
    expect(storage.findRecord).toHaveBeenLastCalledWith({
      domain: 'https://example.com',
      topics: ['tm_a'],
      identityKey: validIdentityKey,
      limit: 3,
      skip: 2,
      sortOrder: 'asc'
    })
  })

  it.each([
    [{ service: 'ls_ship' }, 'A valid query must be provided!'],
    [{ service: 'other', query: 'findAll' }, 'Lookup service not supported!'],
    [{ service: 'ls_ship', query: 'unsupported' }, 'Invalid query format'],
    [{ service: 'ls_ship', query: { limit: -1 } }, 'query.limit'],
    [{ service: 'ls_ship', query: { limit: 1.5 } }, 'query.limit'],
    [{ service: 'ls_ship', query: { limit: Number.NaN } }, 'query.limit'],
    [{ service: 'ls_ship', query: { limit: Number.POSITIVE_INFINITY } }, 'query.limit'],
    [{ service: 'ls_ship', query: { limit: 1001 } }, 'query.limit'],
    [{ service: 'ls_ship', query: { skip: '1' } }, 'query.skip'],
    [{ service: 'ls_ship', query: { skip: 1_000_001 } }, 'query.skip'],
    [{ service: 'ls_ship', query: { sortOrder: 'sideways' } }, 'query.sortOrder'],
    [{ service: 'ls_ship', query: { findAll: 'true' } }, 'query.findAll'],
    [{ service: 'ls_ship', query: { domain: 1 } }, 'query.domain'],
    [{ service: 'ls_ship', query: { domain: '' } }, 'query.domain'],
    [{ service: 'ls_ship', query: { topics: 'tm_a' } }, 'query.topics'],
    [{ service: 'ls_ship', query: { topics: [] } }, 'query.topics'],
    [{ service: 'ls_ship', query: { topics: [1, 2] } }, 'query.topics'],
    [{ service: 'ls_ship', query: { topics: [null] } }, 'query.topics'],
    [{ service: 'ls_ship', query: { topics: ['tm_a', 2] } }, 'query.topics'],
    [{ service: 'ls_ship', query: { topics: ['tm_a', 'tm_a'] } }, 'query.topics'],
    [{ service: 'ls_ship', query: { topics: ['ls_wrong'] } }, 'query.topics'],
    [{ service: 'ls_ship', query: { topics: ['tm_'] } }, 'query.topics'],
    [{ service: 'ls_ship', query: { topics: ['tm__x'] } }, 'query.topics'],
    [{ service: 'ls_ship', query: { topics: ['tm_x_'] } }, 'query.topics'],
    [{ service: 'ls_ship', query: { topics: ['tm_Color'] } }, 'query.topics'],
    [{ service: 'ls_ship', query: { topics: ['tm_' + 'a'.repeat(297)] } }, 'query.topics'],
    [{ service: 'ls_ship', query: { topics: [`color_${assetId}`] } }, 'query.topics'],
    [{ service: 'ls_ship', query: { identityKey: 1 } }, 'query.identityKey'],
    [{ service: 'ls_ship', query: { identityKey: '02'.padEnd(66, '0') } }, 'query.identityKey'],
    [{ service: 'ls_ship', query: { unexpected: true } }, 'unexpected field']
  ])('rejects invalid lookup question %#', async (question, message) => {
    const { service } = makeService()
    await expect(service.lookup(question as never)).rejects.toThrow(message)
  })

  it('accepts BRC-207 per-asset topic names in topic filters', async () => {
    const { service, storage } = makeService()
    const topics = [`tm_color_${assetId}`, 'tm_uhrp_files', 'tm_' + 'a'.repeat(253)]

    await service.lookup({ service: 'ls_ship', query: { topics } } as never)
    expect(storage.findRecord).toHaveBeenLastCalledWith({
      domain: undefined,
      topics,
      identityKey: undefined,
      limit: 1000,
      skip: 0,
      sortOrder: 'desc'
    })
  })

  it('treats a zero limit as an empty page instead of MongoDB no-limit', async () => {
    const { service, storage } = makeService()

    await expect(
      service.lookup({ service: 'ls_ship', query: { findAll: true, limit: 0 } } as never)
    ).resolves.toEqual([])
    expect(storage.findAll).not.toHaveBeenCalled()

    await expect(
      service.lookup({ service: 'ls_ship', query: { limit: -1 } } as never)
    ).rejects.toThrow('query.limit must be an integer from 0 to 1000')
  })

  it('rejects accessor-backed query objects without invoking their getter', async () => {
    const { service } = makeService()
    const getter = jest.fn(() => 'https://example.com')
    const query = Object.defineProperty({}, 'domain', { enumerable: true, get: getter })

    await expect(service.lookup({ service: 'ls_ship', query } as never)).rejects.toThrow(
      'data properties'
    )
    expect(getter).not.toHaveBeenCalled()
  })

  it('preserves the plain Error contract for a non-object query', async () => {
    const { service } = makeService()
    const error = await service.lookup({ service: 'ls_ship', query: 7 } as never).then(
      () => undefined,
      (thrown: unknown) => thrown
    )

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).constructor).toBe(Error)
  })

  it('stores and removes SHIP records for matching callbacks', async () => {
    const { service, storage } = makeService()
    const valid = await makeAdvertisementScript('SHIP', 'tm_example')
    const wrongProtocol = await makeAdvertisementScript('SLAP', 'ls_example')

    await expect(service.outputAdmittedByTopic({ mode: 'none' } as never)).rejects.toThrow(
      'Invalid payload'
    )
    await service.outputAdmittedByTopic({
      mode: 'locking-script',
      topic: 'tm_other'
    } as never)
    await service.outputAdmittedByTopic({
      mode: 'locking-script',
      topic: 'tm_ship',
      lockingScript: wrongProtocol,
      txid: '11'.repeat(32),
      outputIndex: 0
    } as never)
    await service.outputAdmittedByTopic({
      mode: 'locking-script',
      topic: 'tm_ship',
      lockingScript: valid,
      txid: '22'.repeat(32),
      outputIndex: 1
    } as never)

    expect(storage.storeSHIPRecord).toHaveBeenCalledTimes(1)
    expect(storage.storeSHIPRecord).toHaveBeenCalledWith(
      '22'.repeat(32),
      1,
      expect.any(String),
      'https://example.com',
      'tm_example'
    )

    await expect(service.outputSpent({ mode: 'locking-script' } as never)).rejects.toThrow(
      'Invalid payload'
    )
    await service.outputSpent({
      mode: 'none',
      topic: 'tm_other',
      txid: 'ignored',
      outputIndex: 0
    } as never)
    await service.outputSpent({
      mode: 'none',
      topic: 'tm_ship',
      txid: '33'.repeat(32),
      outputIndex: 2
    } as never)
    await service.outputEvicted('44'.repeat(32), 3)

    expect(storage.deleteSHIPRecord).toHaveBeenCalledTimes(2)
    expect(storage.deleteSHIPRecord).toHaveBeenNthCalledWith(1, '33'.repeat(32), 2)
    expect(storage.deleteSHIPRecord).toHaveBeenNthCalledWith(2, '44'.repeat(32), 3)
  })

  it('exposes documentation and metadata', async () => {
    const { service } = makeService()
    await expect(service.getDocumentation()).resolves.toContain('SHIP')
    await expect(service.getMetaData()).resolves.toMatchObject({ name: 'SHIP Lookup Service' })
  })
})

describe('SLAP lookup service', () => {
  function makeService() {
    const storage = {
      deleteSLAPRecord: jest.fn(async () => undefined),
      findAll: jest.fn(async () => ({ type: 'output-list', outputs: [] })),
      findRecord: jest.fn(async () => ({ type: 'output-list', outputs: [] })),
      storeSLAPRecord: jest.fn(async () => undefined)
    }
    return { service: new SLAPLookupService(storage as never), storage }
  }

  it('routes legacy, paginated, and sparse filtered lookups', async () => {
    const { service, storage } = makeService()

    await service.lookup({ service: 'ls_slap', query: 'findAll' } as never)
    expect(storage.findAll).toHaveBeenLastCalledWith(1000, 0, 'desc')

    await service.lookup({
      service: 'ls_slap',
      query: { findAll: true, limit: 2, skip: 1, sortOrder: 'desc' }
    } as never)
    expect(storage.findAll).toHaveBeenLastCalledWith(2, 1, 'desc')

    await service.lookup({
      service: 'ls_slap',
      query: { domain: 'https://example.com', limit: 3 }
    } as never)
    expect(storage.findRecord).toHaveBeenLastCalledWith({
      domain: 'https://example.com',
      limit: 3,
      skip: 0,
      sortOrder: 'desc'
    })

    await service.lookup({
      service: 'ls_slap',
      query: {
        service: 'ls_example',
        identityKey: validIdentityKey,
        skip: 2,
        sortOrder: 'asc'
      }
    } as never)
    expect(storage.findRecord).toHaveBeenLastCalledWith({
      service: 'ls_example',
      identityKey: validIdentityKey,
      limit: 1000,
      skip: 2,
      sortOrder: 'asc'
    })
  })

  it.each([
    [{ service: 'ls_slap', query: null }, 'A valid query must be provided!'],
    [{ service: 'other', query: 'findAll' }, 'Lookup service not supported!'],
    [{ service: 'ls_slap', query: 1 }, 'Invalid query format'],
    [{ service: 'ls_slap', query: { limit: '1' } }, 'query.limit'],
    [{ service: 'ls_slap', query: { limit: 1.5 } }, 'query.limit'],
    [{ service: 'ls_slap', query: { limit: 1001 } }, 'query.limit'],
    [{ service: 'ls_slap', query: { skip: -1 } }, 'query.skip'],
    [{ service: 'ls_slap', query: { sortOrder: 'sideways' } }, 'query.sortOrder'],
    [{ service: 'ls_slap', query: { findAll: 1 } }, 'query.findAll'],
    [{ service: 'ls_slap', query: { domain: 1 } }, 'query.domain'],
    [{ service: 'ls_slap', query: { service: 1 } }, 'query.service'],
    [{ service: 'ls_slap', query: { service: 'tm_wrong' } }, 'query.service'],
    [{ service: 'ls_slap', query: { service: 'ls_' } }, 'query.service'],
    [{ service: 'ls_slap', query: { service: 'ls__x' } }, 'query.service'],
    [{ service: 'ls_slap', query: { service: 'ls_x_' } }, 'query.service'],
    [{ service: 'ls_slap', query: { service: 'ls_Color' } }, 'query.service'],
    [{ service: 'ls_slap', query: { service: 'ls_' + 'a'.repeat(297) } }, 'query.service'],
    [{ service: 'ls_slap', query: { service: `color_${assetId}` } }, 'query.service'],
    [{ service: 'ls_slap', query: { identityKey: 1 } }, 'query.identityKey'],
    [{ service: 'ls_slap', query: { unexpected: true } }, 'unexpected field']
  ])('rejects invalid lookup question %#', async (question, message) => {
    const { service } = makeService()
    await expect(service.lookup(question as never)).rejects.toThrow(message)
  })

  it.each([`ls_color_${assetId}`, 'ls_uhrp_files', 'ls_' + 'a'.repeat(253)])(
    'accepts lookup service name %s in service filters',
    async name => {
      const { service, storage } = makeService()
      await service.lookup({ service: 'ls_slap', query: { service: name } } as never)
      expect(storage.findRecord).toHaveBeenLastCalledWith({
        service: name,
        limit: 1000,
        skip: 0,
        sortOrder: 'desc'
      })
    }
  )

  it('preserves the plain Error contract for a non-object query', async () => {
    const { service } = makeService()
    const error = await service.lookup({ service: 'ls_slap', query: 7 } as never).then(
      () => undefined,
      (thrown: unknown) => thrown
    )

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).constructor).toBe(Error)
  })

  it('stores and removes SLAP records for matching callbacks', async () => {
    const { service, storage } = makeService()
    const valid = await makeAdvertisementScript('SLAP', 'ls_example')
    const wrongProtocol = await makeAdvertisementScript('SHIP', 'tm_example')

    await expect(service.outputAdmittedByTopic({ mode: 'none' } as never)).rejects.toThrow(
      'Invalid mode'
    )
    await service.outputAdmittedByTopic({
      mode: 'locking-script',
      topic: 'tm_other'
    } as never)
    await service.outputAdmittedByTopic({
      mode: 'locking-script',
      topic: 'tm_slap',
      lockingScript: wrongProtocol,
      txid: '55'.repeat(32),
      outputIndex: 0
    } as never)
    await service.outputAdmittedByTopic({
      mode: 'locking-script',
      topic: 'tm_slap',
      lockingScript: valid,
      txid: '66'.repeat(32),
      outputIndex: 1
    } as never)

    expect(storage.storeSLAPRecord).toHaveBeenCalledTimes(1)
    expect(storage.storeSLAPRecord).toHaveBeenCalledWith(
      '66'.repeat(32),
      1,
      expect.any(String),
      'https://example.com',
      'ls_example'
    )

    await expect(service.outputSpent({ mode: 'locking-script' } as never)).rejects.toThrow(
      'Invalid payload'
    )
    await service.outputSpent({
      mode: 'none',
      topic: 'tm_other',
      txid: 'ignored',
      outputIndex: 0
    } as never)
    await service.outputSpent({
      mode: 'none',
      topic: 'tm_slap',
      txid: '77'.repeat(32),
      outputIndex: 2
    } as never)
    await service.outputEvicted('88'.repeat(32), 3)

    expect(storage.deleteSLAPRecord).toHaveBeenCalledTimes(2)
    expect(storage.deleteSLAPRecord).toHaveBeenNthCalledWith(1, '77'.repeat(32), 2)
    expect(storage.deleteSLAPRecord).toHaveBeenNthCalledWith(2, '88'.repeat(32), 3)
  })

  it('exposes documentation and metadata', async () => {
    const { service } = makeService()
    await expect(service.getDocumentation()).resolves.toContain('SLAP')
    await expect(service.getMetaData()).resolves.toMatchObject({ name: 'SLAP Lookup Service' })
  })
})
