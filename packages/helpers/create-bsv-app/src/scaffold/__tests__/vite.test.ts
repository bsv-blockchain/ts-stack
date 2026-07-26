// src/scaffold/__tests__/vite.test.ts
import { describe, expect, test } from '@jest/globals'
import { viteScaffolder, viteCommand } from '../vite'
import type { RunCommand } from '../base-scaffolder'

describe('viteCommand', () => {
  test('npm uses the -- separator before --template and --eslint, run from the parent dir', () => {
    expect(viteCommand('npm', '/proj/client', 'react-ts')).toEqual({
      command: 'npm',
      args: ['create', 'vite@9.1.1', 'client', '--', '--template', 'react-ts', '--eslint'],
      cwd: '/proj'
    })
  })
  test('pnpm/yarn/bun omit the -- separator and pass --eslint', () => {
    expect(viteCommand('pnpm', '/proj/client', 'react-ts').args).toEqual([
      'create',
      'vite@9.1.1',
      'client',
      '--template',
      'react-ts',
      '--eslint'
    ])
    expect(viteCommand('yarn', '/proj/client', 'react-ts').args).toEqual([
      'create',
      'vite@9.1.1',
      'client',
      '--template',
      'react-ts',
      '--eslint'
    ])
    expect(viteCommand('bun', '/proj/client', 'react-ts').args).toEqual([
      'create',
      'vite@9.1.1',
      'client',
      '--template',
      'react-ts',
      '--eslint'
    ])
  })
})

describe('viteScaffolder', () => {
  test('invokes the injected runCommand with the computed vite command', () => {
    const calls: Array<{ command: string; args: string[]; cwd: string }> = []
    const fake: RunCommand = (command, args, opts) => {
      calls.push({ command, args, cwd: opts.cwd })
    }
    viteScaffolder.scaffold(
      { kind: 'frontend', target: { framework: 'react', variant: 'react-ts' } },
      '/proj/client',
      { packageManager: 'npm', runCommand: fake }
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      command: 'npm',
      args: ['create', 'vite@9.1.1', 'client', '--', '--template', 'react-ts', '--eslint'],
      cwd: '/proj'
    })
  })
})
