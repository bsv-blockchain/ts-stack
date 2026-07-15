import { basename, join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import type { ProjectManifest } from './project-manifest.js'
import type { Stack, TargetPaths } from './model.js'

function readPackage (dir: string): Record<string, unknown> | null {
  const file = join(dir, 'package.json')
  if (!existsSync(file)) return null
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
}

function dependenciesOf (pkg: Record<string, unknown> | null): Record<string, string> {
  if (pkg === null) return {}
  return {
    ...((pkg.dependencies as Record<string, string> | undefined) ?? {}),
    ...((pkg.devDependencies as Record<string, string> | undefined) ?? {})
  }
}

function packageName (pkg: Record<string, unknown> | null, dir: string): string {
  return typeof pkg?.name === 'string' && pkg.name.length > 0 ? pkg.name : basename(dir)
}

/** Infer the common project layouts supported by add mode. */
export function detectExistingProject (dir: string): ProjectManifest | null {
  const root = readPackage(dir)
  const pairs: Array<{ client: string, server: string }> = [
    { client: 'client', server: 'server' },
    { client: 'frontend', server: 'backend' }
  ]

  for (const pair of pairs) {
    const client = readPackage(join(dir, pair.client))
    const server = readPackage(join(dir, pair.server))
    if (client !== null || server !== null) {
      const stack: Stack = {}
      const targets: TargetPaths = {}
      if (client !== null) { stack.frontend = { framework: 'react', variant: 'react-ts' }; targets.client = pair.client }
      if (server !== null) { stack.backend = { framework: 'express' }; targets.server = pair.server }
      return {
        version: 2,
        name: packageName(root, dir),
        network: 'test',
        stack,
        targets,
        bsvDir: 'src/bsv',
        capabilities: [],
        starter: { id: 'custom', kind: 'generated' }
      }
    }
  }

  if (root === null) return null
  const deps = dependenciesOf(root)
  const hasReact = deps.react !== undefined
  const hasExpress = deps.express !== undefined
  if (hasReact && hasExpress) {
    throw new Error('cannot infer separate client/server targets from a single package containing both react and express; use --file with explicit targets')
  }
  if (!hasReact && !hasExpress) return null

  const stack: Stack = hasReact
    ? { frontend: { framework: 'react', variant: 'react-ts' } }
    : { backend: { framework: 'express' } }
  const targets: TargetPaths = hasReact ? { client: '' } : { server: '' }
  return {
    version: 2,
    name: packageName(root, dir),
    network: 'test',
    stack,
    targets,
    bsvDir: 'src/bsv',
    capabilities: [],
    starter: { id: 'custom', kind: 'generated' }
  }
}
