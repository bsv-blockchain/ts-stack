import {
  Beef,
  ListActionsResult,
  ListOutputsResult,
  MerklePath,
  Script,
  Telemetry,
  TelemetryEvent,
  Transaction,
  Utils,
  Validation
} from '@bsv/sdk'
import { StorageAdminStats, StorageProvider } from '../StorageProvider'
import { EntityProvenTx } from '../schema/entities/EntityProvenTx'
import { Chain } from '../../sdk/types'
import { Services } from '../../services/Services'
import { BlockHeader, GetMerklePathResult, GetRawTxResult } from '../../sdk/WalletServices.interfaces'
import {
  TableCertificate,
  TableCertificateField,
  TableCertificateX,
  TableCommission,
  TableMonitorEvent,
  TableOutput,
  TableOutputBasket,
  TableOutputTag,
  TableOutputTagMap,
  TableProvenTx,
  TableProvenTxReq,
  TableSettings,
  TableSyncState,
  TableTransaction,
  TableTxLabel,
  TableTxLabelMap,
  TableUser
} from '../schema/tables'
import {
  AuthId,
  FindCertificateFieldsArgs,
  FindCertificatesArgs,
  FindCommissionsArgs,
  FindForUserSincePagedArgs,
  FindMonitorEventsArgs,
  FindOutputBasketsArgs,
  FindOutputsArgs,
  FindOutputTagMapsArgs,
  FindOutputTagsArgs,
  FindProvenTxReqsArgs,
  FindProvenTxsArgs,
  FindSyncStatesArgs,
  FindTransactionsArgs,
  FindTxLabelMapsArgs,
  FindTxLabelsArgs,
  FindUsersArgs,
  ProvenOrRawTx,
  PurgeParams,
  PurgeResults,
  StorageGetBeefOptions,
  TrxToken
} from '../../sdk/WalletStorage.interfaces'

