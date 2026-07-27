import { SyncChunk } from '../../../sdk/WalletStorage.interfaces'
import { EntitySyncState } from './EntitySyncState'

describe('EntitySyncState.syncChunkSummary', () => {
  it('preserves the complete log format', () => {
    const chunk = {
      fromStorageIdentityKey: 'from-storage',
      toStorageIdentityKey: 'to-storage',
      userIdentityKey: 'user-key',
      user: { activeStorage: 'primary' },
      provenTxs: [{ provenTxId: 1, txid: 'proven-txid' }],
      provenTxReqs: [{ provenTxReqId: 2, txid: 'request-txid', status: 'completed', provenTxId: undefined }],
      transactions: [
        {
          transactionId: 3,
          txid: 'transaction-txid',
          status: 'unproven',
          provenTxId: 4,
          satoshis: 5
        }
      ],
      outputs: [
        {
          outputId: 6,
          txid: 'output-txid',
          vout: 7,
          transactionId: 3,
          spendable: true,
          satoshis: 8
        }
      ]
    } as unknown as SyncChunk

    expect(EntitySyncState.syncChunkSummary(chunk)).toBe(
      `SYNC CHUNK SUMMARY
  from storage: from-storage
  to storage: to-storage
  for user: user-key
  USER activeStorage primary
  PROVEN_TXS
    1 proven-txid
  PROVEN_TX_REQS
    2 request-txid completed ${''}
  TRANSACTIONS
    3 transaction-txid unproven 4 sats:5
  OUTPUTS
    6 output-txid.7 3 spendable sats:8
`
    )
  })
})
