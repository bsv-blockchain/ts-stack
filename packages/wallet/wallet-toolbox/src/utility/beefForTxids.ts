import { Beef, BeefTx, MerklePath } from '@bsv/sdk'

interface BeefSelection {
  transactions: Set<BeefTx>
  bumpIndexes: Set<number>
}

/**
 * Return a minimal BEEF when the source contains data outside the requested
 * transaction dependency closure. Return undefined when no pruning is needed.
 *
 * This form lets forwarding clients retain the caller's original bytes in the
 * common no-op case instead of rebuilding and reserializing an equivalent BEEF.
 */
export function pruneBeefForTxids(source: Beef, txids: string[]): Beef | undefined {
  const selection = selectTransactions(source, txids)
  if (selection.transactions.size === source.txs.length && selection.bumpIndexes.size === source.bumps.length) {
    return undefined
  }
  return copySelection(source, selection)
}

/**
 * Return an independent minimal BEEF needed to prove the requested transactions.
 *
 * Transactions remain in source order and are sorted by Beef when serialized.
 * The source is indexed and walked once, using an explicit stack so a hostile
 * dependency depth cannot exhaust the JavaScript call stack.
 */
export function beefForTxids(source: Beef, txids: string[]): Beef {
  const selection = selectTransactions(source, txids)
  return copySelection(source, selection)
}

function selectTransactions(source: Beef, txids: string[]): BeefSelection {
  const byTxid = new Map<string, BeefTx>()
  for (const tx of source.txs) byTxid.set(tx.txid, tx)

  const transactions = new Set<BeefTx>()
  const bumpIndexes = new Set<number>()
  const visited = new Set<string>()
  const stack = [...txids]

  while (stack.length > 0) {
    const txid = stack.pop()
    if (txid == null || visited.has(txid)) continue
    visited.add(txid)

    const tx = byTxid.get(txid)
    if (tx == null) continue
    transactions.add(tx)

    const bumpIndex = tx.bumpIndex
    if (bumpIndex != null && Number.isSafeInteger(bumpIndex) && bumpIndex >= 0 && bumpIndex < source.bumps.length) {
      bumpIndexes.add(bumpIndex)
    }

    for (const inputTxid of tx.inputTxids) {
      if (!visited.has(inputTxid)) stack.push(inputTxid)
    }
  }

  return { transactions, bumpIndexes }
}

function copySelection(source: Beef, selection: BeefSelection): Beef {
  const beef = new Beef(source.version)
  const bumpIndexMap = new Map<number, number>()

  for (let index = 0; index < source.bumps.length; index++) {
    if (!selection.bumpIndexes.has(index)) continue
    bumpIndexMap.set(index, beef.bumps.length)
    beef.bumps.push(cloneMerklePath(source.bumps[index]))
  }

  for (const sourceTx of source.txs) {
    if (!selection.transactions.has(sourceTx)) continue
    const bumpIndex = sourceTx.bumpIndex == null ? undefined : bumpIndexMap.get(sourceTx.bumpIndex)
    const rawTx = sourceTx.rawTxUint8Array
    const copy =
      rawTx == null
        ? BeefTx.fromTxid(sourceTx.txid, bumpIndex)
        : new BeefTx(Uint8Array.from(rawTx), bumpIndex, Array.from(sourceTx.inputTxids))
    beef.txs.push(copy)
  }

  return beef
}

function cloneMerklePath(source: MerklePath): MerklePath {
  return new MerklePath(
    source.blockHeight,
    source.path.map(level => level.map(leaf => ({ ...leaf }))),
    false,
    false
  )
}