describe('getBeefForTransaction tests', () => {
  jest.setTimeout(99999999)

  test('accepts existing, serialized, and omitted merge targets', async () => {
    const storage = new ProtoStorage('main')
    const txid = '11'.repeat(32)
    const options: StorageGetBeefOptions = {
      ignoreStorage: true,
      ignoreServices: true,
      knownTxids: [txid]
    }

    const existing = new Beef()
    const mergedExisting = await storage.getBeefForTransaction(txid, {
      ...options,
      mergeToBeef: existing
    })
    expect(mergedExisting).toBe(existing)
    expect(mergedExisting.findTxid(txid)).toBeDefined()

    const serialized = new Beef().toBinary()
    const mergedSerialized = await storage.getBeefForTransaction(txid, {
      ...options,
      mergeToBeef: serialized
    })
    expect(mergedSerialized).toBeInstanceOf(Beef)
    expect(mergedSerialized.findTxid(txid)).toBeDefined()

    const fresh = await storage.getBeefForTransaction(txid, options)
    expect(fresh).toBeInstanceOf(Beef)
    expect(fresh.findTxid(txid)).toBeDefined()
  })

  test('does not index an entire known-txid history for a single known root', async () => {
    const storage = new ProtoStorage('main')
    const txid = '12'.repeat(32)
    const knownTxids = Array.from({ length: 10_000 }, (_, index) => index.toString(16).padStart(64, '0'))
    knownTxids.push(txid)
    Object.defineProperty(knownTxids, Symbol.iterator, {
      value: () => { throw new Error('the common single-root path must not iterate the full history') }
    })

    const beef = await storage.getBeefForTransaction(txid, {
      ignoreStorage: true,
      ignoreServices: true,
      knownTxids
    })

    expect(beef.findTxid(txid)?.isTxidOnly).toBe(true)
  })

  test('uses storage BEEF and forwards proof-validation policy', async () => {
    const storage = new ProtoStorage('main')
    const txid = '22'.repeat(32)
    const stored = new Beef()
    stored.mergeTxidOnly(txid)
    const chainTracker = {
      isValidRootForHeight: jest.fn(async () => true),
      currentHeight: jest.fn(async () => 800000)
    }
    const getValidBeefForTxid = jest.spyOn(storage, 'getValidBeefForTxid').mockResolvedValue(stored)

    const result = await storage.getBeefForTransaction(txid, {
      ignoreServices: true,
      minProofLevel: 2,
      trustSelf: 'known',
      chainTracker,
      skipInvalidProofs: true
    })

    expect(result.findTxid(txid)).toBeDefined()
    expect(getValidBeefForTxid).toHaveBeenCalledWith(
      txid,
      expect.any(Beef),
      'known',
      undefined,
      undefined,
      2,
      chainTracker,
      true
    )
  })

  test('batch-loads same-block proven roots with sequentially equivalent BEEF bytes', async () => {
    const storage = new ProtoStorage('main')
    const transactions = Array.from({ length: 8 }, (_, index) => {
      const tx = new Transaction()
      tx.addInput({
        sourceTXID: '00'.repeat(32),
        sourceOutputIndex: 0xffffffff,
        unlockingScript: Script.fromHex(`04${(500 + index).toString(16).padStart(8, '0')}`)
      })
      tx.addOutput({ satoshis: index + 1, lockingScript: Script.fromASM('OP_TRUE') })
      return tx
    })
    const txids = transactions.map(transaction => transaction.id('hex'))
    const compound = new MerklePath(900_200, [
      txids.map((hash, offset) => ({ offset, hash, txid: true }))
    ])
    const merkleRoot = compound.computeRoot(txids[0])
    const proven = new Map<string, ProvenOrRawTx>(transactions.map((transaction, index) => {
      const now = new Date()
      return [txids[index], {
        proven: {
          provenTxId: index + 1,
          txid: txids[index],
          height: compound.blockHeight,
          index,
          merklePath: compound.extract([txids[index]]).toBinary(),
          rawTx: transaction.toBinary(),
          blockHash: '11'.repeat(32),
          merkleRoot,
          created_at: now,
          updated_at: now
        }
      }]
    }))
    const batchRead = jest.spyOn(storage, 'getProvenOrRawTxs').mockImplementation(async requested =>
      new Map(requested.map(txid => [txid, proven.get(txid)!]))
    )

    const actual = await storage.getBeefForTransactions(txids, {
      ignoreStorage: false,
      ignoreServices: true
    })
    const expected = new Beef()
    for (let index = 0; index < transactions.length; index++) {
      expected.mergeRawTx(transactions[index].toBinary())
      expected.mergeBump(compound.extract([txids[index]]))
    }

    expect(batchRead).toHaveBeenCalledTimes(1)
    expect(batchRead).toHaveBeenCalledWith(txids)
    expect(actual.toBinary()).toEqual(expected.toBinary())
    expect(actual.isValid()).toBe(true)
  })

  test('reports proof decode and merge failures on their batch spans', async () => {
    const events: TelemetryEvent[] = []
    const storage = new ProtoStorage('main')
    Object.defineProperty(storage, 'telemetry', {
      value: new Telemetry({ sink: { capture: event => events.push(event) } })
    })
    const now = new Date()
    const invalidTxid = '29'.repeat(32)
    const invalidProven: TableProvenTx = {
      provenTxId: 29,
      txid: invalidTxid,
      height: 900_250,
      index: 0,
      merklePath: [255],
      rawTx: [1],
      blockHash: '2a'.repeat(32),
      merkleRoot: '2b'.repeat(32),
      created_at: now,
      updated_at: now
    }
    jest.spyOn(storage, 'getProvenOrRawTxs').mockResolvedValueOnce(
      new Map([[invalidTxid, { proven: invalidProven }]])
    )
    const decodeFailure = jest.spyOn(EntityProvenTx.prototype, 'getMerklePath')
      .mockImplementationOnce(() => { throw new Error('forced proof decode failure') })

    await expect(storage.getBeefForTransactions([invalidTxid], {
      ignoreStorage: false,
      ignoreServices: true
    })).rejects.toThrow('forced proof decode failure')
    decodeFailure.mockRestore()

    const transaction = new Transaction()
    transaction.addOutput({ satoshis: 1, lockingScript: Script.fromASM('OP_TRUE') })
    const txid = transaction.id('hex')
    const path = new MerklePath(900_251, [[{ offset: 0, hash: txid, txid: true }]])
    const proven: TableProvenTx = {
      provenTxId: 30,
      txid,
      height: path.blockHeight,
      index: 0,
      merklePath: path.toBinary(),
      rawTx: transaction.toBinary(),
      blockHash: '2c'.repeat(32),
      merkleRoot: path.computeRoot(txid),
      created_at: now,
      updated_at: now
    }
    jest.spyOn(storage, 'getProvenOrRawTxs').mockResolvedValueOnce(
      new Map([[txid, { proven }]])
    )
    const target = new Beef()
    jest.spyOn(target, 'mergeProvenTxs').mockImplementation(() => {
      throw new Error('forced batch merge failure')
    })

    await expect(storage.getBeefForTransactions([txid], {
      ignoreStorage: false,
      ignoreServices: true,
      mergeToBeef: target
    })).rejects.toThrow('forced batch merge failure')
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'wallet.storage.beef.decode_proven_batch', spanStatus: 'error' }),
      expect.objectContaining({ name: 'wallet.storage.beef.merge_proven_batch', spanStatus: 'error' })
    ]))
  })

  test('preserves merge targets and routes proof-policy options through the single-root lane', async () => {
    const storage = new ProtoStorage('main')
    const roots = ['31'.repeat(32), '32'.repeat(32)]
    const existing = new Beef()
    existing.mergeTxidOnly(roots[0])

    await expect(storage.getBeefForTransactions([], {
      ignoreStorage: false,
      ignoreServices: true,
      mergeToBeef: existing
    })).resolves.toBe(existing)

    const serialized = existing.toBinary()
    const mergedSerialized = await storage.getBeefForTransactions(roots, {
      ignoreStorage: true,
      ignoreServices: true,
      knownTxids: roots,
      mergeToBeef: serialized,
      maxConcurrency: 0
    })
    expect(mergedSerialized).not.toBe(existing)
    expect(roots.every(txid => mergedSerialized.findTxid(txid) != null)).toBe(true)

    const policies: StorageGetBeefOptions[] = [
      { ignoreStorage: false, ignoreServices: true, knownTxids: roots, minProofLevel: 0 },
      {
        ignoreStorage: false,
        ignoreServices: true,
        knownTxids: roots,
        chainTracker: {
          isValidRootForHeight: async () => true,
          currentHeight: async () => 900_000
        },
        maxConcurrency: Number.POSITIVE_INFINITY
      },
      { ignoreStorage: false, ignoreServices: true, knownTxids: roots, skipInvalidProofs: true }
    ]
    for (const options of policies) {
      const beef = await storage.getBeefForTransactions(roots, options)
      expect(roots.every(txid => beef.findTxid(txid)?.isTxidOnly === true)).toBe(true)
    }
  })

  test('promotes broad known-txid lookups and enforces batch recursion depth', async () => {
    const storage = new ProtoStorage('main')
    const roots = Array.from({ length: 5 }, (_, index) => (100 + index).toString(16).padStart(64, '0'))
    const knownTxids = Array.from({ length: 65 }, (_, index) => index.toString(16).padStart(64, '0'))
    knownTxids.push(...roots)

    const known = await storage.getBeefForTransactions(roots, {
      ignoreStorage: false,
      ignoreServices: true,
      knownTxids
    })
    expect(roots.every(txid => known.findTxid(txid)?.isTxidOnly === true)).toBe(true)

    const unresolvedSource = '33'.repeat(32)
    const root = new Transaction()
    root.addInput({
      sourceTXID: unresolvedSource,
      sourceOutputIndex: 0,
      unlockingScript: Script.fromASM('OP_TRUE')
    })
    root.addOutput({ satoshis: 1, lockingScript: Script.fromASM('OP_TRUE') })
    storage.maxRecursionDepth = 1
    jest.spyOn(storage, 'getProvenOrRawTxs').mockImplementation(async txids => new Map(
      txids.map(txid => [txid, txid === root.id('hex') ? { rawTx: root.toBinary() } : {}])
    ))

    await expect(storage.getBeefForTransactions([root.id('hex')], {
      ignoreStorage: false,
      ignoreServices: true
    })).rejects.toThrow('Maximum BEEF depth exceeded')
  })

  test('assembles mixed proven and raw storage records and preserves trustSelf semantics', async () => {
    const storage = new ProtoStorage('main')
    const provenTransaction = new Transaction()
    provenTransaction.addOutput({ satoshis: 2, lockingScript: Script.fromASM('OP_TRUE') })
    const provenTxid = provenTransaction.id('hex')
    const path = new MerklePath(900_300, [[{ offset: 0, hash: provenTxid, txid: true }]])
    const now = new Date()
    const proven: TableProvenTx = {
      provenTxId: 1,
      txid: provenTxid,
      height: path.blockHeight,
      index: 0,
      merklePath: path.toBinary(),
      rawTx: provenTransaction.toBinary(),
      blockHash: '34'.repeat(32),
      merkleRoot: path.computeRoot(provenTxid),
      created_at: now,
      updated_at: now
    }
    const rawTransaction = new Transaction()
    rawTransaction.addOutput({ satoshis: 3, lockingScript: Script.fromASM('OP_TRUE') })
    const rawTxid = rawTransaction.id('hex')
    const inputBEEF = new Beef()
    inputBEEF.mergeTxidOnly('35'.repeat(32))
    const stored = new Map<string, ProvenOrRawTx>([
      [provenTxid, { proven }],
      [rawTxid, { rawTx: rawTransaction.toBinary(), inputBEEF: inputBEEF.toBinary() }]
    ])
    jest.spyOn(storage, 'getProvenOrRawTxs').mockImplementation(async txids => new Map(
      txids.map(txid => [txid, stored.get(txid) ?? {}])
    ))

    const assembled = await storage.getBeefForTransactions([provenTxid, rawTxid], {
      ignoreStorage: false,
      ignoreServices: true
    })
    expect(assembled.findTxid(provenTxid)?.tx).toBeDefined()
    expect(assembled.findTxid(rawTxid)?.tx).toBeDefined()
    expect(assembled.findTxid('35'.repeat(32))?.isTxidOnly).toBe(true)

    const trusted = await storage.getBeefForTransactions([provenTxid, rawTxid], {
      ignoreStorage: false,
      ignoreServices: true,
      trustSelf: 'known'
    })
    expect(trusted.findTxid(provenTxid)?.isTxidOnly).toBe(true)
    expect(trusted.findTxid(rawTxid)?.isTxidOnly).toBe(true)

    await expect(storage.getBeefForTransactions(['36'.repeat(32)], {
      ignoreStorage: false,
      ignoreServices: true
    })).rejects.toThrow('valid transaction on chain main')
  })

  test('falls back to services for missing roots and to sequential proof merging for older SDK peers', async () => {
    const storage = new ProtoStorage('main')
    const serviceTransaction = new Transaction()
    serviceTransaction.addOutput({ satoshis: 4, lockingScript: Script.fromASM('OP_TRUE') })
    const serviceTxid = serviceTransaction.id('hex')
    jest.spyOn(storage, 'getProvenOrRawTxs').mockResolvedValue(new Map())
    storage.getServices().getRawTx = jest.fn(async txid => ({
      txid,
      rawTx: serviceTransaction.toBinary(),
      name: 'mock'
    }))
    storage.getServices().getMerklePath = jest.fn(async () => ({ name: 'mock' }))

    const fromServices = await storage.getBeefForTransactions([serviceTxid], {
      ignoreStorage: false,
      ignoreServices: false,
      ignoreNewProven: true
    })
    expect(fromServices.findTxid(serviceTxid)?.tx).toBeDefined()

    const provenTransaction = new Transaction()
    provenTransaction.addOutput({ satoshis: 5, lockingScript: Script.fromASM('OP_TRUE') })
    const provenTxid = provenTransaction.id('hex')
    const path = new MerklePath(900_400, [[{ offset: 0, hash: provenTxid, txid: true }]])
    const now = new Date()
    const proven: TableProvenTx = {
      provenTxId: 2,
      txid: provenTxid,
      height: path.blockHeight,
      index: 0,
      merklePath: path.toBinary(),
      rawTx: provenTransaction.toBinary(),
      blockHash: '37'.repeat(32),
      merkleRoot: path.computeRoot(provenTxid),
      created_at: now,
      updated_at: now
    }
    jest.spyOn(storage, 'getProvenOrRawTxs').mockResolvedValue(new Map([[provenTxid, { proven }]]))
    const legacyTarget = new Beef()
    Object.defineProperty(legacyTarget, 'mergeProvenTxs', { value: undefined })

    const legacy = await storage.getBeefForTransactions([provenTxid], {
      ignoreStorage: false,
      ignoreServices: true,
      mergeToBeef: legacyTarget
    })
    expect(legacy).toBe(legacyTarget)
    expect(legacy.findTxid(provenTxid)?.tx).toBeDefined()
    expect(legacy.isValid()).toBe(true)
  })

  test('0 ProtoStorage.getBeefForTxid', async () => {
    const ps = new ProtoStorage('main')

    // Build a minimal valid raw transaction (coinbase-style) for mocking
    const buildMockRawTx = (_txid: string): number[] => {
      const tx = new Transaction()
      tx.addInput({
        sourceTransaction: undefined,
        sourceTXID: '00'.repeat(32),
        sourceOutputIndex: 0xffffffff,
        unlockingScript: Script.fromHex('04ffff001d0104'),
        sequence: 0xffffffff
      })
      tx.addOutput({
        satoshis: 5000000000,
        lockingScript: Script.fromHex('51')
      })
      return tx.toBinary()
    }

    // Build a mock merkle path where the txid is at offset 0 with a sibling
    const buildMockMerklePath = (txid: string, blockHeight: number): MerklePath => {
      return new MerklePath(blockHeight, [
        [
          { offset: 0, hash: txid, txid: true },
          { offset: 1, hash: 'ab'.repeat(32) }
        ]
      ])
    }

    const mockHeader: BlockHeader = {
      version: 1,
      previousHash: '00'.repeat(32),
      merkleRoot: '00'.repeat(32),
      time: 1700000000,
      bits: 0x1d00ffff,
      nonce: 0,
      height: 800000,
      hash: 'ff'.repeat(32)
    }

    // Mock services to avoid live WhatsOnChain calls
    const services = ps.getServices()
    services.getRawTx = jest.fn().mockImplementation(async (txid: string): Promise<GetRawTxResult> => {
      return { txid, rawTx: buildMockRawTx(txid), name: 'mock' }
    })
    services.getMerklePath = jest.fn().mockImplementation(async (txid: string): Promise<GetMerklePathResult> => {
      return {
        name: 'mock',
        merklePath: buildMockMerklePath(txid, 800000),
        header: { ...mockHeader, merkleRoot: buildMockMerklePath(txid, 800000).computeRoot() }
      }
    })

    const firstTxid = '794f836052ad73732a550c38bea3697a722c6a1e54bcbe63735ba79e0d23f623'
    const isValidRootForHeight = jest.fn(async () => false)
    ps.gbo.chainTracker = {
      isValidRootForHeight,
      currentHeight: jest.fn(async () => 800000)
    }
    await expect(ps.getBeefForTxid(firstTxid)).rejects.toThrow(/Invalid merkleRoot/)

    isValidRootForHeight.mockResolvedValue(true)
    const beef = await ps.getBeefForTxid(firstTxid)
    expect(beef.bumps.length).toBeGreaterThan(0)
    {
      const beef = await ps.getBeefForTxid('53023657e79f446ca457040a0ab3b903000d7281a091397c7853f021726a560e')
      expect(beef.bumps.length).toBeGreaterThan(0)
    }
  })

  test('resolves a wide ancestor frontier with bounded concurrency and deterministic output', async () => {
    const ps = new ProtoStorage('main')
    ps.maxRecursionDepth = 3
    ps.gbo.maxConcurrency = 4
    ps.gbo.knownTxids = Array.from({ length: 65 }, (_, index) => (10_000 + index).toString(16).padStart(64, '0'))

    const rawByTxid = new Map<string, number[]>()
    const sources: Transaction[] = []
    for (let i = 0; i < 12; i++) {
      const source = new Transaction()
      source.addOutput({ satoshis: 100 + i, lockingScript: Script.fromHex('51') })
      rawByTxid.set(source.id('hex'), source.toBinary())
      sources.push(source)
    }
    const root = new Transaction()
    for (const source of sources) {
      root.addInput({
        sourceTXID: source.id('hex'),
        sourceOutputIndex: 0,
        unlockingScript: new Script(),
        sequence: 0xffffffff
      })
    }
    root.addOutput({ satoshis: 1, lockingScript: Script.fromHex('51') })
    rawByTxid.set(root.id('hex'), root.toBinary())

    const services = ps.getServices()
    let active = 0
    let maxActive = 0
    services.getRawTx = jest.fn().mockImplementation(async (txid: string): Promise<GetRawTxResult> => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, 5))
      active--
      return { txid, rawTx: rawByTxid.get(txid), name: 'mock' }
    })
    services.getMerklePath = jest.fn().mockResolvedValue({ name: 'mock' })

    const first = await ps.getBeefForTxid(root.id('hex'))
    const firstBytes = first.toBinary()
    const second = await ps.getBeefForTxid(root.id('hex'))

    expect(maxActive).toBe(4)
    expect(first.txs).toHaveLength(rawByTxid.size)
    expect(new Set(first.txs.map(tx => tx.txid))).toEqual(new Set(rawByTxid.keys()))
    expect(second.toBinary()).toEqual(firstBytes)

    ps.gbo.maxConcurrency = Number.NaN
    const invalidConcurrency = await ps.getBeefForTxid(root.id('hex'))
    expect(invalidConcurrency.txs).toHaveLength(rawByTxid.size)
  })

  test('1 obtains atomic BEEF hex for an operator-selected live transaction', async () => {
    // This live diagnostic remains in the historical storage harness because it
    // reuses its complete abstract-provider fixture. Normal CI is deterministic;
    // operators opt in explicitly when validating a public mainnet service.
    if (process.env.WALLET_TOOLBOX_LIVE_SERVICES !== 'true') return

    const ps = new ProtoStorage('main')
    const txid = '4cefbe79926d6ef2cc727d8faccac186d9bb141f170411dd75bc6329f428f5a4'
    const beef = await ps.getBeefForTxid(txid)
    expect(beef.bumps.length).toBeGreaterThan(0)
    console.log(beef.toLogString())
    const hex = Utils.toHex(beef.toBinaryAtomic(txid))
    console.log(hex)
  })
})

