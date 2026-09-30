#!/usr/bin/env node

import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { createCommandRunner } from './lib/command-runner.mjs'
import { governedWorkspacePackages, workspaceRuntimeClosure } from './lib/workspace-packages.mjs'

// Last published SDK before the optional output protocol. Existing Express
// consumers must load and typecheck without enabling the new adapter.
const LEGACY_SDK = '2.8.9'
const root = fileURLToPath(new URL('..', import.meta.url))
const execute = createCommandRunner({ timeoutMs: 180000, maxBufferBytes: 16 * 1024 * 1024 })
const temp = await mkdtemp(join(tmpdir(), 'ts-stack-overlay-legacy-sdk-'))
const run = (command, args, cwd) =>
  execute(command, args, {
    cwd,
    env: { ...process.env, npm_config_ignore_scripts: 'true' }
  })

try {
  const workspace = parse(await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8'))
  const packages = await governedWorkspacePackages(root)
  const project = packages.get('@bsv/overlay-express')
  const sdk = packages.get('@bsv/sdk')
  if (!project || !sdk) throw new Error('Missing governed overlay or SDK package')
  const manifests = new Map([...packages].map(([name, entry]) => [name, entry.manifest]))
  const names = [
    '@bsv/overlay-express',
    ...workspaceRuntimeClosure(project.manifest, manifests)
  ].filter(name => name !== '@bsv/sdk')
  const tarballs = join(temp, 'tarballs'),
    consumer = join(temp, 'consumer')
  await mkdir(tarballs)
  await mkdir(consumer)
  const dependencies = {
    '@bsv/sdk': LEGACY_SDK,
    '@types/node': sdk.manifest.devDependencies['@types/node']
  }
  for await (const name of Readable.from(names)) {
    const { stdout } = await run(
      'pnpm',
      ['pack', '--json', '--pack-destination', tarballs],
      packages.get(name).directory
    )
    const path = resolve(JSON.parse(stdout).filename)
    if (!path.startsWith(tarballs + '/'))
      throw new Error('Package escaped consumer artifact directory')
    dependencies[name] = 'file:' + path
  }
  await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify({ private: true, type: 'module', dependencies })
  )
  await writeFile(
    join(consumer, 'pnpm-workspace.yaml'),
    JSON.stringify({
      // Preserve the repository's reviewed first-party release-age policy in
      // this isolated consumer, including CI's inherited age constraint.
      minimumReleaseAge: workspace.minimumReleaseAge,
      minimumReleaseAgeExclude: workspace.minimumReleaseAgeExclude,
      overrides: dependencies
    })
  )
  await run('pnpm', ['install', '--ignore-scripts', '--no-frozen-lockfile'], consumer)
  await run(
    'node',
    [
      '--input-type=module',
      '--eval',
      `
    import assert from 'node:assert/strict'
    import OverlayExpress from '@bsv/overlay-express'
    import * as sdk from '@bsv/sdk'
    assert.equal(typeof OverlayExpress, 'function')
    assert.equal(sdk.parseOutputCapabilities, undefined)
  `
    ],
    consumer
  )
  await run(
    'node',
    [
      '--eval',
      `
    const assert = require('node:assert/strict')
    assert.equal(typeof require('@bsv/overlay-express').default, 'function')
    assert.equal(require('@bsv/sdk').parseOutputCapabilities, undefined)
  `
    ],
    consumer
  )
  const example = `import OverlayExpress from '@bsv/overlay-express'
const host = new OverlayExpress('legacy', '1'.padStart(64, '0'), 'legacy.example.test')
void host.start
`
  await writeFile(join(consumer, 'legacy.mts'), example)
  await writeFile(join(consumer, 'legacy.cts'), example)
  await writeFile(
    join(consumer, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        skipLibCheck: false,
        noEmit: true,
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        target: 'ES2024',
        types: ['node']
      },
      include: ['legacy.mts', 'legacy.cts']
    })
  )
  await run(
    join(root, 'packages/sdk/node_modules/.bin/tsc'),
    ['--project', join(consumer, 'tsconfig.json'), '--pretty', 'false'],
    consumer
  )
  console.log(
    `Packed legacy Overlay Express ESM/CJS runtime and strict .mts/.cts consumers pass with SDK ${LEGACY_SDK}; optional feature remains disabled.`
  )
} finally {
  await rm(temp, { recursive: true, force: true })
}
