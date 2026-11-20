// Generated from config/testing/property-test-batches.cjs. Run node scripts/sync-property-test-batches.mjs.

'use strict'

const PROPERTY_TEST_BATCH_SIZE = 50

/**
 * Preserve fast-check's original stream offsets and counterexample paths. A
 * replay starting inside a shrink tree retains its original configuration.
 */
function propertyTestBatches(selection) {
  const numRuns = selection.numRuns ?? 100
  const seed = selection.seed ?? Date.now() | 0
  if (!Number.isSafeInteger(numRuns) || numRuns < 1)
    throw new RangeError('Property tests require a positive, safe case count.')
  // Shrink paths enumerate siblings of one generated counterexample. Keep
  // those exact replays intact, and partition numeric offsets like normal runs.
  const replayPath = selection.path ?? ''
  if (replayPath && !/^\d+$/.test(replayPath))
    return [{ ...selection, seed, numRuns, path: replayPath }]
  const first = replayPath === '' ? 0 : Number(replayPath)
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(first + numRuns))
    throw new RangeError('Property test replay offset exceeds the safe range.')

  return Array.from({ length: Math.ceil(numRuns / PROPERTY_TEST_BATCH_SIZE) }, (_, index) => {
    const offset = index * PROPERTY_TEST_BATCH_SIZE
    return {
      ...selection,
      seed,
      numRuns: Math.min(PROPERTY_TEST_BATCH_SIZE, numRuns - offset),
      path: String(first + offset)
    }
  })
}

// A separately requested performance diagnostic measures the original fixed
// campaign under its own limit. Regular test registrations use batches only.
function measuredPropertyCampaign(selection, milliseconds) {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1)
    throw new RangeError('Property performance diagnostics require a positive deadline.')
  return [
    {
      ...selection,
      seed: selection.seed ?? Date.now() | 0,
      numRuns: selection.numRuns ?? 100,
      path: selection.path ?? '',
      interruptAfterTimeLimit: milliseconds,
      markInterruptAsFailure: true
    }
  ]
}

exports.propertyTestBatches = propertyTestBatches
exports.measuredPropertyCampaign = measuredPropertyCampaign
