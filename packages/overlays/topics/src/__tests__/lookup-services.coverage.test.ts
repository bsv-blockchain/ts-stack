import { jest } from '@jest/globals'
import { PrivateKey } from '@bsv/sdk'
import createAppsLookupService from '../apps/AppsLookupService.js'
import { BasketMapLookupService } from '../basketmap/BasketMapLookupService.js'
import { Bsv21LookupService } from '../bsv21/Bsv21LookupService.js'
import { CertMapLookupService } from '../certmap/CertMapLookupService.js'
import { DesktopIntegrityLookupService } from '../desktopintegrity/DesktopIntegrityLookupService.js'
import { DstasLookupService } from '../dstas/DstasLookupService.js'
import { IdentityLookupService } from '../identity/IdentityLookupService.js'
import { MessageBoxLookupService } from '../message-box/MessageBoxLookupService.js'
import { MonsterBattleLookupService } from '../monsterbattle/MonsterBattleLookupService.js'
import { ProtoMapLookupService } from '../protomap/ProtoMapLookupService.js'
import { SlackThreadLookupService } from '../slackthreads/SlackThreadsLookupService.js'
import { StasLookupService } from '../stas/StasLookupService.js'
import { SupplyChainLookupService } from '../supplychain/SupplyChainLookupService.js'
import { TokenDemoLookupService } from '../utility-tokens/TokenDemoLookupService.js'
import { WalletConfigLookupService } from '../walletconfig/WalletConfigLookupService.js'

const txid = 'ab'.repeat(32)
const identityKey = PrivateKey.fromRandom().toPublicKey().toString()

function question(service: string, query: Record<string, unknown> = {}) {
  return { service, query }
}

function storage(methods: string[]): Record<string, jest.Mock> {
  return Object.fromEntries(methods.map(method => [method, jest.fn(async () => [{ method }])]))
}

function appsLookupService(storageManager: Record<string, jest.Mock>) {
  const service = createAppsLookupService({ collection: jest.fn(() => ({})) } as never)
  service.storageManager = storageManager as never
  return service
}

