import { LockingScript, Script, Transaction } from '@bsv/sdk'
import { _tu, setLogging } from '../utils/TestUtilsWalletStorage'
import { StorageProvider, WalletStorageManager } from '../../src/index.all'
import { TaskArcadeSSE } from '../../src/monitor/tasks/TaskArcSSE'
import { TaskReconcilePendingTransactions } from '../../src/monitor/tasks/TaskReconcilePendingTransactions'
import type { TableOutput, TableTransaction, TableUser } from '../../src/storage/schema/tables'

setLogging(false)

/**
 * The jam seen on a phone wallet (bsv-browser, Arcade broadcaster):
 *
 * - M, a move, is mined. Its change M:1 (3,253) is unspent on chain.
 * - R, a retry, spends a head H:0 that M already spent, plus M:1. Arcade
 *   answers RECEIVED (202), so the wallet records R as unproven, then rejects
 *   it: REJECTED 466, "UTXO_SPENT (70): ... H:0 utxo already spent by tx M".
 * - C, a later action, is funded by M:0, F:0 (8,404) and R's change R:1.
 *   Arcade rejects it too: "parent rejected".
 *
 * The chain holds M:1 + F:0 = 11,657 of this wallet's change. The wallet,
 * holding R and C as unproven, shows C's change, 6,654.
 */

class FakeEventSource {
  static instances: FakeEventSource[] = []
  private readonly listeners: Record<string, Array<(e: any) => void>> = {}

  constructor(
    public url: string,
    public opts: any
  ) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, fn: (e: any) => void): void {
    ;(this.listeners[type] ??= []).push(fn)
  }

  emit(type: string, event: any = {}): void {
    for (const fn of this.listeners[type] ?? []) fn(event)
  }

  close(): void {}
}

function p2pkh(): LockingScript {
  return LockingScript.fromHex('76a914' + '00'.repeat(20) + '88ac')
}

function makeTx(inputs: Array<{ txid: string; vout: number }>, outputs: number[]): Transaction {
  const tx = new Transaction()
  for (const input of inputs) {
    tx.addInput({
      sourceTXID: input.txid,
      sourceOutputIndex: input.vout,
      unlockingScript: new Script(),
      sequence: 0xffffffff
    })
  }
  for (const satoshis of outputs) tx.addOutput({ satoshis, lockingScript: p2pkh() })
  return tx
}

interface Jam {
  storage: StorageProvider
  manager: WalletStorageManager
  user: TableUser
  txids: { M: string; F: string; R: string; C: string; H: string }
  rows: { R: TableTransaction; C: TableTransaction }
  outputs: Record<'M0' | 'M1' | 'F0' | 'R0' | 'R1' | 'C0' | 'C1', TableOutput>
}

