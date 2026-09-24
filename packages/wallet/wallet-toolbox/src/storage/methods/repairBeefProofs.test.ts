import 'fake-indexeddb/auto'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { StorageServer } from '../remoting/StorageServer'
import { StorageClient } from '../remoting/StorageClient'
import { KnexSessionManager } from '../remoting/KnexSessionManager'
import { Beef, MerklePath, PrivateKey, Script, Transaction, Validation } from '@bsv/sdk'
import { StorageIdb } from '../StorageIdb'
import { StorageProvider } from '../StorageProvider'
import { WalletStorageManager } from '../WalletStorageManager'
import { repairBeefProofs } from './repairBeefProofs'
import { validateSyncProof } from './validateSyncProof'
import { WERR_INVALID_MERKLE_ROOT } from '../../sdk/WERR_errors'
import { WalletErrorFromJson } from '../../sdk/WalletErrorFromJson'
import { toBinaryBaseBlockHeader } from '../../services/Services'
import { doubleSha256BE } from '../../utility/utilityHelpers'
import { asString } from '../../utility/utilityHelpers.noBuffer'
import type { WalletServices } from '../../sdk/WalletServices.interfaces'
import { _tu } from '../../../test/utils/TestUtilsWalletStorage'
import { managedChangeOutputFields } from './managedChange'
import { EntityProvenTxReq } from '../schema/entities/EntityProvenTxReq'
import type { RequestSyncChunkArgs, SyncChunk, WalletStorageSyncReader } from '../../sdk/WalletStorage.interfaces'

function fixture() {
  const tx = new Transaction()
  tx.addOutput({ satoshis: 5000, lockingScript: Script.fromHex('51') })
  const txid = tx.id('hex')
  const old = new MerklePath(100, [[{ offset: 0, hash: txid, txid: true }]])
  const current = new MerklePath(101, [
    [
      { offset: 0, hash: txid, txid: true },
      { offset: 1, hash: 'ab'.repeat(32) }
    ]
  ])
  const root = current.computeRoot(txid)
  const header = toBinaryBaseBlockHeader({
    version: 1,
    previousHash: '00'.repeat(32),
    merkleRoot: root,
    time: 1,
    bits: 0,
    nonce: 0
  })
  const record = {
    provenTxId: 0,
    txid,
    rawTx: tx.toBinary(),
    merklePath: old.toBinary(),
    height: 100,
    index: 0,
    merkleRoot: old.computeRoot(txid),
    blockHash: '11'.repeat(32),
    created_at: new Date(0),
    updated_at: new Date(1)
  }
  const getMerklePath = jest.fn(async () => ({ merklePath: current }))
  const isValidRootForHeight = jest.fn(
    async (candidate: string, height: number) => candidate === root && height === 101
  )
  const getHeaderForHeight = jest.fn(async () => [...header])
  const services = {
    getMerklePath,
    getHeaderForHeight,
    getChainTracker: async () => ({ isValidRootForHeight })
  } as unknown as WalletServices
  const beef = new Beef()
  beef.mergeRawTx(record.rawTx)
  beef.mergeBump(old)
  return { beef, record, services, current, root, header, getMerklePath, isValidRootForHeight, getHeaderForHeight }
}

async function seedFunding(storage: StorageProvider, f: ReturnType<typeof fixture>, identityKey: string) {
  const { user } = await storage.findOrInsertUser(identityKey)
  const basket = await storage.findOrInsertOutputBasket(user.userId, 'default')
  await storage.updateOutputBasket(basket.basketId, { numberOfDesiredUTXOs: 0, minimumDesiredUTXOValue: 1 })
  const { tx } = await _tu.insertTestTransaction(storage, user, false, {
    txid: f.record.txid,
    rawTx: f.record.rawTx,
    provenTxId: f.record.provenTxId,
    status: 'completed'
  })
  const output = await _tu.insertTestOutput(storage, tx, 0, 5000, basket, true, {
    ...managedChangeOutputFields,
    txid: f.record.txid,
    lockingScript: [0x51],
    scriptLength: 1,
    derivationPrefix: 'dGVzdA==',
    derivationSuffix: 'dGVzdA=='
  })
  const args = Validation.validateCreateActionArgs({
    description: 'selected stale proof recovery',
    outputs: [{ satoshis: 1000, lockingScript: '51', outputDescription: 'proof recovery output' }],
    options: { noSend: true, returnTXIDOnly: false, randomizeOutputs: false }
  })
  return { user, output, args }
}

