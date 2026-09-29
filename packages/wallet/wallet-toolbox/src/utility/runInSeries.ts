/** Start each operation only after its predecessor settles; return the last result. */
export async function runInSeries<T, R>(values: Iterable<T>, work: (value: T) => Promise<R>): Promise<R | undefined> {
  async function* results() {
    for (const value of values) yield work(value)
  }
  let last: R | undefined
  for await (last of results()) {
    // Pull lazily: the async generator awaits each operation before accepting the next.
  }
  return last
}