async function seedJam(reqCreatedAt: Date): Promise<Jam> {
  const storage = await _tu.createFreshSQLiteStorage({
    databasePrefix: 'rejectedAfterReceived',
    migrationName: 'rejectedAfterReceived'
  })
  const user = await _tu.insertTestUser(storage)
  const basket = await _tu.insertTestOutputBasket(storage, user, { name: 'default' })

  const H = 'aa'.repeat(32) // the stale head, spent on chain by M; never this wallet's
  const txM = makeTx([{ txid: H, vout: 0 }], [1, 3253])
  const txF = makeTx([{ txid: 'bb'.repeat(32), vout: 0 }], [8404])
  const M = txM.id('hex')
  const F = txF.id('hex')
  const txR = makeTx(
    [
      { txid: H, vout: 0 },
      { txid: M, vout: 1 }
    ],
    [1, 759]
  )
  const R = txR.id('hex')
  const txC = makeTx(
    [
      { txid: M, vout: 0 },
      { txid: F, vout: 0 },
      { txid: R, vout: 1 }
    ],
    [1, 6654]
  )
  const C = txC.id('hex')

  const insertTx = async (
    txid: string,
    tx: Transaction,
    status: TableTransaction['status']
  ): Promise<TableTransaction> =>
    (await _tu.insertTestTransaction(storage, user, false, { txid, status, rawTx: tx.toBinary(), satoshis: 0 })).tx
  const rowM = await insertTx(M, txM, 'unproven')
  const rowF = await insertTx(F, txF, 'unproven')
  const rowR = await insertTx(R, txR, 'unproven')
  const rowC = await insertTx(C, txC, 'unproven')

  const insertOutput = async (
    row: TableTransaction,
    vout: number,
    satoshis: number,
    change: boolean,
    spentBy?: TableTransaction
  ): Promise<TableOutput> =>
    await _tu.insertTestOutput(storage, row, vout, satoshis, change ? basket : undefined, false, {
      txid: row.txid,
      change,
      type: 'P2PKH',
      spendable: spentBy == null,
      spentBy: spentBy?.transactionId
    })
  const outputs = {
    M0: await insertOutput(rowM, 0, 1, false, rowC),
    M1: await insertOutput(rowM, 1, 3253, true, rowR),
    F0: await insertOutput(rowF, 0, 8404, true, rowC),
    R0: await insertOutput(rowR, 0, 1, false),
    R1: await insertOutput(rowR, 1, 759, true, rowC),
    C0: await insertOutput(rowC, 0, 1, false),
    C1: await insertOutput(rowC, 1, 6654, true)
  }

  // Arcade's RECEIVED 202 was aggregated as success: both requests unmined.
  for (const [txid, tx, row] of [
    [R, txR, rowR],
    [C, txC, rowC]
  ] as const) {
    await storage.insertProvenTxReq({
      created_at: reqCreatedAt,
      updated_at: reqCreatedAt,
      provenTxReqId: 0,
      txid,
      status: 'unmined',
      attempts: 0,
      notified: false,
      history: '{}',
      notify: JSON.stringify({ transactionIds: [row.transactionId] }),
      rawTx: tx.toBinary()
    })
  }

  const manager = new WalletStorageManager(user.identityKey, storage)
  await manager.makeAvailable()
  return { storage, manager, user, txids: { M, F, R, C, H }, rows: { R: rowR, C: rowC }, outputs }
}

async function changeBalance(jam: Jam): Promise<number> {
  const outputs = await jam.storage.findOutputs({ partial: { userId: jam.user.userId, change: true, spendable: true } })
  return outputs.reduce((sum, o) => sum + o.satoshis, 0)
}

async function output(jam: Jam, o: TableOutput): Promise<TableOutput> {
  return (await jam.storage.findOutputs({ partial: { outputId: o.outputId } }))[0]
}

async function txStatus(jam: Jam, row: TableTransaction): Promise<string> {
  return (await jam.storage.findTransactions({ partial: { transactionId: row.transactionId }, noRawTx: true }))[0]
    .status
}

async function reqStatus(jam: Jam, txid: string): Promise<string> {
  return (await jam.storage.findProvenTxReqs({ partial: { txid } }))[0].status
}

function utxoSpent(jam: Jam): string {
  return (
    `UTXO_SPENT (70): [ProcessTransaction][${jam.txids.R}] UTXO_SPENT: ` +
    `${jam.txids.H}:0 utxo already spent by tx ${jam.txids.M}[0]`
  )
}

async function expectChainState(jam: Jam): Promise<void> {
  // The rejected retry and the action funded from its change are both failed.
  expect(await txStatus(jam, jam.rows.R)).toBe('failed')
  expect(await reqStatus(jam, jam.txids.R)).toBe('doubleSpend')
  expect(await txStatus(jam, jam.rows.C)).toBe('failed')
  expect(await reqStatus(jam, jam.txids.C)).toBe('invalid')

  // Their inputs that are still unspent on chain return to the wallet.
  expect(await output(jam, jam.outputs.M1)).toMatchObject({ spendable: true, spentBy: undefined })
  expect(await output(jam, jam.outputs.M0)).toMatchObject({ spendable: true, spentBy: undefined })
  expect(await output(jam, jam.outputs.F0)).toMatchObject({ spendable: true, spentBy: undefined })

  // Outputs of dead transactions are never offered.
  for (const dead of [jam.outputs.R0, jam.outputs.R1, jam.outputs.C0, jam.outputs.C1]) {
    expect((await output(jam, dead)).spendable).toBe(false)
  }

  // The balance reads the chain: M:1 + F:0.
  expect(await changeBalance(jam)).toBe(3253 + 8404)
}

