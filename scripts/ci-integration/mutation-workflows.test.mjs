import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPOSITORY_ROOT } from '../repository-health.mjs'
const CI_PATH = join(REPOSITORY_ROOT, '.github/workflows/ci.yml')
async function releaseWorkflows() {
  const { parse } = await import('yaml')
  return ['release.yaml', 'infra-release.yaml', 'wab-marketplace-release.yml'].map(file => ({
    file,
    workflow: parse(readFileSync(join(REPOSITORY_ROOT, '.github/workflows', file), 'utf8'))
  }))
}
function conjunctionPasses(expression, context) {
  const resolve = value =>
    value.startsWith("'")
      ? value.slice(1, -1)
      : value.split('.').reduce((current, key) => current?.[key], context)
  return expression.split(' && ').every(clause => {
    const match = /^(\S+) (==|!=) (\S+)$/.exec(clause)
    assert.ok(match, `Unexpected release guard syntax: ${clause}`)
    return match[2] === '=='
      ? resolve(match[1]) === resolve(match[3])
      : resolve(match[1]) !== resolve(match[3])
  })
}

test('every publisher requires complete exact-source qualification before publisher permissions', async () => {
  for (const { file, workflow } of await releaseWorkflows()) {
    const publisher = workflow.jobs[file === 'infra-release.yaml' ? 'release' : 'publish']
    const campaign = workflow.jobs['full-mutation']
    assert.equal(campaign.uses, './.github/workflows/mutation-tests.yml')
    assert.deepEqual(campaign.permissions, { contents: 'read' })
    assert.equal(campaign.with, undefined)
    assert.ok(publisher.needs.includes('full-mutation'))
    assert.ok(publisher.permissions['id-token'] === 'write')
    for (const result of ['success', 'failure', 'cancelled', 'skipped', undefined]) {
      for (const qualified of ['a'.repeat(40), 'b'.repeat(40), '', undefined]) {
        const context = {
          github: { sha: 'a'.repeat(40) },
          needs: {
            prepare: { outputs: { count: '1' } },
            discover: { outputs: { count: '1' } },
            source: { result: 'success' },
            'full-mutation': { result, outputs: { 'qualified-sha': qualified } }
          }
        }
        assert.equal(
          conjunctionPasses(publisher.if, context),
          result === 'success' && qualified === context.github.sha,
          `${file}: ${result}/${qualified}`
        )
      }
    }
    if (file === 'wab-marketplace-release.yml') {
      assert.deepEqual(workflow.jobs.source.permissions, { contents: 'read' })
      assert.ok(
        workflow.jobs.source.steps.some(step => step.name === 'Verify trusted release source')
      )
    } else {
      const prerequisite = file === 'release.yaml' ? 'prepare' : 'discover'
      const context = {
        github: { sha: 'a'.repeat(40) },
        needs: {
          [prerequisite]: { outputs: { count: '0' } },
          'full-mutation': { result: 'success', outputs: { 'qualified-sha': 'a'.repeat(40) } }
        }
      }
      assert.equal(conjunctionPasses(publisher.if, context), false)
      assert.equal(conjunctionPasses(campaign.if, context), false)
    }
  }
})

test('full campaign receipts cannot borrow another attempt or a partial manual target', async () => {
  const { parse } = await import('yaml')
  const workflow = parse(
    readFileSync(join(REPOSITORY_ROOT, '.github/workflows/mutation-tests.yml'), 'utf8')
  )
  assert.equal(workflow.on.workflow_call.inputs, undefined)
  assert.match(
    workflow.on.workflow_call.outputs['qualified-sha'].value,
    /jobs\.mutation-quality\.outputs\.qualified-sha/
  )
  assert.match(
    workflow.jobs.prepare.steps.find(step => step.id === 'targets').run,
    /mode=diagnostic/
  )
  const gate = workflow.jobs['mutation-quality']
  assert.deepEqual(gate.needs, ['prepare', 'mutation-tests'])
  const script = gate.steps.find(step => step.name === 'Verify the campaign').run
  for (const prepare of ['success', 'failure', 'cancelled', 'skipped', '']) {
    for (const mutation of ['success', 'failure', 'cancelled', 'skipped', '']) {
      const run = spawnSync('/bin/bash', ['-e', '-c', script], {
        env: { PREPARE_RESULT: prepare, MUTATION_RESULT: mutation },
        encoding: 'utf8'
      })
      assert.equal(run.status === 0, prepare === 'success' && mutation === 'success')
    }
  }
  const download = gate.steps.find(step => step.uses?.startsWith('actions/download-artifact@'))
  assert.equal(
    download.with.pattern,
    'mutation-receipt-${{ github.run_id }}-${{ github.run_attempt }}-*'
  )
  const capture = workflow.jobs['mutation-tests'].steps.find(
    step => step.name === 'Capture successful exact-source complete target evidence'
  )
  assert.equal(capture.if, undefined)
  assert.match(capture.run, /mutation-final-qualification\.mjs capture/)
  assert.match(
    gate.steps.find(step => step.id === 'qualification').run,
    /mutation-final-qualification\.mjs verify/
  )
  const ci = parse(readFileSync(CI_PATH, 'utf8'))
  const deadline = workflow.jobs['mutation-tests']['timeout-minutes']
  assert.equal(ci.jobs['mutation-tests']['timeout-minutes'], deadline)
  const allowance = JSON.parse(/fromJSON\('([^']+)'\)/.exec(deadline)[1])
  for (const target of [
    'wallet-retained-snapshot',
    'wallet-snapshot-sync',
    'wallet-snapshot-sync-destination',
    'wallet-snapshot-sync-rows',
    'root-eviction-journal',
    'root-eviction-records'
  ])
    assert.ok(allowance.includes(target))
  assert.match(deadline, /&& 90 \|\| 45/)
})
