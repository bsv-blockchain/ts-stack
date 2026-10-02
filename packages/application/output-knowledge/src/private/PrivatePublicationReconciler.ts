import { outputAssert, OutputProtocolError } from '@bsv/sdk'
import { PrivatePublicationCoordinator } from './PrivatePublicationCoordinator.js'

export interface PrivatePublicationReconciliationReport {
  outcomes: { publicationId: string; status: string }[]
  blocked: { key: string; status: string }[]
  wrapped: boolean
}

/** One bounded current page per pass; a wrap discovers inserts behind the cursor. */
export class PrivatePublicationReconciler {
  private next: string | null = null
  private active = false
  private started = false
  private readonly stopSignal = new AbortController()
  private readonly unchanged: readonly (() => boolean)[]
  constructor(
    private readonly coordinator: PrivatePublicationCoordinator,
    readonly maximum = 16
  ) {
    outputAssert(
      Number.isSafeInteger(maximum) && maximum > 0 && maximum <= 64,
      'Invalid publication reconciliation page capacity'
    )
    this.unchanged = [
      pin(coordinator, 'scanWork'),
      pin(coordinator, 'reconcile'),
      pin(coordinator, 'drainReconciliation')
    ]
  }

  async runOnce(signal?: AbortSignal) {
    outputAssert(!this.active, 'Private publication reconciliation is already active', 'limited')
    const current = signal
      ? AbortSignal.any([signal, this.stopSignal.signal])
      : this.stopSignal.signal
    outputAssert(
      !current.aborted && this.unchanged.every(check => check()),
      'Private publication reconciler stopped or changed',
      'context-changed'
    )
    this.active = true
    try {
      const page = this.coordinator.scanWork(this.next, this.maximum, current)
      const outcomes: { publicationId: string; status: string }[] = []
      for await (const candidate of page.entries) {
        outputAssert(!current.aborted, 'Private publication reconciliation cancelled', 'cancelled')
        try {
          const result = await this.coordinator.reconcile(candidate.publicationId, current)
          outcomes.push({
            publicationId: candidate.publicationId,
            status: result?.status ?? 'no-pending-work'
          })
        } catch (error) {
          if (current.aborted) throw error
          // No private reason or payload is emitted to scheduler diagnostics.
          outcomes.push({
            publicationId: candidate.publicationId,
            status: error instanceof OutputProtocolError ? error.code : 'unavailable'
          })
        }
      }
      this.next = page.next
      return { outcomes, blocked: page.blocked, wrapped: this.next === null }
    } finally {
      // Caller timeouts do not permit overlapping a still-running physical pass.
      await this.coordinator.drainReconciliation()
      this.active = false
    }
  }

  /** Explicit opt-in loop. Observe done; stop waits for physical work before custody may close. */
  start(intervalMs: number, report: (result: PrivatePublicationReconciliationReport) => void) {
    outputAssert(
      !this.started && !this.stopSignal.signal.aborted,
      'Private publication reconciler already started or stopped',
      'conflict'
    )
    outputAssert(
      Number.isSafeInteger(intervalMs) && intervalMs >= 100 && intervalMs <= 60000,
      'Invalid publication reconciliation interval'
    )
    outputAssert(
      typeof report === 'function' && report.constructor.name !== 'AsyncFunction',
      'Publication reconciler requires a synchronous report observer'
    )
    this.started = true
    const done = (async () => {
      try {
        for await (const pass of activePasses(this.stopSignal.signal)) {
          if (pass.aborted) break
          const result: unknown = report(await this.runOnce())
          if (result instanceof Promise) void result.catch(() => undefined)
          outputAssert(
            result === undefined,
            'Publication reconciliation observer must finish synchronously'
          )
          if (!pass.aborted) await delay(intervalMs, pass)
        }
      } catch (error) {
        if (!this.stopSignal.signal.aborted) throw error
      } finally {
        await this.coordinator.drainReconciliation()
      }
    })()
    // The returned promise remains observable; this handler prevents an unattended
    // failure from becoming an unhandled rejection while the owner closes down.
    void done.catch(() => undefined)
    return {
      done,
      stop: async () => {
        this.stopSignal.abort()
        await done
      }
    }
  }
}
function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, milliseconds)
    signal.addEventListener('abort', finish, { once: true })
    if (signal.aborted) finish()
  })
}
function pin<T, K extends keyof T>(owner: T, key: K): () => boolean {
  const original = owner[key]
  return () => owner[key] === original
}

function* activePasses(signal: AbortSignal): Generator<AbortSignal> {
  while (!signal.aborted) yield signal
}
