import { _tu, expectToThrowWERR, TestWalletNoSetup } from '../../utils/TestUtilsWalletStorage'
import * as bsv from '@bsv/sdk'

describe('getKnownTxids Tests', () => {
  jest.setTimeout(99999999)

  const env = _tu.getEnv('test')
  const ctxs: TestWalletNoSetup[] = []

  beforeAll(async () => {
    if (env.runMySQL) {
      ctxs.push(await _tu.createLegacyWalletMySQLCopy('getKnownTxidsTests'))
    }
    ctxs.push(await _tu.createLegacyWalletSQLiteCopy('getKnownTxidsTests'))
  })

  afterAll(async () => {
    for (const ctx of ctxs) {
      await ctx.storage.destroy()
    }
  })

  /*********************************************************************************************************
   * TODOTONE: Duplicates not being handled correctly.
   **********************************************************************************************************/
  test('0 should return an empty array when no txids are provided', async () => {
    for (const { wallet } of ctxs) {
      const result = wallet.getKnownTxids()
      expect(result).toEqual([])
    }
  })

  // Duplicate txids are not being handled correctly
  test('1 should add new known txids', async () => {
    for (const { wallet } of ctxs) {
      const txids = ['txid1']
      const resultBefore = wallet.getKnownTxids()
      expect(resultBefore).toEqual([])

      wallet.getKnownTxids(txids)
      const resultAfter = wallet.getKnownTxids()
      expect(resultAfter).toEqual(txids)
    }
  })

  // Duplicate txids are not being handled correctly
  test('2 should avoid duplicating txids', async () => {
    for (const { wallet } of ctxs) {
      const txids = ['txid1', 'txid2']
      wallet.getKnownTxids(txids)

      const resultBefore = wallet.getKnownTxids()
      expect(resultBefore).toEqual(txids)

      wallet.getKnownTxids(['txid2']) // Add duplicate txid
      const resultAfter = wallet.getKnownTxids()
      expect(resultAfter).toEqual(txids) // Ensure no duplicates are added
    }
  })

  // Duplicate txids are not being handled correctly
  test('3 should return sorted txids', async () => {
    for (const { wallet } of ctxs) {
      const unsortedTxids = ['txid3', 'txid1', 'txid2']
      wallet.getKnownTxids(unsortedTxids)

      const result = wallet.getKnownTxids()
      expect(result).toEqual(['txid1', 'txid2', 'txid3']) // Ensure txids are sorted
    }
  })

  test('4 should handle invalid txids gracefully', async () => {
    for (const { wallet } of ctxs) {
      const invalidTxids = ['invalid_txid']
      const validTxids = ['txid1', 'txid2', 'txid3']
      const inputTxids = [...validTxids, ...invalidTxids]

      // Call the method with both valid and invalid txids
      const result = wallet.getKnownTxids(inputTxids)

      // Validate the result includes all txids
      expect(Array.isArray(result)).toBe(true)
      expect(result).toEqual(expect.arrayContaining(inputTxids))
    }
  })
})
