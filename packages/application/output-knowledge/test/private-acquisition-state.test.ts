import { expect, it } from '@jest/globals'
import { parsePrivateAcquisitionState } from '../src/private/PrivateAcquisitionState.js'
import { acquisitionStoreFixture } from './private-acquisition-store.fixture.js'

it.each([
  'format',
  'digest',
  'challenge',
  'chain',
  'material-acquisition',
  'material-request',
  'material-purpose',
  'material-empty',
  'result-purpose',
  'result-capacity',
  'premature-result',
  'extra'
] as const)('refuses a retained state with changed %s', async field => {
  const f = await acquisitionStoreFixture(),
    original = f.quote().state,
    value = structuredClone(original)
  if (field === 'format') (value as unknown as Record<string, unknown>).format = 'other'
  if (field === 'digest') value.originalDigest = '99'.repeat(32)
  if (field === 'challenge') value.progress.challenge.satoshis = '101'
  if (field === 'chain') value.progress.chain.network = 'different'
  if (field === 'material-acquisition') value.material.acquisitionId = '99'.repeat(32)
  if (field === 'material-request') value.material.requestDigest = '99'.repeat(32)
  if (field === 'material-purpose') value.material.purpose = 'result'
  if (field === 'material-empty') {
    value.material.bytes = null
    value.material.digest = null
  }
  if (field === 'result-purpose') value.result.purpose = 'material'
  if (field === 'result-capacity') value.result.maximumBytes--
  if (field === 'premature-result') {
    value.result.bytes = 1
    value.result.digest = '99'.repeat(32)
  }
  if (field === 'extra') (value as unknown as Record<string, unknown>).extra = true
  expect(() => parsePrivateAcquisitionState(value, f.original)).toThrow()
  expect(f.open().store.load(f.id, f.buyer, f.clock, f.guard)?.state).toEqual(original)
})
