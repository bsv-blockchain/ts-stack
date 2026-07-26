import { expect, test } from '@jest/globals'
import type { SpawnSyncOptions } from 'node:child_process'
import { makeRunCommand } from '../run-command'

test('runs with stdin NOT inherited so interactive generators stay non-interactive', () => {
  let captured: SpawnSyncOptions | undefined
  const run = makeRunCommand((_c, _a, options) => {
    captured = options
    return { status: 0 }
  })
  run('npm', ['create', 'vite@latest', 'app'], { cwd: '/tmp/x' })
  expect(captured?.stdio).toEqual(['ignore', 'inherit', 'inherit'])
  expect(captured?.cwd).toBe('/tmp/x')
})

test('forwards command and args verbatim', () => {
  const seen: Array<{ command: string; args: string[] }> = []
  const run = makeRunCommand((command, args) => {
    seen.push({ command, args })
    return { status: 0 }
  })
  run('pnpm', ['create', 'vite@latest', 'app', '--template', 'react-ts'], { cwd: '.' })
  expect(seen).toEqual([
    { command: 'pnpm', args: ['create', 'vite@latest', 'app', '--template', 'react-ts'] }
  ])
})

test('throws on non-zero exit status', () => {
  const run = makeRunCommand(() => ({ status: 1 }))
  expect(() => run('npm', ['x'], { cwd: '.' })).toThrow(/command failed \(1\)/)
})

test('throws on spawn error', () => {
  const run = makeRunCommand(() => ({ status: null, error: new Error('ENOENT') }))
  expect(() => run('nope', [], { cwd: '.' })).toThrow(/ENOENT/)
})
