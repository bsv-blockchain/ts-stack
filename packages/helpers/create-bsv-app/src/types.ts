// src/types.ts
import type { Network, Stack, Layout } from './config/model.js'

export interface FileSpec {
  /** Relative POSIX path within the target project */
  path: string
  content: string
}

export type Role = 'shared' | 'client' | 'server'

export interface CapabilityContext {
  name: string
  network: Network
  bsvDir: string
  stack: Stack
  layout: Layout
}

export interface RouteDef {
  path: string
  component: string
  importPath: string
  /** Human label for the Home demo hub (falls back to the path). */
  label?: string
}

export interface BaseBuilder {
  main: { imports: string[], wraps: Array<{ open: string, close: string }> }
  app: { imports: string[], routes: RouteDef[] }
  server: { imports: string[], routes: string[] }
}

export interface Capability {
  id: string
  title: string
  description: string
  /** ids of other capabilities that must also be installed */
  requires?: string[]
  roles: Role[]
  /** Pre-selected in NEW-project mode (not auto-selected in add mode). */
  defaultSelected?: boolean
  files: (ctx: CapabilityContext) => Partial<Record<Role, FileSpec[]>>
  glue?: (ctx: CapabilityContext) => Partial<Record<Role, FileSpec[]>>
  baseEdits?: (args: { builder: BaseBuilder, ctx: CapabilityContext }) => void
  npmDependencies: (ctx: CapabilityContext) => Partial<Record<Role, Record<string, string>>>
  agentsSection: (ctx: CapabilityContext) => string
}
