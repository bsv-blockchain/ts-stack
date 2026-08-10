import { ListActionsArgs } from '@bsv/sdk'
import { _tu, TestWalletProviderNoSetup } from '../../utils/TestUtilsWalletStorage'
import {
  makeBrc153ReferenceLabel,
  parseBrc153ReferenceLabel
} from '../../../src/utility/brc153ReferenceLabels'
import path from 'node:path'
import 'fake-indexeddb/auto'

describe('listActions BRC-153 reference label tests', () => {
  jest.setTimeout(99999999)

  const ctxs: TestWalletProviderNoSetup[] = []

  const env = _tu.getEnv('test')
  const databaseName = path.parse(expect.getState().testPath!).name

  beforeAll(async () => {
    if (env.runMySQL) {
      ctxs.push(await _tu.createLegacyWalletMySQLCopy(databaseName))
    }
    ctxs.push(await _tu.createIdbLegacyWalletCopy(databaseName))
    ctxs.push(await _tu.createLegacyWalletSQLiteCopy(databaseName))
  })

  afterAll(async () => {
    for (const ctx of ctxs) {
      await ctx.storage.destroy()
    }
  })

  test('0_injects synthetic reference label when includeLabels is true', async () => {
    for (const ctx of ctxs) {
      const storage = ctx.activeStorage
      const user = { userId: ctx.userId } as any
      const runLabel = `brc153-${Date.now()}-${Math.random().toString(16).slice(2)}`
      const txLabel = await _tu.insertTestTxLabel(storage, user, { label: runLabel })
      const { tx } = await _tu.insertTestTransaction(storage, user, false, {
        userId: ctx.userId,
        description: 'brc153 reference'
      })
      await _tu.insertTestTxLabelMap(storage, tx, txLabel)

      const args: ListActionsArgs = {
        labels: [runLabel],
        includeLabels: true
      }
      const r = await ctx.wallet.listActions(args)
      expect(r.totalActions).toBeGreaterThanOrEqual(1)
      const action = r.actions.find(a => (a.labels || []).includes(runLabel))
      expect(action).toBeDefined()
      const referenceLabel = (action!.labels || []).find(l => l.startsWith('reference '))
      expect(referenceLabel).toBeDefined()
      expect(referenceLabel).toBe(makeBrc153ReferenceLabel(tx.reference))
      expect(parseBrc153ReferenceLabel(referenceLabel!)).toBe(tx.reference)
    }
  })

  test('1_omits synthetic reference label when includeLabels is false', async () => {
    for (const ctx of ctxs) {
      const storage = ctx.activeStorage
      const user = { userId: ctx.userId } as any
      const runLabel = `brc153-nolabels-${Date.now()}-${Math.random().toString(16).slice(2)}`
      const txLabel = await _tu.insertTestTxLabel(storage, user, { label: runLabel })
      const { tx } = await _tu.insertTestTransaction(storage, user, false, {
        userId: ctx.userId,
        description: 'brc153 no labels'
      })
      await _tu.insertTestTxLabelMap(storage, tx, txLabel)

      const r = await ctx.wallet.listActions({ labels: [runLabel], includeLabels: false })
      const action = r.actions.find(a => a.description === 'brc153 no labels') ?? r.actions[0]
      expect(action).toBeDefined()
      expect(action.labels).toBeUndefined()
      void tx
    }
  })
})
