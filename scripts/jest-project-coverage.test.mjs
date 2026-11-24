import assert from 'node:assert/strict'
import test from 'node:test'

import { jestArguments, projectNames } from './jest-project-coverage.mjs'

test('project coverage runs every named project in the Jest config', () => {
  assert.deepEqual(
    projectNames({
      projects: [
        { displayName: 'legacy-commonjs' },
        { displayName: { name: 'private-esm', color: 'blue' } }
      ]
    }),
    ['legacy-commonjs', 'private-esm']
  )
  assert.throws(() => projectNames({}), /must define projects/)
  assert.throws(() => projectNames({ projects: [] }), /must define projects/)
  assert.throws(() => projectNames({ projects: [{}] }), /needs a displayName/)
  assert.throws(() => projectNames({ projects: [{ displayName: 'a;b' }] }), /needs a displayName/)
  assert.throws(
    () => projectNames({ projects: [{ displayName: 'esm' }, { displayName: 'esm' }] }),
    /must be unique/
  )
})

test('each project runs alone with JSON coverage in its own directory', () => {
  assert.deepEqual(jestArguments('private-esm', '/pkg/coverage/projects/private-esm'), [
    '--experimental-vm-modules',
    'node_modules/jest/bin/jest.js',
    '--coverage',
    '--runInBand',
    '--watchman=false',
    '--selectProjects=private-esm',
    '--coverageReporters=json',
    '--coverageDirectory=/pkg/coverage/projects/private-esm'
  ])
})
