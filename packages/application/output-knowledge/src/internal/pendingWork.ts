/**
 * Pull-driven work: test the current condition and start ONE operation only when
 * the consumer asks for it. Consume with `for await` so each operation and its
 * loop body finish before scheduling the next. No prefetch or promise chain is
 * retained across iterations; breaking iteration schedules no further work.
 */
export function* pendingWork<T>(
  pending: () => boolean,
  operation: () => Promise<T>
): Generator<Promise<T>, void, unknown> {
  while (pending()) yield operation()
}
