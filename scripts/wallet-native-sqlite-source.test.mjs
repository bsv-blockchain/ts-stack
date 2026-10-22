import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'

const require = createRequire(import.meta.url)
const wallet = path.resolve(import.meta.dirname, '../packages/wallet/wallet-toolbox')
const {
  sqlite
} = require('../packages/wallet/wallet-toolbox/src/storage/portable/native/source_recipe.cjs')

test('native delivery resolves the actual locked UDL amalgamation matching the qualified recipe', () => {
  const manifest = require.resolve('better-sqlite3/package.json', { paths: [wallet] })
  const source = readFileSync(path.join(path.dirname(manifest), 'deps', 'sqlite3', 'sqlite3.c'))
  assert.equal(source.length, sqlite.bytes)
  assert.equal(createHash('sha256').update(source).digest('hex'), sqlite.sha256)
  assert.match(source.toString('utf8', 0, 4096), /#define SQLITE_UDL_CAPABLE_PARSER 1/)
  const provision = readFileSync(
    new URL('./provision-wallet-native-tests.sh', import.meta.url),
    'utf8'
  )
  assert.match(provision, /require\.resolve\("better-sqlite3\/package\.json"/)
  assert.match(
    provision,
    /path\.join\(path\.dirname\(manifest\), "deps", "sqlite3", "sqlite3\.c"\)/
  )
  assert.match(provision, /TS_STACK_NATIVE_SQLITE_SOURCE/)
  assert.match(provision, /stat --format=%s/)
  assert.match(provision, /sha256sum --check --status/)
  assert.ok(!provision.includes('sqlite-amalgamation-3530400.zip'))
})

test('native first-artifact mode rejects unknown arguments before worker allocation', () => {
  const script = new URL('./provision-wallet-native-tests.sh', import.meta.url).pathname
  for (const args of [['--bootstrap-only', '--destination', '/tmp/injected'], ['--pin'], ['']]) {
    const result = spawnSync('bash', [script, ...args], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(
      result.stderr,
      /Unexpected native qualification arguments|Unknown native qualification mode/
    )
    assert.equal(result.stdout, '')
  }
})

test('candidate-only x64 CI preserves the bounded original runner without delivery or mutation dispatch', () => {
  const workflow = parse(
    readFileSync(
      new URL('../.github/workflows/wallet-native-bootstrap.yml', import.meta.url),
      'utf8'
    )
  )
  assert.deepEqual(workflow.permissions, {})
  assert.deepEqual(workflow.on.push.branches, ['codex/native-bootstrap-qualification'])
  assert.deepEqual(Object.keys(workflow.jobs), ['linux-x64'])
  const job = workflow.jobs['linux-x64']
  assert.equal(job['runs-on'], 'ubuntu-24.04')
  assert.deepEqual(job.permissions, { contents: 'read' })
  const commands = job.steps.flatMap(step => (step.run ? [step.run] : []))
  assert.ok(commands.includes('bash scripts/provision-wallet-native-tests.sh --bootstrap-only'))
  assert.ok(commands.includes('pnpm install --frozen-lockfile --ignore-scripts'))
  assert.ok(commands.every(command => !/mutation|workflow run|gh run|publish|deploy/.test(command)))
  const provision = readFileSync(
    new URL('./provision-wallet-native-tests.sh', import.meta.url),
    'utf8'
  )
  assert.match(provision, /tool=tools\/Brc38NativeBootstrapQualification\.cjs/)
  assert.match(provision, /--output-parent \/native-tests/)
  assert.match(provision, /--memory 12g --cpus 4 --pids-limit 512/)
  assert.match(provision, /--network none --read-only/)
  assert.match(provision, /node --max-old-space-size=1536/)
  assert.match(
    provision,
    /if \[\[ \$bootstrap == true \]\]; then\n  printf[^]*?\n  exit 0\nfi\n\[\[ -f \$private\/native-contract/
  )
})
