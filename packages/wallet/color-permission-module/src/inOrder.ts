/**
 * Runs `step` on each item strictly in order, as a `for … of` loop with `await` would: an item
 * starts only after the previous one has finished, and the first throw ends the run with that
 * same error. Checks rely on this, so the refusal reported is always the first one in order, and
 * steps that reserve outputs never race each other.
 */
export async function eachInOrder<T>(
  items: Iterable<T>,
  step: (item: T) => Promise<void> | void
): Promise<void> {
  await Array.from(items).reduce<Promise<void>>(async (previous, item) => {
    // reduce invokes every callback up front, so nothing may run before this await.
    await previous
    await step(item)
  }, Promise.resolve())
}

/** {@link eachInOrder}, collecting each step's result in item order. */
export async function mapInOrder<T, R>(
  items: Iterable<T>,
  step: (item: T, index: number) => Promise<R> | R
): Promise<R[]> {
  const results: R[] = []
  let index = 0
  await eachInOrder(items, async item => {
    results.push(await step(item, index++))
  })
  return results
}
