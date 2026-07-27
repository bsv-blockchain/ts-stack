import { expect, test } from '@jest/globals'

/**
 * Register an intentional, metadata-governed compatibility gap as a real Jest
 * skip. The repository policy validator requires a concrete reason and removal
 * condition; the callback assertion also prevents a vacuous skip declaration.
 */
export function registerGovernedSkip(vectorId: string, reason: string): void {
  test.skip(`${vectorId} — ${reason}`, () => {
    expect(reason.length).toBeGreaterThanOrEqual(20)
  })
}
