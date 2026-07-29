import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  parseArguments,
  resolvePackageScript,
  stripLeadingBuildCommand
} from './run-prebuilt-package-script.mjs'

test('prebuilt package scripts remove only an exact leading standard build command', () => {
  assert.equal(stripLeadingBuildCommand('pnpm build && jest --coverage'), 'jest --coverage')
  assert.equal(stripLeadingBuildCommand('pnpm run build && vitest run'), 'vitest run')
  assert.equal(stripLeadingBuildCommand('npm run build && node test.mjs'), 'node test.mjs')

  for (const script of [
    'pnpm build || jest',
    'pnpm --filter dependency build && jest',
    'echo "pnpm build" && jest',
    'pnpm rebuild && jest',
    'jest --coverage'
  ]) {
    assert.equal(stripLeadingBuildCommand(script), script)
  }
  assert.throws(() => stripLeadingBuildCommand('pnpm build && '), /no command/)
})

test('prebuilt package script arguments require one named script', () => {
  assert.deepEqual(parseArguments(['--script', 'test:coverage']), {
    scriptName: 'test:coverage'
  })
  assert.throws(() => parseArguments([]), /--script is required/)
  assert.throws(() => parseArguments(['--package', 'example']), /Unknown argument/)
})

test('prebuilt package script resolution reads the current package manifest', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'prebuilt-package-script-'))
  try {
    await writeFile(
      path.join(directory, 'package.json'),
      `${JSON.stringify({
        name: '@bsv/example',
        scripts: { 'test:coverage': 'pnpm build && jest --coverage' }
      })}\n`
    )
    assert.deepEqual(await resolvePackageScript(directory, 'test:coverage'), {
      name: '@bsv/example',
      command: 'jest --coverage'
    })
    await assert.rejects(() => resolvePackageScript(directory, 'test:browser'), /does not define/)
  } finally {
    await rm(directory, { recursive: true })
  }
})
