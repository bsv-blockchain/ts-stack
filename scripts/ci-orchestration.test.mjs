import assert from 'node:assert/strict'

import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

import { dirname, join } from 'node:path'

import test from 'node:test'

import { isDeepStrictEqual } from 'node:util'

import { planShards } from './ci-shard-plan.mjs'
import { APPLICATION_COVERAGE_SHARDS } from './output-knowledge-coverage-validation.mjs'

import { REPOSITORY_ROOT } from './repository-health.mjs'

import { walletCoverageMatrix } from './wallet-composed-native-ci.mjs'

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

test('mutation planning and engine controls stay in the explicit background audit', () => {
  const workflow = readFileSync(CI_PATH, 'utf8')
  const background = readFileSync(
    new URL('../.github/workflows/mutation-tests.yml', import.meta.url),
    'utf8'
  )
  assert.doesNotMatch(workflow, /mutation-partitions(?:-engine)?\.(?:background|integration)\.mjs/)
  assert.match(
    background,
    /node --test scripts\/mutation-execution-batches\.background\.mjs scripts\/mutation-partitions\.background\.mjs scripts\/mutation-partitions-engine\.integration\.mjs/
  )
  assert.doesNotMatch(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    /mutation-partitions\.background\.mjs/
  )
  assert.throws(() => readFileSync(new URL('./mutation-partitions.test.mjs', import.meta.url)))
})

