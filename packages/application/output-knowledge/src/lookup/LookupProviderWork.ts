import { BoundedOutputWork, checkOutputWork } from '../internal/BoundedOutputWork.js'

export function checkLookupWork(signal: AbortSignal): void {
  checkOutputWork(signal, 'Lookup request cancelled')
}

/** No queue: cancelled callers retain capacity until their physical work settles. */
export class LookupProviderWork extends BoundedOutputWork {
  constructor(maximum = 64, perPrincipal = 4, timeoutMs = 30000) {
    super(
      {
        invalid: 'Invalid lookup work capacity or deadline',
        capacity: 'Lookup physical work capacity is full',
        cancelled: 'Lookup request cancelled',
        deadline: 'Lookup request deadline reached'
      },
      maximum,
      perPrincipal,
      timeoutMs
    )
  }
}
