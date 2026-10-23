#!/usr/bin/env node

// Restore or save per-package build outputs keyed by everything that can
// change them.
//
// A package's key hashes the git blob ids of its own tracked files (and
// source roots), of every workspace package it depends on directly or not, and
// of the root toolchain inputs, plus the Node version and platform. A restored
// package is byte-for-byte the output of a build of identical inputs; any
// change to those inputs misses the cache and rebuilds the package.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CACHE_FORMAT = 'build-output-cache-v1'
const ROOT_INPUTS = [
  '.npmrc',
  'config/typescript',
  'package.json',
  'patches',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json'
]
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies'
]
const OUTPUT_DIRECTORIES = new Set(['dist', 'out'])

function git(arguments_) {
  return execFileSync('/usr/bin/git', arguments_, { cwd: REPOSITORY_ROOT, encoding: 'utf8' })
}

function treeListing(paths) {
  return paths.length === 0 ? '' : git(['ls-tree', '-r', 'HEAD', '--', ...paths])
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

export function loadProjects(root = REPOSITORY_ROOT) {
  const registry = JSON.parse(
    readFileSync(path.join(root, 'governance/repository-health/projects.json'), 'utf8')
  )
  return registry.projects
    .filter(project => project.path !== '.')
    .map(project => {
      const manifest = JSON.parse(
        readFileSync(path.join(root, project.path, 'package.json'), 'utf8')
      )
      return {
        name: manifest.name,
        path: project.path,
        sourceRoots: project.sourceRoots ?? [],
        dependencies: DEPENDENCY_FIELDS.flatMap(field => Object.keys(manifest[field] ?? {}))
      }
    })
}

// Every workspace package a project depends on, directly or not, itself included.
export function dependencyClosure(projects, name) {
  const byName = new Map(projects.map(project => [project.name, project]))
  const seen = new Set()
  const queue = [name]
  while (queue.length > 0) {
    const current = queue.shift()
    if (seen.has(current) || !byName.has(current)) continue
    seen.add(current)
    queue.push(...byName.get(current).dependencies)
  }
  return [...seen].sort((left, right) => left.localeCompare(right))
}

export function packageKeys(projects, names, listing = treeListing) {
  const byName = new Map(projects.map(project => [project.name, project]))
  const rootKey = sha256(
    [CACHE_FORMAT, process.version, process.platform, process.arch, listing(ROOT_INPUTS)].join('\n')
  )
  const ownKeys = new Map()
  const ownKey = name => {
    if (!ownKeys.has(name)) {
      const project = byName.get(name)
      ownKeys.set(name, sha256(listing([project.path, ...project.sourceRoots])))
    }
    return ownKeys.get(name)
  }
  return new Map(
    names.map(name => {
      if (!byName.has(name)) throw new Error(`Unknown workspace package ${name}`)
      const inputs = dependencyClosure(projects, name).map(member => `${member} ${ownKey(member)}`)
      return [name, sha256([rootKey, ...inputs].join('\n')).slice(0, 32)]
    })
  )
}

function cachePrefix(name) {
  return `${name.replaceAll(/[^A-Za-z0-9._-]/g, '_')}--`
}

export function cacheFileName(name, key) {
  return `${cachePrefix(name)}${key}.tar.gz`
}

// Build outputs under a package, excluding node_modules and nested packages,
// which own their outputs under their own keys.
export function packageOutputs(projects, name, root = REPOSITORY_ROOT) {
  const project = projects.find(candidate => candidate.name === name)
  const nested = new Set(
    projects
      .filter(other => other.path !== project.path && other.path.startsWith(`${project.path}/`))
      .map(other => other.path)
  )
  const outputs = []
  const visit = relative => {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || nested.has(child)) continue
        if (OUTPUT_DIRECTORIES.has(entry.name)) outputs.push(child)
        else visit(child)
      } else if (entry.isFile() && entry.name.endsWith('.tsbuildinfo')) {
        outputs.push(child)
      }
    }
  }
  visit(project.path)
  return outputs.sort((left, right) => left.localeCompare(right))
}

function restore(projects, names, directory) {
  const keys = packageKeys(projects, names)
  const restored = []
  const build = []
  for (const name of names) {
    const file = path.join(directory, cacheFileName(name, keys.get(name)))
    if (existsSync(file)) {
      execFileSync('/usr/bin/tar', ['--extract', '--gzip', '--file', file], {
        cwd: REPOSITORY_ROOT
      })
      restored.push(name)
    } else {
      build.push(name)
    }
  }
  return { restored, build }
}

function save(projects, names, directory) {
  mkdirSync(directory, { recursive: true })
  const keys = packageKeys(projects, names)
  const saved = []
  for (const name of names) {
    const file = path.join(directory, cacheFileName(name, keys.get(name)))
    if (existsSync(file)) continue
    const outputs = packageOutputs(projects, name)
    execFileSync('/usr/bin/tar', ['--create', '--gzip', '--file', file, '--files-from', '-'], {
      cwd: REPOSITORY_ROOT,
      input: outputs.map(output => `${output}\n`).join('')
    })
    saved.push(name)
  }
  // Keep one entry per package: the current key.
  const current = new Set(names.map(name => cacheFileName(name, keys.get(name))))
  const prefixes = names.map(cachePrefix)
  for (const file of readdirSync(directory)) {
    if (!current.has(file) && prefixes.some(prefix => file.startsWith(prefix)))
      rmSync(path.join(directory, file))
  }
  return { saved }
}

// Every package the shared build produces; docs-site and the paymail example
// are built by their own jobs.
export function buildableNames(projects) {
  return projects
    .map(project => project.name)
    .filter(name => name !== 'docs-site' && name !== 'example-paymail')
    .sort((left, right) => left.localeCompare(right))
}

export function parseArguments(arguments_) {
  const [command, ...rest] = arguments_
  if (command === 'names' && rest.length === 0) return { command }
  if (!['restore', 'save'].includes(command))
    throw new Error('Command must be names, restore or save')
  const options = { command }
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]
    const value = rest[index + 1]
    if (!['--names-json', '--cache-directory'].includes(key) || value === undefined)
      throw new Error(`Unknown or incomplete argument: ${key}`)
    options[key.slice(2)] = value
  }
  for (const key of ['names-json', 'cache-directory'])
    if (!options[key]) throw new Error(`--${key} is required`)
  return options
}

function main(arguments_) {
  const options = parseArguments(arguments_)
  if (options.command === 'names') {
    process.stdout.write(`${JSON.stringify(buildableNames(loadProjects()))}\n`)
    return
  }
  const names = JSON.parse(options['names-json'])
  if (!Array.isArray(names) || names.some(name => typeof name !== 'string'))
    throw new Error('--names-json must be an array of package names')
  const directory = path.resolve(options['cache-directory'])
  const projects = loadProjects()
  const result =
    options.command === 'restore'
      ? restore(projects, names, directory)
      : save(projects, names, directory)
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
