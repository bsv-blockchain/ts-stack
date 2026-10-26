/**
 * Runs `step` on each item strictly in order, as a `for … of` loop with `await` would: an item
 * starts only after the previous one has finished, and the first throw ends the run with that
 * same error. Admission checks rely on this, so the refusal reported is always the first one in
 * index order.
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
