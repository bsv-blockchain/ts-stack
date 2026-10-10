import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPOSITORY_ROOT } from '../repository-health.mjs'
import { mutationExecutionBatches } from '../mutation-execution-batches.mjs'
import { partitionedMutationTargets } from '../mutation-partitions.mjs'
import { buildMutationTargets } from '../../governance/mutation-testing/targets.mjs'
const CI_PATH = join(REPOSITORY_ROOT, '.github/workflows/ci.yml')
async function mutationExecutor(workflow) {
  const caller = workflow.jobs['mutation-tests']
  assert.equal(caller.uses, './.github/workflows/mutation-execution.yml')
  assert.deepEqual(caller.permissions, { contents: 'read' })
  const { parse } = await import('yaml')
  const callee = parse(
    readFileSync(join(REPOSITORY_ROOT, '.github/workflows/mutation-execution.yml'), 'utf8')
  )
  assert.ok(callee.on.workflow_call)
  assert.deepEqual(callee.permissions, {})
  assert.deepEqual(callee.jobs.execution.permissions, { contents: 'read' })
  return callee.jobs.execution
}
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
  const executor = await mutationExecutor(workflow)
  assert.equal(workflow.jobs['mutation-tests'].with.profile, 'qualification')
  assert.equal(workflow.jobs['mutation-tests'].with.mode, '${{ needs.prepare.outputs.mode }}')
  const capture = executor.steps.find(
    step => step.name === 'Capture successful exact-source complete target evidence'
  )
  assert.equal(capture.if, "inputs.profile == 'qualification' && matrix.partition == 'whole'")
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
  const ciExecutor = await mutationExecutor(ci)
  assert.equal(ci.jobs['mutation-tests'].with.profile, 'ci')
  assert.equal(ci.jobs['mutation-tests'].with.mode, 'diagnostic')
  const deadline = executor['timeout-minutes']
  assert.equal(ciExecutor['timeout-minutes'], deadline)
  const allowance = JSON.parse([...deadline.matchAll(/fromJSON\('([^']+)'\)/g)].at(-1)[1])
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
  const executor = await mutationExecutor(full)
  assert.deepEqual(await mutationExecutor(ci), executor)
  assert.equal(
    executor.strategy['max-parallel'],
    "${{ inputs.profile == 'qualification' && 20 || 6 }}"
  )
  assert.equal(executor.strategy['fail-fast'], false)
  assert.equal(executor.strategy.matrix, '${{ fromJSON(inputs.execution-matrix) }}')
  const ratchet = executor.steps.find(step => step.name?.includes('mutation-quality ratchet'))
  assert.match(ratchet.run, /--partition/)
  assert.equal(ratchet.env.TARGET, '${{ matrix.target }}')
  assert.equal(ratchet.env.PARTITION, '${{ matrix.partition }}')
  for (const workflow of [ci, full]) {
    const caller = workflow.jobs['mutation-tests']
    assert.equal(caller.strategy['max-parallel'], 1)
    assert.equal(caller.strategy['fail-fast'], false)
    assert.match(caller.strategy.matrix, /mutation-batches/)
    assert.match(workflow.jobs.prepare.outputs['mutation-matrix'], /mutation-matrix/)
    assert.equal(caller.with['execution-matrix'], '${{ toJSON(matrix.executionMatrix) }}')
    assert.equal(caller.with['execution-batch'], '${{ matrix.batch }}')
    assert.equal(
      caller.with['matrix-digest'],
      '${{ needs.prepare.outputs.mutation-matrix-digest }}'
    )
    assert.equal(caller.with.identity, '${{ needs.prepare.outputs.mutation-execution-identity }}')
  }
  const profile = executor.steps.find(
    step => step.name === 'Require the original caller evidence profile'
  )
  assert.match(profile.run, /ci:diagnostic\|qualification:diagnostic\|qualification:full/)
  assert.match(profile.run, /SOURCE_SHA.*GITHUB_SHA/)
  assert.match(profile.run, /SOURCE_RUN_ID.*GITHUB_RUN_ID/)
  assert.match(profile.run, /SOURCE_RUN_ATTEMPT.*GITHUB_RUN_ATTEMPT/)
  assert.match(
    profile.run,
    /ARTIFACT_NAME.*mutation-build-outputs-\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT/
  )
  const checkout = executor.steps.find(step => step.uses?.startsWith('actions/checkout@'))
  assert.equal(checkout.with.ref, '${{ fromJSON(inputs.identity).sourceSha }}')
  assert.equal(checkout.with['persist-credentials'], false)
  const archive = executor.steps.find(step => step.uses?.startsWith('actions/download-artifact@'))
  assert.equal(archive.with['artifact-ids'], '${{ fromJSON(inputs.identity).artifactId }}')
  const verify = executor.steps.findIndex(
    step => step.name === 'Verify complete immutable batch and archive before extraction'
  )
  assert.ok(
    verify >= 0 && verify < executor.steps.findIndex(step => step.name === 'Restore build outputs')
  )
  assert.match(executor.steps[verify].run, /mutation-execution-batches\.mjs verify-execution/)
  const gate = full.jobs['mutation-quality']
  const script = gate.steps.find(step => step.name === 'Verify the campaign').run
  for (const result of ['success', 'failure', 'cancelled', 'skipped', '']) {
    const run = spawnSync('/bin/bash', ['-e', '-c', script], {
      env: {
        PATH: process.env.PATH,
        PREPARE_RESULT: 'success',
        MUTATION_RESULT: 'success',
        PARTITION_TARGETS: JSON.stringify([
          'sdk-auth-http',
          'wallet-retained-snapshot',
          'root-eviction-records'
        ]),
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
  const canonicalTargets = buildMutationTargets(REPOSITORY_ROOT)
  for (const id of partitionedMutationTargets(Object.keys(canonicalTargets), canonicalTargets)) {
    const downloads = ci.jobs['mutation-quality'].steps.filter(
      step => step.with?.pattern === `mutation-${id}-*`
    )
    assert.equal(downloads.length, 1, id)
    const [download] = downloads
    assert.equal(
      download.if,
      `contains(fromJSON(needs.prepare.outputs.partition-targets || '[]'), '${id}')`
    )
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
  const targets = ['sdk-auth-http', 'wallet-retained-snapshot', 'root-eviction-records']
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
    '["sdk-auth-http","wallet-retained-snapshot"]',
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
        MUTATION_BATCHES: JSON.stringify(mutationExecutionBatches(matrix)),
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
      MUTATION_BATCHES: '{"include":[]}',
      PARTITION_TARGETS: '[]',
      GITHUB_STEP_SUMMARY: '/dev/null'
    }
  })
  assert.equal(empty.status, 0)
})

test('the installed PR gate rejects missing, stale and malformed execution batches', async () => {
  const { parse } = await import('yaml')
  const ci = parse(readFileSync(CI_PATH, 'utf8'))
  const script = ci.jobs['mutation-quality'].steps.find(
    step => step.name === 'Verify the affected mutation targets'
  ).run
  const matrix = { include: [{ target: 'sdk-auth-http', partition: 'core' }] },
    batches = mutationExecutionBatches(matrix)
  const execute = value =>
    spawnSync('/bin/bash', ['-e', '-c', script], {
      env: {
        PATH: process.env.PATH,
        PREPARE_RESULT: 'success',
        MUTATION_RESULT: 'success',
        MUTATION_TARGETS: '["sdk-auth-http"]',
        MUTATION_CLASSIFICATION: '{"deferred":[]}',
        MUTATION_MATRIX: JSON.stringify(matrix),
        PARTITION_TARGETS: '["sdk-auth-http"]',
        GITHUB_STEP_SUMMARY: '/dev/null',
        ...(value === undefined ? {} : { MUTATION_BATCHES: value })
      },
      encoding: 'utf8'
    })
  assert.equal(execute(JSON.stringify(batches)).status, 0)
  for (const value of [
    undefined,
    '',
    'null',
    '{"include":[]}',
    JSON.stringify({ ...batches, unknown: true }),
    JSON.stringify({ include: [...batches.include, ...batches.include] }),
    JSON.stringify({ include: [{ batch: 2, executionMatrix: matrix }] }),
    JSON.stringify({
      include: [
        {
          batch: 1,
          executionMatrix: { include: [{ target: 'sdk-auth-http', partition: 'stale' }] }
        }
      ]
    })
  ])
    assert.notEqual(execute(value).status, 0)
})

test('mutation execution retains the exact caller runtime and ordinary CI baseline', async () => {
  const { parse } = await import('yaml')
  const full = parse(
    readFileSync(join(REPOSITORY_ROOT, '.github/workflows/mutation-tests.yml'), 'utf8')
  )
  const fullRuntimes = Object.values(full.jobs).flatMap(job =>
    (job.steps ?? [])
      .filter(step => step.uses?.startsWith('actions/setup-node@'))
      .map(step => step.with['node-version'])
  )
  assert.deepEqual(fullRuntimes, ['24.19.0', '24.19.0', '24.19.0'])
  const executor = await mutationExecutor(full)
  const setup = executor.steps.find(step => step.uses?.startsWith('actions/setup-node@'))
  assert.equal(
    setup.with['node-version'],
    "${{ fromJSON(inputs.identity).nodeVersion || 'v24.18.0' }}"
  )
  const profile = executor.steps.find(
    step => step.name === 'Require the original caller evidence profile'
  )
  assert.equal(
    profile.env.NODE_VERSION,
    "${{ fromJSON(inputs.identity).nodeVersion || 'v24.18.0' }}"
  )
  const source = 'a'.repeat(40)
  for (const version of [
    'v24.18.0',
    'v24.19.0',
    '',
    'latest',
    '24.19.0',
    'v24.19',
    'v24.19.0-extra',
    'v024.19.0',
    'v24.019.0'
  ]) {
    const result = spawnSync('/bin/bash', ['-e', '-c', profile.run], {
      env: {
        PATH: process.env.PATH,
        PROFILE: 'qualification',
        CAMPAIGN_MODE: 'full',
        SOURCE_SHA: source,
        GITHUB_SHA: source,
        SOURCE_RUN_ID: '123',
        GITHUB_RUN_ID: '123',
        SOURCE_RUN_ATTEMPT: '1',
        GITHUB_RUN_ATTEMPT: '1',
        NODE_VERSION: version,
        ARCHIVE_DIGEST: 'b'.repeat(64),
        ARTIFACT_ID: '456',
        ARTIFACT_NAME: 'mutation-build-outputs-123-1'
      },
      encoding: 'utf8'
    })
    assert.equal(result.status === 0, ['v24.18.0', 'v24.19.0'].includes(version), version)
  }
  const ci = parse(readFileSync(CI_PATH, 'utf8'))
  const originalSetup = ci.jobs.prepare.steps.find(step =>
    step.uses?.startsWith('actions/setup-node@')
  )
  assert.equal(originalSetup.with['node-version'], '24.18.0')
  const ciExecutor = await mutationExecutor(ci)
  assert.equal(
    ciExecutor.steps.find(step => step.uses?.startsWith('actions/setup-node@')).with[
      'node-version'
    ],
    "${{ fromJSON(inputs.identity).nodeVersion || 'v24.18.0' }}"
  )
})

test('long complete-job allowances apply only to three qualification targets', async () => {
  const { parse } = await import('yaml')
  const full = parse(
    readFileSync(join(REPOSITORY_ROOT, '.github/workflows/mutation-tests.yml'), 'utf8')
  )
  const executor = await mutationExecutor(full)
  const deadline = executor['timeout-minutes']
  const match =
    /^\$\{\{ inputs\.profile == 'qualification' && contains\(fromJSON\('([^']+)'\), matrix\.target\) && 180 \|\| contains\(fromJSON\('([^']+)'\), matrix\.target\) && 90 \|\| 45 \}\}$/.exec(
      deadline
    )
  assert.ok(match, 'Qualification scope and original diagnostic fallback must remain explicit')
  const extended = JSON.parse(match[1])
  assert.deepEqual(extended, [
    'wallet-funding-controller',
    'revenue-listing-authority',
    'revenue-listing-profile'
  ])
  const originalNinetyMinuteTargets = JSON.parse(match[2])
  const configured = buildMutationTargets(REPOSITORY_ROOT)
  for (const id of extended) {
    assert.ok(Object.hasOwn(configured, id), id)
    assert.equal(originalNinetyMinuteTargets.includes(id), false, id)
  }
})
