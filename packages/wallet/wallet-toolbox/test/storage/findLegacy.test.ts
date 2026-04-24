import { _tu, TestWalletNoSetup } from '../utils/TestUtilsWalletStorage'

describe('find tests', () => {
  jest.setTimeout(99999999)

  const env = _tu.getEnv('test')
  const ctxs: TestWalletNoSetup[] = []

  beforeAll(async () => {
    if (env.runMySQL) ctxs.push(await _tu.createLegacyWalletMySQLCopy('storagefindLegacytest'))
    ctxs.push(await _tu.createLegacyWalletSQLiteCopy('storagefindLegacytest'))
  })

  afterAll(async () => {
    for (const ctx of ctxs) {
      await ctx.storage.destroy()
    }
  })

  test('0 find ProvenTx', async () => {
    for (const { storage } of ctxs) {
    }
  })

  test('1 find ProvenTxReq', async () => {
    for (const { storage } of ctxs) {
    }
  })

  test('2 find User', async () => {})

  test('3 find Certificate', async () => {})

  test('4 find CertificateField', async () => {})

  test('5 find OutputBasket', async () => {})

  test('6 find Transaction', async () => {})

  test('7 find Commission', async () => {})

  test('8 find Output', async () => {
    for (const { storage } of ctxs) {
      {
        const r = await storage.findOutputs({
          partial: { userId: 1, basketId: 1 },
          txStatus: ['sending']
        })
        expect(r.length).toBe(1)
        expect(r[0].txid).toBe('a3a8fe7f541c1383ff7b975af49b27284ae720af5f2705d8409baaf519190d26')
        expect(r[0].vout).toBe(2)
      }
    }
  })

  test('9 find OutputTag', async () => {})

  test('10 find OutputTagMap', async () => {})

  test('11 find TxLabel', async () => {})

  test('12 find TxLabelMap', async () => {})

  test('13 find MonitorEvent', async () => {})

  test('14 find SyncState', async () => {})
})
