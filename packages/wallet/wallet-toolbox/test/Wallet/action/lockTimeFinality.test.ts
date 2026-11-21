import { Beef, CachedKeyDeriver, PrivateKey, Script, Transaction, Utils } from '@bsv/sdk'
import { Knex, knex as makeKnex } from 'knex'
import { Wallet } from '../../../src/Wallet'
import { MockServices } from '../../../src/mockchain/MockServices'
import { Monitor } from '../../../src/monitor/Monitor'
import { StorageKnex } from '../../../src/storage/StorageKnex'
import { WalletStorageManager } from '../../../src/storage/WalletStorageManager'
import { ScriptTemplateBRC29 } from '../../../src/utility/ScriptTemplateBRC29'
import { randomBytesHex } from '../../../src/utility/utilityHelpers'
import { asArray } from '../../../src/utility/utilityHelpers.noBuffer'

function memoryKnex(): Knex {
  return makeKnex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 }
  })
}

/**
 * A transaction whose nLockTime equals the chain tip height can be mined in the next
 * block, so createAction must commit it rather than refuse it as not final.
 */
describe('createAction with a height lock time', () => {
  jest.setTimeout(120_000)

  let chainDb: Knex
  let walletDb: Knex
  let services: MockServices
  let wallet: Wallet

  beforeAll(async () => {
    chainDb = memoryKnex()
    services = new MockServices(chainDb)
    await services.initialize()
    // Mature coinbases, so the wallet can be funded by a transaction the mock processor accepts.
    for (let i = 0; i < 105; i++) await services.mineBlock()

    const rootKey = PrivateKey.fromHex(randomBytesHex(32))
    const keyDeriver = new CachedKeyDeriver(rootKey)
    walletDb = memoryKnex()
    const provider = new StorageKnex({
      chain: 'mock',
      knex: walletDb,
      commissionSatoshis: 0,
      feeModel: { model: 'sat/kb', value: 1 }
    })
    await provider.migrate('lockTimeFinality', randomBytesHex(33))
    await provider.makeAvailable()
    const storage = new WalletStorageManager(rootKey.toPublicKey().toString(), provider)
    await storage.makeAvailable()
    storage.setServices(services)
    const monitor = new Monitor({
      chain: 'mock',
      storage,
      services,
      chaintracks: services.tracker as any,
      msecsWaitPerMerkleProofServiceReq: 0,
      taskRunWaitMsecs: 5_000,
      abandonedMsecs: 300_000,
      unprovenAttemptsLimitTest: 100,
      unprovenAttemptsLimitMain: 144,
      maxRebroadcastAttempts: 0,
      startupTaskMode: 'default'
    })
    wallet = new Wallet({ chain: 'mock', keyDeriver, storage, services, monitor })
    await fundWallet()
  })

  afterAll(async () => {
    await wallet.destroy()
    await walletDb.destroy()
    await chainDb.destroy()
  })

  async function fundWallet(): Promise<void> {
    const height = await services.getHeight()
    const [utxo] = await services.storage
      .knex('mockchain_utxos')
      .where({ isCoinbase: true, spentByTxid: null })
      .where('blockHeight', '<=', height - 100)
      .orderBy('blockHeight', 'asc')
      .limit(1)
    const sourceRaw = asArray((await services.storage.getTransaction(utxo.txid))!.rawTx)
    const derivationPrefix = Utils.toBase64(Array(16).fill(21))
    const derivationSuffix = Utils.toBase64(Array(16).fill(22))
    const keys = wallet.getClientChangeKeyPair()
    const template = new ScriptTemplateBRC29({ derivationPrefix, derivationSuffix, keyDeriver: wallet.keyDeriver })
    const payment = new Transaction()
    payment.addInput({
      sourceTransaction: Transaction.fromBinary(sourceRaw),
      sourceOutputIndex: 0,
      unlockingScript: new Script(),
      sequence: 0xffffffff
    })
    payment.addOutput({ satoshis: 1_000_000, lockingScript: template.lock(keys.privateKey, keys.publicKey) })

    const submitBeef = new Beef()
    const sourceBump = submitBeef.mergeBump((await services.getMerklePath(utxo.txid)).merklePath!)
    submitBeef.mergeRawTx(sourceRaw, sourceBump)
    submitBeef.mergeRawTx(payment.toUint8Array())
    const paymentTxid = payment.id('hex')
    expect((await services.postBeef(submitBeef, [paymentTxid]))[0].status).toBe('success')

    await services.mineBlock()
    const atomic = new Beef()
    const paymentBump = atomic.mergeBump((await services.getMerklePath(paymentTxid)).merklePath!)
    atomic.mergeRawTx(payment.toUint8Array(), paymentBump)
    await expect(
      wallet.internalizeAction({
        tx: atomic.toBinaryAtomic(paymentTxid),
        outputs: [
          {
            outputIndex: 0,
            protocol: 'wallet payment',
            paymentRemittance: { derivationPrefix, derivationSuffix, senderIdentityKey: wallet.identityKey }
          }
        ],
        description: 'Fund the lock time test wallet'
      })
    ).resolves.toMatchObject({ accepted: true })
  }

  test('a lock time equal to the tip height with a non-final input commits', async () => {
    // An OP_DROP OP_TRUE output, unlocked by OP_0, to spend as an explicit input with a
    // non-final sequence number.
    const parent = await wallet.createAction({
      description: 'parent for a locked spend',
      outputs: [{ satoshis: 1_000, lockingScript: '7551', outputDescription: 'anyone can spend' }],
      options: { randomizeOutputs: false }
    })
    expect(parent.txid).toBeDefined()

    const tip = await services.getHeight()
    const nLockTimeIsFinal = jest.spyOn(services, 'nLockTimeIsFinal')
    const locked = await wallet.createAction({
      description: 'spend locked to the tip height',
      inputBEEF: parent.tx,
      inputs: [
        {
          outpoint: `${parent.txid!}.0`,
          unlockingScript: '00',
          inputDescription: 'anyone can spend',
          sequenceNumber: 0xfffffffe
        }
      ],
      lockTime: tip,
      outputs: [{ satoshis: 500, lockingScript: '51', outputDescription: 'locked output' }],
      options: { randomizeOutputs: false }
    })

    expect(locked.txid).toBeDefined()
    const tx = Beef.fromBinary(locked.tx!).findTxid(locked.txid!)!.tx!
    expect(tx.lockTime).toBe(tip)
    expect(tx.inputs.some(input => input.sequence === 0xfffffffe)).toBe(true)
    // The commit must have asked the services and been told the transaction is final.
    const checked = nLockTimeIsFinal.mock.calls.findIndex(([arg]) => (arg as Transaction).lockTime === tip)
    expect(checked).toBeGreaterThanOrEqual(0)
    await expect(nLockTimeIsFinal.mock.results[checked].value).resolves.toBe(true)
  })
})
