import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPOSITORY_ROOT } from '../repository-health.mjs'
const workflow = async file => {
  const { parse } = await import('yaml')
  return parse(readFileSync(join(REPOSITORY_ROOT, '.github/workflows', file), 'utf8'))
}

test('CI and every publisher have no mutation execution, outcome, receipt or finding dependency', async () => {
  for (const file of [
    'ci.yml',
    'release.yaml',
    'infra-release.yaml',
    'wab-marketplace-release.yml'
  ]) {
    const value = await workflow(file)
    for (const [name, job] of Object.entries(value.jobs)) {
      assert.doesNotMatch(name, /mutation/)
      assert.doesNotMatch(job.uses ?? '', /mutation-(tests|execution)/)
      assert.doesNotMatch(JSON.stringify(job.needs ?? []), /mutation/)
      assert.doesNotMatch(job.if ?? '', /mutation|qualified-sha|campaign|finding/)
      assert.doesNotMatch(JSON.stringify(job.with ?? {}), /qualified-sha|mutation/)
      for (const step of job.steps ?? [])
        assert.doesNotMatch(
          step.run ?? '',
          /mutation-testing\.mjs|mutation-final-qualification\.mjs|test:mutation/
        )
    }
  }
})

test('one explicit background part is bounded, isolated and never grants publication outputs', async () => {
  const value = await workflow('mutation-tests.yml')
  assert.deepEqual(Object.keys(value.on), ['workflow_dispatch'])
  assert.equal(value.on.workflow_dispatch.inputs.target.required, true)
  assert.equal(value.on.workflow_dispatch.inputs.partition.required, true)
  assert.deepEqual(value.permissions, {})
  assert.equal(value.jobs.audit['timeout-minutes'], 30)
  assert.equal(value.jobs.findings['timeout-minutes'], 5)
  assert.deepEqual(value.jobs.audit.permissions, { contents: 'read' })
  assert.deepEqual(value.jobs.findings.permissions, { contents: 'read', issues: 'write' })
  assert.equal(value.jobs.audit.strategy, undefined)
  assert.equal(value.jobs.audit.outputs, undefined)
  assert.equal(value.jobs.findings.outputs, undefined)
  const steps = value.jobs.audit.steps
  assert.equal(steps[1].run, 'test "$GITHUB_REF" = refs/heads/main')
  const validate = steps.findIndex(
    step => step.run === 'node scripts/mutation-findings.mjs validate'
  )
  const install = steps.findIndex(step => step.run?.includes('pnpm install'))
  assert(validate > 0 && validate < install)
  assert(
    steps.some(step => step.if === 'always()' && step.uses?.startsWith('actions/upload-artifact@'))
  )
  assert.equal(value.jobs.findings.if, "always() && github.ref == 'refs/heads/main'")
  assert(
    value.jobs.findings.steps.some(step => step.run === 'node scripts/mutation-findings.mjs report')
  )
  assert.equal(existsSync(join(REPOSITORY_ROOT, '.github/workflows/mutation-execution.yml')), false)
})

test('publisher source, human approval and immutable artifact guards remain present', async () => {
  const npm = await workflow('release.yaml')
  assert.deepEqual(npm.jobs.publish.needs, ['approve', 'prepare'])
  assert.match(npm.jobs.publish.if, /needs.approve.result == 'success'/)
  assert.match(npm.jobs.publish.if, /needs.prepare.result == 'success'/)
  assert.match(npm.jobs.infra.if, /needs.prepare.result == 'success'/)
  assert.equal(npm.jobs.publish.environment, 'npm-production')
  assert.match(JSON.stringify(npm.jobs.publish.steps), /package-release-artifacts/)
  const oci = await workflow('infra-release.yaml')
  assert.deepEqual(oci.jobs.release.needs, ['discover', 'build-image'])
  assert.match(oci.jobs.release.if, /needs.discover.result == 'success'/)
  assert.match(JSON.stringify(oci.jobs.release.steps), /reviewed-image|attestation/)
  const marketplace = await workflow('wab-marketplace-release.yml')
  assert.equal(marketplace.jobs.publish.needs, 'source')
  assert.equal(marketplace.jobs.publish.if, "needs.source.result == 'success'")
  assert(marketplace.jobs.source.steps.some(step => step.name === 'Verify trusted release source'))
})