test('repository health installs real locked wallet compiler dependencies before config regressions', () => {
  const workflow = readFileSync(CI_PATH, 'utf8')
  const job = workflowJobBlocks(workflow).find(value => value.name === 'repository-health').source
  const setup = job.indexOf('uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413')
  const install = job.indexOf(
    'run: pnpm install --frozen-lockfile --ignore-scripts --filter @bsv/ts-stack --filter @bsv/wallet-toolbox --filter @bsv/wallet-toolbox-mobile\n'
  )
  const rebuild = job.indexOf('run: pnpm rebuild esbuild')
  const testControls = job.indexOf('run: node --test scripts/*.test.mjs')
  assert.ok(setup >= 0 && install > setup && rebuild > install && testControls > rebuild)
  assert.doesNotMatch(job, /continue-on-error/)
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

const APPLICATION_PACKAGE = '@bsv/output-knowledge'
const APPLICATION_TEST_SHARDS = 10

function assertApplicationMatrix(
  scope,
  variable,
  packagesVariable,
  { applicationPackages, emptySelection, uniqueIds, shards }
) {
  const command = scope.match(
    new RegExp(
      String.raw`${variable}=\$\(jq -c --argjson all "\$${packagesVariable}" '([\s\S]*?)' <<<"\$${variable}"\)`
    )
  )?.[1]
  assert.ok(command)
  for (const selected of [
    ...(emptySelection ? [[]] : []),
    [APPLICATION_PACKAGE],
    ['other'],
    ['other', 'second'],
    ['other', APPLICATION_PACKAGE, 'second']
  ]) {
    const other = selected.filter(name => name !== APPLICATION_PACKAGE)
    const rows = JSON.parse(
      execFileSync('jq', ['-c', '--argjson', 'all', JSON.stringify(selected), command], {
        input: JSON.stringify(planShards(other, {})),
        encoding: 'utf8'
      })
    ).include
    const application = rows.filter(row => row.application !== 0)
    assert.deepEqual(
      application.map(row => row.application),
      selected.includes(APPLICATION_PACKAGE)
        ? Array.from({ length: shards }, (_, index) => index + 1)
        : []
    )
    assert.ok(
      application.every(
        row =>
          row.total === shards &&
          row.shard === row.application &&
          isDeepStrictEqual(row.packages, applicationPackages)
      )
    )
    const union = rows.filter(row => row.application === 0).flatMap(row => row.packages)
    assert.deepEqual(union.sort(), [...other].sort())
    if (selected.length > 0) assert.ok(rows.length > 0)
    if (uniqueIds) assert.equal(new Set(rows.map(row => row.id)).size, rows.length)
  }
}

test('application dependent-test shards run the complete suite beside the planned packages', () => {
  const workflow = readFileSync(CI_PATH, 'utf8')
  const jobs = Object.fromEntries(workflowJobBlocks(workflow).map(job => [job.name, job.source]))
  assert.match(
    jobs.scope,
    /DEPENDENT_TEST_ORDINARY=\$\(jq -c 'map\(select\(\. != "@bsv\/output-knowledge"\)\)' <<<"\$DEPENDENT_TEST_PACKAGES"\)/
  )
  assertApplicationMatrix(jobs.scope, 'DEPENDENT_TEST_MATRIX', 'DEPENDENT_TEST_PACKAGES', {
    applicationPackages: [APPLICATION_PACKAGE],
    emptySelection: false,
    uniqueIds: false,
    shards: APPLICATION_TEST_SHARDS
  })
  assert.match(jobs['dependent-tests'], /^    timeout-minutes: 30$/m)
  assert.match(jobs['dependent-tests'], /^        if: matrix\.application == 0$/m)
  assert.match(jobs['dependent-tests'], /^        if: matrix\.application != 0$/m)
  assert.match(
    jobs['dependent-tests'],
    /--script test --jest-shard "\$\{\{ matrix\.application \}\}\/\$\{\{ matrix\.total \}\}"\n {10}--jest-sequencer "\$GITHUB_WORKSPACE\/scripts\/jest-duration-sequencer\.cjs"/
  )
  assert.match(jobs['dependent-tests'], /^ {10}JEST_SHARD_LANE: output-knowledge-tests$/m)
  assert.match(
    jobs['dependent-tests'],
    /^ {10}JEST_SHARD_DURATIONS: \$\{\{ github\.workspace \}\}\/governance\/ci-lane-durations\.json$/m
  )
})

test('application coverage shards retain the complete selection and a required merged global gate', () => {
  const workflow = readFileSync(CI_PATH, 'utf8')
  const jobs = Object.fromEntries(workflowJobBlocks(workflow).map(job => [job.name, job.source]))
  assertApplicationMatrix(jobs.scope, 'COVERAGE_OTHER_MATRIX', 'COVERAGE_OTHER_PACKAGES', {
    applicationPackages: [],
    emptySelection: true,
    uniqueIds: true,
    shards: APPLICATION_COVERAGE_SHARDS
  })
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
    if (job.name === 'coverage-wallet') assertNativeWalletJob(job.source)
    else assert.match(job.source, /^    timeout-minutes: \d+$/m, `${job.name} must have a timeout`)
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

test('analysis and artifact gates remain independent of background mutation audits', () => {
  const jobs = Object.fromEntries(
    workflowJobBlocks(readFileSync(CI_PATH, 'utf8')).map(job => [job.name, job.source])
  )
  assert.doesNotMatch(jobs['early-gates'], /sonar-zero-findings|SONAR_RESULT/)
  assert.doesNotMatch(jobs.prepare, /      - sonar-zero-findings/)
  assert.equal(jobs['mutation-tests'], undefined)
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
  const matrix = walletCoverageMatrix().include
  const selected = matrix.filter(value => value.latency !== undefined)
  assert.deepEqual(
    selected.map(value => value.latency),
    latencies
  )
  assert.ok(selected.every(value => value.id === 'sync-http-' + value.latency))
  assert.equal(matrix.filter(value => value.shard).length, 6)
  assert.equal(
    Number(wallet.match(/--shard="\$WALLET_SHARD\/(\d+)"/)[1]),
    matrix.filter(value => value.shard).length
  )
  assert.match(
    wallet,
    /--testSequencer="\$GITHUB_WORKSPACE\/scripts\/jest-duration-sequencer\.cjs"/
  )
  assert.match(wallet, /JEST_SHARD_LANE: wallet-toolbox-coverage/)
  assert.match(
    wallet,
    /--runInBand\n\s+--runTestsByPath src\/storage\/sync\/syncTransferHttp\.test\.ts/
  )
  assert.match(wallet, /--testNamePattern="with \$SYNC_LATENCY ms request latency"/)
  assert.match(
    wallet,
    /args=\(--coverage --coverageDirectory=coverage\/\$\{\{ matrix\.id \}\} --maxWorkers=3\n\s+--testSequencer="\$GITHUB_WORKSPACE\/scripts\/jest-duration-sequencer\.cjs"\)/
  )
  assert.match(wallet, /name: coverage-wallet-\$\{\{ matrix\.id \}\}/)
  assert.doesNotMatch(wallet, /continue-on-error|passWithNoTests/)
})

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

function nativeWalletFixtureSteps() {
  const wallet = workflowJobBlocks(readFileSync(CI_PATH, 'utf8')).find(
    job => job.name === 'coverage-wallet'
  ).source
  const matches = [...wallet.matchAll(/^ {6}- /gm)]
  const steps = matches.map((match, index) =>
    wallet.slice(match.index, matches[index + 1]?.index ?? wallet.length)
  )
  return { wallet, steps }
}

test('actual wallet timeout expression preserves existing lanes and bounds every original merge case', () => {
  const { wallet } = nativeWalletFixtureSteps()
  const expression = wallet.match(/^ {4}timeout-minutes: \$\{\{ (.*?) \}\}$/m)[1]
  const evaluate = new Function('matrix', `return (${expression})`)
  for (const lane of walletCoverageMatrix().include) {
    // GitHub treats absent matrix keys as empty values.
    const minutes = evaluate({
      native_cohort: '',
      native_merge_minutes: 0,
      native_auth_minutes: 0,
      ...lane
    })
    let expected = 40
    if (lane.native_cohort) expected = lane.native_cohort === 'completed' ? 265 : 145
    else if (lane.native_merge_cohort && !lane.native_merge_cohort.startsWith('proof-'))
      expected = 90
    else if (lane.native_auth_cohort) expected = 90
    assert.equal(minutes, expected, lane.id)
  }
})

function onlyFixtureStep(steps, command) {
  const matches = steps.filter(step => step.split('\n').includes(`        run: ${command}`))
  assert.equal(matches.length, 1)
  const step = matches[0]
  assert.match(step, /^ {8}if: matrix.id == 'shard-1'$/m)
  assert.match(step, /^ {8}working-directory: packages\/wallet\/wallet-toolbox$/m)
  assert.doesNotMatch(step, /continue-on-error/)
  return steps.indexOf(step)
}

function assertNativeWalletJob(wallet) {
  assert.match(wallet, /^ {4}needs: prepare$/m)
  assert.match(
    wallet,
    /^ {4}timeout-minutes: \$\{\{ matrix\.native_cohort == 'completed' && 265 \|\| matrix\.native_cohort != '' && 145 \|\| matrix\.native_merge_minutes \|\| matrix\.native_auth_minutes \|\| 40 \}\}$/m
  )
  assert.match(wallet, /^ {4}runs-on: ubuntu-24\.04-arm$/m)
  assert.match(wallet, /^ {4}permissions:\n {6}contents: read\n {4}strategy:/m)
  assert.doesNotMatch(wallet, /continue-on-error/)
  assert.match(
    wallet,
    /^ {4}strategy:\n {6}fail-fast: false\n {6}max-parallel: 3\n {6}matrix: \$\{\{ fromJSON\(needs\.prepare\.outputs\.wallet-test-matrix\) \}\}\n {4}services:$/m
  )
  assert.match(wallet, /node-version: 24\.22\.1/)
  assert.match(wallet, /run: bash scripts\/provision-wallet-native-tests\.sh/)
  assert.match(wallet, /wallet-composed-native-ci\.mjs capture/)
  assert.match(wallet, /wallet-composed-native-ci\.mjs pair-capture/)
  assert.match(wallet, /wallet-composed-native-ci\.mjs pair-pattern/)
  assert.match(wallet, /wallet-composed-native-ci\.mjs merge-capture/)
  assert.match(wallet, /wallet-composed-native-ci\.mjs merge-pattern/)
  assert.match(wallet, /wallet-composed-native-ci\.mjs auth-capture/)
  assert.match(wallet, /wallet-composed-native-ci\.mjs auth-pattern/)
  assert.match(wallet, /NATIVE_AUTH_COHORT: \$\{\{ matrix\.native_auth_cohort \}\}/)
  assert.match(
    wallet,
    /--runTestsByPath src\/storage\/portable\/Brc38NativeAuthenticatedMergeContractsNode\.test\.ts/
  )
  assert.match(
    wallet,
    /testPathIgnorePatterns=.*src\/storage\/portable\/Brc38NativeAuthenticatedMergeContractsNode\.test\.ts/
  )
  assert.match(
    wallet,
    /--runTestsByPath src\/storage\/portable\/Brc38NativeMergeContractsNode\.test\.ts/
  )
  assert.match(
    wallet,
    /testPathIgnorePatterns=.*src\/storage\/portable\/Brc38NativeMergeContractsNode\.test\.ts/
  )
  assert.match(wallet, /NATIVE_MERGE_COHORT: \$\{\{ matrix\.native_merge_cohort \}\}/)
  assert.match(
    wallet,
    /--runTestsByPath src\/storage\/snapshot\/NativeSnapshotMergeContractsNode\.test\.ts/
  )
  assert.match(
    wallet,
    /testPathIgnorePatterns=.*src\/storage\/snapshot\/NativeSnapshotMergeContractsNode\.test\.ts/
  )
  assert.match(wallet, /NATIVE_PAIR_COHORT: \$\{\{ matrix\.native_pair_cohort \}\}/)
  const workflow = readFileSync(CI_PATH, 'utf8')
  assert.match(workflow, /wallet-test-matrix: \$\{\{ steps\.wallet-matrix\.outputs\.matrix \}\}/)
  assert.match(workflow, /wallet-composed-native-ci\.mjs matrix/)
  assert.match(workflow, /wallet-composed-native-ci\.mjs verify \.coverage-artifacts/)
  assert.match(workflow, /wallet-composed-native-ci\.mjs pair-verify \.coverage-artifacts/)
  assert.match(workflow, /wallet-composed-native-ci\.mjs merge-verify \.coverage-artifacts/)
  assert.match(workflow, /wallet-composed-native-ci\.mjs auth-verify \.coverage-artifacts/)
  assert.match(
    wallet,
    /^ {6}postgres:\n {8}image: postgres@sha256:d5daad18926b71c3d663f358af0aea798670cb79fb550c106d19662a9d1627ef(?: #[^\n]*)?$/m
  )
  assert.match(wallet, /^ {8}ports:\n {10}- 5432:5432\n {8}options: >-$/m)
}

test('native snapshot process-loss proof uses the same-head build in exactly one required wallet shard', () => {
  const { wallet, steps } = nativeWalletFixtureSteps()
  const proof = onlyFixtureStep(steps, 'node test/storage/snapshotArchiveCrash.cjs')
  const restored = steps.findIndex(step =>
    step.includes('run: tar --extract --gzip --file .ci-artifacts/build-outputs.tar.gz')
  )
  const coverage = steps.findIndex(step =>
    step.includes('name: Generate wallet-toolbox coverage shard')
  )
  assert.ok(restored >= 0 && restored < proof && proof < coverage)
  assertNativeWalletJob(wallet)
})

test('native MySQL uses a bounded pinned fixture in the existing required wallet shard', () => {
  const { wallet, steps } = nativeWalletFixtureSteps()
  const provision = onlyFixtureStep(
    steps,
    'node test/storage/snapshotArchiveDocker.cjs provision-hosted-image'
  )
  const proof = onlyFixtureStep(steps, 'node test/storage/runSnapshotArchiveMysql.cjs')
  for (const index of [provision, proof]) {
    assert.match(steps[index], /^ {8}timeout-minutes: 5$/m)
    assert.match(steps[index], /^ {8}env:\n {10}TS_STACK_SNAPSHOT_HOSTED_MYSQL: '1'\n {8}run:/m)
  }
  const sqlite = onlyFixtureStep(steps, 'node test/storage/snapshotArchiveCrash.cjs')
  const coverage = steps.findIndex(step =>
    step.includes('name: Generate wallet-toolbox coverage shard')
  )
  assert.ok(sqlite < provision && provision < proof && proof < coverage)
  assertNativeWalletJob(wallet)
})

test('journal native recovery remains mandatory alongside all archive fixture families', () => {
  const { wallet, steps } = nativeWalletFixtureSteps()
  const archive = onlyFixtureStep(steps, 'node test/storage/runSnapshotArchiveMysql.cjs')
  const sqlite = onlyFixtureStep(steps, 'node test/storage/snapshotJournalSqliteCrash.cjs')
  const mysql = onlyFixtureStep(steps, 'node test/storage/runSnapshotJournalMysql.cjs')
  const coverage = steps.findIndex(step =>
    step.includes('name: Generate wallet-toolbox coverage shard')
  )
  assert.match(steps[sqlite], /^ {8}timeout-minutes: 3$/m)
  assert.match(steps[mysql], /^ {8}timeout-minutes: 10$/m)
  assert.ok(steps[mysql].includes("TS_STACK_SNAPSHOT_HOSTED_MYSQL: '1'"))
  assert.ok(archive < sqlite && sqlite < mysql && mysql < coverage)
  assertNativeWalletJob(wallet)
})

test('all original privileged root-copy cases run once as installer with mandatory report and coverage', () => {
  const { wallet, steps } = nativeWalletFixtureSteps()
  const root = steps.find(step =>
    step.includes('name: Qualify the original privileged native root-copy fixtures')
  )
  assert.ok(root)
  assert.match(root, /if: matrix\.id == 'shard-1'/)
  assert.match(root, /timeout-minutes: 3/)
  assert.match(root, /sudo --preserve-env=TS_STACK_NATIVE_TEST_EXECUTABLE/)
  assert.match(
    root,
    /--runInBand --watchman=false --testPathIgnorePatterns=man\.test\.ts --runTestsByPath/
  )
  assert.match(root, /src\/storage\/portable\/native\/RootNativeCopyContracts\.test\.cjs/)
  assert.match(
    root,
    /node scripts\/wallet-native-root-copy-ci\.mjs < native-root-copy-result\.json/
  )
  assert.match(root, /\.coverage-output\/wallet-native-root-copy\.lcov\.info/)
  assert.doesNotMatch(root, /testNamePattern|continue-on-error|passWithNoTests/)
  assert.match(
    wallet,
    /--testPathIgnorePatterns='[^']*\|src\/storage\/portable\/native\/RootNativeCopyContracts\.test\.cjs(?:\||')/
  )
})

test('native browser jobs always release only their delivered exact-path sandbox attachment', () => {
  const jobs = Object.fromEntries(
    workflowJobBlocks(readFileSync(CI_PATH, 'utf8')).map(job => [job.name, job.source])
  )
  for (const name of ['coverage-wallet']) {
    const source = jobs[name]
    assert.ok(source, name)
    assert.match(source, /if: always\(\) && matrix\.id == 'shard-4'/)
    assert.match(source, /run: node scripts\/provision-wallet-native-browser\.mjs --cleanup/)
    assert.doesNotMatch(
      source,
      /--no-sandbox|apparmor_restrict_unprivileged_userns=0|service apparmor/
    )
  }
})
