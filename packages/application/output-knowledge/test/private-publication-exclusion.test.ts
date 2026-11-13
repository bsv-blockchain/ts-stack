import { expect, it } from '@jest/globals'
import {
  advancePrivatePublicationProgress,
  parsePrivatePublicationProgress,
  privatePublicationResult
} from '../src/private/PrivatePublicationProgress.js'
import { fixture, staged, admission } from './private-publication-fixture.js'

function prepared() {
  const f = fixture(),
    state = staged(f.store)
  const reserved = advancePrivatePublicationProgress(state, { kind: 'reserve-admission' }, '11')
  const original = admission(state)
  original.steak.tm_synthetic.outputsToAdmit = []
  const excluded = advancePrivatePublicationProgress(
    reserved,
    {
      kind: 'excluded',
      admission: original,
      reason: 'selected output excluded'
    },
    '100'
  )
  return { state, reserved, original, excluded }
}
it('retains definitive selected-output exclusion after a late original admission, without claiming no public effect', () => {
  const { state, original, excluded } = prepared()
  expect(excluded.progress).toEqual({
    phase: 'excluded',
    admission: original,
    reason: 'selected output excluded'
  })
  expect(parsePrivatePublicationProgress(excluded)).toEqual(excluded)
  expect(privatePublicationResult(excluded)).toEqual({
    version: 1,
    publicationId: state.publicationId,
    txid: state.txid,
    status: 'rejected',
    reason: 'selected output excluded',
    updatedAt: '100'
  })
  expect(excluded.progress).not.toHaveProperty('noEffect')
})
it('cannot invent an exclusion before reserving admission or reinterpret a positive retained receipt', () => {
  const { state, reserved, original } = prepared()
  expect(() =>
    advancePrivatePublicationProgress(
      state,
      { kind: 'excluded', admission: original, reason: 'not admitted' },
      '12'
    )
  ).toThrow(expect.objectContaining({ code: 'conflict' }))
  expect(() =>
    advancePrivatePublicationProgress(
      reserved,
      { kind: 'excluded', admission: admission(state), reason: 'not admitted' },
      '12'
    )
  ).toThrow(expect.objectContaining({ code: 'conflict' }))
})
it('keeps the permanent excluded fence terminal for retries and later lifecycle events', () => {
  const { state, original, excluded } = prepared()
  for (const event of [
    { kind: 'reserve-admission' as const },
    { kind: 'admitted' as const, admission: admission(state) },
    { kind: 'excluded' as const, admission: original, reason: 'again' },
    { kind: 'expired' as const, reason: 'deadline' },
    { kind: 'rejected' as const, noEffect: true as const, reason: 'rollback' }
  ])
    expect(() => advancePrivatePublicationProgress(excluded, event, '200')).toThrow(
      expect.objectContaining({ code: 'conflict' })
    )
})
it('does not turn unresolved external work into exclusion without a complete bound receipt', () => {
  const { excluded } = prepared()
  const missing = structuredClone(excluded)
  if (missing.progress.phase !== 'excluded') throw new Error('Expected exclusion')
  missing.progress.admission.assessmentContextId = ''
  expect(() => parsePrivatePublicationProgress(missing)).toThrow()
  const unrelated = structuredClone(excluded)
  if (unrelated.progress.phase !== 'excluded') throw new Error('Expected exclusion')
  unrelated.progress.admission.operationId = 'ff'.repeat(32)
  expect(() => parsePrivatePublicationProgress(unrelated)).toThrow(
    expect.objectContaining({ code: 'conflict' })
  )
})
