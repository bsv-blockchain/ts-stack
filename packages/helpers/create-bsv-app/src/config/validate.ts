// src/config/validate.ts
import type { ProjectConfig, PackageManager, Network, Mode, Stack } from './model.js'
import { getCapability, listCapabilities } from '../registry.js'

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

// new-mode floor: a new project always gets at least the defaultSelected baseline (e.g. wallet-connect),
// even when the config names zero capabilities. add mode has no floor.
function resolveCapabilityIds (raw: Record<string, unknown>, mode: Mode): string[] {
  const capsRaw = raw.capabilities === undefined ? [] : raw.capabilities
  if (!Array.isArray(capsRaw)) throw new ConfigError('capabilities must be an array')
  const capabilities: string[] = []
  for (const c of capsRaw) {
    if (typeof c !== 'string') throw new ConfigError('capabilities must be strings')
    if (getCapability(c) === undefined) throw new ConfigError(`unknown capability: ${c}`)
    if (!capabilities.includes(c)) capabilities.push(c)
  }
  if (mode === 'new') {
    for (const c of listCapabilities()) {
      if (c.defaultSelected === true && !capabilities.includes(c.id)) capabilities.push(c.id)
    }
  }
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

  const stack = resolveStack(raw.stack)
  if (mode === 'new' && stack.frontend === undefined && stack.backend === undefined) {
    throw new ConfigError('a new project needs at least a frontend or a backend')
  }

  const bsvDir = resolveBsvDir(raw)
  const capabilities = resolveCapabilityIds(raw, mode)
  const glue = raw.glue !== false
  const packageManager = resolvePackageManager(raw)
  const network: Network = raw.network === 'main' ? 'main' : 'test'

  return { mode, name, dir, stack, bsvDir, capabilities, glue, packageManager, network }
}

export function formatConfigError (err: unknown): string {
  if (err instanceof ConfigError) return `Invalid config: ${err.message}`
  if (err instanceof Error) return err.message
  return String(err)
}
