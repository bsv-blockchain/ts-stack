import type { RequestSyncChunkArgs, SyncChunk } from '../../sdk/WalletStorage.interfaces'

interface PageCost {
  records: number
  readMs: number
  commitMs: number
}

/** Fit fixed overhead separately from marginal work, using bounded recent history. */
function marginalCost(
  samples: PageCost[],
  phase: 'readMs' | 'commitMs',
  previousFixedMs: number
): { perRecordMs: number; fixedMs: number } {
  const averageRecords = samples.reduce((sum, sample) => sum + sample.records, 0) / samples.length
  const averageMs = samples.reduce((sum, sample) => sum + sample[phase], 0) / samples.length
  const variance = samples.reduce((sum, sample) => sum + (sample.records - averageRecords) ** 2, 0)
  // Until page sizes differ there is no evidence that any cost is fixed.
  if (variance === 0) {
    const fixedMs = Math.min(previousFixedMs, averageMs)
    return { perRecordMs: (averageMs - fixedMs) / averageRecords, fixedMs }
  }
  const covariance = samples.reduce(
    (sum, sample) => sum + (sample.records - averageRecords) * (sample[phase] - averageMs),
    0
  )
  const slope = Math.max(0, covariance / variance)
  const fixedMs = Math.max(0, averageMs - slope * averageRecords)
  const latest = samples.at(-1)!
  // React to a newly expensive page immediately, even when the rolling fit
  // still contains cheap pages. Never subtract more than its observed cost.
  return { perRecordMs: Math.max(slope, (latest[phase] - fixedMs) / latest.records), fixedMs }
}

/** Per-copy work budget. Bytes alone cannot bound network-backed proof checks. */
export class SyncPageBudget {
  private maxItems = 64
  private samples: PageCost[] = []
  private proofs?: boolean
  private fixedReadMs = 0
  private fixedCommitMs = 0
  private pagesSinceProbe = 0

  apply(args: RequestSyncChunkArgs): RequestSyncChunkArgs {
    return { ...args, maxItems: Math.min(args.maxItems, this.maxItems) }
  }

  /**
   * `elapsedMs` includes read and commit; an optional read measurement keeps
   * network overhead separate from destination work. Old callers remain valid.
   */
  committed(chunk: SyncChunk, elapsedMs: number, readMs = 0): void {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || !Number.isFinite(readMs) || readMs < 0 || readMs > elapsedMs)
      return
    const records = Object.values(chunk).reduce<number>(
      (count, value) => count + (Array.isArray(value) ? value.length : 0),
      0
    )
    if (records === 0) return
    const proofs = (chunk.provenTxs?.length ?? 0) > 0
    // Metadata throughput does not predict network-backed proof checks.
    if (proofs !== this.proofs) {
      this.samples = []
      this.fixedReadMs = 0
      this.fixedCommitMs = 0
      this.pagesSinceProbe = 0
    }
    this.proofs = proofs
    this.samples.push({ records, readMs, commitMs: elapsedMs - readMs })
    if (this.samples.length > 6) this.samples.shift()
    const ceiling = proofs ? 128 : 1000
    const read = marginalCost(this.samples, 'readMs', this.fixedReadMs)
    const commit = marginalCost(this.samples, 'commitMs', this.fixedCommitMs)
    this.fixedReadMs = read.fixedMs
    this.fixedCommitMs = commit.fixedMs
    const perRecordMs = read.perRecordMs + commit.perRecordMs
    const suggested = Math.floor(5000 / Math.max(0.001, perRecordMs))
    let next = Math.max(1, Math.min(ceiling, this.maxItems * 2, suggested))
    this.pagesSinceProbe++
    // At the one-record floor there is no size variation from which to learn
    // fixed latency. A bounded two-record probe prevents permanent collapse.
    // A genuinely expensive proof returns to one on the next measurement.
    if (next === 1 && this.maxItems === 1 && this.pagesSinceProbe >= 4) next = 2
    if (next > this.maxItems) this.pagesSinceProbe = 0
    this.maxItems = next
  }
}
