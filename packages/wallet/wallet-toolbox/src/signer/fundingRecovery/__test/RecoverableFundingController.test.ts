import { Beef, LockingScript, MerklePath, P2PKH, Transaction, Utils, outputPacketDigest } from '@bsv/sdk'
import { _tu, type TestWalletNoSetup } from '../../../../test/utils/TestUtilsWalletStorage'
import { SQLiteFundingRecoveryStore } from '../../../storage/fundingRecovery/SQLiteFundingRecoveryStore'
import { RecoverableFundingController } from '../RecoverableFundingController'
import { fundingFixture } from '../../../storage/fundingRecovery/__tests__/fundingFixture'
import { blockHash, genesisHeader, serializeBaseBlockHeader } from '../../../services/chaintracker/chaintracks/util/blockHeaderUtilities'
import { EntityProvenTxReq } from '../../../storage/schema/entities/EntityProvenTxReq'
import { internalizeAction as internalizeStorage } from '../../../storage/methods/internalizeAction'
import type { FundingRecoveryCommit } from '../../../storage/fundingRecovery/FundingRecoveryProtocol'
import { TaskSendWaiting } from '../../../monitor/tasks/TaskSendWaiting'

describe('durable local acquisition funding', () => {
  let context: TestWalletNoSetup
  beforeEach(async () => { context = await _tu.createLegacyWalletSQLiteCopy(expect.getState().currentTestName!, 'legacy') })
  afterEach(async () => { jest.restoreAllMocks(); await context?.wallet.destroy() })
  async function setup() {
    const fixture = fundingFixture(context)
    jest.spyOn(context.services, 'getChainTracker').mockResolvedValue(fixture.tracker)
    const store = await SQLiteFundingRecoveryStore.install(context.activeStorage, fixture.chain)
    const controller = new RecoverableFundingController(context.wallet, store)
    return { ...fixture, store, controller }
  }

  test('credits once, retains exact receipt and queues broadcast atomically without network submission', async () => {
    const { operation, controller, chain, store } = await setup()
    const input = operation()
    const broadcast = jest.spyOn(context.services, 'postBeef')
    expect(await controller.getInternalization(input.id)).toEqual({ state: 'absent' })
    const simultaneous = await store.retain(context.userId, context.identityKey, input)
    const accepted = await controller.internalizeOnce(input)
    expect(accepted).toMatchObject({ state: 'accepted', funding: input.funding, receipt: { operationId: input.id, satoshis: '100', walletIdentity: context.identityKey, storageIdentity: context.activeStorage.getSettings().storageIdentityKey } })
    const transactions = await context.activeStorage.findTransactions({ partial: { userId: context.userId, txid: input.funding.txid } })
    expect(transactions).toHaveLength(1)
    expect(transactions[0]).toMatchObject({ satoshis: 100, status: 'unprocessed' })
    const outputs = await context.activeStorage.findOutputs({ partial: { userId: context.userId, txid: input.funding.txid } })
    expect(outputs).toHaveLength(1)
    expect(outputs[0]).toMatchObject({ vout: 1, satoshis: 100, change: true, senderIdentityKey: input.buyer })
    const reqs = await context.activeStorage.findProvenTxReqs({ partial: { txid: input.funding.txid } })
    expect(reqs).toHaveLength(1)
    expect(reqs[0].status).toBe('unsent')
    expect(JSON.parse(reqs[0].notify!).transactionIds).toContain(transactions[0].transactionId)
    expect(broadcast).not.toHaveBeenCalled()
    const duplicateEffect = jest.fn()
    expect(await simultaneous.commit(duplicateEffect)).toEqual({ accepted: true, isMerge: true, txid: input.funding.txid, satoshis: 0 })
    expect(duplicateEffect).not.toHaveBeenCalled()
    await expect(simultaneous.reject()).rejects.toThrow('Accepted or absent funding cannot be rejected')
    const reopened = new RecoverableFundingController(context.wallet, await SQLiteFundingRecoveryStore.open(context.activeStorage, chain))
    expect(await reopened.getInternalization(input.id)).toEqual(accepted)
    expect(await reopened.internalizeOnce(input)).toEqual(accepted)
    expect((await context.activeStorage.findTransactions({ partial: { userId: context.userId, txid: input.funding.txid } }))[0].satoshis).toBe(100)
  })

  test('requires the matching active provider and committed workspace before retaining intent', async () => {
    const { operation, controller, store } = await setup(), input = operation()
    const otherStore = Object.create(store) as SQLiteFundingRecoveryStore
    Object.defineProperty(otherStore, 'storage', { value: Object.create(context.activeStorage) })
    await expect(new RecoverableFundingController(context.wallet, otherStore).internalizeOnce(input)).rejects.toThrow('not the active wallet provider')
    jest.spyOn(context.wallet.actionBatch, 'hasWorkspace', 'get').mockReturnValueOnce(true)
    await expect(controller.internalizeOnce(input)).rejects.toThrow('committed wallet workspace')
    const different = { ...input, funding: { ...input.funding, chain: { ...input.funding.chain, genesisHash: '00'.repeat(32) } } }
    different.id = outputPacketDigest('wallet-funding', { seller: different.seller, acquisitionId: different.acquisitionId, funding: different.funding })
    await expect(controller.internalizeOnce(different)).rejects.toThrow('seller or selected chain differs')
    expect(await controller.getInternalization(input.id)).toEqual({ state: 'absent' })
  })

  test('receipt verification rolls back a mismatched ownership write', async () => {
    const { operation, controller } = await setup(), input = operation()
    const insert = context.activeStorage.insertOutput.bind(context.activeStorage)
    jest.spyOn(context.activeStorage, 'insertOutput').mockImplementationOnce(async (row, trx) => await insert({ ...row, change: false }, trx))
    await expect(controller.internalizeOnce(input)).rejects.toThrow('ownership does not match retained intent')
    expect(await controller.getInternalization(input.id)).toEqual({ state: 'unknown' })
    expect(await context.activeStorage.findOutputs({ partial: { txid: input.funding.txid } })).toHaveLength(0)
    expect(await context.activeStorage.findTransactions({ partial: { txid: input.funding.txid } })).toHaveLength(0)
    expect(await controller.internalizeOnce(input)).toMatchObject({ state: 'accepted' })
  })

  test('keeps intent unknown on verification failure and repairs it with the same operation', async () => {
    const { operation, controller, tracker } = await setup()
    const input = operation()
    jest.mocked(context.services.getChainTracker).mockResolvedValueOnce({ currentHeight: async () => 1400, isValidRootForHeight: async () => false })
    await expect(controller.internalizeOnce(input)).rejects.toThrow('Invalid merkle path')
    expect(await controller.getInternalization(input.id)).toEqual({ state: 'unknown' })
    expect(await context.activeStorage.findOutputs({ partial: { txid: input.funding.txid } })).toHaveLength(0)
    jest.mocked(context.services.getChainTracker).mockResolvedValue(tracker)
    expect(await controller.internalizeOnce(input)).toMatchObject({ state: 'accepted' })
  })

  test('rolls back ownership, transaction and broadcast request together when the final write fails', async () => {
    const { operation, controller } = await setup()
    const input = operation()
    jest.spyOn(context.activeStorage, 'getProvenOrReq').mockRejectedValueOnce(new Error('interrupt before receipt'))
    await expect(controller.internalizeOnce(input)).rejects.toThrow('interrupt before receipt')
    expect(await controller.getInternalization(input.id)).toEqual({ state: 'unknown' })
    expect(await context.activeStorage.findTransactions({ partial: { txid: input.funding.txid } })).toHaveLength(0)
    expect(await context.activeStorage.findOutputs({ partial: { txid: input.funding.txid } })).toHaveLength(0)
    expect(await context.activeStorage.findProvenTxReqs({ partial: { txid: input.funding.txid } })).toHaveLength(0)
    expect(await controller.internalizeOnce(input)).toMatchObject({ state: 'accepted' })
  })

  test('reconciles a lost response using only the committed receipt and never recredits', async () => {
    const { operation, controller, store, chain } = await setup()
    const input = operation()
    const get = store.getInternalization.bind(store)
    let reads = 0
    jest.spyOn(store, 'getInternalization').mockImplementation(async (...args) => {
      const result = await get(...args)
      if (++reads === 2) throw new Error('lost post-commit reply')
      return result
    })
    await expect(controller.internalizeOnce(input)).rejects.toThrow('lost post-commit reply')
    const reopened = new RecoverableFundingController(context.wallet, await SQLiteFundingRecoveryStore.open(context.activeStorage, chain))
    const recovered = await reopened.getInternalization(input.id)
    expect(recovered).toMatchObject({ state: 'accepted' })
    const insert = jest.spyOn(context.activeStorage, 'insertOutput')
    expect(await reopened.internalizeOnce(input)).toEqual(recovered)
    expect(insert).not.toHaveBeenCalled()
  })

  test('freezes economic fields and globally fences a funding output across acquisitions', async () => {
    const { operation, controller, store } = await setup()
    const input = operation()
    await store.retain(context.userId, context.identityKey, input)
    await expect(controller.internalizeOnce({ ...input, derivationSuffix: 'different' })).rejects.toThrow('conflicts with retained intent')
    const other = { ...input, acquisitionId: 'b2'.repeat(32) }
    other.id = outputPacketDigest('wallet-funding', { seller: other.seller, acquisitionId: other.acquisitionId, funding: other.funding })
    await expect(controller.internalizeOnce(other)).rejects.toThrow('already assigned')
    expect(await controller.getInternalization(input.id)).toEqual({ state: 'unknown' })
    expect(await controller.getInternalization(other.id)).toEqual({ state: 'absent' })
  })

  test('rejects a wrong script or duplicate matching output durably without wallet effects', async () => {
    const { operation, controller, tx } = await setup()
    tx.outputs.push({ ...tx.outputs[1], satoshis: 1 })
    tx.outputs[0].satoshis = 899
    const duplicate = operation(tx)
    expect(await controller.internalizeOnce(duplicate)).toEqual({ state: 'rejected', reason: 'payment-script-mismatch' })
    expect(await controller.getInternalization(duplicate.id)).toEqual({ state: 'rejected', reason: 'payment-script-mismatch' })
    expect(await controller.internalizeOnce(duplicate)).toEqual({ state: 'rejected', reason: 'payment-script-mismatch' })
    tx.outputs.pop()
    tx.outputs[1].lockingScript = LockingScript.fromHex('51')
    const wrong = operation(tx)
    expect(await controller.internalizeOnce(wrong)).toEqual({ state: 'rejected', reason: 'payment-script-mismatch' })
    expect(await context.activeStorage.findOutputs({ partial: { txid: wrong.funding.txid } })).toHaveLength(0)
  })

  test('accepts alternate valid BEEF encodings as one funding identity and snapshots caller bytes', async () => {
    const { operation, controller } = await setup()
    const input = operation(), original = structuredClone(input)
    const pending = controller.internalizeOnce(input)
    input.derivationSuffix = 'mutated'
    const accepted = await pending
    const beef = Beef.fromBinaryStrict(Utils.toArray(original.beef, 'base64'))
    beef.version = 0xefbe0001
    const variant = { ...original, beef: Utils.toBase64(beef.toBinaryAtomic(original.funding.txid)) }
    expect(variant.beef).not.toBe(original.beef)
    expect(await controller.internalizeOnce(variant)).toEqual(accepted)
  })

  test('refreshes an existing transaction under the write guard and credits only newly owned outputs', async () => {
    const { operation, controller, tx } = await setup()
    const first = operation(), suffix = 'c2Vjb25k'
    const key = context.keyDeriver.derivePrivateKey([2, '3241645161d8'], `${first.derivationPrefix} ${suffix}`, first.buyer)
    tx.outputs[0].satoshis = 800
    tx.outputs.push({ satoshis: 100, lockingScript: new P2PKH().lock(key.toAddress()) })
    const input = operation(tx)
    const second = { ...input, acquisitionId: 'b2'.repeat(32), derivationSuffix: suffix, funding: { ...input.funding, outputIndex: 2 } }
    second.id = outputPacketDigest('wallet-funding', { seller: second.seller, acquisitionId: second.acquisitionId, funding: second.funding })
    const a = await controller.internalizeOnce(input), b = await controller.internalizeOnce(second)
    expect(a).toMatchObject({ state: 'accepted' })
    expect(b).toMatchObject({ state: 'accepted' })
    const transactions = await context.activeStorage.findTransactions({ partial: { userId: context.userId, txid: input.funding.txid } })
    expect(transactions).toHaveLength(1)
    expect(transactions[0].satoshis).toBe(200)
    const outputs = await context.activeStorage.findOutputs({ partial: { userId: context.userId, txid: input.funding.txid } })
    expect(outputs.map(output => output.vout).sort()).toEqual([1, 2])
    expect(await controller.internalizeOnce(input)).toEqual(a)
    expect(await controller.internalizeOnce(second)).toEqual(b)
  })

  test('validates a mined header outside the write transaction and commits its proof with ownership', async () => {
    const { operation, controller, tx } = await setup()
    tx.merklePath = new MerklePath(1500, [[{ offset: 0, hash: tx.id('hex'), txid: true }]])
    const input = operation(tx), base = genesisHeader(context.chain)
    jest.mocked(context.services.getChainTracker).mockResolvedValue({ currentHeight: async () => 2000, isValidRootForHeight: async (root, height) => root === tx.id('hex') && height === 1500 })
    const header = jest.spyOn(context.services, 'getHeaderForHeight').mockResolvedValue(serializeBaseBlockHeader(base))
    await expect(controller.internalizeOnce(input)).rejects.toThrow('header does not match inclusion proof')
    expect(await controller.getInternalization(input.id)).toEqual({ state: 'unknown' })
    expect(await context.activeStorage.findOutputs({ partial: { txid: input.funding.txid } })).toHaveLength(0)
    header.mockResolvedValue(serializeBaseBlockHeader({ ...base, merkleRoot: tx.id('hex') }))
    expect(await controller.internalizeOnce(input)).toMatchObject({ state: 'accepted' })
    const transactions = await context.activeStorage.findTransactions({ partial: { userId: context.userId, txid: input.funding.txid } })
    expect(transactions[0]).toMatchObject({ status: 'completed', satoshis: 100, provenTxId: expect.any(Number) })
    expect(await context.activeStorage.findProvenTxs({ partial: { txid: input.funding.txid } })).toHaveLength(1)
    expect(await context.activeStorage.findProvenTxReqs({ partial: { txid: input.funding.txid } })).toHaveLength(0)
  })

  test.each([false, true])('reconciles an actual wallet noSend output, already internalized = %s', async alreadyInternalized => {
    const { operation, controller, tx } = await setup(), template = operation()
    // Existing public legacy-wallet fixture proofs are trusted only in this test.
    // The actual wallet still constructs/signs and the verifier executes Script.
    jest.mocked(context.services.getChainTracker).mockResolvedValue({ currentHeight: async () => 1000000, isValidRootForHeight: async () => true })
    const created = await context.wallet.createAction({
      description: 'Local funding recovery noSend fixture',
      outputs: [{ lockingScript: tx.outputs[1].lockingScript.toHex(), satoshis: 100, basket: 'funding staging', outputDescription: 'Public fixture payment' }],
      options: { noSend: true, randomizeOutputs: false, returnTXIDOnly: false }
    })
    const target = Transaction.fromAtomicBEEF(created.tx!)
    const input = { ...template, beef: Utils.toBase64(created.tx!), funding: { ...template.funding, txid: target.id('hex'), outputIndex: 0 } }
    input.id = outputPacketDigest('wallet-funding', { seller: input.seller, acquisitionId: input.acquisitionId, funding: input.funding })
    if (alreadyInternalized) await context.wallet.internalizeAction({ tx: created.tx!, outputs: [{ outputIndex: 0, protocol: 'wallet payment', paymentRemittance: { derivationPrefix: input.derivationPrefix, derivationSuffix: input.derivationSuffix, senderIdentityKey: input.buyer } }], description: 'Legacy internalized fixture' })
    const before = (await context.activeStorage.findTransactions({ partial: { userId: context.userId, txid: input.funding.txid } }))[0]
    const result = await controller.internalizeOnce(input)
    expect(result).toMatchObject({ state: 'accepted' })
    const after = (await context.activeStorage.findTransactions({ partial: { userId: context.userId, txid: input.funding.txid } }))[0]
    expect(after.satoshis).toBe(before.satoshis + (alreadyInternalized ? 0 : 100))
    expect(after.status).toBe(alreadyInternalized ? 'unproven' : 'unprocessed')
    const requests = await context.activeStorage.findProvenTxReqs({ partial: { txid: input.funding.txid } })
    expect(requests[0].status).toBe(alreadyInternalized ? 'unmined' : 'unsent')
    expect(await controller.internalizeOnce(input)).toEqual(result)
  })

  test('rejects unsupported hooks before verification and refuses failed, overflowing or inconsistent wallet state', async () => {
    const { operation, controller, store } = await setup(), input = operation()
    const hook = await store.retain(context.userId, context.identityKey, input)
    await expect(internalizeStorage(context.activeStorage, { userId: context.userId }, { tx: [], outputs: [], description: 'Invalid local hook fixture' }, { ...hook, protocol: 'future' } as unknown as FundingRecoveryCommit)).rejects.toThrow('Unsupported funding recovery protocol')
    const now = new Date()
    const transactionId = await context.activeStorage.insertTransaction({ created_at: now, updated_at: now, transactionId: 0, userId: context.userId, status: 'failed', reference: 'Zml4dHVyZQ==', isOutgoing: false, satoshis: 0, description: 'Inconsistent public fixture', txid: input.funding.txid })
    await expect(controller.internalizeOnce(input)).rejects.toThrow('invalid status failed')
    await context.activeStorage.updateTransaction(transactionId, { status: 'unproven', satoshis: Number.MAX_SAFE_INTEGER })
    await expect(controller.internalizeOnce(input)).rejects.toThrow('balance is not a safe integer')
    await context.activeStorage.updateTransaction(transactionId, { status: 'completed', satoshis: 0 })
    await expect(controller.internalizeOnce(input)).rejects.toThrow('completed state lacks a retained proof')
    expect(await controller.getInternalization(input.id)).toEqual({ state: 'unknown' })
    expect(await context.activeStorage.findOutputs({ partial: { txid: input.funding.txid } })).toHaveLength(0)
  })

  test('reconciles an existing broadcast request when verified inclusion arrives before wallet credit', async () => {
    const { operation, controller, tx } = await setup()
    tx.merklePath = new MerklePath(1500, [[{ offset: 0, hash: tx.id('hex'), txid: true }]])
    const input = operation(tx), base = genesisHeader(context.chain)
    jest.mocked(context.services.getChainTracker).mockResolvedValue({ currentHeight: async () => 2000, isValidRootForHeight: async (root, height) => root === tx.id('hex') && height === 1500 })
    jest.spyOn(context.services, 'getHeaderForHeight').mockResolvedValue(serializeBaseBlockHeader({ ...base, merkleRoot: tx.id('hex') }))
    const request = EntityProvenTxReq.fromTxid(input.funding.txid, tx.toBinary(), Utils.toArray(input.beef, 'base64'))
    request.status = 'unsent'
    await context.activeStorage.insertProvenTxReq(request.toApi())
    expect(await controller.internalizeOnce(input)).toMatchObject({ state: 'accepted' })
    const req = (await context.activeStorage.findProvenTxReqs({ partial: { txid: input.funding.txid } }))[0]
    const row = (await context.activeStorage.findTransactions({ partial: { txid: input.funding.txid, userId: context.userId } }))[0]
    expect(req).toMatchObject({ status: 'completed', provenTxId: row.provenTxId })
    expect(req.history).toContain('fundingRecovery-proof')
  })

  test('uses a retained inclusion proof when the repeated payment envelope omits that proof', async () => {
    const { operation, controller, tx } = await setup(), input = operation()
    const now = new Date(), bump = new MerklePath(1500, [[{ offset: 0, hash: input.funding.txid, txid: true }]])
    const header = serializeBaseBlockHeader({ ...genesisHeader(context.chain), merkleRoot: input.funding.txid })
    const { proven } = await context.activeStorage.findOrInsertProvenTx({
      created_at: now, updated_at: now, provenTxId: 0, txid: input.funding.txid, height: 1500, index: 0,
      merklePath: bump.toBinary(), rawTx: tx.toBinary(), blockHash: blockHash(header), merkleRoot: input.funding.txid
    })
    expect(await controller.internalizeOnce(input)).toMatchObject({ state: 'accepted' })
    expect(await context.activeStorage.findTransactions({ partial: { userId: context.userId, txid: input.funding.txid } })).toMatchObject([
      { status: 'completed', satoshis: 100, provenTxId: proven.provenTxId }
    ])
    expect(await context.activeStorage.findProvenTxReqs({ partial: { txid: input.funding.txid } })).toHaveLength(0)
  })

  test.each(['invalid', 'doubleSpend', 'unfail', 'completed'] as const)('refuses an inconsistent existing %s broadcast request atomically', async status => {
    const { operation, controller, tx } = await setup(), input = operation()
    const request = EntityProvenTxReq.fromTxid(input.funding.txid, tx.toBinary(), Utils.toArray(input.beef, 'base64'))
    request.status = status
    await context.activeStorage.insertProvenTxReq(request.toApi())
    await expect(controller.internalizeOnce(input)).rejects.toThrow(status === 'completed' ? 'completed state lacks a retained proof' : 'broadcast record cannot be accepted')
    expect(await controller.getInternalization(input.id)).toEqual({ state: 'unknown' })
    expect(await context.activeStorage.findTransactions({ partial: { txid: input.funding.txid } })).toHaveLength(0)
    expect(await context.activeStorage.findOutputs({ partial: { txid: input.funding.txid } })).toHaveLength(0)
    expect((await context.activeStorage.findProvenTxReqs({ partial: { txid: input.funding.txid } }))[0].status).toBe(status)
  })

  test('replays both terminal states from durable evidence without re-verification or key derivation', async () => {
    const { operation, controller, tx } = await setup(), paid = operation()
    const accepted = await controller.internalizeOnce(paid)
    tx.outputs[1].lockingScript = LockingScript.fromHex('51')
    const unpaid = operation(tx), rejected = await controller.internalizeOnce(unpaid)
    expect(rejected).toEqual({ state: 'rejected', reason: 'payment-script-mismatch' })
    jest.spyOn(context.keyDeriver, 'derivePrivateKey').mockImplementation(() => { throw new Error('No signing capability during replay') })
    jest.mocked(context.services.getChainTracker).mockRejectedValue(new Error('Offline during replay'))
    expect(await controller.internalizeOnce(paid)).toEqual(accepted)
    expect(await controller.internalizeOnce(unpaid)).toEqual(rejected)
  })

  test('refuses a selected output that is not the sole matching BRC-29 output', async () => {
    const { operation, controller, tx } = await setup()
    ;[tx.outputs[0].lockingScript, tx.outputs[1].lockingScript] = [tx.outputs[1].lockingScript, tx.outputs[0].lockingScript]
    const input = operation(tx)
    expect(await controller.internalizeOnce(input)).toEqual({ state: 'rejected', reason: 'payment-script-mismatch' })
    expect(await context.activeStorage.findOutputs({ partial: { txid: input.funding.txid } })).toHaveLength(0)
  })

  test('keeps an intent recoverable when verification rejects or wallet authorization changes', async () => {
    const { operation, controller } = await setup(), input = operation()
    const verify = jest.spyOn(Transaction.prototype, 'verify').mockResolvedValueOnce(false)
    await expect(controller.internalizeOnce(input)).rejects.toThrow('did not pass Script and SPV verification')
    verify.mockRestore()
    const getAuth = context.wallet.storage.getAuth.bind(context.wallet.storage), calls: boolean[] = []
    let reads = 0
    const auth = jest.spyOn(context.wallet.storage, 'getAuth').mockImplementation(async required => {
      calls.push(required)
      const value = await getAuth(required)
      return ++reads === 2 ? { ...value, userId: value.userId! + 1 } : value
    })
    await expect(controller.internalizeOnce(input)).rejects.toThrow('wallet authorization changed')
    expect(calls).toEqual([true, true])
    auth.mockRestore()
    expect(await controller.getInternalization(input.id)).toEqual({ state: 'unknown' })
    expect(await context.activeStorage.findOutputs({ partial: { txid: input.funding.txid } })).toHaveLength(0)
    expect(await controller.internalizeOnce(input)).toMatchObject({ state: 'accepted' })
  })

  test('requires committed ownership before returning success even if the local receipt reader loses that state', async () => {
    const { operation, controller, store } = await setup(), input = operation()
    const read = store.getInternalization.bind(store)
    let reads = 0
    jest.spyOn(store, 'getInternalization').mockImplementation(async (...args) => ++reads === 2 ? { state: 'unknown' } : await read(...args))
    await expect(controller.internalizeOnce(input)).rejects.toThrow('ownership has not committed')
    expect(await controller.getInternalization(input.id)).toMatchObject({ state: 'accepted' })
    expect((await context.activeStorage.findTransactions({ partial: { txid: input.funding.txid } }))[0].satoshis).toBe(100)
  })

  test('hands retained broadcast work to the ordinary monitor without recrediting the acquisition', async () => {
    const { operation, controller } = await setup(), input = operation()
    const accepted = await controller.internalizeOnce(input)
    const posted: string[][] = []
    const post = jest.spyOn(context.services, 'postBeef').mockImplementation(async (beef, txids) => {
      expect(beef.findTxid(input.funding.txid)?.tx?.id('hex')).toBe(input.funding.txid)
      posted.push([...txids])
      return [{ name: 'local synthetic processor', status: 'success', txidResults: txids.map(txid => ({ txid, status: 'success' })) }]
    })
    expect(context.monitor).toBeDefined()
    const task = new TaskSendWaiting(context.monitor!)
    const req = (await context.activeStorage.findProvenTxReqs({ partial: { txid: input.funding.txid } }))[0]
    await task.processUnsent([req])
    expect(posted).toEqual([[input.funding.txid]])
    expect((await context.activeStorage.findProvenTxReqs({ partial: { txid: input.funding.txid } }))[0].status).toBe('unmined')
    expect((await context.activeStorage.findTransactions({ partial: { userId: context.userId, txid: input.funding.txid } }))[0]).toMatchObject({ status: 'unproven', satoshis: 100 })
    expect(await controller.getInternalization(input.id)).toEqual(accepted)
    expect(await controller.internalizeOnce(input)).toEqual(accepted)
    expect(post).toHaveBeenCalledTimes(1)
  })
})