class ProtoStorage extends StorageProvider {
  gbo: StorageGetBeefOptions
  whatsOnChainApiKey?: string

  constructor(chain: Chain) {
    const o = StorageProvider.createStorageBaseOptions(chain)
    super(o)
    const so = Services.createDefaultOptions(chain)
    // so.whatsOnChainApiKey = 'my_api_key'
    const s = new Services(so)
    this.setServices(s)
    this.gbo = {
      ignoreNewProven: true,
      ignoreServices: false,
      ignoreStorage: true
    }
    this.maxRecursionDepth = 2
  }

  async getBeefForTxid(txid: string): Promise<Beef> {
    const beef = this.getBeefForTransaction(txid, this.gbo)
    return await beef
  }

  nip = new Error('Method not implemented.')
  override reviewStatus(args: { agedLimit: Date; trx?: TrxToken }): Promise<{ log: string }> {
    throw this.nip
  }

  override purgeData(params: PurgeParams, trx?: TrxToken): Promise<PurgeResults> {
    throw this.nip
  }

  override allocateChangeInput(
    userId: number,
    basketId: number,
    targetSatoshis: number,
    exactSatoshis: number | undefined,
    excludeSending: boolean,
    transactionId: number
  ): Promise<TableOutput | undefined> {
    throw this.nip
  }

