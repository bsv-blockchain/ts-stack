import { Transaction, Script, P2PKH, PrivateKey } from '@bsv/sdk'
import { _tu, setLogging } from '../utils/TestUtilsWalletStorage'
import { sdk, StorageKnex, StorageProvider, verifyOne } from '../../src/index.all'
import {
  markStaleInputsAsSpent,
  updateReqsFromAggregateResults,
  AggregatePostBeefTxResult,
  PostReqsToNetworkResult
} from '../../src/storage/methods/attemptToPostReqsToNetwork'
import { Beef } from '@bsv/sdk'
import { EntityProvenTxReq } from '../../src/storage/schema/entities'

setLogging(false)

/**
 * Regression coverage for the doubleSpend stale-UTXO trap.
 *
 * Background — see CHANGELOG entry "Auto-evict confirmed stale inputs
 * after doubleSpend". Before this fix, `updateTransactionStatus(failed)`
 * unconditionally restored all consumed-input outputs to spendable=true
 * for ANY failure, including confirmed doubleSpends. For genuine
 * doubleSpends (where the inputs ARE spent on chain) this caused the
 * wallet to pick the same stale UTXO on the next createAction —
 * an infinite missing-inputs broadcast loop. App-isolated wallets
 * (e.g. metanet-desktop) make the default basket admin-only so apps
 * cannot self-evict; the wallet itself must do it. `markStaleInputsAsSpent`
 * is the post-broadcast handler that authoritatively verifies each
 * input against on-chain UTXO state and overrides the optimistic
 * restore for confirmed-spent inputs.
 *
 * Test scenarios:
 *   1. Input confirmed-spent on chain (services.isUtxo → false) →
 *      basket entry transitions to spendable=false.
 *   2. Input still unspent on chain (services.isUtxo → true) →
 *      basket entry remains spendable=true (preserves transient-
 *      failure recovery semantics).
 *   3. Service error mid-check → input is left as-is (eviction is
 *      opt-in based on positive evidence, not absence of evidence).
 *   4. Outpoint not in user's basket → silently skipped (don't touch
 *      other users' UTXOs).
 *   5. Mixed-batch tx — multiple consumed inputs, some stale + some
 *      still-UTXO + one not-in-basket: only the truly-stale subset
 *      is evicted.
 *   6. Helper is broadcaster-agnostic — applies the same decision
 *      under invalidTx (WoC/Bitails missing-inputs path) as it does
 *      under doubleSpend (ARC SEEN_IN_ORPHAN_MEMPOOL path).
 */
