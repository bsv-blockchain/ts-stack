import {
  assertAbortResult,
  assertInternalizeAccepted,
  assertStorageMutationSucceeded
} from '../walletResultGuards'

describe('wallet result guards', () => {
  test('accepts only an exact affirmative internalization verdict', () => {
    expect(() => assertInternalizeAccepted({ accepted: true })).not.toThrow()
    for (const accepted of [false, undefined, null, 1, 'true']) {
      expect(() => assertInternalizeAccepted({ accepted })).toThrow(
        'did not affirmatively accept the internalized action'
      )
    }
    for (const isMerge of [null, 0, 1, 'true']) {
      expect(() => assertInternalizeAccepted({ accepted: true, isMerge })).toThrow(
        'invalid internalization merge verdict'
      )
    }
    expect(() => assertInternalizeAccepted({ accepted: true, isMerge: false })).not.toThrow()
    expect(() => assertInternalizeAccepted({ accepted: true, isMerge: true })).not.toThrow()
  })

  test('requires exactly one row for unique storage mutations', () => {
    expect(() => assertStorageMutationSucceeded(1, 'test mutation')).not.toThrow()
    for (const result of [0, 2, -1, undefined, '1']) {
      expect(() => assertStorageMutationSucceeded(result, 'test mutation')).toThrow(
        'did not affirmatively complete test mutation'
      )
    }
  })

  test('preserves boolean abort refusals and rejects malformed verdicts', () => {
    expect(() => assertAbortResult({ aborted: true })).not.toThrow()
    expect(() => assertAbortResult({ aborted: false })).not.toThrow()
    for (const aborted of [undefined, null, 0, 1, 'false']) {
      expect(() => assertAbortResult({ aborted })).toThrow('invalid action-abort verdict')
    }
  })
})
