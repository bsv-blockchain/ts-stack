import { synchronousPromise } from './synchronousPromise.js'

/**
 * Pull synchronous values through an asynchronous iterator without prefetching
 * or assimilating a value's `then` property. Only the iterator result is awaited.
 * Forward early closure so a source generator can release its resources.
 */
export function asyncValues<T>(values: Iterable<T>): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      const iterator = values[Symbol.iterator]()
      return {
        next: () => synchronousPromise(() => iterator.next()),
        return: () =>
          synchronousPromise(() => iterator.return?.() ?? { done: true, value: undefined })
      }
    }
  }
}
