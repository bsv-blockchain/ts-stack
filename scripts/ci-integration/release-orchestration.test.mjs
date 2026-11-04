import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { REPOSITORY_ROOT } from '../repository-health.mjs'

async function workflow(file) {
  const { parse } = await import('yaml')
  return parse(readFileSync(join(REPOSITORY_ROOT, '.github/workflows', file), 'utf8'))
}

test('one up-front approval gates npm and image publication without a late human wait', async () => {
  const release = await workflow('release.yaml')
  assert.equal(release.jobs.approve.environment, 'release-approval')
  assert.equal(release.jobs.approve.needs, undefined)
  assert.deepEqual(release.jobs.approve.permissions, {})
  // npm trusted publishing is bound to this environment name.
  assert.equal(release.jobs.publish.environment, 'npm-production')
  assert.ok(release.jobs.publish.needs.includes('approve'))
  assert.match(release.jobs.publish.if, /needs\.approve\.result == 'success'/)

  const infra = release.jobs.infra
  assert.equal(infra.uses, './.github/workflows/infra-release.yaml')
  assert.ok(infra.needs.includes('approve'))
  assert.match(infra.if, /needs\.approve\.result == 'success'/)
  assert.match(infra.if, /needs\.full-mutation\.outputs\.qualified-sha == github\.sha/)
  assert.match(infra.if, /needs\.prepare\.outputs\.mode == 'cascade'/)
  assert.equal(infra.with['qualified-sha'], '${{ needs.full-mutation.outputs.qualified-sha }}')

  const sync = release.jobs['sync-versions']
  assert.ok(!sync.steps.some(step => /sleep 300/.test(step.run ?? '')))
  const checkout = sync.steps.find(step => step.uses?.startsWith('actions/checkout@'))
  assert.equal(checkout.with.ref, '${{ github.sha }}')
  assert.equal(sync.outputs['source-sha'], '${{ steps.source.outputs.source-sha }}')

  const infraRelease = await workflow('infra-release.yaml')
  assert.deepEqual(Object.keys(infraRelease.on.workflow_call.inputs).sort(), [
    'qualified-sha',
    'source-sha'
  ])
  assert.match(infraRelease.jobs['post-release-verification'].if, /called == 'false'/)
})

test('jobs downstream of a deliberately skipped campaign opt out of implicit success()', async () => {
  // GitHub's implicit success() treats any skipped upstream job as blocking.
  // A release.yaml call skips infra-release's own full-mutation campaign, so
  // every job below it must use always() and check its direct needs itself.
  const infraRelease = await workflow('infra-release.yaml')
  const needs = job => [infraRelease.jobs[job].needs ?? []].flat()
  const downstream = new Set()
  const visit = job => {
    for (const [name] of Object.entries(infraRelease.jobs)) {
      if (needs(name).includes(job) && !downstream.has(name)) {
        downstream.add(name)
        visit(name)
      }
    }
  }
  visit('full-mutation')
  assert.ok(downstream.has('release'))
  for (const job of downstream) {
    const condition = String(infraRelease.jobs[job].if ?? '')
    assert.match(condition, /always\(\)/, `${job} must not inherit implicit success()`)
  }
  assert.match(infraRelease.jobs.release.if, /needs\.discover\.result == 'success'/)
  assert.match(infraRelease.jobs.release.if, /needs\.qualification\.result == 'success'/)
})

function git(cwd, ...arguments_) {
  return execFileSync('git', arguments_, { cwd, encoding: 'utf8' }).trim()
}

function commit(cwd, file, content) {
  mkdirSync(dirname(join(cwd, file)), { recursive: true })
  writeFileSync(join(cwd, file), content)
  git(cwd, 'add', file)
  git(cwd, 'commit', '-q', '-m', file)
  return git(cwd, 'rev-parse', 'HEAD')
}

test('a release.yaml call accepts only the qualified commit or its infra-sync child', async () => {
  const infraRelease = await workflow('infra-release.yaml')
  const script = infraRelease.jobs.discover.steps.find(
    step => step.name === 'Verify trusted release source'
  ).run
  const root = mkdtempSync(join(tmpdir(), 'infra-source-'))
  try {
    const origin = join(root, 'origin.git')
    const work = join(root, 'work')
    git(root, 'init', '-q', '--bare', origin)
    git(root, 'init', '-q', '-b', 'main', work)
    git(work, 'config', 'user.email', 'test@example.com')
    git(work, 'config', 'user.name', 'test')
    git(work, 'remote', 'add', 'origin', origin)
    const release = commit(work, 'packages/a/src/index.ts', 'export {}\n')
    git(work, 'push', '-q', 'origin', 'main')

    git(work, 'switch', '-q', '-c', 'sync')
    const sync = commit(work, 'infra/wab/package-lock.json', '{}\n')
    const grandchild = commit(work, 'infra/wab/package.json', '{}\n')
    git(work, 'switch', '-q', '-c', 'tampered', release)
    const tampered = commit(work, 'infra/wab/src/index.ts', 'export {}\n')
    git(work, 'switch', '-q', '-c', 'product', release)
    const product = commit(work, 'packages/a/src/index.ts', 'export const x = 1\n')

    const run = (sourceSha, overrides = {}) => {
      const output = join(root, 'output')
      writeFileSync(output, '')
      const result = spawnSync('/bin/bash', ['-e', '-c', script], {
        cwd: work,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          EVENT_NAME: 'workflow_dispatch',
          GITHUB_REF: 'refs/heads/main',
          GITHUB_REPOSITORY: 'bsv-blockchain/ts-stack',
          GITHUB_WORKFLOW_REF:
            'bsv-blockchain/ts-stack/.github/workflows/release.yaml@refs/heads/main',
          GITHUB_SHA: release,
          GITHUB_OUTPUT: output,
          SOURCE_SHA: sourceSha,
          QUALIFIED_SHA: release,
          ...overrides
        }
      })
      return { status: result.status, output: readFileSync(output, 'utf8') }
    }

    assert.equal(run(release).status, 0)
    const accepted = run(sync)
    assert.equal(accepted.status, 0)
    assert.match(accepted.output, new RegExp(`source-sha=${sync}`))
    assert.match(accepted.output, /called=true/)
    assert.notEqual(run(grandchild).status, 0)
    assert.notEqual(run(tampered).status, 0)
    assert.notEqual(run(product).status, 0)
    assert.notEqual(run(sync, { QUALIFIED_SHA: sync }).status, 0)
    assert.notEqual(
      run(sync, {
        GITHUB_WORKFLOW_REF: 'bsv-blockchain/ts-stack/.github/workflows/other.yml@refs/heads/main'
      }).status,
      0
    )

    const standalone = run('')
    assert.equal(standalone.status, 0)
    assert.match(standalone.output, /called=false/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
