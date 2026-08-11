import type { TableMonitorEvent } from '../schema/tables/TableMonitorEvent'

const MAX_ADMIN_AUDIT_TEXT_LENGTH = 4_096

function boundedAuditText(value: string): { text: string; truncated: boolean } {
  return {
    text: value.slice(0, MAX_ADMIN_AUDIT_TEXT_LENGTH),
    truncated: value.length > MAX_ADMIN_AUDIT_TEXT_LENGTH
  }
}

export interface AdminUtxoReviewStorage {
  insertMonitorEvent: (event: TableMonitorEvent) => Promise<number>
}

export interface AdminUtxoReviewTask {
  reviewByIdentityKey: (identityKey: string, mode: 'all' | 'change', release?: boolean) => Promise<string>
}

export interface AdminUtxoReviewRequest {
  storage: AdminUtxoReviewStorage
  task: AdminUtxoReviewTask
  requestedBy: string
  identityKey: string
  mode: 'all' | 'change'
  release: boolean
}

function event(when: Date, details: Record<string, unknown>): TableMonitorEvent {
  return {
    created_at: when,
    updated_at: when,
    id: 0,
    event: 'AdminReviewUtxos',
    details: JSON.stringify(details)
  }
}

/**
 * Run one explicitly scoped admin UTXO review with durable start and outcome
 * evidence. Audit writes deliberately bracket the task so provider failures
 * and blocked releases remain observable.
 */
export async function runAdminUtxoReview(request: AdminUtxoReviewRequest): Promise<{
  requestedBy: string
  identityKey: string
  mode: 'all' | 'change'
  release: boolean
  log: string
}> {
  const { storage, task, requestedBy, identityKey, mode, release } = request
  const startedAt = new Date()
  const common = { requestedBy, identityKey, mode, release }
  await storage.insertMonitorEvent(event(startedAt, { ...common, phase: 'started' }))

  let log: string
  try {
    log = await task.reviewByIdentityKey(identityKey, mode, release)
  } catch (error: unknown) {
    const failure = boundedAuditText(error instanceof Error ? error.message : String(error))
    await storage.insertMonitorEvent(
      event(new Date(), {
        ...common,
        phase: 'failed',
        startedAt: startedAt.toISOString(),
        error: failure.text,
        errorTruncated: failure.truncated
      })
    )
    throw error
  }

  const completion = boundedAuditText(log)
  await storage.insertMonitorEvent(
    event(new Date(), {
      ...common,
      phase: 'completed',
      startedAt: startedAt.toISOString(),
      log: completion.text,
      logTruncated: completion.truncated
    })
  )
  return { ...common, log }
}
