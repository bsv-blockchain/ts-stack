/**
 * Pull-driven work: test the current condition and start ONE operation only when
 * the consumer asks for it. Consume with `for await` so each operation and its
 * loop body finish before scheduling the next. No prefetch or promise chain is
 * retained across iterations; breaking iteration schedules no further work.
 */
export function pendingWork<T>(
  pending: () => boolean,
  operation: () => Promise<T>
): AsyncIterableIterator<T, void, undefined> {
  let closed = false
  return {
    [Symbol.asyncIterator]() {
      return this
    },
    async next(): Promise<IteratorResult<T, void>> {
      try {
        if (closed || !pending()) {
          closed = true
          return { done: true, value: undefined }
        }
        return { done: false, value: await operation() }
      } catch (error) {
        closed = true
        throw error
      }
    },
    return(): Promise<IteratorResult<T, void>> {
      closed = true
      return Promise.resolve({ done: true, value: undefined })
    }
  }
}
