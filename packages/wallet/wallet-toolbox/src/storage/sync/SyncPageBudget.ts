import type { RequestSyncChunkArgs, SyncChunk } from '../../sdk/WalletStorage.interfaces'
import type { WalletSnapshotTable } from '../snapshot/WalletReadSnapshot'

interface PageCost {
  records: number
  readMs: number
  commitMs: number
}

function pageWorkload(chunk: SyncChunk): { records: number; proofs: boolean; workload: string } {
  let records = 0
  const tables: string[] = []
  for (const [name, value] of Object.entries(chunk)) {
    if (Array.isArray(value) && value.length > 0) {
      records += value.length
      tables.push(name)
    }
  }
  tables.sort((first, second) => first.localeCompare(second))
  return { records, proofs: (chunk.provenTxs?.length ?? 0) > 0, workload: tables.join(',') }
}

/** Fit fixed overhead separately from marginal work, using bounded recent history. */
function marginalCost(
  samples: PageCost[],
  phase: 'readMs' | 'commitMs',
  previousFixedMs: number
): { perRecordMs: number; fixedMs: number; fitted: boolean } {
  let totalRecords = 0
  let totalMs = 0
  for (const sample of samples) {
    totalRecords += sample.records
    totalMs += sample[phase]
  }
  const averageRecords = totalRecords / samples.length
  const averageMs = totalMs / samples.length
  let variance = 0
  let covariance = 0
  for (const sample of samples) {
    const delta = sample.records - averageRecords
    variance += delta ** 2
    covariance += delta * (sample[phase] - averageMs)
  }
  // Until page sizes differ there is no evidence that any cost is fixed.
  if (variance === 0) {
    const fixedMs = Math.min(previousFixedMs, averageMs)
    return { perRecordMs: (averageMs - fixedMs) / averageRecords, fixedMs, fitted: false }
  }
  const slope = Math.max(0, covariance / variance)
  const fixedMs = Math.max(0, averageMs - slope * averageRecords)
  const latest = samples.at(-1)!
  // React to a newly expensive page immediately, even when the rolling fit
  // still contains cheap pages. Never subtract more than its observed cost.
  return { perRecordMs: Math.max(slope, (latest[phase] - fixedMs) / latest.records), fixedMs, fitted: true }
}

/** Per-copy work budget. Bytes alone cannot bound network-backed proof checks. */
export class SyncPageBudget {
  private maxItems = 64
  private samples: PageCost[] = []
  private workload?: string
  private fixedReadMs = 0
  private fixedCommitMs = 0
  private pagesSinceProbe = 0
  private smoothedCost?: number
  private fitted = false
  private bytesPerRecord?: number

  /** Initialize a known table before its first asynchronous read. */
  beginTable(table: WalletSnapshotTable): void {
    if (this.beginWorkload(table)) this.maxItems = 64
  }

  apply(args: RequestSyncChunkArgs, nextTable?: WalletSnapshotTable): RequestSyncChunkArgs {
    // A snapshot caller knows the next table before fetching its first page.
    // Start it conservatively instead of carrying a previous table's floor
    // or payload estimate into a different workload. Legacy callers can still
    // discover transitions from their committed chunks.
    if (nextTable !== undefined) this.beginTable(nextTable)
    // This estimate only chooses a request size. The provider still enforces
    // the actual row/byte limits, including refusal of an oversized single row.
    const byteItems =
      this.bytesPerRecord === undefined
        ? args.maxItems
        : Math.max(1, Math.floor(args.maxRoughSize / this.bytesPerRecord))
    return { ...args, maxItems: Math.min(args.maxItems, this.maxItems, byteItems) }
  }

  private beginWorkload(workload: string): boolean {
    if (workload === this.workload) return false
    this.samples = []
    this.fixedReadMs = 0
    this.fixedCommitMs = 0
    this.pagesSinceProbe = 0
    this.smoothedCost = undefined
    this.fitted = false
    this.bytesPerRecord = undefined
    this.workload = workload
    return true
  }

  private observePayload(records: number, payloadBytes: number | undefined): void {
    if (payloadBytes === undefined || !Number.isSafeInteger(payloadBytes) || payloadBytes <= 0) return
    const currentBytes = payloadBytes / records
    // React to larger payloads immediately; recover gradually when they shrink
    // so an unusually small page cannot prompt an abrupt large fetch.
    this.bytesPerRecord =
      this.bytesPerRecord === undefined || currentBytes >= this.bytesPerRecord
        ? currentBytes
        : this.bytesPerRecord * 0.75 + currentBytes * 0.25
  }

  private observeCost(perRecordMs: number, fitted: boolean): number {
    // The first varying-size fit separates previously unknown fixed latency.
    // Do not smooth that discovery with the initial, biased per-row estimate.
    // Subsequent recovery is smoothed; expensive new work shrinks immediately.
    this.smoothedCost =
      this.smoothedCost === undefined || (fitted && !this.fitted) || perRecordMs >= this.smoothedCost
        ? perRecordMs
        : this.smoothedCost * 0.75 + perRecordMs * 0.25
    this.fitted ||= fitted
    return this.smoothedCost
  }

  private chooseLimit(perRecordMs: number, ceiling: number): void {
    const suggested = Math.floor(5000 / Math.max(0.001, perRecordMs))
    let next = Math.max(1, Math.min(ceiling, this.maxItems * 2, suggested))
    // Avoid changing the request for small variations around the work target.
    // Reaching the original ceiling must still work; cheap pages cannot stick
    // just below it. A substantial new slowdown always shrinks immediately.
    if (next !== ceiling && next >= this.maxItems * 0.8 && next <= this.maxItems * 1.2)
      next = Math.min(ceiling, this.maxItems)
    this.pagesSinceProbe++
    // At the one-record floor there is no size variation from which to learn
    // fixed latency. A bounded two-record probe prevents permanent collapse.
    // A genuinely expensive proof returns to one on the next measurement.
    if (next === 1 && this.maxItems === 1 && this.pagesSinceProbe >= 4) next = 2
    if (next > this.maxItems) this.pagesSinceProbe = 0
    this.maxItems = next
  }

  /**
   * `elapsedMs` includes read and commit; an optional read measurement keeps
   * network overhead separate from destination work. `payloadBytes`, when
   * available, is the provider's actual page charge. Old callers remain valid.
   */
  committed(chunk: SyncChunk, elapsedMs: number, readMs = 0, payloadBytes?: number): void {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || !Number.isFinite(readMs) || readMs < 0 || readMs > elapsedMs)
      return
    const { records, proofs, workload } = pageWorkload(chunk)
    if (records === 0) return
    // Table transitions can change query, payload and proof costs. A stable
    // sorted key also handles legacy chunks containing more than one table.
    this.beginWorkload(workload)
    this.observePayload(records, payloadBytes)
    this.samples.push({ records, readMs, commitMs: elapsedMs - readMs })
    if (this.samples.length > 6) this.samples.shift()
    const ceiling = proofs ? 128 : 1000
    const read = marginalCost(this.samples, 'readMs', this.fixedReadMs)
    const commit = marginalCost(this.samples, 'commitMs', this.fixedCommitMs)
    this.fixedReadMs = read.fixedMs
    this.fixedCommitMs = commit.fixedMs
    this.chooseLimit(this.observeCost(read.perRecordMs + commit.perRecordMs, read.fitted && commit.fitted), ceiling)
  }
}
