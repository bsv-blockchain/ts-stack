import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transform } from 'esbuild'
import * as sdk from '@bsv/sdk'
import * as peerExports from '../sdk-peer-exports'

describe('external SDK category exports', () => {
  it('retains every SDK runtime export and its exact ESM object identity', () => {
    expect(Object.keys(peerExports).sort()).toEqual(Object.keys(sdk).sort())
    for (const name of Object.keys(sdk) as Array<keyof typeof sdk>) expect(peerExports[name]).toBe(sdk[name])
  })

  it('retains constructor and namespace identity through real CommonJS imports', async () => {
    const source = await readFile(new URL('../sdk-peer-exports.ts', import.meta.url), 'utf8')
    const cache = fileURLToPath(new URL('../node_modules/.cache/', import.meta.url))
    await mkdir(cache, { recursive: true })
    const directory = await mkdtemp(join(cache, 'sdk-peer-exports-'))
    const filename = join(directory, 'peer-exports.cjs')
    const require = createRequire(import.meta.url)
    try {
      const compiled = await transform(source, { loader: 'ts', format: 'cjs', target: 'node22' })
      await writeFile(filename, compiled.code)
      const actual = require(filename) as Record<string, unknown>
      const original = require('@bsv/sdk') as Record<string, unknown>
      expect(Object.keys(actual).sort()).toEqual(Object.keys(original).sort())
      for (const name of Object.keys(original)) expect(actual[name]).toBe(original[name])
    } finally {
      delete require.cache[filename]
      await rm(directory, { recursive: true, force: true })
    }
  })
})
