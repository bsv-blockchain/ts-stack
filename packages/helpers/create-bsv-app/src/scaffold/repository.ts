import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { Starter } from '../starters.js'
import type { RunCommand } from './base-scaffolder.js'

export interface RepositorySource {
  id: string
  kind: 'repository'
  repository: string
  ref: string
  commit?: string
}

export function scaffoldRepositoryStarter (starter: Starter, targetDir: string, runCommand: RunCommand): RepositorySource {
  if (starter.kind !== 'repository' || starter.repository == null || starter.ref == null) {
    throw new Error(`starter ${starter.id} is not a repository starter`)
  }
  runCommand('git', ['clone', '--depth', '1', '--branch', starter.ref, '--single-branch', starter.repository, targetDir], { cwd: process.cwd() })

  const gitDir = join(targetDir, '.git')
  let commit: string | undefined
  if (existsSync(gitDir)) {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: targetDir, encoding: 'utf8' }).trim()
    rmSync(gitDir, { recursive: true, force: true })
  }
  return { id: starter.id, kind: 'repository', repository: starter.repository, ref: starter.ref, commit }
}
