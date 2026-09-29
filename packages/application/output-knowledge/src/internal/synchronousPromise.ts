/**
 * Adapt a synchronous local driver to a Promise port. Work still runs before
 * this call returns; thrown failures become rejections. Deferring work with
 * Promise.resolve().then(work) would move ownership/CAS checks to a later turn.
 */
export function synchronousPromise<T>(work: () => T): Promise<T> {
  return new Promise<T>(resolve => resolve(work()))
}