describe('a REJECTED answer after RECEIVED', () => {
  jest.setTimeout(60_000)

  let jam: Jam | undefined

  afterEach(async () => {
    await jam?.storage.destroy()
    jam = undefined
  })

  test('the seeded store is the jam: 6,654 shown', async () => {
    jam = await seedJam(new Date())
    expect(await changeBalance(jam)).toBe(6654)
  })

  test("Arcade's REJECTED event fails the action, releases its inputs, and fails every action funded from its change", async () => {
    jam = await seedJam(new Date())
    FakeEventSource.instances = []
    const monitor: any = {
      options: { callbackToken: 'token', EventSourceClass: FakeEventSource },
      services: { options: { arcadeUrl: 'https://arcade.example' } },
      storage: jam.manager,
      logEvent: jest.fn(async () => {}),
      callOnTransactionStatusChanged: jest.fn()
    }
    const task = new TaskArcadeSSE(monitor)
    await task.asyncSetup()

    FakeEventSource.instances[0].emit('status', {
      data: JSON.stringify({
        txid: jam.txids.R,
        txStatus: 'REJECTED',
        timestamp: '2026-10-14T17:44:39Z',
        status: 466,
        extraInfo: utxoSpent(jam)
      })
    })
    await task.runTask()

    await expectChainState(jam)
    expect(monitor.callOnTransactionStatusChanged).toHaveBeenCalledWith(jam.txids.C, 'REJECTED')
  })

  test("the reconcile poll's terminal verdict does the same when the event was missed", async () => {
    jam = await seedJam(new Date(Date.now() - 2 * 60 * 60 * 1000))
    const { R, C } = jam.txids
    const monitor: any = {
      storage: jam.manager,
      services: {
        getStatusForTxids: jest.fn(async () => ({
          name: 'Arcade',
          status: 'success',
          results: [
            {
              txid: R,
              status: 'unknown',
              depth: undefined,
              providerStatus: 'REJECTED',
              terminal: true,
              inputConflict: true,
              statusCode: 466,
              description: utxoSpent(jam),
              competingTxs: []
            },
            { txid: C, status: 'unknown', depth: undefined, providerStatus: 'REJECTED' }
          ]
        }))
      },
      callOnTransactionStatusChanged: jest.fn()
    }
    const task = new TaskReconcilePendingTransactions(monitor, 0, 100, 60, 1)

    await task.runTask()

    await expectChainState(jam)
  })

  test('a rejection that names no input of the action still quarantines every local input', async () => {
    jam = await seedJam(new Date())
    FakeEventSource.instances = []
    const monitor: any = {
      options: { callbackToken: 'token', EventSourceClass: FakeEventSource },
      services: { options: { arcadeUrl: 'https://arcade.example' } },
      storage: jam.manager,
      logEvent: jest.fn(async () => {}),
      callOnTransactionStatusChanged: jest.fn()
    }
    const task = new TaskArcadeSSE(monitor)
    await task.asyncSetup()

    FakeEventSource.instances[0].emit('status', {
      data: JSON.stringify({ txid: jam.txids.R, txStatus: 'DOUBLE_SPEND_ATTEMPTED', timestamp: '' })
    })
    await task.runTask()

    expect(await reqStatus(jam, jam.txids.R)).toBe('doubleSpend')
    expect((await output(jam, jam.outputs.M1)).spendable).toBe(false)
  })
})
