import assert from 'node:assert/strict'
import test from 'node:test'

import { validateBrowserArtifactGovernance } from './browser-artifact-governance.mjs'

test('every browser package has a measured growth and adapter-splitting disposition', () => {
  assert.deepEqual(validateBrowserArtifactGovernance(), [])
})
