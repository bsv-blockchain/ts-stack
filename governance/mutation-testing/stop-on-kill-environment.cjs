'use strict'

// Jest test environment for mutation runs: stop a mutant's run at its first
// failing test.
//
// Stryker treats a mutant as killed by its first failing test and bails for its
// other test runners, but @stryker-mutator/jest-runner forces `bail: false`
// because Jest's own bail exits the process. Every later test that covers a
// killed mutant therefore still runs, although nothing it does can change the
// verdict: a mutant with one failing test is Killed. This environment restores
// Stryker's bail semantics inside Jest: once the active mutant has a failing
// test, jest-circus skips every remaining test in that mutant's run.
//
// It only acts while Stryker has an active mutant. The initial coverage run,
// survived mutants and plain `jest` runs execute every test unchanged.

const ACTIVE_MUTANT = '__STRYKER_ACTIVE_MUTANT__'

// Resolve the Node environment from the package under test, as Stryker does.
const nodeEnvironment = require(
  require.resolve('jest-environment-node', { paths: [process.cwd()] })
)
const NodeEnvironment =
  nodeEnvironment.TestEnvironment ?? nodeEnvironment.default ?? nodeEnvironment

// Stryker runs Jest in band, so module state spans one mutant's test files.
let killedMutant

class StopOnKillEnvironment extends NodeEnvironment {
  async handleTestEvent(event, state) {
    await super.handleTestEvent?.(event, state)
    const mutant = process.env[ACTIVE_MUTANT]
    if (mutant === undefined) {
      killedMutant = undefined
      return
    }
    if (event.name === 'test_start' && killedMutant === mutant) {
      // jest-circus dispatches test_start before it reads the skip mode.
      event.test.mode = 'skip'
    } else if (event.name === 'test_done' && event.test.errors.length > 0) {
      killedMutant = mutant
    }
  }
}

module.exports = StopOnKillEnvironment
