import type { BRC38WalletData } from './index'

/** Bounded synthetic document shared by the independent legacy-parser oracle. */
export function jsonStreamFixture(): BRC38WalletData {
  const time = '2026-10-03T00:00:00.000Z'
  const times = { created_at: time, updated_at: time }
  return {
    brc: 38,
    title: 'User Wallet Data Format',
    formatVersion: 1,
    exportedAt: time,
    sourceStorage: { ...times, storageIdentityKey: 'original-source', storageName: 'original source', chain: 'test' },
    user: { ...times, userId: 7, identityKey: 'original-identity', activeStorage: 'original-source' },
    tables: {
      provenTxs: [{ ...times, provenTxId: 11, txid: 'a'.repeat(64), rawTx: 'AQI=', merklePath: 'AwQ=' }],
      provenTxReqs: [{ ...times, provenTxReqId: 12, txid: 'a'.repeat(64), provenTxId: 11, history: { notes: [] } }],
      outputBaskets: [{ ...times, basketId: 13, userId: 7, name: 'default', isDeleted: false }],
      transactions: [{ ...times, transactionId: 14, userId: 7, txid: 'a'.repeat(64), provenTxId: 11 }],
      commissions: [{ ...times, commissionId: 15, userId: 7, transactionId: 14 }],
      outputs: [
        { ...times, outputId: 16, userId: 7, transactionId: 14, basketId: 13, spentBy: 14, lockingScript: 'AQI=' }
      ],
      outputTags: [{ ...times, outputTagId: 17, userId: 7, tag: 'tag 🙂', isDeleted: true }],
      outputTagMaps: [{ ...times, outputId: 16, outputTagId: 17 }],
      txLabels: [{ ...times, txLabelId: 18, userId: 7, label: 'label', isDeleted: false }],
      txLabelMaps: [{ ...times, transactionId: 14, txLabelId: 18 }],
      certificates: [{ ...times, certificateId: 19, userId: 7 }],
      certificateFields: [{ ...times, certificateId: 19, userId: 7, fieldName: 'name', fieldValue: 'value' }],
      syncStates: [{ ...times, syncStateId: 20, userId: 7, storageIdentityKey: 'original-source', syncMap: {} }]
    }
  }
}
