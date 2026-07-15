// src/config/validate.ts
import type { ProjectConfig, PackageManager, Network, Mode, Stack, TargetPaths } from './model.js'
import { defaultTargetPaths } from './model.js'
import { getCapability, listCapabilities } from '../registry.js'
import { getStarter } from '../starters.js'

export class ConfigError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

const PACKAGE_MANAGERS: Set<PackageManager> = new Set(['npm', 'pnpm', 'yarn', 'bun'])

function asObject (input: unknown, label: string): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ConfigError(`${label} must be an object`)
  }
  return input as Record<string, unknown>
}

function resolveStack (raw: unknown): Stack {
  const stack: Stack = {}
  if (raw === undefined) return stack
  const s = asObject(raw, 'stack')
  if (s.frontend !== undefined) {
    const fe = asObject(s.frontend, 'stack.frontend')
    if (fe.framework !== 'react') throw new ConfigError('stack.frontend.framework must be "react"')
    const variant = typeof fe.variant === 'string' && fe.variant.length > 0 ? fe.variant : 'react-ts'
    stack.frontend = { framework: 'react', variant }
  }
  if (s.backend !== undefined) {
    const be = asObject(s.backend, 'stack.backend')
    if (be.framework !== 'express') throw new ConfigError('stack.backend.framework must be "express"')
    stack.backend = { framework: 'express' }
  }
  return stack
}

function validRelativePath (path: string): boolean {
  if (path === '') return true
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false
  return !path.split(/[/\\]/).includes('..')
}

function resolveTargets (raw: unknown, fallback: TargetPaths): TargetPaths {
  if (raw === undefined) return { ...fallback }
  const value = asObject(raw, 'targets')
  const out: TargetPaths = { ...fallback }
  for (const key of ['client', 'server'] as const) {
    const path = value[key]
    if (path === undefined) continue
    if (typeof path !== 'string' || !validRelativePath(path)) throw new ConfigError(`targets.${key} must be a safe relative path`)
    out[key] = path
  }
  return out
}

export function validBsvDir (dir: string): boolean {
  if (dir.length === 0) return false
  if (dir.startsWith('/') || /^[A-Za-z]:/.test(dir)) return false
  return !dir.split(/[/\\]/).includes('..')
}

function resolveName (raw: Record<string, unknown>): string {
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (name.length === 0) throw new ConfigError('name is required')
  return name
}

function resolveBsvDir (raw: Record<string, unknown>): string {
  const bsvDir = typeof raw.bsvDir === 'string' && raw.bsvDir.length > 0 ? raw.bsvDir : 'src/bsv'
  if (!validBsvDir(bsvDir)) throw new ConfigError(`invalid bsvDir: ${bsvDir}`)
  return bsvDir
}

function requestedCapabilityIds (raw: Record<string, unknown>): string[] {
  const capsRaw = raw.capabilities === undefined ? [] : raw.capabilities
  if (!Array.isArray(capsRaw)) throw new ConfigError('capabilities must be an array')
  const capabilities: string[] = []
  for (const c of capsRaw) {
    if (typeof c !== 'string') throw new ConfigError('capabilities must be strings')
    if (getCapability(c) === undefined) throw new ConfigError(`unknown capability: ${c}`)
    if (!capabilities.includes(c)) capabilities.push(c)
  }
  return capabilities
}

// New generated projects always get the defaultSelected baseline even when the
// config names zero capabilities. Add mode and complete examples have no floor.
function resolveCapabilityIds (raw: Record<string, unknown>, mode: Mode, starterId: string): string[] {
  const capabilities = requestedCapabilityIds(raw)
  const includeDefaults = mode === 'new' && getStarter(starterId)?.supportsCapabilities === true
  if (!includeDefaults) return capabilities

  const defaults = listCapabilities()
    .filter(capability => capability.defaultSelected === true)
    .map(capability => capability.id)
  for (const id of defaults) if (!capabilities.includes(id)) capabilities.push(id)
  return capabilities
}

function resolvePackageManager (raw: Record<string, unknown>): PackageManager {
  return PACKAGE_MANAGERS.has(raw.packageManager as PackageManager) ? raw.packageManager as PackageManager : 'npm'
}

export function resolveConfig (input: unknown, opts: { overrideMode?: Mode } = {}): ProjectConfig {
  const raw = asObject(input, 'config')

  // An explicit caller override (e.g. the --mode flag on the --file door) wins over the
  // config's own "mode" field. Resolved here so the new-mode floor + validation below
  // run against the effective mode.
  const mode: Mode = opts.overrideMode ?? (raw.mode === 'add' ? 'add' : 'new')

  const name = resolveName(raw)
  const dir = typeof raw.dir === 'string' && raw.dir.length > 0 ? raw.dir : '.'

  const starterId = typeof raw.starter === 'string' && raw.starter.length > 0 ? raw.starter : 'custom'
  const starter = getStarter(starterId)
  if (starter === undefined) throw new ConfigError(`unknown starter: ${starterId}`)

  const requestedStack = resolveStack(raw.stack)
  const stack = mode === 'new' && starter.id !== 'custom' ? starter.stack : requestedStack
  if (mode === 'new' && stack.frontend === undefined && stack.backend === undefined) {
    throw new ConfigError('a new project needs at least a frontend or a backend')
  }

  const targets = resolveTargets(raw.targets, mode === 'new' && starter.id !== 'custom' ? starter.targets : defaultTargetPaths(stack))

  const bsvDir = resolveBsvDir(raw)
  const capabilities = resolveCapabilityIds(raw, mode, starterId)
  if (mode === 'new' && !starter.supportsCapabilities && capabilities.length > 0) {
    throw new ConfigError(`starter ${starter.id} is a complete example and does not accept generated capabilities`)
  }
  const glue = raw.glue !== false
  const install = raw.install !== false
  const packageManager = resolvePackageManager(raw)
  const network: Network = raw.network === 'main' ? 'main' : 'test'

  return { mode, name, dir, starter: starterId, stack, targets, bsvDir, capabilities, glue, install, packageManager, network }
}

export function formatConfigError (err: unknown): string {
  if (err instanceof ConfigError) return `Invalid config: ${err.message}`
  if (err instanceof Error) return err.message
  return String(err)
}
