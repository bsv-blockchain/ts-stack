// src/scaffold/base-scaffolder.ts
import type { FrontendTarget, BackendTarget, PackageManager } from '../config/model.js'
import { viteScaffolder } from './vite.js'
import { expressSkeletonScaffolder } from './express-skeleton.js'

export type TargetSpec =
  { kind: 'frontend'; target: FrontendTarget } | { kind: 'backend'; target: BackendTarget }

export type RunCommand = (command: string, args: string[], opts: { cwd: string }) => void

export interface BaseScaffolder {
  scaffold: (
    spec: TargetSpec,
    absDir: string,
    opts: { packageManager: PackageManager; runCommand: RunCommand }
  ) => void
}

export function scaffolderFor(framework: 'react' | 'express'): BaseScaffolder {
  return framework === 'react' ? viteScaffolder : expressSkeletonScaffolder
}

export { viteScaffolder, expressSkeletonScaffolder }
