import { Beef, Transaction, Validation, WalletAction } from '@bsv/sdk'
import { _tu, TestWalletNoSetup } from '../../utils/TestUtilsWalletStorage'
import { asString } from '../../../src/utility/utilityHelpers.noBuffer'
import { applyBrc153ReferenceLabel } from '../../../src/utility/brc153ReferenceLabels'
import { parseTxScriptOffsets } from '../../../src/utility/parseTxScriptOffsets'

/**
 * listActions and listOutputs load each association for the whole page at
 * once. These tests pin the per-page query counts and check the batched
 * results against the per-row storage lookups they replaced.
 */
describe('list query counts', () => {
  jest.setTimeout(99999999)

  let ctx: TestWalletNoSetup

  beforeAll(async () => {
    ctx = await _tu.createLegacyWalletSQLiteCopy('listQueryCounts')
    // Label and tag some records with an older label or tag after a newer one,
    // as createAction does for labels ['new', 'existing']. They must keep that
    // order rather than label or tag id order.
    const knex = ctx.activeStorage.knex
    for (const [table, key, idColumn] of [
      ['tx_labels_map', 'transactionId', 'txLabelId'],
      ['output_tags_map', 'outputId', 'outputTagId']
    ]) {
      const maps = await knex(table).where(key, '<=', 40).orderBy([key, idColumn])
      let reordered = 0
      for (const id of new Set(maps.map(m => m[key]))) {
        const rows = maps.filter(m => m[key] === id)
        if (rows.length < 2) continue
        await knex(table).where(key, id).delete()
        await knex(table).insert(rows.reverse())
        reordered++
      }
      expect(reordered).toBeGreaterThan(0)
    }
  })

  afterAll(async () => {
    await ctx.storage.destroy()
  })

  async function countQueries<T>(run: () => Promise<T>): Promise<{ result: T; queries: number }> {
    let queries = 0
    const onQuery = (): void => {
      queries++
    }
    ctx.activeStorage.knex.on('query', onQuery)
    try {
      return { result: await run(), queries }
    } finally {
      ctx.activeStorage.knex.off('query', onQuery)
    }
  }

  const listActionsArgs = (limit: number) =>
    Validation.validateListActionsArgs({
      labels: [],
      limit,
      includeLabels: true,
      includeOutputs: true,
      includeOutputLockingScripts: true,
      includeInputs: true,
      includeInputSourceLockingScripts: true,
      includeInputUnlockingScripts: true
    })

  test('0 listActions with every include uses a fixed number of queries per page', async () => {
    const auth = { identityKey: ctx.identityKey, userId: ctx.userId }
    const small = await countQueries(async () => await ctx.activeStorage.listActions(auth, listActionsArgs(10)))
    const large = await countQueries(async () => await ctx.activeStorage.listActions(auth, listActionsArgs(200)))
    expect(small.result.actions).toHaveLength(10)
    expect(large.result.actions.length).toBeGreaterThan(100)
    // One query each for the page, the total, outputs, baskets, inputs and the
    // spending transactions, and two each for labels and tags (map rows, then
    // names). Previously 80 and 1866. The larger page also reads a few long
    // locking scripts out of their raw transactions, one output at a time as before.
    expect(small.queries).toBeLessThanOrEqual(10)
    expect(large.queries).toBeLessThanOrEqual(18)
  })

  test('1 listActions includes match the per-row storage lookups', async () => {
    const storage = ctx.activeStorage
    const r = await storage.listActions({ identityKey: ctx.identityKey, userId: ctx.userId }, listActionsArgs(10000))
    // Actions are in transactionId order; txids alone are not unique in this fixture.
    const txs = (
      await storage.findTransactions({
        partial: { userId: ctx.userId },
        status: ['completed', 'unprocessed', 'sending', 'unproven', 'unsigned', 'nosend', 'nonfinal'],
        noRawTx: true
      })
    ).sort((a, b) => a.transactionId - b.transactionId)
    expect(r.actions.map(a => a.txid)).toEqual(txs.map(tx => tx.txid))
    let outputs = 0
    let inputs = 0
    for (const [i, action] of r.actions.entries()) {
      const tx = txs[i]
      const expected: Partial<WalletAction> = { outputs: [], inputs: [] }
      const labels = (await storage.getLabelsForTransactionId(tx.transactionId)).map(l => l.label)
      expect(action.labels).toEqual(tx.reference ? applyBrc153ReferenceLabel(labels, tx.reference) : labels)
      for (const o of await storage.findOutputs({ partial: { transactionId: tx.transactionId } })) {
        await storage.extendOutput(o, true, true)
        expected.outputs!.push({
          satoshis: o.satoshis,
          spendable: o.spendable,
          tags: (o as any).tags.map((t: { tag: string }) => t.tag),
          outputIndex: o.vout,
          outputDescription: o.outputDescription || '',
          basket: (o as any).basket?.name || '',
          lockingScript: asString(o.lockingScript || [])
        })
      }
      const sources = await storage.findOutputs({ partial: { spentBy: tx.transactionId } })
      const rawTx = sources.length > 0 ? await storage.getRawTxOfKnownValidTransaction(tx.txid) : undefined
      const bsvTx = rawTx != null ? Transaction.fromBinary(rawTx) : undefined
      for (const o of sources) {
        const input = bsvTx?.inputs.find(v => v.sourceTXID === o.txid && v.sourceOutputIndex === o.vout)
        expected.inputs!.push({
          sourceOutpoint: `${o.txid}.${o.vout}`,
          sourceSatoshis: o.satoshis,
          inputDescription: o.outputDescription || '',
          sequenceNumber: input?.sequence || 0,
          sourceLockingScript: asString(o.lockingScript || []),
          unlockingScript: input?.unlockingScript?.toHex()
        })
      }
      expect(action.outputs).toEqual(expected.outputs)
      expect(action.inputs).toEqual(expected.inputs)
      outputs += action.outputs!.length
      inputs += action.inputs!.length
    }
    expect(outputs).toBeGreaterThan(100)
    expect(inputs).toBeGreaterThan(50)
  })

  test('2 listOutputs entire transactions loads the outputs transactions in one query', async () => {
    const storage = ctx.activeStorage
    const auth = { identityKey: ctx.identityKey, userId: ctx.userId }
    const vargs = Validation.validateListOutputsArgs({
      basket: 'default',
      include: 'entire transactions',
      limit: 1000
    })
    const { result, queries } = await countQueries(async () => await storage.listOutputs(auth, vargs))
    expect(result.outputs.length).toBeGreaterThan(20)
    // Previously one proven_txs query per output (34 for this basket).
    expect(queries).toBeLessThanOrEqual(6)

    const beef = Beef.fromBinary(result.BEEF!)
    const expected = new Beef()
    for (const o of result.outputs) {
      const txid = o.outpoint.split('.')[0]
      if (expected.findTxid(txid) == null) await storage.getValidBeefForKnownTxid(txid, expected)
    }
    expect(beef.toHex()).toBe(expected.toHex())
  })
  test('3 listActions reads locking scripts kept only in the raw transaction', async () => {
    // Long scripts are stored only as an offset into the transaction's raw bytes.
    const storage = ctx.activeStorage
    const knex = storage.knex
    const candidates = await knex('outputs as o')
      .join('proven_txs as p', 'p.txid', 'o.txid')
      .where('o.userId', ctx.userId)
      .whereNotNull('o.spentBy')
      .select('o.outputId', 'o.transactionId', 'o.spentBy', 'o.vout', 'p.rawTx')
    expect(candidates.length).toBeGreaterThan(0)
    const output = candidates[0]
    const offsets = parseTxScriptOffsets(Array.from(output.rawTx as Uint8Array)).outputs[output.vout]
    const script = asString(Array.from((output.rawTx as Uint8Array).slice(offsets.offset, offsets.offset + offsets.length)))
    await knex('outputs')
      .where('outputId', output.outputId)
      .update({ lockingScript: null, scriptOffset: offsets.offset, scriptLength: offsets.length })

    const r = await storage.listActions({ identityKey: ctx.identityKey, userId: ctx.userId }, listActionsArgs(10000))
    const txs = await knex('transactions')
      .whereIn('transactionId', [output.transactionId, output.spentBy])
      .select('transactionId', 'txid')
    const txidOf = (id: number): string => txs.find(t => t.transactionId === id).txid
    const created = r.actions.find(a => a.txid === txidOf(output.transactionId))!
    expect(created.outputs!.find(o => o.outputIndex === output.vout)!.lockingScript).toBe(script)
    const spending = r.actions.find(a => a.txid === txidOf(output.spentBy))!
    const outpoint = `${txidOf(output.transactionId)}.${output.vout}`
    expect(spending.inputs!.find(i => i.sourceOutpoint === outpoint)!.sourceLockingScript).toBe(script)
  })
})