  override getProvenOrRawTx(txid: string, trx?: TrxToken): Promise<ProvenOrRawTx> {
    throw this.nip
  }

  override getRawTxOfKnownValidTransaction(
    txid?: string,
    offset?: number,
    length?: number,
    trx?: TrxToken
  ): Promise<number[] | undefined> {
    throw this.nip
  }

  override getLabelsForTransactionId(transactionId?: number, trx?: TrxToken): Promise<TableTxLabel[]> {
    throw this.nip
  }

  override getTagsForOutputId(outputId: number, trx?: TrxToken): Promise<TableOutputTag[]> {
    throw this.nip
  }

  override listActions(auth: AuthId, args: Validation.ValidListActionsArgs): Promise<ListActionsResult> {
    throw this.nip
  }

  override listOutputs(auth: AuthId, args: Validation.ValidListOutputsArgs): Promise<ListOutputsResult> {
    throw this.nip
  }

  override countChangeInputs(userId: number, basketId: number, excludeSending: boolean): Promise<number> {
    throw this.nip
  }

  override findCertificatesAuth(auth: AuthId, args: FindCertificatesArgs): Promise<TableCertificateX[]> {
    throw this.nip
  }

  override findOutputBasketsAuth(auth: AuthId, args: FindOutputBasketsArgs): Promise<TableOutputBasket[]> {
    throw this.nip
  }

