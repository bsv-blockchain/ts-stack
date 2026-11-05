import { CachedKeyDeriver, PrivateKey } from '@bsv/sdk'
import { knex, Knex } from 'knex'
import { Wallet } from '../Wallet'
import { WalletPermissionsManager } from '../WalletPermissionsManager'
import { MockServices } from '../mockchain/MockServices'
import { StorageKnex } from '../storage/StorageKnex'
import { WalletStorageManager } from '../storage/WalletStorageManager'

/** Real signing and token funding against isolated, empty SQLite storage. No network or real funds. */
describe('unfunded permission grants with a local wallet', () => {
  let databases: Knex[]
  let wallet: Wallet
  let manager: WalletPermissionsManager
  let prompts: number
  let fundingErrors: string[]
  const originator = 'local-permission-test.example'
  const signatureArgs = {
    data: [1, 2, 3],
    protocolID: [1, 'local permission test'] as [0 | 1 | 2, string],
    keyID: '1',
    counterparty: 'self'
  }

  function memoryDatabase(): Knex {
    const db = knex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 }
    })
    databases.push(db)
    return db
  }

  function permissions(): WalletPermissionsManager {
    const result = new WalletPermissionsManager(wallet, 'admin.local', { seekGroupedPermission: false })
    result.bindCallback('onProtocolPermissionRequested', async request => {
      prompts++
      try {
        await result.grantPermission({ requestID: request.requestID })
      } catch (error) {
        fundingErrors.push((error as { code: string }).code)
      }
    })
    return result
  }

  beforeEach(async () => {
    databases = []
    prompts = 0
    fundingErrors = []
    const services = new MockServices(memoryDatabase())
    await services.initialize()
    const keyDeriver = new CachedKeyDeriver(PrivateKey.fromHex('11'.repeat(32)))
    const active = new StorageKnex({
      chain: 'mock',
      knex: memoryDatabase(),
      commissionSatoshis: 0,
      feeModel: { model: 'sat/kb', value: 1 }
    })
    await active.migrate('unfunded-permission-test', '02' + '22'.repeat(32))
    await active.makeAvailable()
    const storage = new WalletStorageManager(keyDeriver.identityKey, active)
    await storage.makeAvailable()
    wallet = new Wallet({ chain: 'mock', keyDeriver, storage, services })
    manager = permissions()
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    for (const db of databases) await db.destroy()
  })

  it('signs and verifies repeatedly with zero coins, then re-prompts after manager restart', async () => {
    const first = await manager.createSignature(signatureArgs, originator)
    await expect(wallet.verifySignature({ ...signatureArgs, signature: first.signature }, originator)).resolves.toEqual(
      { valid: true }
    )
    expect(fundingErrors).toEqual(['WERR_INSUFFICIENT_FUNDS'])
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000)
    const second = await manager.createSignature(signatureArgs, originator)
    await expect(
      wallet.verifySignature({ ...signatureArgs, signature: second.signature }, originator)
    ).resolves.toEqual({ valid: true })
    expect(prompts).toBe(1)
    await expect(manager.listProtocolPermissions({ originator })).resolves.toEqual([])
    manager = permissions()
    await manager.createSignature(signatureArgs, originator)
    expect(prompts).toBe(2)
    expect(fundingErrors).toEqual(['WERR_INSUFFICIENT_FUNDS', 'WERR_INSUFFICIENT_FUNDS'])
  })

  it('revokes a session grant without coins and prompts on the next signature', async () => {
    await manager.createSignature(signatureArgs, originator)
    await expect(manager.revokeAllForOriginator(originator)).resolves.toEqual([])
    await manager.createSignature(signatureArgs, originator)
    expect(prompts).toBe(2)
    expect(fundingErrors).toEqual(['WERR_INSUFFICIENT_FUNDS', 'WERR_INSUFFICIENT_FUNDS'])
  })
})
