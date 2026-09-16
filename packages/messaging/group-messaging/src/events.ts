import type { Unsubscribe } from './types.js'

/** Called when a listener throws. `event` names the event it was listening to. */
export type ListenerErrorHandler<Events> = (error: Error, event: keyof Events) => void

/**
 * Minimal typed event emitter — no Node `events` dependency, works anywhere.
 *
 * Listeners are isolated from each other: one that throws does not stop the
 * rest from seeing the event, and does not turn the emitter's caller into a
 * failure. A `setState` blowing up inside a React `on("message")` handler is
 * the likeliest way this happens in practice, and it must not cost the other
 * subscribers their event.
 *
 * The error is surfaced, never swallowed — to `onListenerError` when the owner
 * supplied one, and otherwise rethrown on a fresh task so it reaches the
 * platform's unhandled-error reporting rather than vanishing.
 */
export class Emitter<Events> {
  readonly #listeners = new Map<keyof Events, Set<(payload: never) => void>>()

  constructor(private readonly onListenerError?: ListenerErrorHandler<Events>) {}

  on<K extends keyof Events>(event: K, listener: (payload: Events[K]) => void): Unsubscribe {
    const set = this.#listeners.get(event) ?? new Set()
    set.add(listener as (payload: never) => void)
    this.#listeners.set(event, set)
    return () => {
      set.delete(listener as (payload: never) => void)
    }
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      try {
        ;(listener as (p: Events[K]) => void)(payload)
      } catch (cause) {
        this.#report(cause instanceof Error ? cause : new Error(String(cause)), event)
      }
    }
  }

  #report(error: Error, event: keyof Events): void {
    if (this.onListenerError === undefined) {
      queueMicrotask(() => {
        throw error
      })
      return
    }
    this.onListenerError(error, event)
  }
}