  override findOutputsAuth(auth: AuthId, args: FindOutputsArgs): Promise<TableOutput[]> {
    throw this.nip
  }

  override insertCertificateAuth(auth: AuthId, certificate: TableCertificateX): Promise<number> {
    throw this.nip
  }

  override dropAllData(): Promise<void> {
    throw this.nip
  }

  override migrate(storageName: string, storageIdentityKey: string): Promise<string> {
    throw this.nip
  }

  override findOutputTagMaps(args: FindOutputTagMapsArgs): Promise<TableOutputTagMap[]> {
    throw this.nip
  }

  override findProvenTxReqs(args: FindProvenTxReqsArgs): Promise<TableProvenTxReq[]> {
    throw this.nip
  }

  override findProvenTxs(args: FindProvenTxsArgs): Promise<TableProvenTx[]> {
    throw this.nip
  }

  override findTxLabelMaps(args: FindTxLabelMapsArgs): Promise<TableTxLabelMap[]> {
    throw this.nip
  }

  override countOutputTagMaps(args: FindOutputTagMapsArgs): Promise<number> {
    throw this.nip
  }

  override countProvenTxReqs(args: FindProvenTxReqsArgs): Promise<number> {
    throw this.nip
  }

  override countProvenTxs(args: FindProvenTxsArgs): Promise<number> {
    throw this.nip
  }

