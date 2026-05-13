import {
  buildActionRow,
  buildTransactionNewRow,
  buildTransactionNewRowFromLegacyTx
} from '../backfill'
import { TableProvenTx, TableProvenTxReq, TableTransaction } from '../tables'

const now = new Date('2026-05-11T12:00:00Z')

function legacyReq (overrides: Partial<TableProvenTxReq> = {}): TableProvenTxReq {
  return {
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-02T00:00:00Z'),
    provenTxReqId: 1,
    status: 'unmined',
    attempts: 3,
    notified: false,
    txid: 'a'.repeat(64),
    history: '{}',
    notify: '{}',
    rawTx: [1, 2, 3],
    wasBroadcast: true,
    rebroadcastAttempts: 0,
    ...overrides
  }
}

function legacyProven (overrides: Partial<TableProvenTx> = {}): TableProvenTx {
  return {
    created_at: new Date('2026-01-03T00:00:00Z'),
    updated_at: new Date('2026-01-03T00:00:00Z'),
    provenTxId: 1,
    txid: 'a'.repeat(64),
    height: 800000,
    index: 7,
    merklePath: [9, 9, 9],
    rawTx: [1, 2, 3],
    blockHash: 'b'.repeat(64),
    merkleRoot: 'c'.repeat(64),
    ...overrides
  }
}

function legacyTx (overrides: Partial<TableTransaction> = {}): TableTransaction {
  return {
    created_at: new Date('2026-02-01T00:00:00Z'),
    updated_at: new Date('2026-02-02T00:00:00Z'),
    transactionId: 42,
    userId: 7,
    status: 'completed',
    reference: 'ref-abc',
    isOutgoing: true,
    satoshis: 5000,
    description: 'pay alice',
    txid: 'a'.repeat(64),
    ...overrides
  }
}

describe('Backfill', () => {
  test('buildTransactionNewRow maps unmined req without proof to sent FSM state', () => {
    const row = buildTransactionNewRow(legacyReq(), undefined, now)
    expect(row.processing).toBe('sent')
    expect(row.wasBroadcast).toBe(true)
    expect(row.attempts).toBe(3)
    expect(row.height).toBeUndefined()
    expect(row.rawTx).toEqual([1, 2, 3])
  })

  test('buildTransactionNewRow merges proven_txs fields when present', () => {
    const row = buildTransactionNewRow(legacyReq({ status: 'completed' }), legacyProven(), now)
    expect(row.processing).toBe('confirmed')
    expect(row.height).toBe(800000)
    expect(row.merkleIndex).toBe(7)
    expect(row.blockHash).toBe('b'.repeat(64))
  })

  test('buildTransactionNewRow maps rebroadcastAttempts -> rebroadcastCycles', () => {
    const row = buildTransactionNewRow(legacyReq({ rebroadcastAttempts: 5 }), undefined, now)
    expect(row.rebroadcastCycles).toBe(5)
  })

  test('buildTransactionNewRowFromLegacyTx returns undefined when no txid', () => {
    const row = buildTransactionNewRowFromLegacyTx(legacyTx({ txid: undefined }), now)
    expect(row).toBeUndefined()
  })

  test('buildTransactionNewRowFromLegacyTx maps completed -> confirmed', () => {
    const row = buildTransactionNewRowFromLegacyTx(legacyTx(), now)
    expect(row?.processing).toBe('confirmed')
    expect(row?.txid).toBe('a'.repeat(64))
  })

  test('buildActionRow propagates per-user fields and detects nosend', () => {
    const a = buildActionRow(legacyTx({ status: 'nosend' }), 99, now)
    expect(a.userId).toBe(7)
    expect(a.transactionId).toBe(99)
    expect(a.userNosend).toBe(true)
    expect(a.userAborted).toBe(false)
    expect(a.satoshisDelta).toBe(5000)
    expect(a.reference).toBe('ref-abc')
  })

  test('buildActionRow flags failed legacy tx as userAborted', () => {
    const a = buildActionRow(legacyTx({ status: 'failed' }), 100, now)
    expect(a.userAborted).toBe(true)
    expect(a.userNosend).toBe(false)
  })
})
