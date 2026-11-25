export function propertyReplayOptions(minimumRuns, { runs, seed, path }) {
  const requestedRuns = Number.parseInt(runs ?? '', 10)
  const requestedSeed = Number.parseInt(seed ?? '', 10)

  return {
    numRuns: Number.isSafeInteger(requestedRuns)
      ? Math.max(minimumRuns, requestedRuns)
      : minimumRuns,
    ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
    ...(path ? { path } : {})
  }
}
