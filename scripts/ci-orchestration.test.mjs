import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { buildMutationTargets } from '../governance/mutation-testing/targets.mjs'
import { planShards } from './ci-shard-plan.mjs'
import { mutationExecutionMatrix, partitionedMutationTargets } from './mutation-partitions.mjs'
import { APPLICATION_COVERAGE_SHARDS } from './output-knowledge-coverage-validation.mjs'
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
    /- name: Archive build outputs\n {8}run: \|\n([\s\S]*?)\n {6}- name:/
  )?.[1]
  assert.ok(archiveStep, 'the actual archive command must be exercised')
  const directory = mkdtempSync(join(tmpdir(), 'stack-build-archive-'))
  const included = [
    'packages/example/dist/index.js',
    'packages/example/out/cjs/index.js',
    'packages/example/build.tsbuildinfo',
    'apps/reference/dist/assets/main.js',
    'apps/reference/dist-server/server.js',
    'apps/reference/dist-proposals/proposalNodeServer.js',
    'apps/reference/dist-proposals/licenses/LICENSE.txt',
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
    execFileSync('/bin/bash', ['-e', '-o', 'pipefail', '-c', archiveStep], { cwd: directory })
    const entries = execFileSync('/usr/bin/tar', ['-tzf', 'build-outputs.tar.gz'], {
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

test('installed engine regressions run unconditionally after frozen installation and before build reuse', () => {
  const workflow = readFileSync(CI_PATH, 'utf8')
  const policy = workflowJobBlocks(workflow).find(job => job.name === 'policy').source
  const steps = policy.split(/\n {6}- /)
  const installed = steps.findIndex(step =>
    step.includes('run: pnpm install --frozen-lockfile --ignore-scripts')
  )
  const engine = steps.findIndex(step =>
    step.startsWith('name: Test installed mutation engine controls\n')
  )
  const rebuild = steps.findIndex(step =>
    step.startsWith('name: Rebuild the audited workspace build tool\n')
  )
  const reuse = steps.findIndex(step => step.startsWith('uses: actions/download-artifact@'))
  assert.ok(installed >= 0 && engine > installed && rebuild > engine && reuse > engine)
  assert.match(
    steps[engine],
    /run: node --test scripts\/mutation-partitions-engine\.integration\.mjs(?:\n|$)/
  )
  assert.doesNotMatch(steps[engine], /(?:if:|continue-on-error:)/)
  assert.equal(
    workflow.match(/node --test scripts\/mutation-partitions-engine\.integration\.mjs/g)?.length,
    1
  )
  const health = workflowJobBlocks(workflow).find(job => job.name === 'repository-health').source
  assert.match(health, /node --test scripts\/\*\.test\.mjs/)
  assert.doesNotMatch(health, /mutation-partitions-engine\.integration|pnpm install/)
})

test('CI shares one audited build across coverage and browser consumer lanes', () => {
  const workflow = readFileSync(CI_PATH, 'utf8')

  assert.equal(workflow.match(/- name: Build workspace/g)?.length, 1)
  assert.match(
    workflow,
    /^      browser-packages: \$\{\{ steps\.lanes\.outputs\.browser-packages \}\}$/m
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

test('application coverage shards retain the complete selection and a required merged global gate', () => {
  const workflow = readFileSync(CI_PATH, 'utf8')
  const jobs = Object.fromEntries(workflowJobBlocks(workflow).map(job => [job.name, job.source]))
  const command = jobs.scope.match(
    /COVERAGE_OTHER_MATRIX=\$\(jq -c --argjson all "\$COVERAGE_OTHER_PACKAGES" '([\s\S]*?)' <<<"\$COVERAGE_OTHER_MATRIX"\)/
  )?.[1]
  assert.ok(command)
  for (const selected of [
    [],
    ['@bsv/output-knowledge'],
    ['other'],
    ['other', 'second'],
    ['other', '@bsv/output-knowledge', 'second']
  ]) {
    const planned = planShards(
      selected.filter(name => name !== '@bsv/output-knowledge'),
      {}
    )
    const rows = JSON.parse(
      execFileSync('jq', ['-c', '--argjson', 'all', JSON.stringify(selected), command], {
        input: JSON.stringify(planned),
        encoding: 'utf8'
      })
    ).include
    const application = rows.filter(row => row.application !== 0)
    assert.deepEqual(
      application.map(row => row.application),
      selected.includes('@bsv/output-knowledge')
        ? Array.from({ length: APPLICATION_COVERAGE_SHARDS }, (_, index) => index + 1)
        : []
    )
    assert.ok(
      application.every(
        row => row.total === APPLICATION_COVERAGE_SHARDS && row.shard === row.application
      )
    )
    const other = selected.filter(name => name !== '@bsv/output-knowledge')
    const packageRows = rows.filter(row => row.application === 0)
    const union = packageRows.flatMap(row => row.packages)
    assert.deepEqual(union.sort(), [...other].sort())
    assert.equal(new Set(rows.map(row => row.id)).size, rows.length)
  }
  assert.match(jobs['coverage-other'], /^    timeout-minutes: 35$/m)
  assert.match(jobs['coverage-other'], /node scripts\/output-knowledge-coverage.mjs collect/)
  assert.match(jobs['coverage-other'], /name: coverage-other-\$\{\{ matrix.id \}\}/)
  assert.match(jobs['coverage-upload'], /node scripts\/output-knowledge-coverage.mjs aggregate/)
  assert.match(jobs['coverage-upload'], /output-knowledge.lcov.info/)
  assert.match(jobs['coverage-upload'], /needs.coverage-other.result == 'success'/)
  assert.match(jobs['merge-gate'], /^      - coverage-upload$/m)
  assert.doesNotMatch(
    jobs['coverage-other'] + jobs['coverage-upload'],
    /continue-on-error|passWithNoTests/
  )
  const steps = jobs.policy.split(/\n {6}- /)
  const installed = steps.findIndex(step =>
    step.includes('run: pnpm install --frozen-lockfile --ignore-scripts')
  )
  const reporting = steps.findIndex(step =>
    step.startsWith('name: Test installed application coverage reporting\n')
  )
  const reuse = steps.findIndex(step => step.startsWith('uses: actions/download-artifact@'))
  assert.ok(installed >= 0 && reporting > installed && reuse > reporting)
  assert.match(
    steps[reporting],
    /run: node --test scripts\/output-knowledge-coverage\.integration\.mjs/
  )
  assert.doesNotMatch(steps[reporting], /if:|continue-on-error:|passWithNoTests/)
})

test('CI push jobs survive intentionally skipped pull-request-only gates', () => {
  const workflow = readFileSync(CI_PATH, 'utf8')
  const jobs = Object.fromEntries(workflowJobBlocks(workflow).map(job => [job.name, job.source]))
  const directGateCondition =
    "always() && !cancelled() && needs.early-gates.result == 'success' && needs.scope.result == 'success'"

  // Lint, policy and typecheck wait for every early gate and the shared build.
  for (const prerequisite of ['early-gates', 'scope', 'build'])
    assert.match(jobs.policy, new RegExp(`^      - ${prerequisite}$`, 'm'))
  assert.match(jobs.policy, /needs\.early-gates\.result == 'success' &&$/m)
  assert.match(jobs.policy, /name: Typecheck workspace/)
  assert.ok(jobs['infra-scope'].includes(`    if: ${directGateCondition}\n`))
  // The build overlaps the repository-health contract; test lanes still wait
  // for every early gate and the shared build before they start.
  // The build waits for nothing; it builds every package from the cache.
  assert.doesNotMatch(jobs.build, /^    needs:/m)
  assert.match(jobs.build, /scripts\/build-output-cache\.mjs names/)
  for (const prerequisite of ['early-gates', 'scope', 'build'])
    assert.match(jobs.prepare, new RegExp(`^      - ${prerequisite}$`, 'm'))
  assert.match(jobs.prepare, /needs\.early-gates\.result == 'success' &&$/m)
  assert.match(jobs.prepare, /needs\.build\.result == 'success'$/m)
  for (const gate of ['merge-gate', 'build-and-test'])
    assert.match(jobs[gate], /^      - policy$/m, gate)
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
      const executor = readFileSync(
        join(REPOSITORY_ROOT, '.github/workflows/mutation-execution.yml'),
        'utf8'
      )
      const executionJob = workflowJobBlocks(executor).find(
        candidate => candidate.name === 'execution'
      )
      const actualTimeout = executionJob?.source.match(/^ {4}timeout-minutes: .+$/m)?.[0]
      const qualificationPrefix = `inputs.profile == 'qualification' && contains(fromJSON('["wallet-funding-controller","revenue-listing-authority","revenue-listing-profile","lch-overlay-acquisition","lch-overlay-covenant","lch-overlay-covenant-candidate","private-purchase-evidence","private-purchase-coordination","private-purchase-native-clock","private-purchase-disclosure","output-knowledge-proposal-core"]'), matrix.target) && 180 || `
      assert.equal(actualTimeout, expected.replace('${{ ', '${{ ' + qualificationPrefix))
      assert.equal(actualTimeout.replace(qualificationPrefix, ''), expected)
      const dedicated = readFileSync(
        join(REPOSITORY_ROOT, '.github/workflows/mutation-tests.yml'),
        'utf8'
      )
      const dedicatedJob = workflowJobBlocks(dedicated).find(
        candidate => candidate.name === 'mutation-tests'
      )
      for (const caller of [job, dedicatedJob]) {
        assert.ok(caller)
        assert.match(caller.source, /^ {4}uses: \.\/\.github\/workflows\/mutation-execution\.yml$/m)
        assert.doesNotMatch(caller.source, /^ {4}(?:timeout-minutes|runs-on):/m)
      }
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
  assert.equal(selected.length, 15)
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
  // Every planned shard has a matrix row, so no test file can go unrun.
  const shardRows = wallet.match(/id: shard-\d+, shard: \d+/g).length
  assert.equal(Number(wallet.match(/--shard="\$WALLET_SHARD\/(\d+)"/)[1]), shardRows)
  assert.match(
    wallet,
    /--testSequencer="\$GITHUB_WORKSPACE\/scripts\/jest-duration-sequencer\.cjs"/
  )
  assert.match(wallet, /JEST_SHARD_LANE=wallet-toolbox-coverage/)
  assert.match(
    wallet,
    /--runInBand --runTestsByPath src\/storage\/sync\/syncTransferHttp\.test\.ts/
  )
  assert.match(wallet, /--testNamePattern="with \$SYNC_LATENCY ms request latency"/)
  assert.match(wallet, /args=\(--coverage --coverageDirectory=coverage\/\$\{\{ matrix\.id \}\}\)/)
  assert.match(wallet, /name: coverage-wallet-\$\{\{ matrix\.id \}\}/)
  assert.doesNotMatch(wallet, /continue-on-error|passWithNoTests/)
})

function mutationQualityGateScript(job) {
  return / {8}run: \|\n([\s\S]*?)(?=\n {6}-|$)/
    .exec(job)[1]
    .split('\n')
    .map(line => line.replace(/^ {10}/, ''))
    .join('\n')
}

test('the mutation quality job accepts skipped execution only for explicitly empty scope', () => {
  const job = workflowJobBlocks(readFileSync(CI_PATH, 'utf8')).find(
    candidate => candidate.name === 'mutation-quality'
  ).source
  assert.match(job, /MUTATION_TARGETS: \$\{\{ needs\.prepare\.outputs\.mutation-targets \}\}/)
  const script = mutationQualityGateScript(job)
  for (const targets of ['[]', '["selected"]', '']) {
    for (const result of ['success', 'skipped', 'failure', 'cancelled', '']) {
      const execution = spawnSync('/bin/bash', ['-e', '-c', script], {
        env: {
          NODE_EXECUTABLE: process.execPath,
          MUTATION_MATRIX: '{"include":[]}',
          MUTATION_BATCHES: '{"include":[]}',
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

test('the actual required mutation gate rejects missing, altered and unordered execution batches', () => {
  const job = workflowJobBlocks(readFileSync(CI_PATH, 'utf8')).find(
    candidate => candidate.name === 'mutation-quality'
  ).source
  const script = mutationQualityGateScript(job)
  const matrix = {
    include: Array.from({ length: 257 }, (_, index) => ({
      target: `fixture-${index}`,
      partition: 'whole'
    }))
  }
  const batches = {
    include: [
      { batch: 1, executionMatrix: { include: matrix.include.slice(0, 256) } },
      { batch: 2, executionMatrix: { include: matrix.include.slice(256) } }
    ]
  }
  const execute = value =>
    spawnSync('/bin/bash', ['-e', '-c', script], {
      env: {
        NODE_EXECUTABLE: process.execPath,
        MUTATION_MATRIX: JSON.stringify(matrix),
        MUTATION_BATCHES: JSON.stringify(value),
        PARTITION_TARGETS: '[]',
        PREPARE_RESULT: 'success',
        MUTATION_TARGETS: '["selected"]',
        MUTATION_RESULT: 'success',
        MUTATION_CLASSIFICATION: '{"deferred":[]}',
        GITHUB_STEP_SUMMARY: '/dev/null',
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin'
      },
      encoding: 'utf8'
    })
  assert.equal(execute(batches).status, 0)
  for (const altered of [
    {},
    { include: [] },
    { include: batches.include.slice(0, 1) },
    { include: [...batches.include].reverse() },
    { include: [...batches.include, batches.include[0]] },
    { include: batches.include, unknown: true },
    { include: [{ batch: 1, executionMatrix: matrix }] }
  ])
    assert.notEqual(execute(altered).status, 0)
  for (const change of [
    value => {
      value.include[1].batch = 1
    },
    value => {
      value.include[0].executionMatrix.include.pop()
    },
    value => {
      value.include[0].executionMatrix.include[0] = value.include[0].executionMatrix.include[1]
    },
    value => {
      value.include[1].executionMatrix.include[0].target = 'unexpected'
    }
  ]) {
    const altered = structuredClone(batches)
    change(altered)
    assert.notEqual(execute(altered).status, 0)
  }
})

function assertPartitionDownload(aggregate, id) {
  const downloads = aggregate
    .split(/\n {6}- /)
    .filter(
      step =>
        step.startsWith('uses: actions/download-artifact@') &&
        step.includes('pattern: mutation-*\n')
    )
  assert.equal(downloads.length, 1, id)
  assert.ok(downloads[0].includes("if: needs.prepare.outputs.partition-targets != '[]'"), id)
  assert.ok(downloads[0].includes('path: .mutation-parts-raw'), id)
  const verify = aggregate.indexOf('name: Require every selected canonical partition target gate')
  assert.ok(verify > aggregate.indexOf(downloads[0]), id)
  const staging = aggregate.slice(verify)
  assert.match(staging, /MUTATION_MATRIX:/)
  assert.match(staging, /select\(\.target == \$target and \.partition != "whole"\)/)
  assert.match(staging, /\.mutation-parts-raw\/mutation-\$target-\$partition/)
  assert.match(staging, /Missing mutation partition evidence/)
  assert.match(staging, /--target "\$target" --directory "\.mutation-parts\/\$target"/)
}

test('canonical staging requires exact selected artifacts and excludes prefix neighbours', () => {
  const aggregate = workflowJobBlocks(readFileSync(CI_PATH, 'utf8')).find(
    job => job.name === 'mutation-quality'
  ).source
  const body = aggregate.slice(
    aggregate.indexOf('name: Require every selected canonical partition target gate')
  )
  const script = body.match(/ {8}run: \|\n([\s\S]*?)(?=\n {6}- )/)[1]
  const directory = mkdtempSync(join(tmpdir(), 'stack-mutation-staging-'))
  const targets = buildMutationTargets(REPOSITORY_ROOT)
  const selected = partitionedMutationTargets(Object.keys(targets), targets)
  const matrix = mutationExecutionMatrix(selected, targets)
  const rows = matrix.include.filter(row => row.partition !== 'whole')
  const artifact = row =>
    join(directory, '.mutation-parts-raw', `mutation-${row.target}-${row.partition}`)
  const run = () =>
    spawnSync('/bin/bash', ['-e', '-o', 'pipefail', '-c', 'node() { :; }\n' + script], {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        PARTITION_TARGETS: JSON.stringify(selected),
        MUTATION_MATRIX: JSON.stringify(matrix)
      }
    })
  try {
    for (const row of rows) mkdirSync(artifact(row), { recursive: true })
    mkdirSync(artifact({ target: rows[0].target + '-foreign', partition: rows[0].partition }), {
      recursive: true
    })
    const passed = run()
    assert.equal(passed.status, 0, passed.stderr)
    for (const target of selected)
      assert.deepEqual(
        readdirSync(join(directory, '.mutation-parts', target)).sort(),
        rows
          .filter(row => row.target === target)
          .map(row => `mutation-${row.target}-${row.partition}`)
          .sort()
      )
    rmSync(join(directory, '.mutation-parts'), { recursive: true })
    rmSync(artifact(rows.at(-1)), { recursive: true })
    const missing = run()
    assert.notEqual(missing.status, 0)
    assert.match(missing.stdout, /Missing mutation partition evidence/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('every selected application and LCH execution part is downloaded before canonical aggregation', () => {
  const targets = buildMutationTargets(REPOSITORY_ROOT)
  const application = Object.keys(targets).filter(
    id => targets[id].packageDirectory === 'packages/application/output-knowledge'
  )
  const selected = partitionedMutationTargets(
    [
      ...application,
      'lch-overlay-covenant-terms',
      'wallet-recovery-codec',
      'overlay-proposal-admission'
    ],
    targets
  )
  assert.ok(selected.includes('output-knowledge-proposal-core'))
  assert.ok(selected.includes('proposal-journal-send'))
  assert.ok(selected.includes('proposal-channel-storage'))
  for (const id of [
    'lch-overlay-covenant-terms',
    'private-purchase-state',
    'private-purchase-coordination',
    'private-purchase-native-clock',
    'revenue-listing-purchase',
    'wallet-recovery-codec',
    'overlay-proposal-admission'
  ]) {
    assert.ok(selected.includes(id), id)
  }
  const aggregate = workflowJobBlocks(readFileSync(CI_PATH, 'utf8')).find(
    job => job.name === 'mutation-quality'
  ).source
  for (const id of selected) assertPartitionDownload(aggregate, id)
  assert.ok(
    aggregate.includes('node scripts/mutation-partition-evidence.mjs verify --mode diagnostic')
  )
  assert.ok(aggregate.includes('--target "$target" --directory ".mutation-parts/$target"'))
})

test('wallet recovery encoding downloads all complete execution parts before canonical aggregation', () => {
  const id = 'wallet-recovery-encoding'
  const selected = partitionedMutationTargets([id], buildMutationTargets(REPOSITORY_ROOT))
  assert.deepEqual(selected, [id])
  const aggregate = workflowJobBlocks(readFileSync(CI_PATH, 'utf8')).find(
    job => job.name === 'mutation-quality'
  ).source
  assertPartitionDownload(aggregate, id)
})

test('protected ledger aggregation requires selected complete execution artifacts', () => {
  const id = 'protected-ledger'
  assert.deepEqual(partitionedMutationTargets([id], buildMutationTargets(REPOSITORY_ROOT)), [id])
  const aggregate = workflowJobBlocks(readFileSync(CI_PATH, 'utf8')).find(
    job => job.name === 'mutation-quality'
  ).source
  assertPartitionDownload(aggregate, id)
})

test('private publication aggregation requires selected complete execution artifacts', () => {
  const id = 'private-publication-state'
  assert.deepEqual(partitionedMutationTargets([id], buildMutationTargets(REPOSITORY_ROOT)), [id])
  const aggregate = workflowJobBlocks(readFileSync(CI_PATH, 'utf8')).find(
    job => job.name === 'mutation-quality'
  ).source
  assertPartitionDownload(aggregate, id)
})

test('lineage graph aggregation requires selected complete execution artifacts', () => {
  const id = 'revenue-lineage-graph'
  assert.deepEqual(partitionedMutationTargets([id], buildMutationTargets(REPOSITORY_ROOT)), [id])
  const aggregate = workflowJobBlocks(readFileSync(CI_PATH, 'utf8')).find(
    job => job.name === 'mutation-quality'
  ).source
  assertPartitionDownload(aggregate, id)
})

test('verified publication service aggregation requires selected complete execution artifacts', () => {
  const id = 'private-publication-service'
  assert.deepEqual(partitionedMutationTargets([id], buildMutationTargets(REPOSITORY_ROOT)), [id])
  const aggregate = workflowJobBlocks(readFileSync(CI_PATH, 'utf8')).find(
    job => job.name === 'mutation-quality'
  ).source
  assertPartitionDownload(aggregate, id)
})

test('private publication coordination aggregation requires selected complete execution artifacts', () => {
  const id = 'private-publication-coordination'
  assert.deepEqual(partitionedMutationTargets([id], buildMutationTargets(REPOSITORY_ROOT)), [id])
  const aggregate = workflowJobBlocks(readFileSync(CI_PATH, 'utf8')).find(
    job => job.name === 'mutation-quality'
  ).source
  assertPartitionDownload(aggregate, id)
})

test('private publication HTTP aggregation requires selected complete execution artifacts', () => {
  const id = 'private-publication-http'
  assert.deepEqual(partitionedMutationTargets([id], buildMutationTargets(REPOSITORY_ROOT)), [id])
  const aggregate = workflowJobBlocks(readFileSync(CI_PATH, 'utf8')).find(
    job => job.name === 'mutation-quality'
  ).source
  assertPartitionDownload(aggregate, id)
})

test('acquisition and proposal HTTP aggregation require every selected part artifact', () => {
  for (const id of [
    'private-acquisition-foundation',
    'private-acquisition-state',
    'private-acquisition-coordination',
    'private-acquisition-http',
    'sdk-paid-lookup-http',
    'protected-operation-state',
    'protected-operation-objects',
    'overlay-proposal-http'
  ]) {
    assert.deepEqual(partitionedMutationTargets([id], buildMutationTargets(REPOSITORY_ROOT)), [id])
    const aggregate = workflowJobBlocks(readFileSync(CI_PATH, 'utf8')).find(
      job => job.name === 'mutation-quality'
    ).source
    assertPartitionDownload(aggregate, id)
  }
})

// Extract one step's `run: |` block from the raw workflow text, as the other
// checks here read the workflow without a YAML dependency.
function stepScript(workflow, name) {
  const lines = workflow.split('\n')
  const at = lines.findIndex(line => line.trim() === `- name: ${name}`)
  assert.ok(at >= 0, name)
  const run = lines.findIndex((line, index) => index > at && line.trim() === 'run: |')
  const indent = lines[run + 1].match(/^ */)[0].length
  const body = []
  for (const line of lines.slice(run + 1)) {
    if (line.trim() !== '' && line.match(/^ */)[0].length < indent) break
    body.push(line.slice(indent))
  }
  return body.join('\n')
}

test('infra image builds back off longer only for registry rate limits', () => {
  const script = stepScript(readFileSync(CI_PATH, 'utf8'), 'Build Linux image')
    .replaceAll('${{ strategy.job-index }}', '0')
    .replaceAll('${{ matrix.component }}', 'wab')
  const scenario = outcomes => {
    const directory = mkdtempSync(join(tmpdir(), 'ts-stack-image-retry-'))
    writeFileSync(join(directory, 'outcomes'), outcomes.join('\n') + '\n')
    // Each docker call consumes one scripted outcome; sleep only records.
    writeFileSync(
      join(directory, 'docker'),
      `#!/bin/bash\noutcome=$(head -n1 "${directory}/outcomes"); sed -i.bak 1d "${directory}/outcomes"\n` +
        `echo call >> "${directory}/calls"\n` +
        `case "$outcome" in ok) exit 0;; 429) echo "429 Too Many Requests" >&2; exit 1;; *) echo "error: build failed" >&2; exit 1;; esac\n`
    )
    writeFileSync(join(directory, 'sleep'), `#!/bin/bash\necho "$1" >> "${directory}/sleeps"\n`)
    chmodSync(join(directory, 'docker'), 0o755)
    chmodSync(join(directory, 'sleep'), 0o755)
    const run = spawnSync('/bin/bash', ['-e', '-c', script], {
      env: { PATH: `${directory}:${process.env.PATH}`, RUNNER_TEMP: directory },
      encoding: 'utf8'
    })
    const lines = file => {
      try {
        return readFileSync(join(directory, file), 'utf8').trim().split('\n').filter(Boolean)
      } catch {
        return []
      }
    }
    return { status: run.status, calls: lines('calls').length, sleeps: lines('sleeps').map(Number) }
  }
  assert.deepEqual(scenario(['ok']), { status: 0, calls: 1, sleeps: [] })
  assert.deepEqual(scenario(['429', '429', '429', 'ok']), {
    status: 0,
    calls: 4,
    sleeps: [15, 30, 60]
  })
  assert.deepEqual(scenario(['429', '429', '429', '429', '429']), {
    status: 1,
    calls: 5,
    sleeps: [15, 30, 60, 120]
  })
  // A genuine build failure keeps the short retry and does not wait minutes.
  assert.deepEqual(scenario(['fail', 'fail', 'fail', 'ok']), {
    status: 1,
    calls: 3,
    sleeps: [5, 10]
  })
})
