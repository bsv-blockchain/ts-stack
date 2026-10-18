type Listener<V> = (value: V) => void

/**
 * Minimal typed event emitter. A listener that throws (or returns a promise that
 * rejects) never stops the other listeners and never escapes `emit`; the error is
 * handed to `onListenerError` when one is set and swallowed otherwise.
 */
export class Emitter<E extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof E, Set<{ fn: Listener<never> }>>()

  /** Receives errors thrown by listeners. Failures inside this hook are ignored. */
  onListenerError?: (error: unknown, event: keyof E) => void

  constructor(onListenerError?: (error: unknown, event: keyof E) => void) {
    this.onListenerError = onListenerError
  }

  /** Subscribe. Each call is its own registration; the returned function removes it. */
  on<K extends keyof E>(k: K, fn: (v: E[K]) => void): () => void {
    const entry = { fn: fn as Listener<never> }
    let set = this.listeners.get(k)
    if (!set) {
      set = new Set()
      this.listeners.set(k, set)
    }
    set.add(entry)
    return () => {
      const current = this.listeners.get(k)
      if (!current) return
      current.delete(entry)
      if (current.size === 0) this.listeners.delete(k)
    }
  }

  /** Subscribe for a single delivery. The returned function cancels it if it has not fired. */
  once<K extends keyof E>(k: K, fn: (v: E[K]) => void): () => void {
    const off = this.on(k, v => {
      off()
      // return the listener's result so `emit` can route an async rejection to onListenerError
      return fn(v)
    })
    return off
  }

  /** Deliver `v` to the listeners registered when `emit` was called. */
  emit<K extends keyof E>(k: K, v: E[K]): void {
    const set = this.listeners.get(k)
    if (!set) return
    for (const { fn } of Array.from(set)) {
      try {
        const result: unknown = (fn as Listener<E[K]>)(v)
        if (isThenable(result)) {
          result.then(undefined, (error: unknown) => this.report(error, k))
        }
      } catch (error) {
        this.report(error, k)
      }
    }
  }

  /** Remove every listener for every event. */
  clear(): void {
    this.listeners.clear()
  }

  private report(error: unknown, event: keyof E): void {
    try {
      this.onListenerError?.(error, event)
    } catch {
      // a failing error hook must not break event delivery
    }
  }
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return typeof v === 'object' && v !== null && typeof (v as { then?: unknown }).then === 'function'
}
