import { pendingWork } from '../internal/pendingWork.js'
import {
  negotiateOutputLookupLimits,
  outputU64,
  OutputProtocolError,
  type OutputLookupBatch,
  type OutputLookupLimits
} from '@bsv/sdk'
import { LookupBatchBuilder, type LookupBatchBoundary } from './LookupBatchBuilder.js'
import type { LookupIndexStorage } from './LookupIndexStorage.js'
import type { LookupQueryView } from './LookupQueryRegistry.js'
import { checkLookupWork } from './LookupProviderWork.js'
import { LookupWake } from './LookupWake.js'

export interface LookupReadBudgets {
  maximumScans: number
  maximumExpirations: number
  pollMs: number
}

/** Register before rechecking the durable log; local hints are never required for correctness. */
export class LookupLiveReader {
  readonly budgets: Readonly<LookupReadBudgets>
  constructor(
    private readonly index: LookupIndexStorage,
    private readonly wake: LookupWake,
    private readonly now: () => string,
    budgets: Partial<LookupReadBudgets> = {}
  ) {
    this.budgets = Object.freeze({
      maximumScans: 128,
      maximumExpirations: 128,
      pollMs: 250,
      ...budgets
    })
    for (const [value, maximum] of [
      [this.budgets.maximumScans, 1024],
      [this.budgets.maximumExpirations, 1024],
      [this.budgets.pollMs, 1000]
    ])
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
        throw new OutputProtocolError('invalid', 'Invalid lookup read work budget')
  }

  async capture(time: string, signal: AbortSignal): Promise<string> {
    checkLookupWork(signal)
    const captured = await this.index.advanceTime(time, this.budgets.maximumExpirations)
    checkLookupWork(signal)
    if (!captured.complete)
      throw new OutputProtocolError(
        'limited',
        'Lookup timer work remains before a complete watermark',
        true
      )
    if (outputU64(captured.head.processedThrough) < outputU64(time))
      throw new OutputProtocolError(
        'reset-required',
        'Lookup index did not capture its evaluation time'
      )
    return captured.head.sequence
  }

  async read(
    boundary: LookupBatchBoundary,
    query: LookupQueryView,
    cursor: string,
    requested: OutputLookupLimits,
    maximums: OutputLookupLimits,
    arrival: number,
    signal: AbortSignal
  ): Promise<OutputLookupBatch> {
    const limits = negotiateOutputLookupLimits(requested, maximums)
    const deadline = arrival + limits.waitMs
    let remaining = this.budgets.maximumScans
    let expirations = this.budgets.maximumExpirations
    let incoming = cursor
    const scan = async (): Promise<{ batch: OutputLookupBatch; complete: boolean }> => {
      checkLookupWork(signal)
      // A notification during the read remains latched until wait(). The next
      // iteration installs another watch before rechecking the persisted index.
      const watch = this.wake.watch()
      try {
        const time = outputU64(this.now())
        if (time >= outputU64(boundary.expiresAt) || time >= outputU64(boundary.replayUntil))
          throw new OutputProtocolError('reset-required', 'Lookup session expired while waiting')
        const captured = await this.index.advanceTime(time.toString(), expirations)
        checkLookupWork(signal)
        if (!captured.complete || outputU64(captured.head.processedThrough) < time)
          throw new OutputProtocolError(
            'limited',
            'Lookup timer work exceeds this read budget',
            true
          )
        expirations -= captured.expired
        const result = await new LookupBatchBuilder(this.index, remaining).build(
          boundary,
          query,
          incoming,
          limits,
          maximums,
          captured.head.sequence,
          signal
        )
        // Empty checks still consume database work. Repeated hints cannot create
        // an unbounded poll loop while no rows or log groups advance.
        remaining -= Math.max(1, result.scanned)
        const batch = result.batch
        const complete =
          batch.phase === 'snapshot' ||
          batch.groups.length > 0 ||
          remaining <= 0 ||
          expirations <= 0 ||
          performance.now() >= deadline
        if (!complete) {
          incoming = batch.cursor
          const expiryMs = Number(outputU64(boundary.expiresAt) - time) * 1000
          await watch.wait(
            Math.max(0, Math.min(this.budgets.pollMs, deadline - performance.now(), expiryMs)),
            signal
          )
        }
        return { batch, complete }
      } finally {
        watch.close()
      }
    }
    let result = await scan()
    // Each pull finishes the read and its wait before scheduling another scan.
    // Every scan consumes at least one unit, including an empty notification.
    for await (const next of pendingWork(() => !result.complete, scan)) result = next
    return result.batch
  }
}
