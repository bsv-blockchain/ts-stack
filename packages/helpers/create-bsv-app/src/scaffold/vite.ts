// src/scaffold/vite.ts
import { basename, dirname } from 'node:path'
import type { PackageManager } from '../config/model.js'
import type { BaseScaffolder } from './base-scaffolder.js'

export const CREATE_VITE_VERSION = '9.1.1'

export function viteCommand(
  pm: PackageManager,
  dir: string,
  variant: string
): { command: string; args: string[]; cwd: string } {
  // create-vite scaffolds into a folder named <name> relative to cwd; run from the parent.
  const name = basename(dir)
  const cwd = dirname(dir)
  // --eslint: use ESLint instead of create-vite's default Oxlint for React templates.
  if (pm === 'npm')
    return {
      command: 'npm',
      args: [
        'create',
        `vite@${CREATE_VITE_VERSION}`,
        name,
        '--',
        '--template',
        variant,
        '--eslint'
      ],
      cwd
    }
  if (pm === 'yarn')
    return {
      command: 'yarn',
      args: ['create', `vite@${CREATE_VITE_VERSION}`, name, '--template', variant, '--eslint'],
      cwd
    }
  // pnpm and bun
  return {
    command: pm,
    args: ['create', `vite@${CREATE_VITE_VERSION}`, name, '--template', variant, '--eslint'],
    cwd
  }
}

export const viteScaffolder: BaseScaffolder = {
  scaffold(spec, absDir, opts) {
    if (spec.kind !== 'frontend') throw new Error('viteScaffolder handles only frontend targets')
    const { command, args, cwd } = viteCommand(opts.packageManager, absDir, spec.target.variant)
    opts.runCommand(command, args, { cwd })
  }
}
