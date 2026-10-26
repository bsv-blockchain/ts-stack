import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { buildMutationTargets } from '../../governance/mutation-testing/targets.mjs'

const require = createRequire(import.meta.url)
const environmentPath =
  require.resolve('../../governance/mutation-testing/stop-on-kill-environment.cjs')
const StopOnKillEnvironment = require(environmentPath)
const ACTIVE_MUTANT = '__STRYKER_ACTIVE_MUTANT__'

const handle = event => StopOnKillEnvironment.prototype.handleTestEvent.call({}, event)
const start = () => ({ name: 'test_start', test: { mode: undefined } })
const done = errors => ({ name: 'test_done', test: { errors } })

async function withMutant(id, run) {
  const previous = process.env[ACTIVE_MUTANT]
  if (id === undefined) delete process.env[ACTIVE_MUTANT]
  else process.env[ACTIVE_MUTANT] = id
  try {
    await run()
  } finally {
    if (previous === undefined) delete process.env[ACTIVE_MUTANT]
    else process.env[ACTIVE_MUTANT] = previous
  }
}

test('a killed mutant skips its remaining tests while passing and unmutated runs execute all', async () => {
  await withMutant(undefined, async () => {
    await handle(done([new Error('dry-run failure')]))
    const next = start()
    await handle(next)
    assert.equal(next.test.mode, undefined)
  })
  await withMutant('1', async () => {
    await handle(done([]))
    const afterPass = start()
    await handle(afterPass)
    assert.equal(afterPass.test.mode, undefined)
    await handle(done([new Error('killed')]))
    const afterKill = start()
    await handle(afterKill)
    assert.equal(afterKill.test.mode, 'skip')
  })
  // The next mutant starts clean even in the same in-band process.
  await withMutant('2', async () => {
    const first = start()
    await handle(first)
    assert.equal(first.test.mode, undefined)
  })
})

test('every governed Jest target runs under the stop-on-kill environment', () => {
  const root = new URL('../..', import.meta.url).pathname
  const targets = Object.entries(buildMutationTargets(root))
  const jest = targets.filter(([, target]) => target.testRunner === 'jest')
  assert.ok(jest.length > 0)
  for (const [id, target] of jest)
    assert.equal(target.runnerOptions.jest.config.testEnvironment, environmentPath, id)
})
