import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import {
  mutationFinding,
  publishMutationFinding,
  validateMutationAuditSelection
} from './mutation-findings.mjs'
const environment = {
  MUTATION_AUDIT_TARGET: 'p2p-messages',
  MUTATION_AUDIT_PARTITION: 'whole',
  MUTATION_AUDIT_RESULT: 'failure',
  GITHUB_REPOSITORY: 'owner/repo',
  GITHUB_SHA: 'a'.repeat(40),
  GITHUB_RUN_ID: '123',
  GITHUB_RUN_ATTEMPT: '2'
}
test('all unsuccessful audit outcomes produce advisory metadata without raw failure payloads', () => {
  for (const result of ['failure', 'cancelled', 'skipped']) {
    const finding = mutationFinding({
      ...environment,
      MUTATION_AUDIT_RESULT: result,
      statusReason: 'private payload'
    })
    assert.equal(finding.needsTriage, true)
    assert.match(finding.body, /cannot block development, merge, publication or deployment/)
    assert(!finding.body.includes('private payload'))
  }
  for (const invalid of ['../target', '$(id)', '', 'target\nother'])
    assert.throws(() => mutationFinding({ ...environment, MUTATION_AUDIT_TARGET: invalid }))
})
test('a successful audit neither publishes nor automatically closes an existing issue', () => {
  assert.deepEqual(
    publishMutationFinding({ ...environment, MUTATION_AUDIT_RESULT: 'success' }, () => {
      throw new Error('No issue operation expected')
    }),
    { created: false }
  )
})
test('findings create or update the exact matching open issue and clean their body file', () => {
  for (const existing of [false, true]) {
    const calls = []
    let bodyFile
    const result = publishMutationFinding(environment, args => {
      calls.push(args)
      if (args[1] === 'list')
        return JSON.stringify(
          existing
            ? [{ number: 7, title: 'Mutation audit: p2p-messages/whole' }]
            : [{ number: 8, title: 'different finding' }]
        )
      bodyFile = args.at(-1)
      assert.match(readFileSync(bodyFile, 'utf8'), /attempts\/2/)
      return ''
    })
    assert.equal(result.created, !existing)
    assert.equal(calls[1][1], existing ? 'comment' : 'create')
    assert.equal(existsSync(bodyFile), false)
  }
})

test('background selection rejects whole-target and legacy aliases for partitioned work', () => {
  assert.doesNotThrow(() => validateMutationAuditSelection('private-lookup-buyer', 'payment'))
  assert.throws(
    () => validateMutationAuditSelection('private-lookup-buyer', 'whole'),
    /one canonical partition/
  )
  assert.throws(
    () => validateMutationAuditSelection('private-lookup-buyer', undefined),
    /one canonical partition/
  )
  assert.throws(
    () => validateMutationAuditSelection('unknown-target', 'whole'),
    /exact governed target/
  )
})
