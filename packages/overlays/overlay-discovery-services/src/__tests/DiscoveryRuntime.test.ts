import { jest } from '@jest/globals'
import { PrivateKey, ProtoWallet, PushDrop, Transaction, Utils, WalletInterface } from '@bsv/sdk'
import { SHIPLookupService } from '../SHIP/SHIPLookupService.js'
import { SHIPTopicManager } from '../SHIP/SHIPTopicManager.js'
import { SLAPLookupService } from '../SLAP/SLAPLookupService.js'
import { SLAPTopicManager } from '../SLAP/SLAPTopicManager.js'
import { isAdmissibleDiscoveryOutput } from '../utils/isAdmissibleDiscoveryOutput.js'

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
    expect(storage.findAll).toHaveBeenLastCalledWith()

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
        identityKey: 'identity',
        limit: 3,
        skip: 2,
        sortOrder: 'asc'
      }
    } as never)
    expect(storage.findRecord).toHaveBeenLastCalledWith({
      domain: 'https://example.com',
      topics: ['tm_a'],
      identityKey: 'identity',
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
    [{ service: 'ls_ship', query: { skip: '1' } }, 'query.skip'],
    [{ service: 'ls_ship', query: { sortOrder: 'sideways' } }, 'query.sortOrder'],
    [{ service: 'ls_ship', query: { domain: 1 } }, 'query.domain'],
    [{ service: 'ls_ship', query: { topics: 'tm_a' } }, 'query.topics'],
    [{ service: 'ls_ship', query: { topics: [1, 2] } }, 'query.topics'],
    [{ service: 'ls_ship', query: { topics: [null] } }, 'query.topics'],
    [{ service: 'ls_ship', query: { topics: ['tm_a', 2] } }, 'query.topics'],
    [{ service: 'ls_ship', query: { identityKey: 1 } }, 'query.identityKey']
  ])('rejects invalid lookup question %#', async (question, message) => {
    const { service } = makeService()
    await expect(service.lookup(question as never)).rejects.toThrow(message)
  })

  it('accepts a limit of zero and reports the bound accurately when negative', async () => {
    const { service, storage } = makeService()

    await service.lookup({ service: 'ls_ship', query: { findAll: true, limit: 0 } } as never)
    expect(storage.findAll).toHaveBeenLastCalledWith(0, undefined, undefined)

    await expect(
      service.lookup({ service: 'ls_ship', query: { limit: -1 } } as never)
    ).rejects.toThrow('query.limit must be a non-negative number if provided')
  })

  it('throws a plain Error for a non-object query', async () => {
    const { service } = makeService()
    const error = await service
      .lookup({ service: 'ls_ship', query: 7 } as never)
      .then(
        () => undefined,
        (thrown: unknown) => thrown
      )

    // Callers branching on the error class must keep seeing Error, not TypeError.
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).constructor).toBe(Error)
    expect((error as Error).name).toBe('Error')
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
      txid: 'wrong',
      outputIndex: 0
    } as never)
    await service.outputAdmittedByTopic({
      mode: 'locking-script',
      topic: 'tm_ship',
      lockingScript: valid,
      txid: 'txid',
      outputIndex: 1
    } as never)

    expect(storage.storeSHIPRecord).toHaveBeenCalledTimes(1)
    expect(storage.storeSHIPRecord).toHaveBeenCalledWith(
      'txid',
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
      txid: 'spent',
      outputIndex: 2
    } as never)
    await service.outputEvicted('evicted', 3)

    expect(storage.deleteSHIPRecord).toHaveBeenCalledTimes(2)
    expect(storage.deleteSHIPRecord).toHaveBeenNthCalledWith(1, 'spent', 2)
    expect(storage.deleteSHIPRecord).toHaveBeenNthCalledWith(2, 'evicted', 3)
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
    expect(storage.findAll).toHaveBeenLastCalledWith()

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
      limit: 3
    })

    await service.lookup({
      service: 'ls_slap',
      query: {
        service: 'ls_example',
        identityKey: 'identity',
        skip: 2,
        sortOrder: 'asc'
      }
    } as never)
    expect(storage.findRecord).toHaveBeenLastCalledWith({
      service: 'ls_example',
      identityKey: 'identity',
      skip: 2,
      sortOrder: 'asc'
    })
  })

  it.each([
    [{ service: 'ls_slap', query: null }, 'A valid query must be provided!'],
    [{ service: 'other', query: 'findAll' }, 'Lookup service not supported!'],
    [{ service: 'ls_slap', query: 1 }, 'Invalid query format'],
    [{ service: 'ls_slap', query: { limit: '1' } }, 'query.limit'],
    [{ service: 'ls_slap', query: { skip: -1 } }, 'query.skip'],
    [{ service: 'ls_slap', query: { sortOrder: 'sideways' } }, 'query.sortOrder'],
    [{ service: 'ls_slap', query: { domain: 1 } }, 'query.domain'],
    [{ service: 'ls_slap', query: { service: 1 } }, 'query.service'],
    [{ service: 'ls_slap', query: { identityKey: 1 } }, 'query.identityKey']
  ])('rejects invalid lookup question %#', async (question, message) => {
    const { service } = makeService()
    await expect(service.lookup(question as never)).rejects.toThrow(message)
  })

  it('throws a plain Error for a non-object query', async () => {
    const { service } = makeService()
    const error = await service
      .lookup({ service: 'ls_slap', query: 7 } as never)
      .then(
        () => undefined,
        (thrown: unknown) => thrown
      )

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).constructor).toBe(Error)
    expect((error as Error).name).toBe('Error')
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
      txid: 'wrong',
      outputIndex: 0
    } as never)
    await service.outputAdmittedByTopic({
      mode: 'locking-script',
      topic: 'tm_slap',
      lockingScript: valid,
      txid: 'txid',
      outputIndex: 1
    } as never)

    expect(storage.storeSLAPRecord).toHaveBeenCalledTimes(1)
    expect(storage.storeSLAPRecord).toHaveBeenCalledWith(
      'txid',
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
      txid: 'spent',
      outputIndex: 2
    } as never)
    await service.outputEvicted('evicted', 3)

    expect(storage.deleteSLAPRecord).toHaveBeenCalledTimes(2)
    expect(storage.deleteSLAPRecord).toHaveBeenNthCalledWith(1, 'spent', 2)
    expect(storage.deleteSLAPRecord).toHaveBeenNthCalledWith(2, 'evicted', 3)
  })

  it('exposes documentation and metadata', async () => {
    const { service } = makeService()
    await expect(service.getDocumentation()).resolves.toContain('SLAP')
    await expect(service.getMetaData()).resolves.toMatchObject({ name: 'SLAP Lookup Service' })
  })
})
