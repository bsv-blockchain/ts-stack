import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { canonicalInventory } from '../mutation-final-qualification.mjs'
const directory = '/tmp/ts-stack-mutation-evidence'
const sources = new Map([
  [
    'src/api.ts',
    'export const equal = (n: number) => n > 0\nexport const twice = (n: number) => n * 2\n'
  ],
  ['src/other.ts', 'export const positive = (n: number) => n >= 1\n'],
  ['src/types.ts', 'export interface Empty { value: string }\n']
])
const mutate = ['src/api.ts:1-1', 'src/other.ts', 'src/types.ts']
const inventory = JSON.parse(
  fs.readFileSync(new URL('./fixtures/mutation-inventory.json', import.meta.url), 'utf8')
)
test('pinned engine reproduces the independently stored canonical fixture inventory', async () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(await canonicalInventory(directory, sources, mutate))),
    inventory
  )
})
test('overlapping ranges merge and full-file specifications dominate, without double-counting', async () => {
  const tuples = values => values.map(({ id: _id, ...value }) => value)
  const full = await canonicalInventory(directory, sources, ['src/api.ts'])
  const dominance = await canonicalInventory(directory, sources, [
    'src/api.ts:1-1',
    'src/api.ts',
    'src/api.ts:1-2'
  ])
  assert.deepEqual(tuples(dominance), tuples(full))
  const ranged = await canonicalInventory(directory, sources, ['src/api.ts:1-1', 'src/api.ts:1-1'])
  const single = await canonicalInventory(directory, sources, ['src/api.ts:1-1'])
  assert.deepEqual(tuples(ranged), tuples(single))
  assert.ok(single.length < full.length)
})

test('only source-declared Ignored reasons are preserved by inventory replay', async () => {
  const ignoredSources = new Map([
    [
      'src/ignore.ts',
      '// Stryker disable all: reviewed source directive\nexport const equal = (n: number) => n > 0\nexport const next = (n: number) => n + 1\n'
    ]
  ])
  const ignored = await canonicalInventory(directory, ignoredSources, ['src/ignore.ts'])
  assert.ok(
    ignored.some(
      mutant =>
        mutant.status === 'Ignored' && mutant.statusReason.includes('reviewed source directive')
    )
  )
  assert.ok(ignored.every(mutant => mutant.status === 'Ignored'))
})
