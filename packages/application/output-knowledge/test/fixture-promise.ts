/** Match an async fixture's immediate body evaluation and rejected throws. */
export function fixturePromise<T>(effect: () => T): Promise<Awaited<T>> {
  try {
    return Promise.resolve(effect())
  } catch (error) {
    return Promise.reject(error)
  }
}
