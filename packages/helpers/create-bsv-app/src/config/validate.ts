// src/config/validate.ts
import type {
  ProjectConfig,
  PackageManager,
  Network,
  Mode,
  Stack,
  TargetPaths,
  PulledCapability
} from './model.js'
import { defaultTargetPaths, layoutOf } from './model.js'
import { getCapability, listCapabilities } from '../registry.js'
import { getStarter } from '../starters.js'
import { fitsLayout } from '../engine.js'
import { capabilityClosure, pulledCapabilities } from './requires.js'

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

const PACKAGE_MANAGERS: Set<PackageManager> = new Set(['npm', 'pnpm', 'yarn', 'bun'])

function asObject(input: unknown, label: string): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ConfigError(`${label} must be an object`)
  }
  return input as Record<string, unknown>
}

function resolveStack(raw: unknown): Stack {
  const stack: Stack = {}
  if (raw === undefined) return stack
  const s = asObject(raw, 'stack')
  if (s.frontend !== undefined) {
    const fe = asObject(s.frontend, 'stack.frontend')
    if (fe.framework !== 'react') throw new ConfigError('stack.frontend.framework must be "react"')
    const variant =
      typeof fe.variant === 'string' && fe.variant.length > 0 ? fe.variant : 'react-ts'
    stack.frontend = { framework: 'react', variant }
  }
  if (s.backend !== undefined) {
    const be = asObject(s.backend, 'stack.backend')
    if (be.framework !== 'express')
      throw new ConfigError('stack.backend.framework must be "express"')
    stack.backend = { framework: 'express' }
  }
  return stack
}

function validRelativePath(path: string): boolean {
  if (path === '') return true
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false
  return !path.split(/[/\\]/).includes('..')
}

function resolveTargets(raw: unknown, fallback: TargetPaths): TargetPaths {
  if (raw === undefined) return { ...fallback }
  const value = asObject(raw, 'targets')
  const out: TargetPaths = { ...fallback }
  for (const key of ['client', 'server'] as const) {
    const path = value[key]
    if (path === undefined) continue
    if (typeof path !== 'string' || !validRelativePath(path))
      throw new ConfigError(`targets.${key} must be a safe relative path`)
    out[key] = path
  }
  return out
}

export function validBsvDir(dir: string): boolean {
  if (dir.length === 0) return false
  if (dir.startsWith('/') || /^[A-Za-z]:/.test(dir)) return false
  return !dir.split(/[/\\]/).includes('..')
}

function resolveName(raw: Record<string, unknown>): string {
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (name.length === 0) throw new ConfigError('name is required')
  return name
}

export function resolveBsvDir(raw: Record<string, unknown>): string {
  const bsvDir = typeof raw.bsvDir === 'string' && raw.bsvDir.length > 0 ? raw.bsvDir : 'src/bsv'
  if (!validBsvDir(bsvDir)) throw new ConfigError(`invalid bsvDir: ${bsvDir}`)
  return bsvDir
}

export function requestedCapabilityIds(raw: Record<string, unknown>): string[] {
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
function resolveCapabilityIds(
  raw: Record<string, unknown>,
  mode: Mode,
  starterId: string
): string[] {
  const capabilities = requestedCapabilityIds(raw)
  const includeDefaults = mode === 'new' && getStarter(starterId)?.supportsCapabilities === true
  if (!includeDefaults) return capabilities

  const defaults = listCapabilities()
    .filter(capability => capability.defaultSelected === true)
    .map(capability => capability.id)
  for (const id of defaults) if (!capabilities.includes(id)) capabilities.push(id)
  return capabilities
}

const NO_LAYOUT =
  'add mode found no frontend or backend in this directory; pass --frontend react or --backend express, or set a stack in the --file config'

// A capability whose roles all lack a target in this layout would be recorded with nothing written.
// A requested misfit is named before a pulled one, so the error names what the user typed.
function assertCapabilitiesFit(
  capabilities: string[],
  pulled: PulledCapability[],
  stack: Stack
): void {
  if (capabilities.length === 0) return
  const layout = layoutOf(stack)
  if (layout === 'none') throw new ConfigError(NO_LAYOUT)
  const misfits = capabilities.filter(id => {
    const capability = getCapability(id)
    return capability !== undefined && !fitsLayout(capability, layout)
  })
  const misfit = misfits.find(id => !pulled.some(p => p.id === id)) ?? misfits[0]
  if (misfit === undefined) return
  const requiredBy = pulled.find(p => p.id === misfit)?.requiredBy
  const label =
    requiredBy === undefined ? misfit : `${misfit} (required by ${requiredBy.join(', ')})`
  throw new ConfigError(`capability ${label} cannot be placed in this project's layout (${layout})`)
}

function resolvePackageManager(raw: Record<string, unknown>): PackageManager {
  return PACKAGE_MANAGERS.has(raw.packageManager as PackageManager)
    ? (raw.packageManager as PackageManager)
    : 'npm'
}

/**
 * The effective mode: an explicit caller override (e.g. the --mode flag on the --file door)
 * wins over the config's own "mode" field.
 */
export function resolveMode(raw: Record<string, unknown>, overrideMode?: Mode): Mode {
  return overrideMode ?? (raw.mode === 'add' ? 'add' : 'new')
}

export function resolveDir(raw: Record<string, unknown>): string {
  return typeof raw.dir === 'string' && raw.dir.length > 0 ? raw.dir : '.'
}

export function resolveConfig(input: unknown, opts: { overrideMode?: Mode } = {}): ProjectConfig {
  const raw = asObject(input, 'config')

  // Resolved first so the new-mode floor + validation below run against the effective mode.
  const mode = resolveMode(raw, opts.overrideMode)

  const name = resolveName(raw)
  const dir = resolveDir(raw)

  const starterId =
    typeof raw.starter === 'string' && raw.starter.length > 0 ? raw.starter : 'custom'
  const starter = getStarter(starterId)
  if (starter === undefined) throw new ConfigError(`unknown starter: ${starterId}`)

  const requestedStack = resolveStack(raw.stack)
  const stack = mode === 'new' && starter.id !== 'custom' ? starter.stack : requestedStack
  if (mode === 'new' && stack.frontend === undefined && stack.backend === undefined) {
    throw new ConfigError('a new project needs at least a frontend or a backend')
  }

  const targets = resolveTargets(
    raw.targets,
    mode === 'new' && starter.id !== 'custom' ? starter.targets : defaultTargetPaths(stack)
  )

  const bsvDir = resolveBsvDir(raw)
  // every entry point resolves here, so all of them get the same closed list and notice
  const requested = resolveCapabilityIds(raw, mode, starterId)
  const layout = layoutOf(stack)
  const capabilities = capabilityClosure(requested, layout)
  if (mode === 'new' && !starter.supportsCapabilities && capabilities.length > 0) {
    throw new ConfigError(
      `starter ${starter.id} is a complete example and does not accept generated capabilities`
    )
  }
  const pulled = pulledCapabilities(requested, layout)
  assertCapabilitiesFit(capabilities, pulled, stack)
  const glue = raw.glue !== false
  const install = raw.install !== false
  const packageManager = resolvePackageManager(raw)
  const network: Network = raw.network === 'main' || raw.network === 'ttn' ? raw.network : 'test'

  return {
    mode,
    name,
    dir,
    starter: starterId,
    stack,
    targets,
    bsvDir,
    capabilities,
    pulled,
    glue,
    install,
    packageManager,
    network
  }
}

export function formatConfigError(err: unknown): string {
  if (err instanceof ConfigError) return `Invalid config: ${err.message}`
  if (err instanceof Error) return err.message
  return String(err)
}
