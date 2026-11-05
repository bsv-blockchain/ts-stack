import type { HeightRange } from '../services/chaintracker/chaintracks/util/HeightRange'
import type { Monitor } from './Monitor'
import type { ReviewHeightRangeResult } from './tasks/TaskReviewProvenTxs'

/**
 * For each height in `range`, compares the merkleRoot of the chaintracks header at that height
 * with the roots of the proven_txs records stored for that height, and reproves the transactions
 * tied to any stale root.
 *
 * Shared by the lagged audit in TaskReviewProvenTxs and the recent-height review in TaskReorg.
 */
export async function reviewProvenTxHeights(monitor: Monitor, range: HeightRange): Promise<ReviewHeightRangeResult> {
  const result: ReviewHeightRangeResult = {
    log: '',
    reviewedHeights: 0,
    mismatchedHeights: 0,
    affectedTransactions: 0,
    updatedTransactions: 0,
    unresolvedHeights: []
  }
  if (range.isEmpty) return result

  const chaintracks = monitor.chaintracksWithEvents || monitor.chaintracks

  // Keep remote and storage operations sequential and bounded by the caller's range.
  const reviewHeight = async (height: number): Promise<void> => {
    result.reviewedHeights++
    const header = await chaintracks.findHeaderForHeight(height)
    if (header == null) {
      result.log += `  height ${height} canonical header unavailable\n`
      result.unresolvedHeights.push(height)
      return
    }

    let staleRoots: string[] = []
    await monitor.storage.runAsStorageProvider(async sp => {
      staleRoots = await sp.findStaleMerkleRoots({ height, merkleRoot: header.merkleRoot })
    })
    if (staleRoots.length === 0) return

    result.mismatchedHeights++
    result.log += `  height ${height} canonical ${header.merkleRoot} stale ${staleRoots.join(',')}\n`
    let unresolved = false
    await staleRoots.reduce(async (previous, staleRoot) => {
      await previous
      const reprove = await monitor.storage.reproveHeightMerkleRoot(height, staleRoot)
      result.affectedTransactions += reprove.updated.length + reprove.unchanged.length + reprove.unavailable.length
      result.updatedTransactions += reprove.updated.length
      if (reprove.unchanged.length > 0 || reprove.unavailable.length > 0) unresolved = true
      result.log += reprove.log
    }, Promise.resolve())
    if (unresolved) result.unresolvedHeights.push(height)
  }
  const reviewNext = async (height: number): Promise<void> => {
    if (height > range.maxHeight) return
    try {
      await reviewHeight(height)
    } catch {
      // A transient header/proof/storage failure must not erase the rest of the batch.
      // Do not copy remote exception text into durable monitor diagnostics.
      result.log += `  height ${height} review unavailable\n`
      // Stop this batch after a transport/storage exception: repeatedly waiting on
      // the same unavailable provider would block every other monitor task.
      for (let pending = height; pending <= range.maxHeight; pending++) result.unresolvedHeights.push(pending)
      return
    }
    return await reviewNext(height + 1)
  }
  await reviewNext(range.minHeight)
  return result
}
