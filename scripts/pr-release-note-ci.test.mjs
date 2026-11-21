import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { parse } from 'yaml'

import { validateCiResults } from './ci-result-gate.mjs'

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')

test('release-note enforcement is a failing step in the required repository health gate', () => {
  const workflow = parse(read('.github/workflows/ci.yml'))
  assert.deepEqual(workflow.on.pull_request.branches, ['main'])
  for (const event of ['opened', 'synchronize', 'reopened', 'edited', 'ready_for_review'])
    assert.ok(workflow.on.pull_request.types.includes(event))
  assert.equal(workflow.on.pull_request.paths, undefined)
  assert.equal(workflow.on.pull_request['paths-ignore'], undefined)
  const health = workflow.jobs['repository-health']
  assert.equal(health.if, undefined)
  assert.equal(health['continue-on-error'], undefined)
  assert.deepEqual(health.permissions, { contents: 'read', 'pull-requests': 'read' })
  const steps = health.steps.filter(step => step.run === 'node scripts/pr-release-note.mjs')
  assert.equal(steps.length, 1)
  const [step] = steps
  assert.equal(step.if, "github.event_name == 'pull_request'")
  assert.equal(step['continue-on-error'], undefined)
  assert.deepEqual(step.env, {
    GH_TOKEN: '${{ github.token }}',
    PR_NUMBER: '${{ github.event.pull_request.number }}',
    PR_HEAD_SHA: '${{ github.event.pull_request.head.sha }}'
  })
  assert.ok(
    health.steps.indexOf(step) < health.steps.findIndex(item => item.run?.includes('pnpm install'))
  )
  const gate = Object.values(workflow.jobs).find(job =>
    job.steps?.some(item => item.run === 'node scripts/ci-result-gate.mjs')
  )
  assert.ok(gate.needs.includes('repository-health'))
  for (const event of ['pull_request', 'push', 'merge_group']) {
    for (const result of ['failure', 'cancelled', 'skipped', undefined])
      assert.ok(
        validateCiResults({ 'repository-health': { result } }, event).some(error =>
          error.startsWith('repository-health:')
        )
      )
  }
})

test('the validator and owning tests receive the protected control owners', () => {
  const owners = read('.github/CODEOWNERS').split('\n')
  for (const file of [
    'pr-release-note.mjs',
    'pr-release-note.test.mjs',
    'pr-release-note-ci.test.mjs'
  ])
    assert.deepEqual(
      owners
        .find(line => line.startsWith(`/scripts/${file} `))
        ?.trim()
        .split(/\s+/)
        .slice(1),
      ['@sirdeggen', '@ty-everett']
    )
})
