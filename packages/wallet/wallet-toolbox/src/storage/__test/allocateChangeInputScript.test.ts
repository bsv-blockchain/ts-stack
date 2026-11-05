import { TableOutput, TableOutputBasket } from '../schema/tables'
import { _tu, TestWalletNoSetup, TestWalletProviderNoSetup } from '../../../test/utils/TestUtilsWalletStorage'
import 'fake-indexeddb/auto'
import { managedChangeOutputFields } from '../methods/managedChange'
import { restoreOutputScript } from '../methods/restoreOutputScript'

/**
 * Change candidates are scanned with `noScript: true`, which clears every
 * locking script. `validateOutputScript` reloads only a script offloaded into
 * a raw transaction storage still holds, so a script kept on the row stayed
 * cleared and the signer received a funding input with no locking script.
 * Rows restored or synced without outpoint metadata are the common case.
 */
describe('funding outputs keep their locking script', () => {
  jest.setTimeout(60_000)
  type Ctx = TestWalletNoSetup | TestWalletProviderNoSetup
  const ctxs: Ctx[] = []

  beforeAll(async () => {
    ctxs.push(await _tu.createLegacyWalletSQLiteCopy('allocateChangeInputScript'))
    ctxs.push(await _tu.createIdbLegacyWalletCopy('allocateChangeInputScriptIdb'))
  })
  afterAll(async () => {
    for (const ctx of ctxs) await ctx.storage.destroy()
  })

  const p2pkhScript = [0x76, 0xa9, 0x14, ...Array.from({ length: 20 }, () => 0x22), 0x88, 0xac]

  /** Row shapes `validateOutputScript` cannot fill, each with the script kept on the row. */
  const shapes: Array<[string, Partial<TableOutput>]> = [
    ['inline', { txid: 'allocateChangeInputScriptTxid', scriptLength: p2pkhScript.length, scriptOffset: 0 }],
    ['restored without outpoint metadata', { txid: undefined, scriptLength: undefined, scriptOffset: undefined }],
    [
      'offloaded with no stored raw transaction',
      { txid: 'ab'.repeat(32), scriptLength: p2pkhScript.length, scriptOffset: 1 }
    ]
  ]

  async function inlineChange(
    ctx: Ctx,
    name: string,
    satoshis: number,
    vout: number,
    shape: Partial<TableOutput> = shapes[0][1]
  ): Promise<{ basketId: number; transactionId: number; outputId: number }> {
    const storage = ctx.activeStorage
    const basket: TableOutputBasket = {
      created_at: new Date(),
      updated_at: new Date(),
      basketId: 0,
      userId: ctx.userId,
      name,
      numberOfDesiredUTXOs: 0,
      minimumDesiredUTXOValue: 0,
      isDeleted: false
    }
    const basketId = await storage.insertOutputBasket(basket)
    const tx = (await storage.findTransactions({ partial: { userId: ctx.userId, status: 'completed' } }))[0]
    const outputId = await storage.insertOutput({
      outputId: 0,
      created_at: new Date(),
      updated_at: new Date(),
      userId: ctx.userId,
      transactionId: tx.transactionId,
      basketId,
      spendable: true,
      satoshis,
      outputDescription: 'inline script change',
      vout,
      txid: 'allocateChangeInputScriptTxid',
      derivationPrefix: 'AAAAAAAAAAA=',
      derivationSuffix: 'AAAAAAAAAAA=',
      lockingScript: p2pkhScript,
      ...managedChangeOutputFields,
      ...shape
    } as TableOutput)
    return { basketId, transactionId: tx.transactionId, outputId }
  }

  test.each(shapes.map(([label, shape], i) => [label, shape, i] as const))(
    'allocateChangeInput returns the chosen %s output with its script',
    async (_label, shape, i) => {
      for (const [backend, ctx] of ctxs.entries()) {
        const value = 616161 + i
        const { basketId, transactionId, outputId } = await inlineChange(
          ctx,
          `script-allocate-${i}-${backend}`,
          value,
          950 + i,
          shape
        )
        const picked = await ctx.activeStorage.allocateChangeInput(
          ctx.userId,
          basketId,
          value,
          value,
          false,
          transactionId
        )
        expect(picked?.outputId).toBe(outputId)
        expect(Array.from(picked?.lockingScript ?? [])).toEqual(p2pkhScript)
      }
    }
  )

  test('restoreOutputScript still rebuilds a script offloaded into a stored raw transaction', async () => {
    for (const ctx of ctxs) {
      const outputs = await ctx.activeStorage.findOutputs({ partial: { userId: ctx.userId }, noScript: true })
      let checked = 0
      for (const scanned of outputs) {
        if (scanned.scriptOffset == null || scanned.scriptOffset === 0 || scanned.txid == null) continue
        const raw = await ctx.activeStorage.getRawTxOfKnownValidTransaction(scanned.txid)
        if (raw == null) continue
        const expected = raw.slice(scanned.scriptOffset, scanned.scriptOffset + (scanned.scriptLength ?? 0))
        await restoreOutputScript(ctx.activeStorage, scanned)
        expect(Array.from(scanned.lockingScript ?? [])).toEqual(Array.from(expected))
        if (++checked === 3) break
      }
      expect(checked).toBeGreaterThan(0)
    }
  })

  test('restoreOutputScript rereads an inline script cleared by a noScript scan', async () => {
    for (const [backend, ctx] of ctxs.entries()) {
      const { basketId } = await inlineChange(ctx, `inline-restore-${backend}`, 717171, 970)
      const [scanned] = await ctx.activeStorage.findOutputs({
        partial: { userId: ctx.userId, basketId },
        noScript: true
      })
      expect(scanned.lockingScript).toBeUndefined()
      await ctx.activeStorage.validateOutputScript(scanned)
      expect(scanned.lockingScript).toBeUndefined()
      await restoreOutputScript(ctx.activeStorage, scanned)
      expect(Array.from(scanned.lockingScript ?? [])).toEqual(p2pkhScript)
    }
  })
})
