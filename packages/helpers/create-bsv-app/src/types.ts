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

export interface Capability {
  id: string
  title: string
  description: string
  /** ids of other capabilities that must also be installed */
  requires?: string[]
  roles: Role[]
  files: (ctx: CapabilityContext) => Partial<Record<Role, FileSpec[]>>
  glue?: (ctx: CapabilityContext) => Partial<Record<Role, FileSpec[]>>
  npmDependencies: (ctx: CapabilityContext) => Partial<Record<Role, Record<string, string>>>
  agentsSection: (ctx: CapabilityContext) => string
}
