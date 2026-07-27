#!/usr/bin/env node

import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const MODES = Object.freeze({
  manual: '.man.test.ts',
  live: '.live.test.ts',
  resource: '.man.test.ts'
})

export function resolveGovernedTest(cwd, mode, requestedPath) {
  const requiredSuffix = MODES[mode]
  if (requiredSuffix === undefined) {
    throw new Error(`Unknown governed test mode "${mode}". Expected manual, live, or resource.`)
  }
  if (typeof requestedPath !== 'string' || requestedPath.trim() === '') {
    throw new Error(
      `A test path is required. Example: pnpm test:${mode} -- path/to/example${requiredSuffix}`
    )
  }

  const workspaceRoot = realpathSync(cwd)
  const absolutePath = path.resolve(workspaceRoot, requestedPath)
  const relativePath = path.relative(workspaceRoot, absolutePath)
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`Governed test path escapes the workspace: ${requestedPath}`)
  }
  if (!relativePath.endsWith(requiredSuffix)) {
    throw new Error(`${mode} tests must end with ${requiredSuffix}: ${relativePath}`)
  }
  if (!existsSync(absolutePath)) {
    throw new Error(`Governed test does not exist: ${relativePath}`)
  }

  return relativePath
}

function run() {
  const [mode, requestedPath] = process.argv.slice(2)
  let testPath
  try {
    testPath = resolveGovernedTest(process.cwd(), mode, requestedPath)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 2
    return
  }

  const executable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const nodeOptions = process.env.NODE_OPTIONS ?? ''
  const env =
    mode === 'resource'
      ? {
          ...process.env,
          NODE_OPTIONS: `${nodeOptions} --max-old-space-size=3072`.trim()
        }
      : process.env
  const result = spawnSync(
    executable,
    [
      'exec',
      'jest',
      '--runInBand',
      '--runTestsByPath',
      testPath,
      '--testPathIgnorePatterns=^$',
      '--watchman=false'
    ],
    { env, stdio: 'inherit' }
  )

  if (result.error !== undefined) throw result.error
  process.exitCode = result.status ?? 1
}

const isMain =
  process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) run()
