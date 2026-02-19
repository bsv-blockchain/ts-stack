import { ListActionsArgs } from '@bsv/sdk'
import { sdk } from '../../../src/index.client'
import { _tu, expectToThrowWERR, TestWalletProviderNoSetup } from '../../utils/TestUtilsWalletStorage'
import path from 'path'
import 'fake-indexeddb/auto'

function makeTimeLabel(ms: number) {
  return `action time ${ms}`
}

function makeTimeFromLabel(ms: number) {
  return `action time from ${ms}`
}

function makeTimeToLabel(ms: number) {
  return `action time to ${ms}`
}

function hasReservedTimeControlLabel(labels: string[] | undefined): boolean {
  return (labels || []).some(l => l.startsWith('action time from ') || l.startsWith('action time to '))
}

function injectedTimeLabels(labels: string[] | undefined): string[] {
  return (labels || []).filter(l => /^action time [0-9]+$/.test(l))
}

type InsertedAction = {
  txid: string
  createdAtMs: number
  label: string
}

describe('listActions BRC-114 action time label tests', () => {
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

  async function insertThreeActions(
    ctx: any,
    runLabel: string
  ): Promise<{ a: InsertedAction; b: InsertedAction; c: InsertedAction }> {
    const storage = ctx.activeStorage
    const user = { userId: ctx.userId } as any

    const base = 1704067200000
    const times = [base, base + 1000, base + 2000]

    const aLabel = `${runLabel}-a`
    const bLabel = `${runLabel}-b`
    const cLabel = `${runLabel}-c`

    const runTxLabel = await _tu.insertTestTxLabel(storage, user, { label: runLabel })
    const aTxLabel = await _tu.insertTestTxLabel(storage, user, { label: aLabel })
    const bTxLabel = await _tu.insertTestTxLabel(storage, user, { label: bLabel })
    const cTxLabel = await _tu.insertTestTxLabel(storage, user, { label: cLabel })

    const { tx: txA } = await _tu.insertTestTransaction(storage, user, false, {
      userId: ctx.userId,
      description: 'brc114 a',
      created_at: new Date(times[0]),
      updated_at: new Date(times[0])
    })
    await _tu.insertTestTxLabelMap(storage, txA, runTxLabel)
    await _tu.insertTestTxLabelMap(storage, txA, aTxLabel)

    const { tx: txB } = await _tu.insertTestTransaction(storage, user, false, {
      userId: ctx.userId,
      description: 'brc114 b',
      created_at: new Date(times[1]),
      updated_at: new Date(times[1])
    })
    await _tu.insertTestTxLabelMap(storage, txB, runTxLabel)
    await _tu.insertTestTxLabelMap(storage, txB, bTxLabel)

    const { tx: txC } = await _tu.insertTestTransaction(storage, user, false, {
      userId: ctx.userId,
      description: 'brc114 c',
      created_at: new Date(times[2]),
      updated_at: new Date(times[2])
    })
    await _tu.insertTestTxLabelMap(storage, txC, runTxLabel)
    await _tu.insertTestTxLabelMap(storage, txC, cTxLabel)

    return {
      a: { txid: txA.txid!, createdAtMs: times[0], label: aLabel },
      b: { txid: txB.txid!, createdAtMs: times[1], label: bLabel },
      c: { txid: txC.txid!, createdAtMs: times[2], label: cLabel }
    }
  }

  function txids(r: any): string[] {
    return r.actions.map((x: any) => x.txid)
  }

  function sortStrings(xs: string[]) {
    return [...xs].sort()
  }

  test('0_invalid_brc114_time_control_labels', async () => {
    for (const { wallet } of ctxs) {
      await expectToThrowWERR(
        sdk.WERR_INVALID_PARAMETER,
        async () => await wallet.listActions({ labels: ['action time from 0', 'action time from 1'] })
      )
      await expectToThrowWERR(
        sdk.WERR_INVALID_PARAMETER,
        async () => await wallet.listActions({ labels: ['action time to 1', 'action time to 2'] })
      )
      await expectToThrowWERR(
        sdk.WERR_INVALID_PARAMETER,
        async () => await wallet.listActions({ labels: ['action time from 2', 'action time to 1'] })
      )
      await expectToThrowWERR(
        sdk.WERR_INVALID_PARAMETER,
        async () => await wallet.listActions({ labels: ['action time from abc'] })
      )
      await expectToThrowWERR(
        sdk.WERR_INVALID_PARAMETER,
        async () => await wallet.listActions({ labels: ['action time to -1'] })
      )
      await expectToThrowWERR(
        sdk.WERR_INVALID_PARAMETER,
        async () => await wallet.listActions({ labels: ['action time from 9999999999999999999999999'] })
      )
      await expectToThrowWERR(
        sdk.WERR_INVALID_PARAMETER,
        async () => await wallet.listActions({ labels: ['action time from 123abc'] })
      )
    }
  })

  test('1_time_filtering_and_response_injection', async () => {
    for (const ctx of ctxs) {
      const runLabel = `brc114-${Date.now()}-${Math.random().toString(16).slice(2)}`
      const { a, b, c } = await insertThreeActions(ctx, runLabel)

      {
        const args: ListActionsArgs = {
          labels: [runLabel],
          includeLabels: true,
          limit: 100,
          offset: 0
        }
        const r = await ctx.wallet.listActions(args)
        expect(sortStrings(txids(r))).toStrictEqual(sortStrings([a.txid, b.txid, c.txid]))
        for (const act of r.actions) {
          expect(act.labels).toBeTruthy()
          expect(hasReservedTimeControlLabel(act.labels)).toBe(false)
          expect(act.labels!.some(l => /^action time [0-9]+$/.test(l))).toBe(false)
        }
      }

      {
        const args: ListActionsArgs = {
          labels: [runLabel, makeTimeFromLabel(0)],
          includeLabels: false,
          limit: 100,
          offset: 0
        }
        const r = await ctx.wallet.listActions(args)
        expect(sortStrings(txids(r))).toStrictEqual(sortStrings([a.txid, b.txid, c.txid]))
        for (const act of r.actions) {
          expect(act.labels).toBeUndefined()
        }
      }

      {
        const args: ListActionsArgs = {
          labels: [runLabel, makeTimeFromLabel(0)],
          includeLabels: true,
          limit: 100,
          offset: 0
        }
        const r = await ctx.wallet.listActions(args)
        expect(sortStrings(txids(r))).toStrictEqual(sortStrings([a.txid, b.txid, c.txid]))
        for (const act of r.actions) {
          expect(act.labels).toBeTruthy()
          expect(hasReservedTimeControlLabel(act.labels)).toBe(false)
          expect(injectedTimeLabels(act.labels).length).toBe(1)
        }
        const byTxid: Record<string, any> = Object.fromEntries(r.actions.map((x: any) => [x.txid, x]))
        expect(byTxid[a.txid].labels.includes(makeTimeLabel(a.createdAtMs))).toBe(true)
        expect(byTxid[b.txid].labels.includes(makeTimeLabel(b.createdAtMs))).toBe(true)
        expect(byTxid[c.txid].labels.includes(makeTimeLabel(c.createdAtMs))).toBe(true)
      }

      {
        const r = await ctx.wallet.listActions({
          labels: [runLabel, makeTimeFromLabel(0)],
          includeLabels: true,
          limit: 2,
          offset: 2
        })
        expect(r.actions.length).toBe(1)
        expect(r.totalActions).toBe(3)
      }

      {
        const args: ListActionsArgs = {
          labels: [runLabel, makeTimeFromLabel(b.createdAtMs)],
          includeLabels: true,
          limit: 100,
          offset: 0
        }
        const r = await ctx.wallet.listActions(args)
        expect(sortStrings(txids(r))).toStrictEqual(sortStrings([b.txid, c.txid]))
      }

      {
        const args: ListActionsArgs = {
          labels: [runLabel, makeTimeToLabel(c.createdAtMs)],
          includeLabels: true,
          limit: 100,
          offset: 0
        }
        const r = await ctx.wallet.listActions(args)
        expect(sortStrings(txids(r))).toStrictEqual(sortStrings([a.txid, b.txid]))
      }

      {
        const args: ListActionsArgs = {
          labels: [runLabel, makeTimeFromLabel(b.createdAtMs), makeTimeToLabel(c.createdAtMs)],
          includeLabels: true,
          limit: 100,
          offset: 0
        }
        const r = await ctx.wallet.listActions(args)
        expect(sortStrings(txids(r))).toStrictEqual(sortStrings([b.txid]))
      }

      {
        const rBaseline = await ctx.wallet.listActions({
          labels: [runLabel],
          includeLabels: true,
          labelQueryMode: 'all',
          limit: 100,
          offset: 0
        })

        const rAllWithTimeLabel = await ctx.wallet.listActions({
          labels: [runLabel, makeTimeFromLabel(0)],
          includeLabels: true,
          labelQueryMode: 'all',
          limit: 100,
          offset: 0
        })

        expect(sortStrings(txids(rAllWithTimeLabel))).toStrictEqual(sortStrings(txids(rBaseline)))
      }

      {
        const r = await ctx.wallet.listActions({
          labels: [runLabel, a.label],
          includeLabels: true,
          labelQueryMode: 'all',
          limit: 100,
          offset: 0
        })
        expect(sortStrings(txids(r))).toStrictEqual(sortStrings([a.txid]))
      }
    }
  })
})