describe('lookup service query routing', () => {
  it.each([
    ['domain', 'findByDomain', 'example.com'],
    ['publisher', 'findByPublisher', identityKey],
    ['name', 'findByNameFuzzy', 'wallet'],
    ['outpoint', 'findByOutpoint', `${txid}.1`],
    ['tags', 'findByTags', ['wallet', 'identity']],
    ['category', 'findByCategory', 'finance']
  ])('routes Apps %s selectors to %s', async (selector, method, value) => {
    const db = storage([
      'findByDomain',
      'findByPublisher',
      'findByNameFuzzy',
      'findByOutpoint',
      'findByTags',
      'findByCategory',
      'findAllApps'
    ])
    const service = appsLookupService(db)
    await service.lookup(
      question('ls_apps', { [selector]: value, limit: 5, skip: 2, sortOrder: 'asc' })
    )
    expect(db[method]).toHaveBeenCalled()
  })

  it('lists Apps by default and exposes stable metadata', async () => {
    const db = storage(['findAllApps', 'deleteRecord'])
    const service = appsLookupService(db)
    await expect(service.lookup(question('ls_apps'))).resolves.toEqual([{ method: 'findAllApps' }])
    await expect(service.getDocumentation()).resolves.toContain('Apps Lookup Service')
    await expect(service.getMetaData()).resolves.toMatchObject({ name: 'Apps Lookup Service' })
    await service.outputEvicted(txid, 1)
    await service.outputSpent({ mode: 'none', topic: 'tm_apps', txid, outputIndex: 1 })
    expect(db.deleteRecord).toHaveBeenCalledTimes(2)
    await expect(
      service.outputSpent({ mode: 'script', topic: 'tm_apps', txid, outputIndex: 1 } as never)
    ).rejects.toThrow('Invalid payload')
  })

  it.each([
    ['configID', 'findByConfigId', 'wallet-1'],
    ['name', 'findByName', 'Wallet'],
    ['wab', 'findByWab', 'https://wab.example'],
    ['storage', 'findByStorage', 'https://storage.example'],
    ['messagebox', 'findByMessagebox', 'https://message.example']
  ])('routes WalletConfig %s selectors to %s', async (selector, method, value) => {
    const db = storage([
      'findByConfigId',
      'findByName',
      'findByWab',
      'findByStorage',
      'findByMessagebox',
      'listAll'
    ])
    const service = new WalletConfigLookupService(db as never)
    await service.lookup(
      question('ls_walletconfig', { [selector]: value, registryOperators: [identityKey] })
    )
    expect(db[method]).toHaveBeenCalledWith(value, [identityKey])
  })

  it('requires WalletConfig registry authority and lists within it', async () => {
    const db = storage(['listAll'])
    const service = new WalletConfigLookupService(db as never)
    await expect(service.lookup(question('ls_walletconfig'))).rejects.toThrow(
      'registryOperators must be provided'
    )
    await service.lookup(question('ls_walletconfig', { registryOperators: [identityKey] }))
    expect(db.listAll).toHaveBeenCalledWith([identityKey])
    await expect(service.getDocumentation()).resolves.toContain('WalletConfig')
    await expect(service.getMetaData()).resolves.toMatchObject({
      name: 'WalletConfig Lookup Service'
    })
  })

  it('routes every Identity selector through bounded, normalized storage calls', async () => {
    const certificateType = Buffer.alloc(32, 2).toString('base64')
    const certifier = PrivateKey.fromRandom().toPublicKey().toString()
    const db = storage([
      'findByAttribute',
      'findByCertificateType',
      'findByIdentityKey',
      'findByCertifier',
      'deleteRecord'
    ])
    const service = new IdentityLookupService(db as never)

    await service.lookup(
      question('ls_identity', {
        attributes: { displayName: 'Alice' },
        certifiers: [certifier],
        limit: 5,
        offset: 2
      })
    )
    const parsedAttributes = db.findByAttribute.mock.calls[0]?.[0] as Record<string, string>
    expect(Object.getPrototypeOf(parsedAttributes)).toBeNull()
    expect(parsedAttributes).toEqual({ displayName: 'Alice' })
    expect(db.findByAttribute).toHaveBeenCalledWith(parsedAttributes, [certifier], 5, 2)

    await service.lookup(
      question('ls_identity', {
        identityKey,
        certificateTypes: [certificateType],
        certifiers: [certifier]
      })
    )
    expect(db.findByCertificateType).toHaveBeenCalledWith(
      [certificateType],
      identityKey,
      [certifier],
      10,
      0
    )

    await service.lookup(question('ls_identity', { identityKey }))
    expect(db.findByIdentityKey).toHaveBeenCalledWith(identityKey, undefined, 10, 0)
    await service.lookup(question('ls_identity', { certifiers: [certifier] }))
    expect(db.findByCertifier).toHaveBeenCalledWith([certifier], 10, 0)

    await service.outputEvicted(txid, 1)
    expect(db.deleteRecord).toHaveBeenCalledWith(txid, 1)
    await expect(service.getDocumentation()).resolves.toContain('Identity Lookup Service')
    await expect(service.getMetaData()).resolves.toMatchObject({ name: 'Identity Lookup Service' })
  })

  it.each([
    ['null attributes', null, 'plain object'],
    ['array attributes', [], 'plain object'],
    ['empty attributes', {}, '1-32 fields'],
    [
      'too many attributes',
      Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`field${index}`, 'value'])),
      '1-32 fields'
    ],
    ['oversized attribute value', { name: 'é'.repeat(251) }, 'at most 500 UTF-8 bytes']
  ])('rejects Identity queries with %s before storage', async (_label, attributes, message) => {
    const db = storage(['findByAttribute'])
    const service = new IdentityLookupService(db as never)

    await expect(service.lookup(question('ls_identity', { attributes }))).rejects.toThrow(
      message as string
    )
    expect(db.findByAttribute).not.toHaveBeenCalled()
  })

  it('requires at least one Identity selector before storage', async () => {
    const db = storage(['findByAttribute', 'findByIdentityKey', 'findByCertifier'])
    const service = new IdentityLookupService(db as never)

    await expect(service.lookup(question('ls_identity'))).rejects.toThrow('params is missing')
    expect(db.findByAttribute).not.toHaveBeenCalled()
    expect(db.findByIdentityKey).not.toHaveBeenCalled()
    expect(db.findByCertifier).not.toHaveBeenCalled()
  })

  it('routes CertMap type/name selectors and rejects ambiguous queries', async () => {
    const db = storage(['findByType', 'findByName', 'deleteRecord'])
    const service = new CertMapLookupService(db as never)
    await service.lookup(
      question('ls_certmap', { type: 'certificate', registryOperators: [identityKey] })
    )
    await service.lookup(question('ls_certmap', { name: 'Name', registryOperators: [identityKey] }))
    await expect(service.lookup(question('ls_certmap'))).rejects.toThrow('must be valid params')
    expect(db.findByType).toHaveBeenCalled()
    expect(db.findByName).toHaveBeenCalled()
    await service.outputEvicted(txid, 1)
    await service.outputSpent({ mode: 'none', topic: 'tm_certmap', txid, outputIndex: 1 })
    expect(db.deleteRecord).toHaveBeenCalledTimes(2)
    await expect(service.getDocumentation()).resolves.toContain('CertMap')
  })

  it('routes BasketMap ID and name only within an explicit registry authority set', async () => {
    const db = storage(['findById', 'findByName', 'deleteRecord'])
    const service = new BasketMapLookupService(db as never)

    await service.lookup(
      question('ls_basketmap', { basketID: 'payments', registryOperators: [identityKey] })
    )
    await service.lookup(
      question('ls_basketmap', { name: 'Payments', registryOperators: [identityKey] })
    )
    expect(db.findById).toHaveBeenCalledWith('payments', [identityKey])
    expect(db.findByName).toHaveBeenCalledWith('Payments', [identityKey])
    await expect(
      service.lookup(question('ls_basketmap', { basketID: 'payments' }))
    ).rejects.toThrow('registryOperator is missing')
    await service.outputSpent({ mode: 'none', topic: 'tm_basketmap', txid, outputIndex: 1 })
    await service.outputEvicted(txid, 1)
    expect(db.deleteRecord).toHaveBeenCalledTimes(2)
  })

  it('routes ProtoMap name/protocol selectors and rejects ambiguous queries', async () => {
    const db = storage(['findByName', 'findByProtocolID', 'deleteRecord'])
    const service = new ProtoMapLookupService(db as never)
    await service.lookup(
      question('ls_protomap', { name: 'Payments', registryOperators: [identityKey] })
    )
    await service.lookup(
      question('ls_protomap', {
        protocolID: [2, 'payments protocol'],
        registryOperators: [identityKey]
      })
    )
    await expect(service.lookup(question('ls_protomap'))).rejects.toThrow('must be valid params')
    expect(db.findByName).toHaveBeenCalled()
    expect(db.findByProtocolID).toHaveBeenCalled()
    await service.outputEvicted(txid, 1)
    await expect(service.getMetaData()).resolves.toMatchObject({ name: 'ls_protomap' })
  })

  it('routes SupplyChain txid, chain, and bounded scans', async () => {
    const db = storage(['findByTxid', 'findByChainId', 'findAll', 'deleteRecord', 'spendRecord'])
    const service = new SupplyChainLookupService(db as never)
    await service.lookup(question('ls_supplychain', { txid }))
    await service.lookup(question('ls_supplychain', { chainId: 'shipment-1' }))
    await service.lookup(
      question('ls_supplychain', {
        startDate: '2026-01-01T00:00:00.000Z',
        endDate: '2026-02-01T00:00:00.000Z'
      })
    )
    expect(db.findByTxid).toHaveBeenCalled()
    expect(db.findByChainId).toHaveBeenCalled()
    expect(db.findAll).toHaveBeenCalled()
    await expect(
      service.lookup(
        question('ls_supplychain', {
          startDate: '2026-02-01T00:00:00.000Z',
          endDate: '2026-01-01T00:00:00.000Z'
        })
      )
    ).rejects.toThrow('must not be after')
    await service.outputSpent({
      mode: 'txid',
      topic: 'tm_supplychain',
      txid,
      outputIndex: 1,
      spendingTxid: 'cd'.repeat(32)
    })
    expect(db.spendRecord).toHaveBeenCalled()
  })

  it('routes MonsterBattle exact and scan lookups', async () => {
    const db = storage(['findByTxid', 'findAll', 'deleteRecord'])
    const service = new MonsterBattleLookupService(db as never)
    await service.lookup(question('ls_monsterbattle', { txid }))
    await service.lookup(question('ls_monsterbattle'))
    expect(db.findByTxid).toHaveBeenCalled()
    expect(db.findAll).toHaveBeenCalled()
    await service.outputEvicted(txid, 0)
    await expect(service.getMetaData()).resolves.toMatchObject({
      name: 'MonsterBattle Lookup Service'
    })
  })

  it('routes token-demo outpoint, token ID, and scan lookups', async () => {
    const db = storage(['findByOutpoint', 'findByTokenId', 'findAll', 'deleteRecord'])
    const service = new TokenDemoLookupService(db as never)
    await service.lookup(question('ls_tokendemo', { outpoint: `${txid}.3` }))
    await service.lookup(question('ls_tokendemo', { tokenId: 'token-1' }))
    await service.lookup(question('ls_tokendemo'))
    expect(db.findByOutpoint).toHaveBeenCalledWith(`${txid}.3`)
    expect(db.findByTokenId).toHaveBeenCalled()
    expect(db.findAll).toHaveBeenCalled()
    await service.outputSpent({ mode: 'none', topic: 'tm_tokendemo', txid, outputIndex: 3 })
    await service.outputEvicted(txid, 3)
    expect(db.deleteRecord).toHaveBeenCalledTimes(2)
  })

  it('routes STAS asset, owner, and exact outpoint lookups', async () => {
    const db = storage(['findByAssetId', 'findByOwner', 'findByOutpoint', 'deleteToken'])
    const service = new StasLookupService({ storage: db as never })
    await service.lookup(question('ls_stas', { assetId: 'asset-1' }))
    await service.lookup(question('ls_stas', { ownerHash160: '11'.repeat(20) }))
    await service.lookup(question('ls_stas', { txid, outputIndex: 1 }))
    expect(db.findByAssetId).toHaveBeenCalled()
    expect(db.findByOwner).toHaveBeenCalled()
    expect(db.findByOutpoint).toHaveBeenCalled()
    await service.outputSpent({ mode: 'none', topic: 'tm_stas', txid, outputIndex: 1 })
    await service.outputEvicted(txid, 1)
    expect(db.deleteToken).toHaveBeenCalledTimes(2)
    await expect(service.getDocumentation()).resolves.toContain('STAS')
  })

  it('routes BSV-21 token, owner, and exact outpoint lookups', async () => {
    const db = storage(['findByTokenId', 'findByOwner', 'findByOutpoint', 'deleteToken'])
    const service = new Bsv21LookupService({ storage: db as never })
    const ownerHash160 = '11'.repeat(20)

    await service.lookup(question('ls_bsv21', { tokenId: 'token-id', limit: 5, skip: 2 }))
    await service.lookup(question('ls_bsv21', { ownerHash160 }))
    await service.lookup(question('ls_bsv21', { txid, outputIndex: 3 }))
    expect(db.findByTokenId).toHaveBeenCalledWith('token-id', 5, 2)
    expect(db.findByOwner).toHaveBeenCalledWith(ownerHash160, 100, 0)
    expect(db.findByOutpoint).toHaveBeenCalledWith(txid, 3)
    await expect(service.lookup(question('ls_bsv21'))).rejects.toThrow('Unsupported query')
    await service.outputSpent({ mode: 'script', topic: 'tm_bsv21', txid, outputIndex: 3 } as never)
    await service.outputEvicted(txid, 3)
    expect(db.deleteToken).toHaveBeenCalledTimes(2)
    await expect(service.getMetaData()).resolves.toMatchObject({ name: 'ls_bsv21' })
  })

  it('routes DSTAS token, owner, and exact outpoint lookups with explicit frozen state', async () => {
    const db = storage(['findByTokenId', 'findByOwner', 'findByOutpoint', 'deleteToken'])
    const service = new DstasLookupService({ storage: db as never })
    const tokenId = '22'.repeat(20)
    const ownerHash160 = '33'.repeat(20)

    await service.lookup(question('ls_dstas', { tokenId, frozen: false, limit: 5, skip: 2 }))
    await service.lookup(question('ls_dstas', { ownerHash160, frozen: true }))
    await service.lookup(question('ls_dstas', { txid, outputIndex: 4 }))
    expect(db.findByTokenId).toHaveBeenCalledWith(tokenId, false, 5, 2)
    expect(db.findByOwner).toHaveBeenCalledWith(ownerHash160, true, 100, 0)
    expect(db.findByOutpoint).toHaveBeenCalledWith(txid, 4)
    await expect(service.lookup(question('ls_dstas'))).rejects.toThrow('Unsupported query')
    await service.outputSpent({ mode: 'script', topic: 'tm_dstas', txid, outputIndex: 4 } as never)
    await service.outputEvicted(txid, 4)
    expect(db.deleteToken).toHaveBeenCalledTimes(2)
  })

  it('routes DesktopIntegrity hashes, txids, and bounded date scans', async () => {
    const db = storage(['findByFileHash', 'findByTxid', 'findAll', 'deleteRecord'])
    const service = new DesktopIntegrityLookupService(db as never)
    const fileHash = 'CD'.repeat(32)
    const startDate = '2026-01-01T00:00:00.000Z'
    const endDate = '2026-02-01T00:00:00.000Z'

    await service.lookup(question('ls_desktopintegrity', { fileHash, limit: 5, skip: 2 }))
    await service.lookup(question('ls_desktopintegrity', { txid }))
    await service.lookup(question('ls_desktopintegrity', { startDate, endDate, sortOrder: 'asc' }))
    expect(db.findByFileHash).toHaveBeenCalledWith(fileHash.toLowerCase(), 5, 2, 'desc')
    expect(db.findByTxid).toHaveBeenCalledWith(txid, 50, 0, 'desc')
    expect(db.findAll).toHaveBeenCalledWith(50, 0, new Date(startDate), new Date(endDate), 'asc')
    await expect(
      service.lookup(question('ls_desktopintegrity', { startDate: endDate, endDate: startDate }))
    ).rejects.toThrow('must not be after')
    await service.outputSpent({ mode: 'none', topic: 'tm_desktopintegrity', txid, outputIndex: 1 })
    await service.outputEvicted(txid, 1)
    expect(db.deleteRecord).toHaveBeenCalledTimes(2)
  })

  it('routes Slack thread hashes, txids, and bounded date scans', async () => {
    const db = storage(['findByThreadHash', 'findByTxid', 'findAll', 'deleteRecord'])
    const service = new SlackThreadLookupService(db as never)
    const threadHash = 'CD'.repeat(32)
    const startDate = '2026-01-01T00:00:00.000Z'
    const endDate = '2026-02-01T00:00:00.000Z'

    await service.lookup(question('ls_slackthread', { threadHash, limit: 6, skip: 3 }))
    await service.lookup(question('ls_slackthread', { txid }))
    await service.lookup(question('ls_slackthread', { startDate, endDate, sortOrder: 'asc' }))
    expect(db.findByThreadHash).toHaveBeenCalledWith(threadHash.toLowerCase(), 6, 3, 'desc')
    expect(db.findByTxid).toHaveBeenCalledWith(txid, 50, 0, 'desc')
    expect(db.findAll).toHaveBeenCalledWith(50, 0, new Date(startDate), new Date(endDate), 'asc')
    await expect(
      service.lookup(question('ls_slackthread', { startDate: endDate, endDate: startDate }))
    ).rejects.toThrow('must not be after')
    await service.outputSpent({ mode: 'none', topic: 'tm_slackthread', txid, outputIndex: 1 })
    await service.outputEvicted(txid, 1)
    expect(db.deleteRecord).toHaveBeenCalledTimes(2)
  })

  it('binds MessageBox lookups to one canonical identity and optional host', async () => {
    const db = storage(['findAdvertisements', 'deleteRecord'])
    const service = new MessageBoxLookupService(db as never)
    await service.lookup(
      question('ls_messagebox', { identityKey, host: 'https://message-box.example' })
    )
    expect(db.findAdvertisements).toHaveBeenCalledWith(identityKey, 'https://message-box.example')
    await expect(service.lookup(question('ls_messagebox'))).rejects.toThrow('identityKey')
    await service.outputSpent({ mode: 'none', topic: 'tm_messagebox', txid, outputIndex: 1 })
    await service.outputEvicted(txid, 1)
    expect(db.deleteRecord).toHaveBeenCalledTimes(2)
    await expect(service.getMetaData()).resolves.toMatchObject({
      name: 'MessageBox Lookup Service'
    })
  })
})
