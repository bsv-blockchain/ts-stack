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
    // always() only lifts GitHub's implicit success(); the remaining clauses
    // must still pass on their own.
    if (clause === 'always()') return true
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
    // infra-release resolves its own campaign or the release.yaml caller's
    // same-run campaign into one exact-source qualification job.
    const gate = file === 'infra-release.yaml' ? 'qualification' : 'full-mutation'
    assert.equal(campaign.uses, './.github/workflows/mutation-tests.yml')
    assert.deepEqual(campaign.permissions, { contents: 'read' })
    assert.equal(campaign.with, undefined)
    assert.ok(publisher.needs.includes(gate))
    assert.ok(publisher.permissions['id-token'] === 'write')
    for (const result of ['success', 'failure', 'cancelled', 'skipped', undefined]) {
      for (const qualified of ['a'.repeat(40), 'b'.repeat(40), '', undefined]) {
        const context = {
          github: { sha: 'a'.repeat(40) },
          needs: {
            approve: { result: 'success' },
            prepare: { outputs: { count: '1' } },
            discover: { result: 'success', outputs: { count: '1' } },
            source: { result: 'success' },
            [gate]: { result, outputs: { 'qualified-sha': qualified } }
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
          approve: { result: 'success' },
          [prerequisite]: { result: 'success', outputs: { count: '0', called: 'false' } },
          [gate]: { result: 'success', outputs: { 'qualified-sha': 'a'.repeat(40) } }
        }
      }
      assert.equal(conjunctionPasses(publisher.if, context), false)
      if (file === 'release.yaml') {
        // The npm campaign starts at t=0 beside prepare; it also qualifies the
        // infrastructure images, so an empty npm set does not skip it.
        assert.equal(campaign.needs, undefined)
        assert.equal(campaign.if, undefined)
      } else {
        assert.equal(conjunctionPasses(campaign.if, context), false)
        // A release.yaml call reuses the caller's qualification of github.sha.
        context.needs.discover.outputs = { count: '1', called: 'true' }
        assert.equal(conjunctionPasses(campaign.if, context), false)
      }
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
  assert.deepEqual(gate.needs, ['prepare', 'mutation-tests', 'partition-aggregate'])
  const script = gate.steps.find(step => step.name === 'Verify the campaign').run
  for (const prepare of ['success', 'failure', 'cancelled', 'skipped', '']) {
    for (const mutation of ['success', 'failure', 'cancelled', 'skipped', '']) {
      const run = spawnSync('/bin/bash', ['-e', '-c', script], {
        env: {
          PREPARE_RESULT: prepare,
          MUTATION_RESULT: mutation,
          PARTITION_TARGETS: '[]',
          PARTITION_RESULT: 'skipped',
          PATH: process.env.PATH
        },
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
  assert.equal(capture.if, "matrix.partition == 'whole'")
  assert.match(capture.run, /mutation-final-qualification\.mjs capture/)
  assert.match(
    gate.steps.find(step => step.id === 'qualification').run,
    /mutation-final-qualification\.mjs verify/
  )
  const ci = parse(readFileSync(CI_PATH, 'utf8'))
  assert.equal(
    ci.jobs.prepare.outputs['partition-targets'],
    '${{ needs.scope.outputs.partition-targets }}'
  )
  assert.equal(
    ci.jobs.scope.outputs['partition-targets'],
    '${{ steps.scope.outputs.partition-targets }}'
  )
  assert.equal(
    workflow.jobs.prepare.outputs['partition-targets'],
    '${{ steps.targets.outputs.partition-targets }}'
  )
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

test('partition jobs cannot replace each original canonical global gate or the final raw-part recheck', async () => {
  const { parse } = await import('yaml')
  const full = parse(
    readFileSync(join(REPOSITORY_ROOT, '.github/workflows/mutation-tests.yml'), 'utf8')
  )
  const ci = parse(readFileSync(CI_PATH, 'utf8'))
  assert.equal(ci.jobs['mutation-tests'].strategy['max-parallel'], 6)
  // Release qualification runs every target at once; one target bounds wall time.
  assert.equal(full.jobs['mutation-tests'].strategy['max-parallel'], 20)
  for (const workflow of [ci, full]) {
    assert.match(workflow.jobs['mutation-tests'].strategy.matrix, /mutation-matrix/)
    assert.match(
      workflow.jobs['mutation-tests'].steps.find(step =>
        step.name?.includes('mutation-quality ratchet')
      ).run,
      /--partition/
    )
  }
  const gate = full.jobs['mutation-quality']
  const script = gate.steps.find(step => step.name === 'Verify the campaign').run
  for (const result of ['success', 'failure', 'cancelled', 'skipped', '']) {
    const run = spawnSync('/bin/bash', ['-e', '-c', script], {
      env: {
        PATH: process.env.PATH,
        PREPARE_RESULT: 'success',
        MUTATION_RESULT: 'success',
        PARTITION_TARGETS: JSON.stringify(['sdk-auth-http', 'wallet-retained-snapshot']),
        PARTITION_RESULT: result
      }
    })
    assert.equal(run.status === 0, result === 'success')
  }
  const recheck = gate.steps.findIndex(
    step =>
      step.name ===
      'Independently recheck every selected canonical partition before full qualification'
  )
  assert.ok(recheck >= 0 && recheck < gate.steps.findIndex(step => step.id === 'qualification'))
  assert.match(gate.steps[recheck].run, /mutation-partition-evidence\.mjs recheck/)
  assert.match(
    ci.jobs['mutation-quality'].steps.find(
      step => step.name === 'Require every selected canonical partition target gate'
    ).run,
    /mutation-partition-evidence\.mjs verify/
  )
  assert.deepEqual(full.jobs['partition-aggregate'].needs, ['prepare', 'mutation-tests'])
  assert.match(full.jobs['partition-aggregate'].strategy.matrix.target, /partition-targets/)
  for (const id of ['sdk-auth-http', 'wallet-retained-snapshot']) {
    const download = ci.jobs['mutation-quality'].steps.find(
      step => step.with?.pattern === `mutation-${id}-*`
    )
    assert.ok(download)
    assert.match(download.if, /partition-targets/)
    assert.equal(download.with.path, `.mutation-parts/${id}`)
  }
  for (const targets of ['[]', '', 'null']) {
    const run = spawnSync('/bin/bash', ['-e', '-c', script], {
      env: {
        PREPARE_RESULT: 'success',
        MUTATION_RESULT: 'success',
        PARTITION_TARGETS: targets,
        PARTITION_RESULT: 'skipped',
        PATH: process.env.PATH
      }
    })
    assert.equal(run.status === 0, targets === '[]')
  }
})

test('PR partial execution cannot qualify when canonical aggregate selection is absent, empty or incomplete', async () => {
  const { parse } = await import('yaml')
  const ci = parse(readFileSync(CI_PATH, 'utf8'))
  const script = ci.jobs['mutation-quality'].steps.find(
    step => step.name === 'Verify the affected mutation targets'
  ).run
  const targets = ['sdk-auth-http', 'wallet-retained-snapshot']
  const matrix = {
    include: targets.flatMap(target =>
      ['first', 'second'].map(partition => ({ target, partition }))
    )
  }
  for (const selection of [
    '',
    '[]',
    'null',
    '["sdk-auth-http"]',
    '["sdk-auth-http","sdk-auth-http"]',
    JSON.stringify(targets)
  ]) {
    const run = spawnSync('/bin/bash', ['-e', '-c', script], {
      env: {
        PATH: process.env.PATH,
        PREPARE_RESULT: 'success',
        MUTATION_RESULT: 'success',
        MUTATION_TARGETS: JSON.stringify(targets),
        MUTATION_CLASSIFICATION: '{"deferred":[]}',
        MUTATION_MATRIX: JSON.stringify(matrix),
        PARTITION_TARGETS: selection,
        GITHUB_STEP_SUMMARY: '/dev/null'
      }
    })
    assert.equal(run.status === 0, selection === JSON.stringify(targets))
  }
  const empty = spawnSync('/bin/bash', ['-e', '-c', script], {
    env: {
      PATH: process.env.PATH,
      NODE_EXECUTABLE: process.execPath,
      PREPARE_RESULT: 'success',
      MUTATION_RESULT: 'skipped',
      MUTATION_TARGETS: '[]',
      MUTATION_CLASSIFICATION: '{"deferred":[]}',
      MUTATION_MATRIX: '{"include":[]}',
      PARTITION_TARGETS: '[]',
      GITHUB_STEP_SUMMARY: '/dev/null'
    }
  })
  assert.equal(empty.status, 0)
})