  override countTxLabelMaps(args: FindTxLabelMapsArgs): Promise<number> {
    throw this.nip
  }

  override insertCertificate(certificate: TableCertificate, trx?: TrxToken): Promise<number> {
    throw this.nip
  }

  override insertCertificateField(certificateField: TableCertificateField, trx?: TrxToken): Promise<void> {
    throw this.nip
  }

  override insertCommission(commission: TableCommission, trx?: TrxToken): Promise<number> {
    throw this.nip
  }

  override insertMonitorEvent(event: TableMonitorEvent, trx?: TrxToken): Promise<number> {
    throw this.nip
  }

  override insertOutput(output: TableOutput, trx?: TrxToken): Promise<number> {
    throw this.nip
  }

  override insertOutputBasket(basket: TableOutputBasket, trx?: TrxToken): Promise<number> {
    throw this.nip
  }

  override insertOutputTag(tag: TableOutputTag, trx?: TrxToken): Promise<number> {
    throw this.nip
  }

  override insertOutputTagMap(tagMap: TableOutputTagMap, trx?: TrxToken): Promise<void> {
    throw this.nip
  }

  override insertProvenTx(tx: TableProvenTx, trx?: TrxToken): Promise<number> {
    throw this.nip
  }

  override insertProvenTxReq(tx: TableProvenTxReq, trx?: TrxToken): Promise<number> {
    throw this.nip
  }

