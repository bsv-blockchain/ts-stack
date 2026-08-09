import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { extractExamples, selectExamples } from './check-documentation-examples.mjs'

const examples = extractExamples(
  await readFile(new URL('../docs/guides/compiled-package-examples.md', import.meta.url), 'utf8')
)

test('compiled examples are scoped through their first-party dependency closure', async () => {
  const selected = await selectExamples(examples, new Set(['@bsv/auth-express-middleware']))

  assert.deepEqual(
    selected.map(example => example.id),
    ['sdk-and-simple', 'middleware', 'overlay-and-gasp', 'wallet-storage']
  )
})

test('an SDK change retains every compiled consumer example', async () => {
  const selected = await selectExamples(examples, new Set(['@bsv/sdk']))

  assert.deepEqual(selected, examples)
})
