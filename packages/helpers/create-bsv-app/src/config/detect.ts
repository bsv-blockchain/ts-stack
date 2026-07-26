import { basename, join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import type { ProjectManifest } from './project-manifest.js'
import type { Stack, TargetPaths } from './model.js'

function readPackage(dir: string): Record<string, unknown> | null {
  const file = join(dir, 'package.json')
  if (!existsSync(file)) return null
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
}

function dependenciesOf(pkg: Record<string, unknown> | null): Record<string, string> {
  if (pkg === null) return {}
  const dependencies = pkg.dependencies as Record<string, string> | undefined
  const devDependencies = pkg.devDependencies as Record<string, string> | undefined
  return Object.assign(Object.create(null), dependencies, devDependencies)
}

function packageName(pkg: Record<string, unknown> | null, dir: string): string {
  return typeof pkg?.name === 'string' && pkg.name.length > 0 ? pkg.name : basename(dir)
}

interface PackagePair {
  client: string
  server: string
}

function manifestForPair(
  dir: string,
  root: Record<string, unknown> | null,
  pair: PackagePair
): ProjectManifest | null {
  const client = readPackage(join(dir, pair.client))
  const server = readPackage(join(dir, pair.server))
  if (client === null && server === null) return null

  const stack: Stack = {}
  const targets: TargetPaths = {}
  if (client !== null) {
    stack.frontend = { framework: 'react', variant: 'react-ts' }
    targets.client = pair.client
  }
  if (server !== null) {
    stack.backend = { framework: 'express' }
    targets.server = pair.server
  }
  return projectManifest(packageName(root, dir), stack, targets)
}

function projectManifest(name: string, stack: Stack, targets: TargetPaths): ProjectManifest {
  return {
    version: 2,
    name,
    network: 'test',
    stack,
    targets,
    bsvDir: 'src/bsv',
    capabilities: [],
    starter: { id: 'custom', kind: 'generated' }
  }
}

function manifestForRoot(dir: string, root: Record<string, unknown>): ProjectManifest | null {
  const deps = dependenciesOf(root)
  const hasReact = deps.react !== undefined
  const hasExpress = deps.express !== undefined
  if (hasReact && hasExpress) {
    throw new Error(
      'cannot infer separate client/server targets from a single package containing both react and express; use --file with explicit targets'
    )
  }
  if (!hasReact && !hasExpress) return null

  const stack: Stack = hasReact
    ? { frontend: { framework: 'react', variant: 'react-ts' } }
    : { backend: { framework: 'express' } }
  const targets: TargetPaths = hasReact ? { client: '' } : { server: '' }
  return projectManifest(packageName(root, dir), stack, targets)
}

/** Infer the common project layouts supported by add mode. */
export function detectExistingProject(dir: string): ProjectManifest | null {
  const root = readPackage(dir)
  const pairs: PackagePair[] = [
    { client: 'client', server: 'server' },
    { client: 'frontend', server: 'backend' }
  ]

  for (const pair of pairs) {
    const manifest = manifestForPair(dir, root, pair)
    if (manifest !== null) return manifest
  }

  return root === null ? null : manifestForRoot(dir, root)
}
