import { expect, it } from '@jest/globals'
import { createHash } from 'node:crypto'
import { canonicalOutputJSON } from '@bsv/sdk'
import {
  createPrivateAcquisitionState,
  parsePrivateAcquisitionState,
  privateAcquisitionAddress,
  privateAcquisitionPrefix
} from '../src/private/PrivateAcquisitionState.js'
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

it('binds the exact original digest and opaque address purposes independently of state creation', async () => {
  const f = await acquisitionStoreFixture(),
    state = f.quote().state,
    identity = f.owner.domain.identity,
    digest = createHash('sha256')
      .update('private-acquisition-original/1\0')
      .update(canonicalOutputJSON(f.original))
      .digest('hex')
  expect(state.originalDigest).toBe(digest)
  for (const kind of ['acquisition', 'quote'] as const)
    expect(privateAcquisitionAddress(identity, kind, f.id)).toEqual(
      identity.address(kind, { purpose: 'private-acquisition', acquisitionId: f.id })
    )
  const { acquisitionId, requestDigest, derivationPrefix } = f.original.challenge
  expect(privateAcquisitionPrefix(identity, f.original)).toEqual({
    address: identity.address('prefix-fence', {
      purpose: 'private-acquisition-prefix',
      derivationPrefix
    }),
    value: {
      format: 'private-acquisition-prefix/1',
      acquisitionId,
      requestDigest,
      derivationPrefix
    }
  })
  expect(createPrivateAcquisitionState(f.original, state.material, state.result, '20')).toEqual(
    state
  )
})

it.each([
  ['format', 'unsupported', 'Unsupported acquisition state'],
  ['digest', 'unavailable', 'Acquisition state differs from retained original'],
  ['material-request', 'unavailable', 'Acquisition payload belongs to another request'],
  ['result-request', 'unavailable', 'Acquisition payload belongs to another request'],
  ['result-acquisition', 'unavailable', 'Acquisition payload belongs to another request'],
  ['result-capacity', 'unavailable', 'Acquisition payload purpose or reservation differs'],
  ['premature-result', 'unavailable', 'Acquisition result completion differs from delivery']
] as const)(
  'retains the specific refusal for the changed %s contract',
  async (field, code, message) => {
    const f = await acquisitionStoreFixture(),
      original = f.quote().state,
      changed = structuredClone(original)
    if (field === 'format') (changed as unknown as Record<string, unknown>).format = 'other'
    if (field === 'digest') changed.originalDigest = '99'.repeat(32)
    if (field === 'material-request') changed.material.requestDigest = '99'.repeat(32)
    if (field === 'result-request') changed.result.requestDigest = '99'.repeat(32)
    if (field === 'result-acquisition') changed.result.acquisitionId = '99'.repeat(32)
    if (field === 'result-capacity') changed.result.maximumBytes--
    if (field === 'premature-result') {
      changed.result.bytes = 1
      changed.result.digest = '99'.repeat(32)
    }
    expect(() => parsePrivateAcquisitionState(changed, f.original)).toThrow(
      expect.objectContaining({ code, message })
    )
  }
)

it('enforces the retained-state byte bound before schema interpretation', async () => {
  const f = await acquisitionStoreFixture(),
    oversized = { ...f.quote().state, padding: 'x'.repeat(1048576) }
  expect(() => parsePrivateAcquisitionState(oversized, f.original)).toThrow(
    expect.objectContaining({ code: 'limited', message: 'Output JSON byte limit' })
  )
})
