import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EXCEPTION_ID,
  EXCEPTION_BASE,
  EXCEPTION_PATHS,
  validateReleaseException
} from './release-source-admission.mjs'

const source = 'a'.repeat(40)
function fixture() {
  return {
    id: EXCEPTION_ID,
    source,
    environment: {
      GITHUB_SHA: source,
      GITHUB_REF: 'refs/heads/main',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_ACTOR: 'ty-everett'
    },
    record: {
      id: EXCEPTION_ID,
      sourceBase: EXCEPTION_BASE,
      owner: 'ty-everett',
      status: 'active',
      expiresAt: '2026-11-05T16:00:00Z'
    },
    paths: [...EXCEPTION_PATHS],
    now: Date.parse('2026-11-04T17:00:00Z')
  }
}
test('one exact release records a waiver without asserting qualification', () => {
  const result = validateReleaseException(fixture())
  assert.equal(result.admission, 'operator-waiver')
  assert.equal(result.sourceSha, source)
  assert.equal(result['qualified-sha'], undefined)
})
test('future application, version, dependency, generated baseline and image changes cannot reuse the waiver', () => {
  for (const path of [
    'packages/sdk/src/mod.ts',
    'packages/sdk/package.json',
    'pnpm-lock.yaml',
    'governance/package-release-notes.json',
    'infra/wab/package.json',
    'infra/wab/package-lock.json'
  ]) {
    assert.throws(
      () => validateReleaseException({ ...fixture(), paths: [path] }),
      /content changed/
    )
  }
  assert.throws(() => validateReleaseException({ ...fixture(), paths: [] }), /content changed/)
})
test('wrong source, ref, actor, trigger, exception identity and expiry fail closed', () => {
  for (const [key, value] of Object.entries({
    GITHUB_SHA: 'b'.repeat(40),
    GITHUB_REF: 'refs/heads/other',
    GITHUB_EVENT_NAME: 'push',
    GITHUB_ACTOR: 'other'
  })) {
    const f = fixture()
    f.environment[key] = value
    assert.throws(() => validateReleaseException(f), /authorized manual main/)
  }
  assert.throws(() => validateReleaseException({ ...fixture(), id: 'other' }), /Unknown/)
  assert.throws(
    () => validateReleaseException({ ...fixture(), source: 'bad' }),
    /authorized manual main/
  )
  assert.throws(
    () => validateReleaseException({ ...fixture(), now: Date.parse('2026-11-05T16:00:00Z') }),
    /expired/
  )
  const f = fixture()
  f.record.sourceBase = 'b'.repeat(40)
  assert.throws(() => validateReleaseException(f), /Unknown/)
})

test('retired records cannot authorize another release', () => {
  const f = fixture()
  f.record.status = 'retired'
  assert.throws(() => validateReleaseException(f), /authorized manual main/)
})
