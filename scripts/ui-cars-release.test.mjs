import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const releaseScript = fileURLToPath(new URL('./ui-cars-release.sh', import.meta.url))
const archiveName = 'cars_artifact_1.tgz'

function releaseFixture(t, project = 'uhrp-ui') {
  const temp = mkdtempSync(path.join(tmpdir(), 'ui-cars-test-'))
  t.after(() => rmSync(temp, { recursive: true, force: true }))
  const projectDir = path.join(temp, 'packages', 'ui', project)
  const candidate = path.join(temp, 'cars-candidate')
  const artifact = path.join(candidate, archiveName)
  const receipt = path.join(temp, 'cli-receipt')
  const bin = path.join(projectDir, 'node_modules', '.bin')
  mkdirSync(bin, { recursive: true })
  mkdirSync(candidate)
  writeFileSync(
    path.join(projectDir, 'deployment-info.json'),
    JSON.stringify({
      frontend: { language: 'react', sourceDirectory: './frontend' },
      configs: [
        null,
        { deploy: ['frontend'], projectID: 'fixture', CARSCloudURL: 'https://release.invalid' }
      ]
    })
  )
  writeFileSync(artifact, 'staged artifact bytes')
  writeFileSync(path.join(projectDir, 'cars_artifact_2.tgz'), 'unselected project artifact')
  writeFileSync(path.join(candidate, 'cars_artifact_3.tgz'), 'unselected downloaded artifact')
  writeFileSync(
    path.join(bin, 'cars'),
    `#!/usr/bin/env bash
set -euo pipefail
test "$*" = 'release now 1 --key test-fixture-only'
test -f deployment-info.json
test "$(echo cars_artifact_*.tgz)" = 'cars_artifact_1.tgz'
test "$(cat cars_artifact_1.tgz)" = 'staged artifact bytes'
printf '%s\\n' "$PWD" > "$CARS_FIXTURE_RECEIPT"
if [[ "$CARS_FIXTURE_RESULT" == missing ]]; then exit 0; fi
printf '%s\\n' 'CARS_RELEASE_SUCCESS deploymentId=fixture'
if [[ "$CARS_FIXTURE_RESULT" == failed ]]; then exit 1; fi
`,
    { mode: 0o700 }
  )
  const env = {
    ...process.env,
    CARS_ARCHIVE_SHA256: createHash('sha256').update(readFileSync(artifact)).digest('hex'),
    CARS_PRIVATE_KEY: 'test-fixture-only',
    CARS_TARGET: '1',
    UI_PROJECT: project,
    RUNNER_TEMP: temp,
    CARS_FIXTURE_RECEIPT: receipt,
    CARS_FIXTURE_RESULT: 'success'
  }
  function run(overrides) {
    return spawnSync('bash', [releaseScript], {
      cwd: temp,
      env: { ...env, ...overrides },
      encoding: 'utf8'
    })
  }
  return { artifact, receipt, run, temp }
}

for (const project of ['uhrp-ui', 'wui']) {
  test(`uses only the verified ${project} artifact for the approved target`, t => {
    const { receipt, run } = releaseFixture(t, project)
    const result = run()
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const releaseDir = readFileSync(receipt, 'utf8').trim()
    assert.match(path.basename(releaseDir), /^cars-release\./)
    assert.equal(existsSync(releaseDir), false)
    assert.doesNotMatch(result.stdout, /test-fixture-only/)
  })
}

test('rejects unapproved targets and projects before calling the CLI', t => {
  const { receipt, run } = releaseFixture(t)
  assert.equal(run({ CARS_TARGET: '2' }).status, 1)
  assert.equal(run({ UI_PROJECT: 'unsupported' }).status, 1)
  assert.equal(existsSync(receipt), false)
})

test('rejects a digest mismatch before calling the CLI', t => {
  const { artifact, receipt, run } = releaseFixture(t)
  writeFileSync(artifact, 'changed bytes')
  const result = run()
  assert.equal(result.status, 1)
  assert.match(result.stdout, /FAILED/)
  assert.equal(existsSync(receipt), false)
})

test('rejects a linked archive even when its content matches the approved digest', t => {
  const { artifact, receipt, run, temp } = releaseFixture(t)
  const alternate = path.join(temp, 'alternate.tgz')
  writeFileSync(alternate, readFileSync(artifact))
  rmSync(artifact)
  symlinkSync(alternate, artifact)
  assert.equal(run().status, 1)
  assert.equal(existsSync(receipt), false)
})

test('requires both CLI success and a terminal deployment receipt', t => {
  const { run } = releaseFixture(t)
  assert.equal(run({ CARS_FIXTURE_RESULT: 'missing' }).status, 1)
  assert.equal(run({ CARS_FIXTURE_RESULT: 'failed' }).status, 1)
})
