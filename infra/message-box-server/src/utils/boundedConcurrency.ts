/**
 * Run asynchronous work with a fixed number of workers while preserving
 * result order. `-1` is the explicit operator opt-out used by resource limits.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (concurrency !== -1 && (!Number.isSafeInteger(concurrency) || concurrency < 1)) {
    throw new RangeError('concurrency must be -1 or a positive safe integer')
  }
  if (items.length === 0) return []
  if (concurrency === -1) return await Promise.all(items.map(worker))

  const results = Array.from({ length: items.length }, () => undefined as R)
  let nextIndex = 0
  const runWorker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex++
      results[index] = await worker(items[index], index)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => await runWorker())
  )
  return results
}