describe('markStaleInputsAsSpent', () => {
  jest.setTimeout(30000)
  const chain: sdk.Chain = 'test'

  let storages: StorageProvider[]

  beforeEach(async () => {
    storages = []
    const testSlug = (expect.getState().currentTestName || 'markStale').replace(/[^a-zA-Z0-9_]/g, '_')
    const databaseName = `markStale_${testSlug.slice(-40)}`
    const localSQLiteFile = await _tu.newTmpFile(`${databaseName}.sqlite`, false, false, false)
    storages.push(
      new StorageKnex({
        ...StorageKnex.defaultOptions(),
        chain,
        knex: _tu.createLocalSQLite(localSQLiteFile)
      })
    )
    for (const storage of storages) {
      await storage.dropAllData()
      await storage.migrate('markStaleInputsAsSpent', '1'.repeat(64))
      await storage.makeAvailable()
    }
  })

  afterEach(async () => {
    for (const storage of storages) {
      await storage.destroy()
    }
  })

  /**
   * Build a realistic failed-broadcast scenario:
   *   - One funding tx with a P2PKH output the user "owns"
   *   - One failed tx whose ONLY input spends that output
   *   - A ProvenTxReq for the failed tx with rawTx populated
   *   - The output marked spendable=true to simulate the state AFTER
   *     updateTransactionStatus(failed) ran (i.e. the optimistic
   *     restore the helper is meant to override).
   */
  async function seedDoubleSpendScenario (storage: StorageProvider): Promise<{
    userId: number
    failedTxId: number
    consumedOutpoint: { txid: string; vout: number }
    consumedOutputId: number
    failedReq: EntityProvenTxReq
  }> {
    const priv = PrivateKey.fromRandom()
    const lockingScript = new P2PKH().lock(priv.toPublicKey().toAddress())

    // Funding tx — has a single P2PKH output the wallet's basket tracks.
    const fundingTx = new Transaction()
    fundingTx.addOutput({ lockingScript, satoshis: 1000 })
    const fundingTxid = fundingTx.id('hex')

    // Failed tx — single input spending the funding output. We don't
    // need a valid signature for this test; the helper only reads
    // sourceTXID + sourceOutputIndex from inputs.
    const failedTx = new Transaction()
    failedTx.addInput({
      sourceTXID: fundingTxid,
      sourceOutputIndex: 0,
      sequence: 0xffffffff,
      unlockingScript: Script.fromASM('OP_1')
    })
    failedTx.addOutput({ lockingScript, satoshis: 900 })
    const failedTxid = failedTx.id('hex')

    // Storage seed:
    const { tx: fundingRecord, user } = await _tu.insertTestTransaction(storage, undefined, false, {
      status: 'completed',
      txid: fundingTxid
    })
    const { tx: failedRecord } = await _tu.insertTestTransaction(storage, user, false, {
      status: 'failed',
      txid: failedTxid,
      rawTx: failedTx.toBinary()
    })
    const consumedOutput = await _tu.insertTestOutput(storage, fundingRecord, 0, 1000, undefined, false, {
      txid: fundingTxid,
      lockingScript: lockingScript.toBinary(),
      // Simulate the post-updateTransactionStatus(failed) state:
      // the output was just optimistically restored to spendable=true
      // and spentBy was cleared.
      spendable: true,
      spentBy: undefined
    })

    const failedReqApi = await _tu.insertTestProvenTxReq(storage, failedTxid)
    await storage.updateProvenTxReq(failedReqApi.provenTxReqId, {
      rawTx: failedTx.toBinary(),
      notify: JSON.stringify({ transactionIds: [failedRecord.transactionId] })
    })
    const refreshed = verifyOne(
      await storage.findProvenTxReqs({ partial: { provenTxReqId: failedReqApi.provenTxReqId } })
    )
    const failedReq = new EntityProvenTxReq(refreshed)

    return {
      userId: user.userId!,
      failedTxId: failedRecord.transactionId!,
      consumedOutpoint: { txid: fundingTxid, vout: 0 },
      consumedOutputId: consumedOutput.outputId!,
      failedReq
    }
  }

  function makeAggregateResult (failedReq: EntityProvenTxReq): AggregatePostBeefTxResult {
    return {
      txid: failedReq.txid,
      txidResults: [],
      status: 'doubleSpend',
      vreq: { txid: failedReq.txid, req: failedReq, status: 'doubleSpend' } as never,
      successCount: 0,
      doubleSpendCount: 1,
      statusErrorCount: 0,
      serviceErrorCount: 0,
      competingTxs: []
    }
  }

  /** Mock WalletServices that returns a configured isUtxo result. */
  function mockServices (isUtxoFn: (output: any) => boolean | Promise<boolean>): sdk.WalletServices {
    return {
      isUtxo: async (output: any) => isUtxoFn(output)
    } as unknown as sdk.WalletServices
  }

  test('marks input as spendable=false when chain confirms it is spent (regression)', async () => {
    for (const storage of storages) {
      const seed = await seedDoubleSpendScenario(storage)
      const ar = makeAggregateResult(seed.failedReq)

      // Chain says: NOT a UTXO (i.e. spent).
      const services = mockServices(() => false)

      const result = await markStaleInputsAsSpent(ar, storage as StorageKnex, services, undefined)

      expect(result.checked).toBe(1)
      expect(result.staleConfirmed).toBe(1)
      expect(result.staleOutpoints).toEqual([
        `${seed.consumedOutpoint.txid}.${seed.consumedOutpoint.vout}`
      ])

      // Critical: the basket entry MUST now be unspendable so the wallet
      // does not pick it again on the next createAction.
      const after = verifyOne(await storage.findOutputs({ partial: { outputId: seed.consumedOutputId } }))
      expect(after.spendable).toBe(false)
    }
  })

  test('leaves input spendable=true when chain confirms it is still a UTXO (preserves transient retry)', async () => {
    for (const storage of storages) {
      const seed = await seedDoubleSpendScenario(storage)
      const ar = makeAggregateResult(seed.failedReq)

      // Chain says: still a UTXO. Any "doubleSpend" was a false positive
      // (e.g. the competing tx itself failed). Restore semantics apply.
      const services = mockServices(() => true)

      const result = await markStaleInputsAsSpent(ar, storage as StorageKnex, services, undefined)

      expect(result.checked).toBe(1)
      expect(result.staleConfirmed).toBe(0)
      expect(result.staleOutpoints).toEqual([])

      const after = verifyOne(await storage.findOutputs({ partial: { outputId: seed.consumedOutputId } }))
      expect(after.spendable).toBe(true)
    }
  })

  test('leaves input untouched when service errors (eviction requires positive evidence)', async () => {
    for (const storage of storages) {
      const seed = await seedDoubleSpendScenario(storage)
      const ar = makeAggregateResult(seed.failedReq)

      const services = mockServices(() => {
        throw new Error('simulated service outage')
      })

      const result = await markStaleInputsAsSpent(ar, storage as StorageKnex, services, undefined)

      // Helper counts the input as "checked" only on a definitive answer.
      // On exception we skip without incrementing.
      expect(result.staleConfirmed).toBe(0)

      const after = verifyOne(await storage.findOutputs({ partial: { outputId: seed.consumedOutputId } }))
      expect(after.spendable).toBe(true)
    }
  })

  test('mixed-batch: only truly-stale inputs are evicted; still-UTXO and not-in-basket are untouched', async () => {
    for (const storage of storages) {
      // Three funding outputs the wallet "owns":
      //   - staleOutput: chain says NOT a UTXO → must be evicted
      //   - liveOutput:  chain says IS a UTXO → must NOT be evicted
      //   - (a third outpoint NOT in the basket → must be skipped)
      const priv = PrivateKey.fromRandom()
      const lockingScript = new P2PKH().lock(priv.toPublicKey().toAddress())

      const { tx: fundingRecord, user } = await _tu.insertTestTransaction(storage, undefined, false, {
        status: 'completed',
        txid: 'aa'.repeat(32)
      })
      const fundingTxid = fundingRecord.txid!

      const liveFundingTxid = 'bb'.repeat(32)
      const { tx: liveFundingRecord } = await _tu.insertTestTransaction(storage, user, false, {
        status: 'completed',
        txid: liveFundingTxid
      })

      const staleOutput = await _tu.insertTestOutput(storage, fundingRecord, 0, 1000, undefined, false, {
        txid: fundingTxid,
        lockingScript: lockingScript.toBinary(),
        spendable: true,
        spentBy: undefined
      })
      const liveOutput = await _tu.insertTestOutput(storage, liveFundingRecord, 0, 1000, undefined, false, {
        txid: liveFundingTxid,
        lockingScript: lockingScript.toBinary(),
        spendable: true,
        spentBy: undefined
      })

      // Failed tx with THREE inputs: stale, live, and one external.
      const failedTx = new Transaction()
      failedTx.addInput({
        sourceTXID: fundingTxid,
        sourceOutputIndex: 0,
        sequence: 0xffffffff,
        unlockingScript: Script.fromASM('OP_1')
      })
      failedTx.addInput({
        sourceTXID: liveFundingTxid,
        sourceOutputIndex: 0,
        sequence: 0xffffffff,
        unlockingScript: Script.fromASM('OP_1')
      })
      failedTx.addInput({
        sourceTXID: 'ee'.repeat(32), // not in any basket
        sourceOutputIndex: 5,
        sequence: 0xffffffff,
        unlockingScript: Script.fromASM('OP_1')
      })
      failedTx.addOutput({ lockingScript, satoshis: 1500 })
      const failedTxid = failedTx.id('hex')

      const { tx: failedRecord } = await _tu.insertTestTransaction(storage, user, false, {
        status: 'failed',
        txid: failedTxid,
        rawTx: failedTx.toBinary()
      })
      const failedReqApi = await _tu.insertTestProvenTxReq(storage, failedTxid)
      await storage.updateProvenTxReq(failedReqApi.provenTxReqId, {
        rawTx: failedTx.toBinary(),
        notify: JSON.stringify({ transactionIds: [failedRecord.transactionId] })
      })
      const refreshed = verifyOne(
        await storage.findProvenTxReqs({ partial: { provenTxReqId: failedReqApi.provenTxReqId } })
      )
      const failedReq = new EntityProvenTxReq(refreshed)
      const ar = makeAggregateResult(failedReq)

      // services.isUtxo: stale → false, live → true. External outpoint
      // never reaches services because it's not in the user's basket.
      const services = mockServices((output: any) => {
        const txidHex = typeof output.txid === 'string'
          ? output.txid
          : Buffer.from(output.txid).toString('hex')
        if (txidHex === fundingTxid) return false
        if (txidHex === liveFundingTxid) return true
        throw new Error(`unexpected isUtxo lookup for ${txidHex}`)
      })

      const result = await markStaleInputsAsSpent(ar, storage as StorageKnex, services, undefined)

      expect(result.checked).toBe(2) // stale + live; external skipped
      expect(result.staleConfirmed).toBe(1)
      expect(result.staleOutpoints).toEqual([`${fundingTxid}.0`])

      const staleAfter = verifyOne(await storage.findOutputs({ partial: { outputId: staleOutput.outputId } }))
      const liveAfter = verifyOne(await storage.findOutputs({ partial: { outputId: liveOutput.outputId } }))
      expect(staleAfter.spendable).toBe(false)
      expect(liveAfter.spendable).toBe(true)
    }
  })

  test('broadcaster-agnostic: applies the same decision under ar.status==="invalidTx" (WoC/Bitails missing-inputs path)', async () => {
    for (const storage of storages) {
      const seed = await seedDoubleSpendScenario(storage)
      // Aggregate status that some broadcasters return for the same
      // on-chain reality as ARC's doubleSpend. Confirms the helper's
      // decision is based on services.isUtxo, not on aggregate-status
      // classification.
      const ar = makeAggregateResult(seed.failedReq)
      ar.status = 'invalidTx'
      ar.doubleSpendCount = 0

      const services = mockServices(() => false)

      const result = await markStaleInputsAsSpent(ar, storage as StorageKnex, services, undefined)

      expect(result.checked).toBe(1)
      expect(result.staleConfirmed).toBe(1)
      const after = verifyOne(await storage.findOutputs({ partial: { outputId: seed.consumedOutputId } }))
      expect(after.spendable).toBe(false)
    }
  })

  /**
   * Integration test: exercises the wired path through
   * `updateReqsFromAggregateResults`, not just the helper in isolation.
   *
   * Reproduces the FULL post-broadcast handler flow:
   *   1. Insert a "consumed input" output with spendable=false,
   *      spentBy=failedTxId (the state BEFORE updateTransactionStatus
   *      runs).
   *   2. Build an apbrs map with the failing aggregate status.
   *   3. Call updateReqsFromAggregateResults — this triggers
   *      updateTransactionsStatus(failed) which restores the input to
   *      spendable=true, then markStaleInputsAsSpent overrides it back
   *      to spendable=false (the fix).
   *   4. Assert: final basket state is spendable=false (would FAIL on
   *      main without the fix, because updateTransactionStatus's
   *      restore would be the last write).
   *
   * Per Codex review 51331f6e035a7ed0, this is the integration coverage
   * the helper-level tests above did not provide. Two cases — doubleSpend
   * and invalidTx — confirm broadcaster-agnostic wiring.
   */
  describe('integration: updateReqsFromAggregateResults wiring', () => {
    async function seedForIntegration (storage: StorageProvider): Promise<{
      failedReq: EntityProvenTxReq
      failedTxId: number
      consumedOutputId: number
      txids: string[]
    }> {
      const priv = PrivateKey.fromRandom()
      const lockingScript = new P2PKH().lock(priv.toPublicKey().toAddress())
      const fundingTx = new Transaction()
      fundingTx.addOutput({ lockingScript, satoshis: 1000 })
      const fundingTxid = fundingTx.id('hex')

      const failedTx = new Transaction()
      failedTx.addInput({
        sourceTXID: fundingTxid,
        sourceOutputIndex: 0,
        sequence: 0xffffffff,
        unlockingScript: Script.fromASM('OP_1')
      })
      failedTx.addOutput({ lockingScript, satoshis: 900 })
      const failedTxid = failedTx.id('hex')

      const { tx: fundingRecord, user } = await _tu.insertTestTransaction(storage, undefined, false, {
        status: 'completed',
        txid: fundingTxid
      })
      const { tx: failedRecord } = await _tu.insertTestTransaction(storage, user, false, {
        status: 'sending',
        txid: failedTxid,
        rawTx: failedTx.toBinary()
      })
      // The pre-state before updateTransactionStatus(failed) runs:
      // output is marked spent BY the failing tx.
      const consumedOutput = await _tu.insertTestOutput(storage, fundingRecord, 0, 1000, undefined, false, {
        txid: fundingTxid,
        lockingScript: lockingScript.toBinary(),
        spendable: false,
        spentBy: failedRecord.transactionId
      })
      const failedReqApi = await _tu.insertTestProvenTxReq(storage, failedTxid)
      await storage.updateProvenTxReq(failedReqApi.provenTxReqId, {
        rawTx: failedTx.toBinary(),
        notify: JSON.stringify({ transactionIds: [failedRecord.transactionId] }),
        status: 'sending'
      })
      const refreshed = verifyOne(
        await storage.findProvenTxReqs({ partial: { provenTxReqId: failedReqApi.provenTxReqId } })
      )
      const failedReq = new EntityProvenTxReq(refreshed)
      return {
        failedReq,
        failedTxId: failedRecord.transactionId!,
        consumedOutputId: consumedOutput.outputId!,
        txids: [failedTxid]
      }
    }

    function makeApbrs (
      failedReq: EntityProvenTxReq,
      aggStatus: 'doubleSpend' | 'invalidTx'
    ): Record<string, AggregatePostBeefTxResult> {
      return {
        [failedReq.txid]: {
          txid: failedReq.txid,
          txidResults: [],
          status: aggStatus,
          vreq: { txid: failedReq.txid, req: failedReq, status: aggStatus } as never,
          successCount: 0,
          doubleSpendCount: aggStatus === 'doubleSpend' ? 1 : 0,
          statusErrorCount: aggStatus === 'invalidTx' ? 1 : 0,
          serviceErrorCount: 0,
          competingTxs: []
        }
      }
    }

    function makeResult (failedReq: EntityProvenTxReq): PostReqsToNetworkResult {
      return {
        status: 'success',
        beef: new Beef(),
        details: [{ txid: failedReq.txid, req: failedReq, status: 'doubleSpend' } as never],
        log: '',
        pbrTxResultsByTxidByProvider: []
      } as unknown as PostReqsToNetworkResult
    }

    function mockServicesForIntegration (isUtxoFn: () => boolean | Promise<boolean>): sdk.WalletServices {
      return {
        isUtxo: async () => isUtxoFn(),
        // confirmDoubleSpend uses these — return "unknown" so it does
        // NOT flip back to 'success' (that would skip our fix).
        getStatusForTxids: async () => ({
          status: 'success' as const,
          name: 'mock',
          results: [{ txid: 'x'.repeat(64), status: 'unknown' as const }]
        }),
        // gatherCompetingTxids uses these — return empty.
        hashOutputScript: () => 'x'.repeat(64),
        getScriptHashHistory: async () => ({ status: 'success' as const, history: [], name: 'mock', error: undefined as never })
      } as unknown as sdk.WalletServices
    }

    test('doubleSpend aggregate: input becomes spendable=false after full pipeline (regression)', async () => {
      for (const storage of storages) {
        const seed = await seedForIntegration(storage)
        const apbrs = makeApbrs(seed.failedReq, 'doubleSpend')
        const r = makeResult(seed.failedReq)
        const services = mockServicesForIntegration(() => false)

        await updateReqsFromAggregateResults(seed.txids, r, apbrs, storage as StorageKnex, services, undefined)

        const after = verifyOne(await storage.findOutputs({ partial: { outputId: seed.consumedOutputId } }))
        expect(after.spendable).toBe(false)
      }
    })

    test('invalidTx aggregate: input becomes spendable=false after full pipeline (covers WoC/Bitails missing-inputs path)', async () => {
      for (const storage of storages) {
        const seed = await seedForIntegration(storage)
        const apbrs = makeApbrs(seed.failedReq, 'invalidTx')
        const r = makeResult(seed.failedReq)
        const services = mockServicesForIntegration(() => false)

        await updateReqsFromAggregateResults(seed.txids, r, apbrs, storage as StorageKnex, services, undefined)

        const after = verifyOne(await storage.findOutputs({ partial: { outputId: seed.consumedOutputId } }))
        expect(after.spendable).toBe(false)
      }
    })

    test('failed broadcast where chain says input is still UTXO: input restored to spendable=true (transient retry semantics preserved)', async () => {
      for (const storage of storages) {
        const seed = await seedForIntegration(storage)
        const apbrs = makeApbrs(seed.failedReq, 'invalidTx')
        const r = makeResult(seed.failedReq)
        // Chain says: still a UTXO. e.g. malformed/fee failure where the
        // referenced inputs are intact. Existing transient-retry must apply.
        const services = mockServicesForIntegration(() => true)

        await updateReqsFromAggregateResults(seed.txids, r, apbrs, storage as StorageKnex, services, undefined)

        const after = verifyOne(await storage.findOutputs({ partial: { outputId: seed.consumedOutputId } }))
        expect(after.spendable).toBe(true)
      }
    })
  })

  test('skips inputs not in the user\'s basket (does not touch other users\' UTXOs)', async () => {
    for (const storage of storages) {
      const seed = await seedDoubleSpendScenario(storage)

      // Replace the failed tx's rawTx with one that references a
      // DIFFERENT (unknown to the wallet) outpoint. The basket should
      // not be touched at all.
      const otherTx = new Transaction()
      otherTx.addInput({
        sourceTXID: 'cd'.repeat(32),
        sourceOutputIndex: 7,
        sequence: 0xffffffff,
        unlockingScript: Script.fromASM('OP_1')
      })
      otherTx.addOutput({ lockingScript: new Script(), satoshis: 1 })
      seed.failedReq.api.rawTx = otherTx.toBinary()

      const ar = makeAggregateResult(seed.failedReq)
      let isUtxoCalled = false
      const services = mockServices(() => {
        isUtxoCalled = true
        return false
      })

      const result = await markStaleInputsAsSpent(ar, storage as StorageKnex, services, undefined)

      expect(result.checked).toBe(0)
      expect(result.staleConfirmed).toBe(0)
      expect(isUtxoCalled).toBe(false)

      // Original consumed output untouched.
      const after = verifyOne(await storage.findOutputs({ partial: { outputId: seed.consumedOutputId } }))
      expect(after.spendable).toBe(true)
    }
  })
})