  override insertSyncState(syncState: TableSyncState, trx?: TrxToken): Promise<number> {
    throw this.nip
  }

  override insertTransaction(tx: TableTransaction, trx?: TrxToken): Promise<number> {
    throw this.nip
  }

  override insertTxLabel(label: TableTxLabel, trx?: TrxToken): Promise<number> {
    throw this.nip
  }

  override insertTxLabelMap(labelMap: TableTxLabelMap, trx?: TrxToken): Promise<void> {
    throw this.nip
  }

  override insertUser(user: TableUser, trx?: TrxToken): Promise<number> {
    throw this.nip
  }

  override updateCertificate(id: number, update: Partial<TableCertificate>, trx?: TrxToken): Promise<number> {
    throw this.nip
  }

  override updateCertificateField(
    certificateId: number,
    fieldName: string,
    update: Partial<TableCertificateField>,
    trx?: TrxToken
  ): Promise<number> {
    throw this.nip
  }

  override updateCommission(id: number, update: Partial<TableCommission>, trx?: TrxToken): Promise<number> {
    throw this.nip
  }

  override updateMonitorEvent(id: number, update: Partial<TableMonitorEvent>, trx?: TrxToken): Promise<number> {
    throw this.nip
  }

  override updateOutput(id: number, update: Partial<TableOutput>, trx?: TrxToken): Promise<number> {
    throw this.nip
  }

  override updateOutputBasket(id: number, update: Partial<TableOutputBasket>, trx?: TrxToken): Promise<number> {
    throw this.nip
  }

  override updateOutputTag(id: number, update: Partial<TableOutputTag>, trx?: TrxToken): Promise<number> {
    throw this.nip
  }

  override updateOutputTagMap(
    outputId: number,
    tagId: number,
    update: Partial<TableOutputTagMap>,
    trx?: TrxToken
  ): Promise<number> {
    throw this.nip
  }

  override updateProvenTx(id: number, update: Partial<TableProvenTx>, trx?: TrxToken): Promise<number> {
    throw this.nip
  }

  override updateProvenTxReq(
    id: number | number[],
    update: Partial<TableProvenTxReq>,
    trx?: TrxToken
  ): Promise<number> {
    throw this.nip
  }

