// src/types.ts
export type Framework = 'express' | 'react'

export interface FileSpec {
  /** Relative POSIX path within the target project */
  path: string
  content: string
}

export interface GenContext {
  appName: string
  network: 'main' | 'test'
  framework: Framework
}

export interface Capability {
  id: string
  title: string
  description: string
  /** ids of other capabilities that must also be installed */
  requires?: string[]
  /** frameworks for which this capability emits dedicated files (beyond shared utils) */
  frameworks: Framework[]
  files: (ctx: GenContext) => FileSpec[]
  npmDependencies: (ctx: GenContext) => Record<string, string>
  agentsSection: (ctx: GenContext) => string
}

export interface Selection {
  appName: string
  network: 'main' | 'test'
  framework: Framework
  capabilityIds: string[]
}

export interface Manifest {
  version: 1
  name: string
  network: 'main' | 'test'
  framework: Framework
  capabilities: string[]
}
