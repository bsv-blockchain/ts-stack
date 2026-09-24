import { Script, Transaction, MerklePath } from '@bsv/sdk'
import type { StorageProvider } from '../src/storage/StorageProvider'

export const labels = 10000
export const proofCount = 64
export const proofBytes = 32 * 1024
export const pageBytes = 256 * 1024
export const fixedReadMs = 15

export async function seedSyncBenchmark(
  storage: Pick<
    StorageProvider,
    'findOrInsertUser' | 'transaction' | 'insertTxLabel' | 'insertProvenTx' | 'insertTransaction'
  >,
  identityKey: string
) {
  const { user } = await storage.findOrInsertUser(identityKey)
  const timestamp = new Date(1_700_000_000_000)
  await storage.transaction(async trx => {
    for (let i = 0; i < labels; i++)
      await storage.insertTxLabel(
        {
          txLabelId: 0,
          userId: user.userId,
          label: `label ${i}`,
          isDeleted: i % 97 === 0,
          created_at: timestamp,
          updated_at: timestamp
        },
        trx
      )
    for (let i = 0; i < proofCount; i++) {
      const tx = new Transaction()
      tx.addOutput({ satoshis: i + 1, lockingScript: Script.fromASM(`OP_FALSE OP_RETURN ${'01'.repeat(proofBytes)}`) })
      const txid = tx.id('hex')
      const path = new MerklePath(100, [[{ offset: 0, hash: txid, txid: true }]])
      const provenTxId = await storage.insertProvenTx(
        {
          provenTxId: 0,
          txid,
          rawTx: tx.toBinary(),
          merklePath: path.toBinary(),
          merkleRoot: txid,
          height: 100,
          index: 0,
          blockHash: '01'.repeat(32),
          created_at: timestamp,
          updated_at: timestamp
        },
        trx
      )
      await storage.insertTransaction(
        {
          transactionId: 0,
          userId: user.userId,
          provenTxId,
          txid,
          reference: `bounded-sync-${i}`,
          status: 'completed',
          isOutgoing: false,
          satoshis: i + 1,
          description: 'large proof sync fixture',
          created_at: timestamp,
          updated_at: timestamp
        },
        trx
      )
    }
  })
  return user
}
