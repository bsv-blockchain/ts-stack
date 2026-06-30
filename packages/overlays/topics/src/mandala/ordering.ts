import { Transaction } from '@bsv/sdk'

export function txOrdering (tx: Transaction): { height: number, offset: number } {
  const mp = tx.merklePath
  if (mp == null) return { height: Number.MAX_SAFE_INTEGER, offset: 0 }
  const txid = tx.id('hex')
  const leaf = mp.path[0]?.find(l => l.hash === txid && l.txid)
  return { height: mp.blockHeight, offset: leaf?.offset ?? 0 }
}
