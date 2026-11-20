/** Execute immediately, preserving an async function's fresh Promise and
 * rejection delivery even when its implementation performs no asynchronous I/O.
 * The executor owns synchronous throws; resolving adopts returned thenables.
 */
export function promiseFromSync<T>(work: () => T): Promise<Awaited<T>> {
  return Promise.resolve(new Promise<T>(resolve => resolve(work())))
}

/** Share the asynchronous suspension of simple forwarding callbacks across
 * runtimes that otherwise compile a separate state machine per callback. */
export async function awaitFromSync<T>(work: () => T): Promise<Awaited<T>> {
  return await work()
}

/** Await completion while discarding the result, as a void forwarding callback. */
export async function awaitVoidFromSync<T>(work: () => T): Promise<void> {
  await work()
}

/** Continue synchronously after one awaited operation. Both stages retain the
 * original async function's failure delivery and single suspension boundary. */
export async function mapAwaitFromSync<T, U>(work: () => T, next: (value: Awaited<T>) => U): Promise<Awaited<U>> {
  const value = await work()
  // The async return adopts next's result without another explicit await.
  return next(value) as Awaited<U>
}