describe.each(['IndexedDB', 'SQLite'])('canonical BEEF recovery on %s', backend => {
  let storage: StorageProvider
  let cleanup: () => Promise<void>
  beforeEach(async () => {
    if (backend === 'IndexedDB') {
      const idb = new StorageIdb(StorageProvider.createStorageBaseOptions('test'))
      idb.dbName = `proof-recovery-${randomUUID()}`
      await idb.migrate('proof recovery', PrivateKey.fromRandom().toPublicKey().toString())
      await idb.makeAvailable()
      storage = idb
      cleanup = async () => {
        await idb.destroy()
        await idb.dropAllData()
      }
    } else {
      const ctx = await _tu.createLegacyWalletSQLiteCopy('proof-recovery')
      storage = ctx.activeStorage
      cleanup = async () => {
        await ctx.wallet.destroy()
      }
    }
  })
  afterEach(async () => {
    jest.restoreAllMocks()
    await cleanup()
  })

  test('repairs stale selected or embedded ancestry, persists atomically and reuses the correction', async () => {
    const f = fixture()
    storage.setServices(f.services)
    f.record.provenTxId = await storage.insertProvenTx(f.record)
    const original = f.beef.toBinary()
    const result = await repairBeefProofs(storage, f.beef)
    expect(result.findTxid(f.record.txid)?.rawTx).toEqual(f.record.rawTx)
    expect(result.bumps.map(path => path.toBinary())).toEqual([f.current.toBinary()])
    expect(f.beef.toBinary()).toEqual(original)
    expect(f.getMerklePath).toHaveBeenCalledTimes(1)
    const stored = (await storage.findProvenTxs({ partial: { txid: f.record.txid } }))[0]
    expect(stored).toMatchObject({ height: 101, blockHash: asString(doubleSha256BE(f.header)), merkleRoot: f.root })
    expect(stored.updated_at.getTime()).toBeGreaterThan(f.record.updated_at.getTime())
    const repeated = await repairBeefProofs(storage, f.beef)
    expect(repeated.toBinary()).toEqual(result.toBinary())
    expect(f.getMerklePath).toHaveBeenCalledTimes(1)
  })

  test.each(['absent', 'orphan', 'wrong header', 'throw'])(
    'fails with typed remote context for %s canonical evidence',
    async failure => {
      const f = fixture()
      storage.setServices(f.services)
      f.record.provenTxId = await storage.insertProvenTx(f.record)
      const before = f.beef.toBinary()
      if (failure === 'absent') f.getMerklePath.mockResolvedValue({ merklePath: undefined! })
      if (failure === 'orphan') f.isValidRootForHeight.mockResolvedValue(false)
      if (failure === 'wrong header') f.getHeaderForHeight.mockResolvedValue(Array(80).fill(0))
      if (failure === 'throw') f.getMerklePath.mockRejectedValue(new Error('unavailable'))
      const error = await repairBeefProofs(storage, f.beef).catch(error => error)
      expect(error).toBeInstanceOf(WERR_INVALID_MERKLE_ROOT)
      expect(WalletErrorFromJson(JSON.parse(error.toJson()))).toMatchObject({ txid: f.record.txid, blockHeight: 100 })
      expect(f.beef.toBinary()).toEqual(before)
      expect(f.getMerklePath).toHaveBeenCalledTimes(1)
      expect((await storage.findProvenTxs({ partial: { txid: f.record.txid } }))[0].height).toBe(100)
    }
  )

  test('refuses unvalidated replacements and does not overwrite a concurrently changed proof', async () => {
    const f = fixture()
    storage.setServices(f.services)
    f.record.provenTxId = await storage.insertProvenTx(f.record)
    const replacement = {
      ...f.record,
      height: 101,
      merklePath: f.current.toBinary(),
      merkleRoot: f.root,
      blockHash: asString(doubleSha256BE(f.header))
    }
    await expect(storage.compareAndSetProvenTxProof(f.record, replacement)).rejects.toThrow(
      'requires active-chain validation'
    )
    await validateSyncProof(storage, replacement)
    await storage.updateProvenTx(f.record.provenTxId, { height: 102 })
    expect(await storage.compareAndSetProvenTxProof(f.record, replacement)).toBe(false)
    expect((await storage.findProvenTxs({ partial: { txid: f.record.txid } }))[0].height).toBe(102)
  })

  test.each([false, true])(
    'prepared sync detaches payloads and fences concurrent proof changes (%s)',
    async changed => {
      const f = fixture()
      storage.setServices(f.services)
      f.record.provenTxId = await storage.insertProvenTx(f.record)
      const identityKey = PrivateKey.fromRandom().toPublicKey().toString()
      const source = PrivateKey.fromRandom().toPublicKey().toString()
      const checkpoint = await storage.getSyncCheckpoint({ identityKey }, source, 'prepared fixture')
      const args: RequestSyncChunkArgs = {
        ...checkpoint,
        identityKey,
        fromStorageIdentityKey: source,
        toStorageIdentityKey: storage.getSettings().storageIdentityKey,
        maxItems: 64,
        maxRoughSize: 1000000,
        requireMatchingCheckpoint: true,
        includeNextCheckpoint: true
      }
      const replacement = {
        ...f.record,
        height: 101,
        merklePath: f.current.toBinary(),
        merkleRoot: f.root,
        blockHash: asString(doubleSha256BE(f.header))
      }
      const chunk: SyncChunk = {
        fromStorageIdentityKey: source,
        toStorageIdentityKey: args.toStorageIdentityKey,
        userIdentityKey: identityKey,
        provenTxs: [replacement]
      }
      const apply = await storage.prepareSyncChunk(args, chunk)
      if (changed) {
        await storage.updateProvenTx(f.record.provenTxId, { height: 102 })
        await expect(apply()).rejects.toThrow('Proof changed during sync preparation')
        expect(await storage.getSyncCheckpoint({ identityKey }, source, 'prepared fixture')).toEqual(checkpoint)
        expect((await storage.findProvenTxs({ partial: { txid: f.record.txid } }))[0].height).toBe(102)
      } else {
        replacement.rawTx[0] ^= 1
        replacement.merklePath[0] ^= 1
        args.offsets[0].offset = 9999
        const committed = await apply()
        expect(committed.nextCheckpoint?.offsets[0].offset).toBe(1)
        expect((await storage.findProvenTxs({ partial: { txid: f.record.txid } }))[0]).toMatchObject({
          height: 101,
          merkleRoot: f.root
        })
      }
      await expect(apply()).rejects.toThrow('already consumed')
    }
  )

  test('sync proof I/O yields the manager queue and cancellation discards the prepared page', async () => {
    const f = fixture()
    storage.setServices(f.services)
    f.record.provenTxId = await storage.insertProvenTx(f.record)
    const identityKey = PrivateKey.fromRandom().toPublicKey().toString()
    const manager = new WalletStorageManager(identityKey, storage)
    await manager.makeAvailable()
    const sourceSettings = {
      ...storage.getSettings(),
      storageIdentityKey: PrivateKey.fromRandom().toPublicKey().toString()
    }
    const reader = {
      makeAvailable: async () => sourceSettings,
      getSettings: () => sourceSettings,
      getSyncChunk: async (args: RequestSyncChunkArgs): Promise<SyncChunk> => ({
        fromStorageIdentityKey: sourceSettings.storageIdentityKey,
        toStorageIdentityKey: args.toStorageIdentityKey,
        userIdentityKey: identityKey,
        provenTxs: [
          {
            ...f.record,
            height: 101,
            merklePath: f.current.toBinary(),
            merkleRoot: f.root,
            blockHash: asString(doubleSha256BE(f.header))
          }
        ]
      })
    } as WalletStorageSyncReader
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>(resolve => {
      entered = resolve
    })
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    f.getHeaderForHeight.mockImplementation(async () => {
      entered()
      await gate
      return f.header
    })
    const controller = new AbortController()
    const sync = manager.syncFromReaderResumable(identityKey, reader, { signal: controller.signal })
    await started
    try {
      const userId = await manager.getUserId()
      await manager.runAsWriter(async () => await storage.findOrInsertTxLabel(userId, 'during proof lookup'))
      expect(await manager.runAsReader(async () => await storage.countTxLabels({ partial: { userId } }))).toBe(1)
      controller.abort()
    } finally {
      release()
    }
    expect(await sync).toMatchObject({ mode: 'paged', status: 'cancelled', pages: 0 })
    expect((await storage.findProvenTxs({ partial: { txid: f.record.txid } }))[0].height).toBe(100)
  }, 10000)

  test.each(['direct', 'header', 'height'])(
    'monitor %s recovery cannot overwrite a concurrent proof correction',
    async mode => {
      const f = fixture()
      const manager = new WalletStorageManager(PrivateKey.fromRandom().toPublicKey().toString(), storage)
      await manager.makeAvailable()
      manager.setServices(f.services)
      f.record.provenTxId = await storage.insertProvenTx(f.record)
      let entered!: () => void
      let release!: () => void
      const started = new Promise<void>(resolve => {
        entered = resolve
      })
      const paused = new Promise<void>(resolve => {
        release = resolve
      })
      f.getMerklePath.mockImplementation(async () => {
        entered()
        await paused
        return { merklePath: f.current }
      })
      const recovering =
        mode === 'direct'
          ? manager.reproveProven(f.record)
          : mode === 'header'
            ? manager.reproveHeader(f.record.blockHash)
            : manager.reproveHeightMerkleRoot(f.record.height, f.record.merkleRoot)
      await started
      try {
        await manager.runAsWriter(async () => await storage.updateProvenTx(f.record.provenTxId, { height: 102 }))
      } finally {
        release()
      }
      const result = await recovering
      expect(result.updated == null || (Array.isArray(result.updated) && result.updated.length === 0)).toBe(true)
      expect(result.log).toContain('changed concurrently')
      expect((await storage.findProvenTxs({ partial: { txid: f.record.txid } }))[0].height).toBe(102)
    },
    10000
  )

  test('monitor recovery fences primary replacement before committing a late proof', async () => {
    const f = fixture()
    const manager = new WalletStorageManager(PrivateKey.fromRandom().toPublicKey().toString(), storage)
    const next = new StorageIdb(StorageProvider.createStorageBaseOptions('test'))
    next.dbName = `reproof-next-${randomUUID()}`
    await next.migrate('reproof replacement', PrivateKey.fromRandom().toPublicKey().toString())
    await manager.makeAvailable()
    await manager.addWalletStorageProvider(next)
    await manager.setActive(storage.getSettings().storageIdentityKey)
    manager.setServices(f.services)
    f.record.provenTxId = await storage.insertProvenTx(f.record)
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>(resolve => {
      entered = resolve
    })
    const paused = new Promise<void>(resolve => {
      release = resolve
    })
    f.getMerklePath.mockImplementation(async () => {
      entered()
      await paused
      return { merklePath: f.current }
    })
    const recovering = manager.reproveHeader(f.record.blockHash)
    const rejected = expect(recovering).rejects.toThrow('Proof destination changed')
    await started
    try {
      await manager.setActive(next.getSettings().storageIdentityKey)
    } finally {
      release()
    }
    try {
      await rejected
      expect((await storage.findProvenTxs({ partial: { txid: f.record.txid } }))[0].height).toBe(100)
      expect(await next.findProvenTxs({ partial: { txid: f.record.txid } })).toHaveLength(0)
    } finally {
      await next.destroy()
      await next.dropAllData()
    }
  }, 10000)

  test('repairs embedded ancestry absent from storage and preserves txid-only references', async () => {
    const f = fixture()
    storage.setServices(f.services)
    const reference = 'ac'.repeat(32)
    f.beef.mergeTxidOnly(reference)
    const repaired = await repairBeefProofs(storage, f.beef)
    expect(repaired.findTxid(reference)?.isTxidOnly).toBe(true)
    expect(repaired.findTxid(f.record.txid)?.rawTx).toEqual(f.record.rawTx)
    expect(repaired.bumps[0].computeRoot(f.record.txid)).toBe(f.root)
    expect(await storage.countProvenTxs({ partial: { txid: f.record.txid } })).toBe(0)
  })

  test('reuses a concurrent canonical database correction without another provider request', async () => {
    const f = fixture()
    storage.setServices(f.services)
    await storage.insertProvenTx({
      ...f.record,
      height: 101,
      merklePath: f.current.toBinary(),
      merkleRoot: f.root,
      blockHash: asString(doubleSha256BE(f.header))
    })
    const persist = jest.spyOn(storage, 'compareAndSetProvenTxProof')
    const repaired = await repairBeefProofs(storage, f.beef)
    expect(repaired.bumps[0].computeRoot(f.record.txid)).toBe(f.root)
    expect(f.getMerklePath).not.toHaveBeenCalled()
    expect(persist).not.toHaveBeenCalled()
  })

  test('a provider without atomic proof replacement can repair outgoing BEEF without changing shared storage', async () => {
    const f = fixture()
    storage.setServices(f.services)
    await storage.insertProvenTx(f.record)
    jest
      .spyOn(storage, 'compareAndSetProvenTxProof')
      .mockImplementation(StorageProvider.prototype.compareAndSetProvenTxProof.bind(storage))
    const repaired = await repairBeefProofs(storage, f.beef)
    expect(repaired.bumps[0].computeRoot(f.record.txid)).toBe(f.root)
    expect((await storage.findProvenTxs({ partial: { txid: f.record.txid } }))[0].height).toBe(100)
  })

  test('keeps valid proof assembly free of copies and storage/provider lookups', async () => {
    const f = fixture()
    storage.setServices(f.services)
    f.isValidRootForHeight.mockResolvedValue(true)
    const find = jest.spyOn(storage, 'findProvenTxs')
    expect(await repairBeefProofs(storage, f.beef)).toBe(f.beef)
    expect(find).not.toHaveBeenCalled()
    expect(f.getMerklePath).not.toHaveBeenCalled()
    expect(f.isValidRootForHeight).toHaveBeenCalledTimes(1)
  })

  test.each([false, true])(
    'validates selected change before returning to the signer (recovery unavailable=%s)',
    async unavailable => {
      const f = fixture()
      storage.setServices(f.services)
      f.record.provenTxId = await storage.insertProvenTx(f.record)
      const { user, output, args } = await seedFunding(storage, f, PrivateKey.fromRandom().toPublicKey().toString())
      if (unavailable) {
        f.getMerklePath.mockResolvedValue({ merklePath: undefined! })
        await expect(
          storage.createAction({ identityKey: user.identityKey, userId: user.userId }, args)
        ).rejects.toBeInstanceOf(WERR_INVALID_MERKLE_ROOT)
        const retained = (await storage.findOutputs({ partial: { outputId: output.outputId } }))[0]
        expect(retained.spendable).toBe(true)
        expect(retained.spentBy).toBeUndefined()
        expect(await storage.findTransactions({ partial: { userId: user.userId }, status: ['failed'] })).toHaveLength(1)
        f.getMerklePath.mockResolvedValue({ merklePath: f.current })
      }
      const created = await storage.createAction({ identityKey: user.identityKey, userId: user.userId }, args)
      expect(Beef.fromBinary(created.inputBeef!).bumps.map(bump => bump.computeRoot())).toEqual([f.root])
      expect(created.inputs).toHaveLength(1)
      expect(created.inputs[0].sourceTxid).toBe(f.record.txid)
    }
  )

  test.each([false, true])(
    'checks the final rebuilt send bundle before broadcast (recovery unavailable=%s)',
    async unavailable => {
      const f = fixture()
      const stop = new Error('stop at controlled broadcaster')
      const postBeef = jest.fn(async (_beef: Beef) => {
        throw stop
      })
      storage.setServices({ ...f.services, postBeef } as WalletServices)
      f.record.provenTxId = await storage.insertProvenTx(f.record)
      const tx = new Transaction()
      tx.addInput({ sourceTXID: f.record.txid, sourceOutputIndex: 0, unlockingScript: Script.fromHex('') })
      tx.addOutput({ satoshis: 4999, lockingScript: Script.fromHex('51') })
      const req = EntityProvenTxReq.fromTxid(tx.id('hex'), tx.toBinary(), f.beef.toBinary())
      req.notify.transactionIds = [1]
      if (unavailable) f.getMerklePath.mockResolvedValue({ merklePath: undefined! })
      const result = storage.attemptToPostReqsToNetwork([req])
      if (unavailable) {
        await expect(result).rejects.toBeInstanceOf(WERR_INVALID_MERKLE_ROOT)
        expect(postBeef).not.toHaveBeenCalled()
        expect(req.attempts).toBe(0)
      } else {
        await expect(result).rejects.toBe(stop)
        expect(postBeef).toHaveBeenCalledTimes(1)
        expect(postBeef.mock.calls[0][0].bumps.map(bump => bump.computeRoot())).toEqual([f.root])
      }
    }
  )
})

