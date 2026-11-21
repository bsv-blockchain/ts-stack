// src/config/model.ts
export type FrontendFramework = 'react'
export type BackendFramework = 'express'
export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'
export type Network = 'main' | 'test' | 'ttn'
export type Mode = 'new' | 'add'
export type Layout = 'frontend-only' | 'backend-only' | 'monorepo' | 'none'

export interface FrontendTarget {
  framework: FrontendFramework
  variant: string
}
export interface BackendTarget {
  framework: BackendFramework
}
export interface Stack {
  frontend?: FrontendTarget
  backend?: BackendTarget
}
export interface TargetPaths {
  client?: string
  server?: string
}

/** A capability added because a selected one requires it. */
export interface PulledCapability {
  id: string
  /** Members of the closed list that require it, in registry order. */
  requiredBy: string[]
}

export interface ProjectConfig {
  mode: Mode
  name: string
  dir: string
  starter: string
  stack: Stack
  targets: TargetPaths
  bsvDir: string
  /** Closed over `requires`, in registry order. */
  capabilities: string[]
  /** What the closure added beyond the request; set by `resolveConfig`. */
  pulled?: PulledCapability[]
  glue: boolean
  install: boolean
  packageManager: PackageManager
  network: Network
}

export function isMonorepo(stack: Stack): boolean {
  return stack.frontend != null && stack.backend != null
}

export function layoutOf(stack: Stack): Layout {
  const fe = stack.frontend != null
  const be = stack.backend != null
  if (fe && be) return 'monorepo'
  if (fe) return 'frontend-only'
  if (be) return 'backend-only'
  return 'none'
}

export function defaultTargetPaths(stack: Stack): TargetPaths {
  const layout = layoutOf(stack)
  if (layout === 'frontend-only') return { client: '' }
  if (layout === 'backend-only') return { server: '' }
  if (layout === 'monorepo') return { client: 'client', server: 'server' }
  return {}
}

/**
 * Folder of target `t` relative to the project root ('' is the root): the configured path, else the
 * layout default (single-target layouts live at the root). A target the layout lacks falls back to
 * its own name; nothing is placed there.
 */
export function targetFolder(
  config: Pick<ProjectConfig, 'stack' | 'targets'>,
  t: keyof TargetPaths
): string {
  return config.targets[t] ?? defaultTargetPaths(config.stack)[t] ?? t
}
