/** Synthetic adapters complete synchronously but retain Promise rejection and
 * caller-visible ordering, matching their original async methods. */
export function fixturePromise<T>(work: () => T): Promise<T> {
  try {
    return Promise.resolve(work())
  } catch (error) {
    return Promise.reject(error)
  }
}
