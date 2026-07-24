import { Beef } from '@bsv/sdk'

/**
 * Return the minimal subgraph needed to prove the requested transactions.
 *
 * Parents are added before children so the resulting BEEF preserves dependency
 * order. Shared ancestors and bumps are merged only once.
 */
export function beefForTxids (source: Beef, txids: string[]): Beef {
  const beef = new Beef()
  const visited = new Set<string>()

  const visit = (txid: string): void => {
    if (visited.has(txid)) return
    visited.add(txid)
    const sourceTx = source.findTxid(txid)
    if (sourceTx == null) return
    if (sourceTx.tx != null) {
      for (const input of sourceTx.tx.inputs) {
        if (input.sourceTXID != null) visit(input.sourceTXID)
      }
    }
    if (sourceTx.bumpIndex != null) beef.mergeBump(source.bumps[sourceTx.bumpIndex])
    beef.mergeBeefTx(sourceTx)
  }

  for (const txid of txids) visit(txid)
  return beef
}
