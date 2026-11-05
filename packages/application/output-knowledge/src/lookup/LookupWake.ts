import { OutputProtocolError } from '@bsv/sdk'
import { checkLookupWork } from './LookupProviderWork.js'

export interface LookupWatch {
  wait(milliseconds: number, signal: AbortSignal): Promise<void>
  close(): void
}

/** A bounded local hint. Durable reads and periodic polling also cover other processes. */
export class LookupWake {
  private readonly listeners = new Set<() => void>()
  constructor(readonly maximum = 64) {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 4096)
      throw new OutputProtocolError('invalid', 'Invalid lookup waiter capacity')
  }
  notify(): void {
    for (const listener of this.listeners) listener()
  }
  watch(): LookupWatch {
    if (this.listeners.size >= this.maximum)
      throw new OutputProtocolError('limited', 'Lookup waiter capacity is full', true)
    let notified = false,
      closed = false,
      wake: (() => void) | undefined
    const listener = () => {
      notified = true
      wake?.()
    }
    this.listeners.add(listener)
    return {
      wait: async (milliseconds, signal) => {
        checkLookupWork(signal)
        if (closed || wake !== undefined)
          throw new OutputProtocolError('invalid', 'Lookup watch is closed or already waiting')
        if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > 25000)
          throw new OutputProtocolError('invalid', 'Invalid bounded lookup wait')
        if (notified || milliseconds === 0) return
        await new Promise<void>(resolve => {
          const finish = () => {
            clearTimeout(timer)
            signal.removeEventListener('abort', finish)
            wake = undefined
            resolve()
          }
          const timer = setTimeout(finish, milliseconds)
          wake = finish
          signal.addEventListener('abort', finish, { once: true })
          if (signal.aborted || notified || closed) finish()
        })
        checkLookupWork(signal)
        if (closed) throw new OutputProtocolError('cancelled', 'Lookup watch closed')
      },
      close: () => {
        closed = true
        this.listeners.delete(listener)
        wake?.()
      }
    }
  }
}
