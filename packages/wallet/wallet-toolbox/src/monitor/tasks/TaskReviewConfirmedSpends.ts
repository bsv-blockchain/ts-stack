import { WERR_NOT_ACTIVE } from '../../sdk/WERR_errors'
import type { ConfirmedSpendCursor, StorageWriterAdmission } from '../../storage/StorageActiveWrite'
import type { StorageProvider } from '../../storage/StorageProvider'
import { Monitor } from '../Monitor'
import { optionalMonitorInteger, requireMonitorInteger } from '../monitorValidation'
import { WalletMonitorTask } from './WalletMonitorTask'

interface SpendProgress {
  after: number
  partial?: ConfirmedSpendCursor
  recoveryAfter: number
  legacyAfter: number | null
  recoveryFinishedAt: number
}

const emptyProgress: SpendProgress = { after: 0, recoveryAfter: 0, legacyAfter: 0, recoveryFinishedAt: 0 }
const maxCursor = Number.MAX_SAFE_INTEGER

function readPartial(value: unknown): ConfirmedSpendCursor | undefined {
  if (value == null || typeof value !== 'object') return undefined
  const fields = value as Record<string, unknown>
  const proofId = optionalMonitorInteger(fields.proofId, 1, maxCursor)
  const inputOffset = optionalMonitorInteger(fields.inputOffset, 0, maxCursor)
  const outputId = optionalMonitorInteger(fields.outputId, 0, maxCursor)
  if (proofId == null || inputOffset == null || outputId == null) return undefined
  return { proofId, inputOffset, outputId }
}

/** Bounded reconciliation for primary SQL stores with independently retained spend proofs. */
export class TaskReviewConfirmedSpends extends WalletMonitorTask {
  private progress = emptyProgress
  private provider: StorageProvider | undefined
  private readonly pageSize: number | undefined

  constructor(monitor: Monitor) {
    super(monitor, 'ReviewConfirmedSpends')
    const limit = monitor.options?.confirmedSpendReviewPageSize
    this.pageSize = limit == null ? undefined : requireMonitorInteger(limit, 'confirmedSpendReviewPageSize', 1, 128)
  }

  override async asyncSetup(): Promise<void> {
    await this.storage.runAsStorageProvider(async sp => await this.loadProgress(sp))
  }

  private async loadProgress(provider: StorageProvider): Promise<void> {
    const checkpoints = await provider.loadMonitorCheckpoint(this.name)
    this.provider = provider
    this.progress = emptyProgress
    for (const checkpoint of checkpoints) {
      try {
        const value = JSON.parse(checkpoint)
        const after = optionalMonitorInteger(value.after, 0, maxCursor)
        if (after == null) continue
        this.progress = {
          after,
          partial: readPartial(value.partial),
          recoveryAfter:
            value.legacyAfter === undefined ? 0 : (optionalMonitorInteger(value.recoveryAfter, 0, maxCursor) ?? 0),
          legacyAfter:
            value.legacyAfter === null ? null : (optionalMonitorInteger(value.legacyAfter, 0, maxCursor) ?? 0),
          recoveryFinishedAt: optionalMonitorInteger(value.recoveryFinishedAt, 0, Date.now()) ?? 0
        }
        return
      } catch {
        // One damaged legacy record can hide an earlier valid checkpoint.
      }
    }
  }

  trigger(now: number): { run: boolean } {
    const progress = this.progress
    const continuation =
      progress.after > 0 || progress.partial != null || progress.recoveryAfter > 0 || (progress.legacyAfter ?? 0) > 0
    return {
      run:
        this.monitor.lastNewHeader != null &&
        now - this.lastRunMsecsSinceEpoch >= (continuation ? Monitor.oneSecond : 15 * Monitor.oneMinute)
    }
  }

  async runTask(): Promise<string> {
    const tip = this.monitor.lastNewHeader
    if (tip == null) return ''
    const provider = await this.storage.runAsStorageProvider(sp => Promise.resolve(sp))
    if (this.provider !== provider) await this.loadProgress(provider)
    const admission: StorageWriterAdmission = async operation =>
      await this.storage.runAsStorageProvider(async current => {
        if (current !== provider) throw new WERR_NOT_ACTIVE('Spend review belongs to a replaced provider')
        return await operation()
      }, true)
    const started = performance.now()
    const progress = this.progress
    const result = await provider.reviewConfirmedSpendPage(
      progress.after,
      tip.height,
      admission,
      progress.partial,
      this.pageSize
    )
    if (result == null) {
      this.progress = emptyProgress
      this.provider = undefined
      return ''
    }
    const now = Date.now()
    const recoveryDue =
      progress.recoveryAfter > 0 || progress.legacyAfter != null || now - progress.recoveryFinishedAt >= Monitor.oneHour
    const recovery = recoveryDue
      ? await provider.reviewConfirmedSpendRecoveries(progress.recoveryAfter, admission, progress.legacyAfter)
      : undefined
    const next: SpendProgress = {
      after: result.after,
      partial: result.partial,
      recoveryAfter: recovery?.after ?? progress.recoveryAfter,
      legacyAfter: recovery == null ? progress.legacyAfter : recovery.legacyAfter,
      recoveryFinishedAt: recovery?.after === 0 && recovery.legacyAfter === null ? now : progress.recoveryFinishedAt
    }
    await admission(() =>
      provider.saveMonitorCheckpoint(
        this.name,
        JSON.stringify({ ...result, ...next, recovery, durationMsecs: Math.round(performance.now() - started) })
      )
    )
    this.progress = next
    return ''
  }
}