  override updateSyncState(id: number, update: Partial<TableSyncState>, trx?: TrxToken): Promise<number> {
    throw this.nip
  }

  override updateTransaction(
    id: number | number[],
    update: Partial<TableTransaction>,
    trx?: TrxToken
  ): Promise<number> {
    throw this.nip
  }

  override updateTxLabel(id: number, update: Partial<TableTxLabel>, trx?: TrxToken): Promise<number> {
    throw this.nip
  }

  override updateTxLabelMap(
    transactionId: number,
    txLabelId: number,
    update: Partial<TableTxLabelMap>,
    trx?: TrxToken
  ): Promise<number> {
    throw this.nip
  }

  override updateUser(id: number, update: Partial<TableUser>, trx?: TrxToken): Promise<number> {
    throw this.nip
  }

  override destroy(): Promise<void> {
    throw this.nip
  }

  override transaction<T>(scope: (trx: TrxToken) => Promise<T>, trx?: TrxToken): Promise<T> {
    throw this.nip
  }

  override readSettings(trx?: TrxToken): Promise<TableSettings> {
    throw this.nip
  }

  override findCertificateFields(args: FindCertificateFieldsArgs): Promise<TableCertificateField[]> {
    throw this.nip
  }

  override findCertificates(args: FindCertificatesArgs): Promise<TableCertificateX[]> {
    throw this.nip
  }

  override findCommissions(args: FindCommissionsArgs): Promise<TableCommission[]> {
    throw this.nip
  }

  override findMonitorEvents(args: FindMonitorEventsArgs): Promise<TableMonitorEvent[]> {
    throw this.nip
  }

  override findOutputBaskets(args: FindOutputBasketsArgs): Promise<TableOutputBasket[]> {
    throw this.nip
  }

  override findOutputs(args: FindOutputsArgs): Promise<TableOutput[]> {
    throw this.nip
  }

  override findOutputTags(args: FindOutputTagsArgs): Promise<TableOutputTag[]> {
    throw this.nip
  }

  override findSyncStates(args: FindSyncStatesArgs): Promise<TableSyncState[]> {
    throw this.nip
  }

  override findTransactions(args: FindTransactionsArgs): Promise<TableTransaction[]> {
    throw this.nip
  }

  override findTxLabels(args: FindTxLabelsArgs): Promise<TableTxLabel[]> {
    throw this.nip
  }

  override findUsers(args: FindUsersArgs): Promise<TableUser[]> {
    throw this.nip
  }

  override countCertificateFields(args: FindCertificateFieldsArgs): Promise<number> {
    throw this.nip
  }

  override countCertificates(args: FindCertificatesArgs): Promise<number> {
    throw this.nip
  }

  override countCommissions(args: FindCommissionsArgs): Promise<number> {
    throw this.nip
  }

  override countMonitorEvents(args: FindMonitorEventsArgs): Promise<number> {
    throw this.nip
  }

  override countOutputBaskets(args: FindOutputBasketsArgs): Promise<number> {
    throw this.nip
  }

  override countOutputs(args: FindOutputsArgs): Promise<number> {
    throw this.nip
  }

  override countOutputTags(args: FindOutputTagsArgs): Promise<number> {
    throw this.nip
  }

  override countSyncStates(args: FindSyncStatesArgs): Promise<number> {
    throw this.nip
  }

  override countTransactions(args: FindTransactionsArgs): Promise<number> {
    throw this.nip
  }

  override countTxLabels(args: FindTxLabelsArgs): Promise<number> {
    throw this.nip
  }

  override countUsers(args: FindUsersArgs): Promise<number> {
    throw this.nip
  }

  override getProvenTxsForUser(args: FindForUserSincePagedArgs): Promise<TableProvenTx[]> {
    throw this.nip
  }

  override getProvenTxReqsForUser(args: FindForUserSincePagedArgs): Promise<TableProvenTxReq[]> {
    throw this.nip
  }

  override getTxLabelMapsForUser(args: FindForUserSincePagedArgs): Promise<TableTxLabelMap[]> {
    throw this.nip
  }

  override getOutputTagMapsForUser(args: FindForUserSincePagedArgs): Promise<TableOutputTagMap[]> {
    throw this.nip
  }

  override adminStats(adminIdentityKey: string): Promise<StorageAdminStats> {
    throw this.nip
  }
}
