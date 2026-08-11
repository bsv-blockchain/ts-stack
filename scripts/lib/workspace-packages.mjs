import { readFile } from 'node:fs/promises'
import path from 'node:path'

function workspaceRuntimeDependencies(manifest) {
  const dependencies = []
  for (const field of ['dependencies', 'optionalDependencies']) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      if (typeof range === 'string' && range.startsWith('workspace:')) {
        dependencies.push(name)
      }
    }
  }
  return dependencies
}

function governedWorkspacePeers(manifest, manifestsByName) {
  return Object.keys(manifest.peerDependencies ?? {}).filter(name => manifestsByName.has(name))
}

function governedWorkspaceRuntimeDependencies(manifest, manifestsByName) {
  return [
    ...workspaceRuntimeDependencies(manifest),
    ...governedWorkspacePeers(manifest, manifestsByName)
  ]
}

export function workspaceRuntimeClosure(rootManifest, manifestsByName) {
  const selected = new Set()
  const queue = governedWorkspaceRuntimeDependencies(rootManifest, manifestsByName)
  while (queue.length > 0) {
    const name = queue.shift()
    if (name === rootManifest.name || selected.has(name)) continue
    const manifest = manifestsByName.get(name)
    if (!manifest) {
      throw new Error(`${rootManifest.name} references unknown workspace dependency ${name}`)
    }
    selected.add(name)
    queue.push(...governedWorkspaceRuntimeDependencies(manifest, manifestsByName))
  }
  return [...selected].sort((left, right) => left.localeCompare(right))
}

export async function governedWorkspacePackages(repositoryRoot) {
  const registry = JSON.parse(
    await readFile(path.join(repositoryRoot, 'governance/repository-health/projects.json'), 'utf8')
  )
  const packages = new Map()
  for (const project of registry.projects) {
    const directory = path.join(repositoryRoot, project.path)
    const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'))
    packages.set(manifest.name, { directory, manifest })
  }
  return packages
}
