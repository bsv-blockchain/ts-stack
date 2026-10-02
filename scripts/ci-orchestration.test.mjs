import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { buildMutationTargets } from '../governance/mutation-testing/targets.mjs'
import { partitionedMutationTargets } from './mutation-partitions.mjs'
import { REPOSITORY_ROOT } from './repository-health.mjs'

const CI_PATH = join(REPOSITORY_ROOT, '.github/workflows/ci.yml')
const CONFORMANCE_PATH = join(REPOSITORY_ROOT, '.github/workflows/conformance.yml')
const RUNTIME_PATH = join(REPOSITORY_ROOT, '.github/workflows/container-runtime-contract.yml')
const WALLET_MOBILE_COVERAGE_PATH = join(
  REPOSITORY_ROOT,
  'packages/wallet/wallet-toolbox/mobile/vitest.config.ts'
)

test('the shared build archive carries application browser and server bundles', () => {
  const workflow = readFileSync(CI_PATH, 'utf8')
  const archiveStep = workflow.match(
    /- name: Archive build outputs\n        run: \|\n([\s\S]*?)\n      - name:/
  )?.[1]
  assert.ok(archiveStep, 'the actual archive command must be exercised')
  const directory = mkdtempSync(join(tmpdir(), 'stack-build-archive-'))
  const included = [
    'packages/example/dist/index.js',
    'packages/example/out/cjs/index.js',
    'packages/example/build.tsbuildinfo',
    'apps/reference/dist/assets/main.js',
    'apps/reference/dist-server/server.js',
    'apps/another app/dist/index.html'
  ]
  const excluded = [
    'apps/reference/src/main.ts',
    'apps/reference/node_modules/dependency/dist/index.js',
    'apps/reference/.stryker-tmp/sandbox/dist/index.js'
  ]
  try {
    for (const path of [...included, ...excluded]) {
      mkdirSync(dirname(join(directory, path)), { recursive: true })
      writeFileSync(join(directory, path), path)
    }
    execFileSync('bash', ['-e', '-o', 'pipefail', '-c', archiveStep], { cwd: directory })
    const entries = execFileSync('tar', ['-tzf', 'build-outputs.tar.gz'], {
      cwd: directory,
      encoding: 'utf8'
    }).split('\n')
    for (const path of included) assert.ok(entries.includes(path), `${path} must be reusable`)
    for (const path of excluded) assert.ok(!entries.includes(path), `${path} is not a build output`)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

function workflowJobBlocks(workflow) {
  const jobsMarker = '\njobs:\n'
  const jobs = workflow.slice(workflow.indexOf(jobsMarker) + jobsMarker.length)
  const matches = [...jobs.matchAll(/^  ([a-z][a-z0-9-]+):$/gm)]
  return matches.map((match, index) => ({
    name: match[1],
    source: jobs.slice(match.index, matches[index + 1]?.index ?? jobs.length)
  }))
}

test('CI shares one audited build across coverage and browser consumer lanes', () => {
  const workflow = readFileSync(CI_PATH, 'utf8')

  assert.equal(workflow.match(/- name: Build workspace/g)?.length, 1)
  assert.match(
    workflow,
    /^      browser-packages: \$\{\{ steps\.scope\.outputs\.browser-packages \}\}$/m
  )
  assert.match(workflow, /^  browser-packages:$/m)
  assert.match(
    workflow,
    /^      matrix: \$\{\{ fromJSON\(needs\.prepare\.outputs\.browser-matrix\) \}\}$/m
  )
  assert.match(workflow, /PREBUILT_PACKAGE_OUTPUTS: '1'/)
  assert.match(workflow, /^  early-gates:$/m)
  assert.match(workflow, /Stop before installing or building when a cheap gate failed/)
  assert.match(workflow, /AFFECTED=\$\(jq -r '\.\[\]\.name' <<<"\$AFFECTED_PROJECTS"\)/)
  assert.match(workflow, /"wallet_client:@bsv\/wallet-toolbox-client"/)
  assert.match(workflow, /BROWSER_COMPOSITION_DIRECTORY:/)
  assert.match(workflow, /name: browser-composition-\$\{\{ matrix\.shard \}\}/)
  assert.match(workflow, /name: browser-composition-sdk/)
  assert.match(workflow, /name: browser-composition-verifast/)
  assert.match(workflow, /name: browser-composition-wallet/)
  assert.match(workflow, /run-prebuilt-package-script\.mjs" \\\n\s+--script test:browser/)
  assert.match(workflow, /run-prebuilt-package-script\.mjs" \\\n\s+--script test:coverage/)
  assert.match(workflow, /^  dependent-tests:$/m)
  assert.match(workflow, /run-prebuilt-package-script\.mjs" \\\n\s+--script test/)
  assert.doesNotMatch(workflow, /@bsv\/sdk run test:coverage/)
  assert.doesNotMatch(workflow, /@bsv\/verifast run test:coverage/)
  assert.doesNotMatch(workflow, /pnpm -r --no-sort "\$\{filters\[@\]\}" run test:coverage/)
  assert.match(workflow, /^      - browser-packages$/m)
  assert.match(workflow, /^      - dependent-tests$/m)
  assert.match(
    workflow,
    /\( "\$PACKAGE_BROWSER_RESULT" != "success" && "\$PACKAGE_BROWSER_RESULT" != "skipped" \)/
  )
})

test('CI skips empty duplicate lanes without weakening the aggregate gate', () => {
  const workflow = readFileSync(CI_PATH, 'utf8')

  assert.match(
    workflow,
    /^    if: always\(\) && !cancelled\(\) && needs\.prepare\.result == 'success' && needs\.prepare\.outputs\.standard-packages != '\[\]'$/m
  )
  assert.match(
    workflow,
    /^    if: always\(\) && !cancelled\(\) && needs\.prepare\.result == 'success' && needs\.prepare\.outputs\.dependent-test-packages != '\[\]'$/m
  )
  assert.match(
    workflow,
    /^    if: always\(\) && !cancelled\(\) && needs\.prepare\.result == 'success' && needs\.prepare\.outputs\.coverage-other-packages != '\[\]'$/m
  )
  assert.match(
    workflow,
    /^      matrix: \$\{\{ fromJSON\(needs\.prepare\.outputs\.coverage-other-matrix\) \}\}$/m
  )
  assert.match(workflow, /if length > 1 then \{include:/)
  assert.match(workflow, /needs\.prepare\.outputs\.coverage-required == 'true'/)
  assert.match(workflow, /\( "\$TEST_RESULT" != "success" && "\$TEST_RESULT" != "skipped" \)/)
  assert.match(workflow, /grep -Fxq '@bsv\/overlay-topics'/)
  assert.equal(workflow.match(/mongodb-memory-server binary cache warmed/g)?.length, 2)
})

test('CI contributes mobile and type-only wallet surfaces to aggregate patch coverage', () => {
  const workflow = readFileSync(CI_PATH, 'utf8')
  const mobileCoverage = readFileSync(WALLET_MOBILE_COVERAGE_PATH, 'utf8')

  assert.match(workflow, /pnpm --filter @bsv\/wallet-toolbox-mobile run test:coverage/)
  assert.match(workflow, /name: coverage-wallet-mobile/)
  assert.match(workflow, /^      - wallet-mobile-platform$/m)
  for (const source of ['index.mobile.ts', 'BulkIngestorApi.ts', 'ChaintracksClientApi.ts']) {
    assert.ok(mobileCoverage.includes(source), `${source} must be present in mobile LCOV`)
  }
})

test('CI push jobs survive intentionally skipped pull-request-only gates', () => {
  const workflow = readFileSync(CI_PATH, 'utf8')
  const jobs = Object.fromEntries(workflowJobBlocks(workflow).map(job => [job.name, job.source]))
  const directGateCondition =
    "always() && !cancelled() && needs.early-gates.result == 'success' && needs.scope.result == 'success'"

  assert.ok(jobs.prepare.includes(`    if: ${directGateCondition}\n`))
  assert.ok(jobs['infra-scope'].includes(`    if: ${directGateCondition}\n`))
  for (const jobName of ['docs-validate', 'conformance']) {
    assert.match(jobs[jobName], /^    if: >-$/m)
    assert.match(jobs[jobName], /^      always\(\) && !cancelled\(\) &&$/m)
    assert.match(jobs[jobName], /^      needs\.early-gates\.result == 'success' &&$/m)
    assert.match(jobs[jobName], /^      needs\.scope\.result == 'success' &&$/m)
  }
})

test('CI bounds every job and allocates no runner for an empty infrastructure matrix', () => {
  const workflow = readFileSync(CI_PATH, 'utf8')
  const jobs = workflowJobBlocks(workflow)

  assert.ok(jobs.length > 0)
  for (const job of jobs) {
    if (job.name === 'mutation-tests') {
      const expected = `    timeout-minutes: \${{ contains(fromJSON('["revenue-lineage-package","revenue-lineage-graph","sdk-revenue-listing-funding","output-lookup-session-records","output-lookup-session-payloads","wallet-recovery-codec","wallet-recovery-installation","wallet-recovery-store","wallet-funding-store","wallet-recovery-transitions","wallet-recovery-controller","root-eviction-storage","root-eviction-journal","root-eviction-records","wallet-retained-snapshot","wallet-snapshot-sync","wallet-snapshot-sync-destination","wallet-snapshot-sync-rows","wallet-snapshot-archive","wallet-snapshot-remote-http","root-eviction-codec"]'), matrix.target) && 90 || 45 }}`
      assert.equal(job.source.match(/^    timeout-minutes: .+$/m)?.[0], expected)
      const dedicated = readFileSync(
        join(REPOSITORY_ROOT, '.github/workflows/mutation-tests.yml'),
        'utf8'
      )
      const dedicatedJob = workflowJobBlocks(dedicated).find(
        candidate => candidate.name === 'mutation-tests'
      )
      assert.equal(dedicatedJob?.source.match(/^    timeout-minutes: .+$/m)?.[0], expected)
    } else {
      assert.match(job.source, /^    timeout-minutes: \d+$/m, `${job.name} must have a timeout`)
    }
  }
  assert.match(workflow, /^      has-infra: \$\{\{ steps\.scope\.outputs\.has-infra \}\}$/m)
  assert.match(
    workflow,
    /^    if: always\(\) && !cancelled\(\) && needs\.infra-scope\.result == 'success' && needs\.infra-scope\.outputs\.has-infra == 'true'$/m
  )
  assert.match(workflow, /\( "\$INFRA_RESULT" != "success" && "\$INFRA_RESULT" != "skipped" \)/)
})

test('specialized workflows are bounded and required conformance checks always run on PRs', () => {
  const conformance = readFileSync(CONFORMANCE_PATH, 'utf8')
  const runtime = readFileSync(RUNTIME_PATH, 'utf8')

  assert.equal(conformance.match(/- 'conformance\/\*\*'/g)?.length, 1)
  assert.match(conformance, /^  pull_request:\n    branches: \[main\]\n\nconcurrency:/m)
  assert.match(conformance, /^    timeout-minutes: 30$/m)
  assert.match(runtime, /^    timeout-minutes: 10$/m)
  assert.match(runtime, /^    if: needs\.scope\.outputs\.has-runtime == 'true'$/m)
})

test('all selected execution jobs survive skipped ancestors and expose a strict final gate', () => {
  const workflow = readFileSync(CI_PATH, 'utf8')
  const jobs = workflowJobBlocks(workflow)
  const selected = jobs.filter(
    job => job.name === 'mutation-tests' || /^    needs: (?:prepare|infra-scope)$/m.test(job.source)
  )
  assert.equal(selected.length, 14)
  for (const job of selected) {
    if (job.name === 'mutation-tests') continue // Its analyzer prerequisite is tested below.
    assert.match(
      job.source,
      /^    if: always\(\) && !cancelled\(\) && needs\.(?:prepare|infra-scope)\.result == 'success'(?: && |$)/m,
      job.name
    )
  }
  assert.match(workflow, /^  workflow_dispatch:$/m)
  assert.doesNotMatch(workflow, /fail-fast: true/)
  const gate = jobs.find(job => job.name === 'merge-gate').source
  for (const job of selected) assert.ok(gate.includes(`      - ${job.name}\n`), job.name)
  assert.match(gate, /CI_NEEDS: \$\{\{ toJSON\(needs\) \}\}/)
  assert.match(gate, /run: node scripts\/ci-result-gate\.mjs/)
})

test('fork PRs retain advisory Codecov reports without a privileged workflow', () => {
  const workflow = readFileSync(CI_PATH, 'utf8')
  for (const step of [
    'Upload coverage to Codecov',
    'Wait for Codecov to merge the uploaded report',
    'Publish finalized Codecov notifications'
  ]) {
    assert.ok(
      workflow.includes(
        `      - name: ${step}\n        if: steps.cov.outputs.has-coverage == 'true'\n`
      )
    )
  }
  assert.doesNotMatch(workflow, /pull_request_target|id-token:\s*write/)
  assert.match(workflow, /run: >-\n          node scripts\/patch-coverage\.mjs/)
})

test('analysis gates mutation without serializing the shared build or external reporting', () => {
  const jobs = Object.fromEntries(
    workflowJobBlocks(readFileSync(CI_PATH, 'utf8')).map(job => [job.name, job.source])
  )
  assert.doesNotMatch(jobs['early-gates'], /sonar-zero-findings|SONAR_RESULT/)
  assert.doesNotMatch(jobs.prepare, /      - sonar-zero-findings/)
  assert.match(jobs['mutation-tests'], /      - sonar-zero-findings/)
  assert.match(jobs['merge-gate'], /      - sonar-zero-findings/)
  assert.match(jobs['merge-gate'], /      - package-artifacts/)
  assert.doesNotMatch(jobs.prepare, /name: Verify changed package artifacts/)
  assert.match(jobs['package-artifacts'], /name: Verify changed package artifacts/)
  assert.match(
    jobs['package-artifacts'],
    /name: Compile documentation examples against exact package tarballs/
  )
  assert.match(jobs['coverage-upload'], /--target 90/)
  assert.doesNotMatch(jobs['coverage-upload'], /Wait for Codecov/)
  assert.match(jobs['coverage-report'], /continue-on-error: true/)
  assert.doesNotMatch(jobs['merge-gate'], /      - coverage-report/)
})

function mutationEligibility(options = {}) {
  const { event, prepare, sonar, targets, labels, diagnosticInput, workflowCancelled } = {
    event: 'pull_request',
    prepare: 'success',
    sonar: 'success',
    targets: '["selected"]',
    labels: [],
    diagnosticInput: false,
    workflowCancelled: false,
    ...options
  }
  const job = workflowJobBlocks(readFileSync(CI_PATH, 'utf8')).find(
    candidate => candidate.name === 'mutation-tests'
  ).source
  const folded = /^    if: >-\n((?:      .*\n)+)/m.exec(job)
  const source = folded
    ? folded[1]
        .trim()
        .split('\n')
        .map(line => line.trim())
        .join(' ')
    : /^    if: (.*)$/m.exec(job)[1]
  // Evaluate the actual authored job expression, not a second copy of the policy.
  const expression = source
    .replaceAll(
      'needs.prepare.outputs.mutation-targets',
      'needs.prepare.outputs["mutation-targets"]'
    )
    .replaceAll('needs.sonar-zero-findings.result', 'needs["sonar-zero-findings"].result')
    .replaceAll('github.event.pull_request.labels.*.name', 'labels')
    .replaceAll('inputs.mutation-diagnostics', 'inputs["mutation-diagnostics"]')
  const evaluate = new Function(
    'needs',
    'github',
    'inputs',
    'labels',
    'always',
    'cancelled',
    'contains',
    `return Boolean(${expression})`
  )
  return evaluate(
    {
      prepare: { result: prepare, outputs: { 'mutation-targets': targets } },
      'sonar-zero-findings': { result: sonar }
    },
    { event_name: event },
    { 'mutation-diagnostics': diagnosticInput },
    labels,
    () => true,
    () => workflowCancelled,
    (values, value) => values.includes(value)
  )
}

test('mutation defaults to successful exact-head PR analysis and a successful shared build', () => {
  assert.equal(mutationEligibility(), true)
  for (const sonar of ['failure', 'cancelled', 'skipped', 'in_progress', undefined, '']) {
    assert.equal(mutationEligibility({ sonar }), false, `PR analysis: ${sonar}`)
  }
  for (const prepare of ['failure', 'cancelled', 'skipped', undefined]) {
    assert.equal(mutationEligibility({ prepare, labels: ['ci:mutation-diagnostics'] }), false)
  }
  for (const targets of ['[]', '', undefined]) {
    assert.equal(mutationEligibility({ targets }), false)
  }
  assert.equal(mutationEligibility({ workflowCancelled: true }), false)
})

test('main and full manual mutation survive only the intentional PR analysis skip', () => {
  for (const event of ['push', 'workflow_dispatch']) {
    assert.equal(mutationEligibility({ event, sonar: 'skipped' }), true)
    for (const sonar of ['failure', 'cancelled', undefined]) {
      assert.equal(mutationEligibility({ event, sonar }), false)
    }
  }
})

test('explicit diagnostics collect analyzer failures without bypassing build or cancellation', () => {
  for (const sonar of ['failure', 'cancelled', 'skipped', undefined]) {
    assert.equal(mutationEligibility({ sonar, labels: ['ci:mutation-diagnostics'] }), true)
    assert.equal(mutationEligibility({ sonar, diagnosticInput: true }), false)
    assert.equal(
      mutationEligibility({ event: 'workflow_dispatch', sonar, diagnosticInput: true }),
      true
    )
  }
  assert.equal(mutationEligibility({ sonar: 'failure', labels: ['unrelated'] }), false)
  assert.equal(
    mutationEligibility({
      sonar: 'failure',
      labels: ['ci:mutation-diagnostics'],
      workflowCancelled: true
    }),
    false
  )
  assert.equal(
    mutationEligibility({ event: 'workflow_dispatch', prepare: 'failure', diagnosticInput: true }),
    false
  )
  assert.equal(
    mutationEligibility({ event: 'workflow_dispatch', targets: '[]', diagnosticInput: true }),
    false
  )
  const workflow = readFileSync(CI_PATH, 'utf8')
  assert.match(workflow, /^      mutation-diagnostics:\n/m)
  assert.match(workflow, /mutation-diagnostics:[\s\S]*?type: boolean\n        default: false/)
  assert.doesNotMatch(workflow, /pull_request_target/)
})

test('every HTTP latency scenario retains its own required coverage execution', () => {
  const jobs = Object.fromEntries(
    workflowJobBlocks(readFileSync(CI_PATH, 'utf8')).map(job => [job.name, job.source])
  )
  const wallet = jobs['coverage-wallet']
  const suite = readFileSync(
    join(
      REPOSITORY_ROOT,
      'packages/wallet/wallet-toolbox/src/storage/sync/syncTransferHttp.test.ts'
    ),
    'utf8'
  )
  const latencies = JSON.parse(suite.match(/test\.each\((\[[\d, ]+\])\)/)[1])
  const selected = [...wallet.matchAll(/id: sync-http-(\d+), latency: (\d+)/g)]
  assert.deepEqual(
    selected.map(match => Number(match[2])),
    latencies
  )
  assert.ok(selected.every(match => match[1] === match[2]))
  assert.equal(wallet.match(/id: shard-\d, shard: \d/g).length, 4)
  assert.match(
    wallet,
    /--runInBand --runTestsByPath src\/storage\/sync\/syncTransferHttp\.test\.ts/
  )
  assert.match(wallet, /--testNamePattern="with \$SYNC_LATENCY ms request latency"/)
  assert.match(wallet, /args=\(--coverage --coverageDirectory=coverage\/\$\{\{ matrix\.id \}\}\)/)
  assert.match(wallet, /name: coverage-wallet-\$\{\{ matrix\.id \}\}/)
  assert.doesNotMatch(wallet, /continue-on-error|passWithNoTests/)
})

test('the mutation quality job accepts skipped execution only for explicitly empty scope', () => {
  const job = workflowJobBlocks(readFileSync(CI_PATH, 'utf8')).find(
    candidate => candidate.name === 'mutation-quality'
  ).source
  assert.match(job, /MUTATION_TARGETS: \$\{\{ needs\.prepare\.outputs\.mutation-targets \}\}/)
  const script = /        run: \|\n([\s\S]*?)(?=\n      -|$)/
    .exec(job)[1]
    .split('\n')
    .map(line => line.replace(/^          /, ''))
    .join('\n')
  for (const targets of ['[]', '["selected"]', '']) {
    for (const result of ['success', 'skipped', 'failure', 'cancelled', '']) {
      const execution = spawnSync('/bin/bash', ['-e', '-c', script], {
        env: {
          NODE_EXECUTABLE: process.execPath,
          MUTATION_MATRIX: '{"include":[]}',
          PARTITION_TARGETS: '[]',
          PREPARE_RESULT: 'success',
          MUTATION_TARGETS: targets,
          MUTATION_RESULT: result,
          MUTATION_CLASSIFICATION: '{"deferred":[]}',
          GITHUB_STEP_SUMMARY: '/dev/null',
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin'
        },
        encoding: 'utf8'
      })
      assert.equal(execution.error, undefined)
      const permitted = result === 'success' || (result === 'skipped' && targets === '[]')
      assert.equal(execution.status === 0, permitted, `${targets}: ${result}`)
    }
  }
  const failedBuild = spawnSync('/bin/bash', ['-e', '-c', script], {
    env: { PREPARE_RESULT: 'failure', MUTATION_TARGETS: '[]', MUTATION_RESULT: 'skipped' }
  })
  assert.notEqual(failedBuild.status, 0)
})

test('every selected application execution part is downloaded before canonical aggregation', () => {
  const targets = buildMutationTargets(REPOSITORY_ROOT)
  const application = Object.keys(targets).filter(
    id => targets[id].packageDirectory === 'packages/application/output-knowledge'
  )
  const selected = partitionedMutationTargets(application, targets)
  assert.ok(selected.includes('output-knowledge-proposal-core'))
  assert.ok(selected.includes('proposal-journal-send'))
  assert.ok(selected.includes('proposal-channel-storage'))
  const aggregate = workflowJobBlocks(readFileSync(CI_PATH, 'utf8')).find(
    job => job.name === 'mutation-quality'
  ).source
  const steps = aggregate.split(/\n      - /)
  for (const id of selected) {
    const downloads = steps.filter(
      step =>
        step.startsWith('uses: actions/download-artifact@') &&
        step.includes(`pattern: mutation-${id}-*\n`)
    )
    assert.equal(downloads.length, 1, id)
    assert.ok(
      downloads[0].includes(
        `if: contains(fromJSON(needs.prepare.outputs.partition-targets || '[]'), '${id}')\n`
      ),
      id
    )
    assert.ok(
      downloads[0].split('\n').some(line => line.trim() === `path: .mutation-parts/${id}`),
      id
    )
    assert.ok(
      aggregate.indexOf(downloads[0]) <
        aggregate.indexOf('name: Require every selected canonical partition target gate'),
      id
    )
  }
  assert.ok(
    aggregate.includes('node scripts/mutation-partition-evidence.mjs verify --mode diagnostic')
  )
  assert.ok(aggregate.includes('--target "$target" --directory ".mutation-parts/$target"'))
})

test('wallet recovery encoding downloads both complete execution parts before canonical aggregation', () => {
  const id = 'wallet-recovery-encoding'
  const selected = partitionedMutationTargets([id], buildMutationTargets(REPOSITORY_ROOT))
  assert.deepEqual(selected, [id])
  const aggregate = workflowJobBlocks(readFileSync(CI_PATH, 'utf8')).find(
    job => job.name === 'mutation-quality'
  ).source
  const downloads = aggregate
    .split(/\n      - /)
    .filter(
      step =>
        step.startsWith('uses: actions/download-artifact@') &&
        step.includes(`pattern: mutation-${id}-*\n`)
    )
  assert.equal(downloads.length, 1)
  assert.ok(
    downloads[0].includes(
      `contains(fromJSON(needs.prepare.outputs.partition-targets || '[]'), '${id}')`
    )
  )
  assert.ok(downloads[0].includes(`path: .mutation-parts/${id}`))
})

test('protected ledger aggregation requires selected complete execution artifacts', () => {
  const id = 'protected-ledger'
  assert.deepEqual(partitionedMutationTargets([id], buildMutationTargets(REPOSITORY_ROOT)), [id])
  const aggregate = workflowJobBlocks(readFileSync(CI_PATH, 'utf8')).find(
    job => job.name === 'mutation-quality'
  ).source
  const downloads = aggregate
    .split(/\n      - /)
    .filter(
      step =>
        step.startsWith('uses: actions/download-artifact@') &&
        step.includes(`pattern: mutation-${id}-*\n`)
    )
  assert.equal(downloads.length, 1)
  assert.ok(
    downloads[0].includes(
      `contains(fromJSON(needs.prepare.outputs.partition-targets || '[]'), '${id}')`
    )
  )
  assert.ok(downloads[0].includes(`path: .mutation-parts/${id}`))
  assert.ok(
    aggregate.indexOf(downloads[0]) <
      aggregate.indexOf('name: Require every selected canonical partition target gate')
  )
})
