import { Transaction as BsvTransaction, TransactionInput } from '@bsv/sdk'
import { _tu } from '../utils/TestUtilsWalletStorage'
import { StorageProvider } from '../../src/index.all'
import {
  markUserInputsSpent,
  restoreInputsToSpendable,
  SpentInputTransition
} from '../../src/storage/methods/internalizeAction'

/**
 * Storage-level coverage for the new spent-input bookkeeping inside
 * internalizeAction. The full path requires a real AtomicBEEF + chain
 * tracker validation; these tests target the two extracted helpers
 * directly so the bookkeeping invariants can be verified without fixture
 * weight.
 *
 * Background. createAction marks user UTXOs spent at the moment a tx
 * consumes them (createAction.ts createNewInputs). For externally-built
 * txs brought in via internalizeAction the same bookkeeping was missing
 * — the UTXO stayed spendable=true in the basket and the next
 * createAction would pick it again, producing a stale-UTXO loop.
 *
 * markUserInputsSpent closes that gap; restoreInputsToSpendable rolls
 * back the transition when an internalize call's broadcast fails so the
 * caller can retry.
 */
describe('internalizeAction spent-input bookkeeping', () => {
  jest.setTimeout(15000)
  let storage: StorageProvider

  beforeEach(async () => {
    storage = await _tu.createFreshSQLiteStorage({
      databasePrefix: 'internalizeMarkInputs',
      migrationName: 'internalizeActionMarkInputsSpent'
    })
  })

  afterEach(async () => {
    await storage.destroy()
  })

  function buildTxConsuming (
    outpoints: Array<{ txid: string, vout: number }>
  ): BsvTransaction {
    const tx = new BsvTransaction()
    tx.inputs = outpoints.map(o => ({
      sourceTXID: o.txid,
      sourceOutputIndex: o.vout,
      sequence: 0xffffffff
    })) as unknown as TransactionInput[]
    return tx
  }

  test('marks a spendable user output as spent with spentBy=transactionId', async () => {
    const user = await _tu.insertTestUser(storage)
    const basket = await _tu.insertTestOutputBasket(storage, user)
    const { tx: ownerTx } = await _tu.insertTestTransaction(storage, user)
    const utxo = await _tu.insertTestOutput(storage, ownerTx, 0, 1000, basket, false, {
      spendable: true,
      spentBy: undefined
    })
    const { tx: consumerTx } = await _tu.insertTestTransaction(storage, user, false, {
      txid: 'aa'.repeat(32)
    })

    const bsvTx = buildTxConsuming([{ txid: utxo.txid!, vout: utxo.vout }])
    const transitioned = await markUserInputsSpent(
      storage,
      user.userId,
      bsvTx,
      consumerTx.transactionId
    )

    expect(transitioned).toHaveLength(1)
    expect(transitioned[0].outputId).toBe(utxo.outputId)
    expect(transitioned[0].setSpentBy).toBe(true)

    const refreshed = (await storage.findOutputs({ partial: { outputId: utxo.outputId } }))[0]
    expect(refreshed.spendable).toBe(false)
    expect(refreshed.spentBy).toBe(consumerTx.transactionId)
  })

  test('skips inputs that do not correspond to any user-owned output', async () => {
    const user = await _tu.insertTestUser(storage)
    const { tx: consumerTx } = await _tu.insertTestTransaction(storage, user, false, {
      txid: 'bb'.repeat(32)
    })

    const bsvTx = buildTxConsuming([{ txid: 'cc'.repeat(32), vout: 0 }])
    const transitioned = await markUserInputsSpent(
      storage,
      user.userId,
      bsvTx,
      consumerTx.transactionId
    )
    expect(transitioned).toEqual([])
  })

  test('is idempotent: already-spent outputs are skipped (no overwrite of spentBy)', async () => {
    const user = await _tu.insertTestUser(storage)
    const basket = await _tu.insertTestOutputBasket(storage, user)
    const { tx: ownerTx } = await _tu.insertTestTransaction(storage, user)
    const { tx: firstSpender } = await _tu.insertTestTransaction(storage, user, false, {
      txid: 'dd'.repeat(32)
    })
    const utxo = await _tu.insertTestOutput(storage, ownerTx, 0, 500, basket, false, {
      spendable: false,
      spentBy: firstSpender.transactionId
    })

    const { tx: secondSpender } = await _tu.insertTestTransaction(storage, user, false, {
      txid: 'ee'.repeat(32)
    })
    const bsvTx = buildTxConsuming([{ txid: utxo.txid!, vout: utxo.vout }])
    const transitioned = await markUserInputsSpent(
      storage,
      user.userId,
      bsvTx,
      secondSpender.transactionId
    )

    expect(transitioned).toEqual([])
    const refreshed = (await storage.findOutputs({ partial: { outputId: utxo.outputId } }))[0]
    expect(refreshed.spendable).toBe(false)
    expect(refreshed.spentBy).toBe(firstSpender.transactionId)
  })

  test('marks rows of OTHER users at the same outpoint as spendable=false but leaves spentBy untouched', async () => {
    // An on-chain spend invalidates the UTXO for every wallet that
    // references it. The internalizing user gets spentBy set (their tx
    // record exists); other users get only spendable=false (their
    // transactionId space is independent).
    const userA = await _tu.insertTestUser(storage)
    const userB = await _tu.insertTestUser(storage)
    const sharedTxid = 'ff'.repeat(32)
    const sharedVout = 3

    const basketA = await _tu.insertTestOutputBasket(storage, userA)
    const { tx: ownerTxA } = await _tu.insertTestTransaction(storage, userA)
    const utxoA = await _tu.insertTestOutput(storage, ownerTxA, sharedVout, 700, basketA, false, {
      txid: sharedTxid,
      spendable: true,
      spentBy: undefined
    })

    const basketB = await _tu.insertTestOutputBasket(storage, userB)
    const { tx: ownerTxB } = await _tu.insertTestTransaction(storage, userB)
    const utxoB = await _tu.insertTestOutput(storage, ownerTxB, sharedVout, 700, basketB, false, {
      txid: sharedTxid,
      spendable: true,
      spentBy: undefined
    })

    const { tx: consumerTxA } = await _tu.insertTestTransaction(storage, userA, false, {
      txid: '88'.repeat(32)
    })

    const bsvTx = buildTxConsuming([{ txid: sharedTxid, vout: sharedVout }])
    const transitioned = await markUserInputsSpent(
      storage,
      userA.userId,
      bsvTx,
      consumerTxA.transactionId
    )

    expect(transitioned).toHaveLength(2)
    const tA = transitioned.find(t => t.outputId === utxoA.outputId)!
    const tB = transitioned.find(t => t.outputId === utxoB.outputId)!
    expect(tA.setSpentBy).toBe(true)
    expect(tB.setSpentBy).toBe(false)

    const refreshedA = (await storage.findOutputs({ partial: { outputId: utxoA.outputId } }))[0]
    expect(refreshedA.spendable).toBe(false)
    expect(refreshedA.spentBy).toBe(consumerTxA.transactionId)

    const refreshedB = (await storage.findOutputs({ partial: { outputId: utxoB.outputId } }))[0]
    expect(refreshedB.spendable).toBe(false)
    expect(refreshedB.spentBy).toBeUndefined()
  })

  test('restoreInputsToSpendable reverses the spendable=true → false transition for both same-user and cross-user rows', async () => {
    const userA = await _tu.insertTestUser(storage)
    const userB = await _tu.insertTestUser(storage)
    const sharedTxid = '11'.repeat(32)
    const sharedVout = 5

    const basketA = await _tu.insertTestOutputBasket(storage, userA)
    const { tx: ownerTxA } = await _tu.insertTestTransaction(storage, userA)
    const utxoA = await _tu.insertTestOutput(storage, ownerTxA, sharedVout, 200, basketA, false, {
      txid: sharedTxid,
      spendable: true,
      spentBy: undefined
    })

    const basketB = await _tu.insertTestOutputBasket(storage, userB)
    const { tx: ownerTxB } = await _tu.insertTestTransaction(storage, userB)
    const utxoB = await _tu.insertTestOutput(storage, ownerTxB, sharedVout, 200, basketB, false, {
      txid: sharedTxid,
      spendable: true,
      spentBy: undefined
    })

    const { tx: consumerTxA } = await _tu.insertTestTransaction(storage, userA, false, {
      txid: '22'.repeat(32)
    })

    const bsvTx = buildTxConsuming([{ txid: sharedTxid, vout: sharedVout }])
    const transitioned = await markUserInputsSpent(
      storage,
      userA.userId,
      bsvTx,
      consumerTxA.transactionId
    )
    expect(transitioned).toHaveLength(2)

    await restoreInputsToSpendable(storage, transitioned)

    const refreshedA = (await storage.findOutputs({ partial: { outputId: utxoA.outputId } }))[0]
    expect(refreshedA.spendable).toBe(true)
    expect(refreshedA.spentBy).toBeUndefined()

    const refreshedB = (await storage.findOutputs({ partial: { outputId: utxoB.outputId } }))[0]
    expect(refreshedB.spendable).toBe(true)
    expect(refreshedB.spentBy).toBeUndefined()
  })

  test('restoreInputsToSpendable does not clobber an existing spentBy on cross-user rows', async () => {
    // Setup: userB's row at the outpoint is already marked spent by
    // some unrelated transaction in userB's scope. userA internalizes a
    // tx consuming the same outpoint; markUserInputsSpent should SKIP
    // userB's row (it's already spendable=false with a different
    // spentBy). Restore must not then clear that spentBy.
    const userA = await _tu.insertTestUser(storage)
    const userB = await _tu.insertTestUser(storage)
    const sharedTxid = '33'.repeat(32)
    const sharedVout = 1

    const basketA = await _tu.insertTestOutputBasket(storage, userA)
    const { tx: ownerTxA } = await _tu.insertTestTransaction(storage, userA)
    const utxoA = await _tu.insertTestOutput(storage, ownerTxA, sharedVout, 100, basketA, false, {
      txid: sharedTxid,
      spendable: true,
      spentBy: undefined
    })

    const basketB = await _tu.insertTestOutputBasket(storage, userB)
    const { tx: ownerTxB } = await _tu.insertTestTransaction(storage, userB)
    const { tx: bsExistingSpender } = await _tu.insertTestTransaction(storage, userB, false, {
      txid: '44'.repeat(32)
    })
    const utxoB = await _tu.insertTestOutput(storage, ownerTxB, sharedVout, 100, basketB, false, {
      txid: sharedTxid,
      spendable: false,
      spentBy: bsExistingSpender.transactionId
    })

    const { tx: consumerTxA } = await _tu.insertTestTransaction(storage, userA, false, {
      txid: '55'.repeat(32)
    })

    const bsvTx = buildTxConsuming([{ txid: sharedTxid, vout: sharedVout }])
    const transitioned: SpentInputTransition[] = await markUserInputsSpent(
      storage,
      userA.userId,
      bsvTx,
      consumerTxA.transactionId
    )

    // Only userA's row transitions. userB's row was already spent — skipped.
    expect(transitioned).toHaveLength(1)
    expect(transitioned[0].outputId).toBe(utxoA.outputId)

    await restoreInputsToSpendable(storage, transitioned)

    const refreshedB = (await storage.findOutputs({ partial: { outputId: utxoB.outputId } }))[0]
    expect(refreshedB.spendable).toBe(false)
    expect(refreshedB.spentBy).toBe(bsExistingSpender.transactionId)
  })

  test('restoreInputsToSpendable is a no-op for an empty input list', async () => {
    await expect(restoreInputsToSpendable(storage, [])).resolves.toBeUndefined()
  })

  test('ignores inputs with missing sourceTXID', async () => {
    const user = await _tu.insertTestUser(storage)
    const { tx: consumerTx } = await _tu.insertTestTransaction(storage, user, false, {
      txid: '22'.repeat(32)
    })

    const tx = new BsvTransaction()
    tx.inputs = [
      { sourceTXID: undefined, sourceOutputIndex: 0, sequence: 0xffffffff }
    ] as unknown as TransactionInput[]

    const transitioned = await markUserInputsSpent(
      storage,
      user.userId,
      tx,
      consumerTx.transactionId
    )
    expect(transitioned).toEqual([])
  })
})
