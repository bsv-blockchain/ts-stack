import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPOSITORY_ROOT } from '../repository-health.mjs'

test('actual scope Bash routes every affected wallet to complete coverage exactly once', async () => {
  const { parse } = await import('yaml')
  const workflow = parse(readFileSync(join(REPOSITORY_ROOT, '.github/workflows/ci.yml'), 'utf8'))
  const script = workflow.jobs.prepare.steps.find(step => step.id === 'scope').run
  const wallet = {
    name: '@bsv/wallet-toolbox',
    path: join(REPOSITORY_ROOT, 'packages/wallet/wallet-toolbox')
  }
  const sdk = { name: '@bsv/sdk', path: join(REPOSITORY_ROOT, 'packages/sdk') }
  for (const { direct, affected, selected, dependents } of [
    { direct: [wallet], affected: [wallet], selected: true, dependents: [] },
    { direct: [sdk], affected: [sdk, wallet], selected: true, dependents: [] },
    { direct: [], affected: [wallet, sdk], selected: true, dependents: ['@bsv/sdk'] },
    { direct: [], affected: [sdk], selected: false, dependents: ['@bsv/sdk'] },
    { direct: [], affected: [], selected: false, dependents: [] }
  ]) {
    const directory = mkdtempSync(join(tmpdir(), 'wallet-ci-scope-'))
    try {
      mkdirSync(join(directory, 'scripts'))
      copyFileSync(
        join(REPOSITORY_ROOT, 'scripts/run-ci-tests.mjs'),
        join(directory, 'scripts/run-ci-tests.mjs')
      )
      const output = join(directory, 'output')
      const summary = join(directory, 'summary')
      const result = spawnSync('/bin/bash', ['-e', '-c', script], {
        cwd: directory,
        encoding: 'utf8',
        timeout: 10000,
        env: {
          ...process.env,
          DIRECT_PROJECTS: JSON.stringify(direct),
          AFFECTED_PROJECTS: JSON.stringify(affected),
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary
        }
      })
      assert.equal(result.status, 0, result.stderr)
      const values = Object.fromEntries(
        readFileSync(output, 'utf8')
          .trim()
          .split('\n')
          .map(line => {
            const index = line.indexOf('=')
            return [line.slice(0, index), line.slice(index + 1)]
          })
      )
      assert.equal(values.wallet, String(selected))
      assert.deepEqual(JSON.parse(values['dependent-test-packages']), dependents)
      if (selected) assert.equal(values['coverage-required'], 'true')
      assert.equal(values.sdk, String(direct.some(project => project.name === sdk.name)))
      assert.ok(
        workflow.jobs['coverage-wallet'].if.includes("needs.prepare.outputs.wallet == 'true'")
      )
      assert.ok(
        workflow.jobs['coverage-upload'].if.includes(
          "needs.prepare.outputs['coverage-required'] == 'true'"
        ) ||
          workflow.jobs['coverage-upload'].if.includes(
            "needs.prepare.outputs.coverage-required == 'true'"
          )
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
})