test('remote selected-change recovery binds the authenticated wallet and preserves typed errors', async () => {
  const ctx = await _tu.createLegacyWalletSQLiteCopy('remote-proof-recovery')
  const server = new StorageServer(ctx.activeStorage, {
    port: 0,
    wallet: ctx.wallet,
    monetize: false,
    logRpcRequests: false,
    sessionManager: new KnexSessionManager(ctx.activeStorage.knex),
    adminIdentityKeys: [],
    calculateRequestPrice: async () => 0
  })
  server.start()
  if (!server.server.listening) await once(server.server, 'listening')
  const address = server.server.address()
  if (address == null || typeof address === 'string') throw new Error('server did not bind')
  const endpointUrl = `http://localhost:${address.port}`
  const client = await _tu.createTestWalletWithStorageClient({
    rootKeyHex: ctx.rootKey.toHex(),
    endpointUrl,
    chain: ctx.chain
  })
  const stranger = await _tu.createTestWalletWithStorageClient({
    rootKeyHex: '2'.repeat(64),
    endpointUrl,
    chain: ctx.chain
  })
  try {
    const f = fixture()
    ctx.activeStorage.setServices(f.services)
    for (const output of await ctx.activeStorage.findOutputs({ partial: { userId: ctx.userId }, noScript: true })) {
      if (output.spendable) await ctx.activeStorage.updateOutput(output.outputId, { spendable: false })
    }
    f.record.provenTxId = await ctx.activeStorage.insertProvenTx(f.record)
    const { args } = await seedFunding(ctx.activeStorage, f, ctx.identityKey)
    const forgedAuth = { identityKey: ctx.identityKey, userId: ctx.userId, isActive: true }
    await expect((stranger.storage.getActive() as StorageClient).createAction(forgedAuth, args)).rejects.toThrow()
    expect(f.getMerklePath).not.toHaveBeenCalled()
    f.getMerklePath.mockResolvedValue({ merklePath: undefined! })
    await expect((client.storage.getActive() as StorageClient).createAction(forgedAuth, args)).rejects.toMatchObject({
      name: 'WERR_INVALID_MERKLE_ROOT',
      txid: f.record.txid,
      blockHeight: 100
    })
    f.getMerklePath.mockResolvedValue({ merklePath: f.current })
    const created = await (client.storage.getActive() as StorageClient).createAction(forgedAuth, args)
    expect(Beef.fromBinary(created.inputBeef!).bumps.map(bump => bump.computeRoot())).toEqual([f.root])
  } finally {
    await stranger.wallet.destroy()
    await client.wallet.destroy()
    await server.close()
    await ctx.wallet.destroy()
  }
}, 30000)
