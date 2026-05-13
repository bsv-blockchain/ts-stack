import {
  TableAction,
  TableProvenTx,
  TableProvenTxReq,
  TableTransaction,
  TableTransactionNew
} from '../tables'
import { runBackfill, BackfillDriver } from '../backfill.runner'

class FakeDriver implements BackfillDriver {
  reqs: Array<{ req: TableProvenTxReq, proven?: TableProvenTx }> = []
  legacyTxs: TableTransaction[] = []
  newRows: TableTransactionNew[] = []
  actions: TableAction[] = []
  labelRepoints: Array<[number, number]> = []
  nextNewId = 1
  nextActionId = 1

  async * streamLegacyReqs (): AsyncIterable<{ req: TableProvenTxReq, proven?: TableProvenTx }> {
    for (const r of this.reqs) yield r
  }

  async * streamLegacyTransactions (): AsyncIterable<TableTransaction> {
    for (const t of this.legacyTxs) yield t
  }

  async upsertTransactionNew (row: Omit<TableTransactionNew, 'transactionId'>): Promise<number> {
    const existing = this.newRows.find(r => r.txid === row.txid)
    if (existing != null) {
      Object.assign(existing, row)
      return existing.transactionId
    }
    const inserted: TableTransactionNew = { ...row, transactionId: this.nextNewId++ }
    this.newRows.push(inserted)
    return inserted.transactionId
  }

  async upsertAction (row: Omit<TableAction, 'actionId'>): Promise<number> {
    const existing = this.actions.find(a => a.userId === row.userId && a.transactionId === row.transactionId)
    if (existing != null) {
      Object.assign(existing, row)
      return existing.actionId
    }
    const inserted: TableAction = { ...row, actionId: this.nextActionId++ }
    this.actions.push(inserted)
    return inserted.actionId
  }

  async repointTxLabelMap (legacyTransactionId: number, actionId: number): Promise<void> {
    this.labelRepoints.push([legacyTransactionId, actionId])
  }
}

const now = new Date('2026-05-11T12:00:00Z')

function legacyReq (txid: string, overrides: Partial<TableProvenTxReq> = {}): TableProvenTxReq {
  return {
    created_at: now,
    updated_at: now,
    provenTxReqId: Math.floor(Math.random() * 1e9),
    status: 'unmined',
    attempts: 1,
    notified: false,
    txid,
    history: '{}',
    notify: '{}',
    rawTx: [1, 2],
    wasBroadcast: true,
    rebroadcastAttempts: 0,
    ...overrides
  }
}

function legacyProven (txid: string): TableProvenTx {
  return {
    created_at: now,
    updated_at: now,
    provenTxId: 99,
    txid,
    height: 800001,
    index: 2,
    merklePath: [7, 7],
    rawTx: [1, 2],
    blockHash: 'b'.repeat(64),
    merkleRoot: 'c'.repeat(64)
  }
}

function legacyTx (overrides: Partial<TableTransaction> = {}): TableTransaction {
  return {
    created_at: now,
    updated_at: now,
    transactionId: 1,
    userId: 7,
    status: 'completed',
    reference: 'r-1',
    isOutgoing: true,
    satoshis: 1000,
    description: 'd',
    txid: 'a'.repeat(64),
    ...overrides
  }
}

describe('runBackfill orchestrator', () => {
  test('emits one transactions_new row per unique txid across reqs + legacy tx', async () => {
    const driver = new FakeDriver()
    const txidA = 'a'.repeat(64)
    const txidB = 'b'.repeat(64)
    driver.reqs = [{ req: legacyReq(txidA, { status: 'completed' }), proven: legacyProven(txidA) }]
    driver.legacyTxs = [
      legacyTx({ transactionId: 1, txid: txidA, status: 'completed' }),
      legacyTx({ transactionId: 2, txid: txidB, status: 'sending', userId: 7, reference: 'r-2' })
    ]
    const stats = await runBackfill(driver, now)
    expect(driver.newRows).toHaveLength(2)
    expect(stats.reqsBackfilled).toBe(1)
    expect(stats.legacyTxOnlyBackfilled).toBe(1)
    expect(stats.actionsBackfilled).toBe(2)
    expect(stats.labelMapsRepointed).toBe(2)

    const provenRow = driver.newRows.find(r => r.txid === txidA)!
    expect(provenRow.processing).toBe('confirmed')
    expect(provenRow.height).toBe(800001)

    const localRow = driver.newRows.find(r => r.txid === txidB)!
    expect(localRow.processing).toBe('sending')
    expect(localRow.height).toBeUndefined()
  })

  test('skips legacy transactions without a txid', async () => {
    const driver = new FakeDriver()
    driver.legacyTxs = [legacyTx({ transactionId: 5, txid: undefined, status: 'unsigned' })]
    const stats = await runBackfill(driver, now)
    expect(driver.newRows).toHaveLength(0)
    expect(driver.actions).toHaveLength(0)
    expect(stats.actionsBackfilled).toBe(0)
    expect(stats.legacyTxOnlyBackfilled).toBe(0)
  })

  test('shares one transactions_new row when multiple users have actions on same txid', async () => {
    const driver = new FakeDriver()
    const txid = 'a'.repeat(64)
    driver.legacyTxs = [
      legacyTx({ transactionId: 10, txid, userId: 1, reference: 'r-1' }),
      legacyTx({ transactionId: 11, txid, userId: 2, reference: 'r-2' })
    ]
    const stats = await runBackfill(driver, now)
    expect(driver.newRows).toHaveLength(1)
    expect(driver.actions).toHaveLength(2)
    expect(driver.actions.map(a => a.userId).sort()).toEqual([1, 2])
    expect(stats.legacyTxOnlyBackfilled).toBe(1)
  })

  test('repoints labels using the new actionId, not the legacy transactionId', async () => {
    const driver = new FakeDriver()
    driver.legacyTxs = [legacyTx({ transactionId: 42, userId: 7, reference: 'r-x' })]
    await runBackfill(driver, now)
    expect(driver.labelRepoints).toHaveLength(1)
    const [legacy, actionId] = driver.labelRepoints[0]
    expect(legacy).toBe(42)
    expect(actionId).toBe(driver.actions[0].actionId)
  })
})
