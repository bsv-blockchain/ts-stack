import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Starter } from '../starters.js'
import type { RunCommand } from './base-scaffolder.js'

export interface RepositorySource {
  id: string
  kind: 'repository'
  repository: string
  ref: string
  commit?: string
}

const COMMIT_PATTERN = /^[0-9a-f]{40}$/

function readCommit(file: string): string | undefined {
  if (!existsSync(file)) return undefined
  const commit = readFileSync(file, 'utf8').trim()
  return COMMIT_PATTERN.test(commit) ? commit : undefined
}

function clonedCommit(gitDir: string): string | undefined {
  const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
  if (COMMIT_PATTERN.test(head)) return head
  if (!head.startsWith('ref: ')) return undefined

  const ref = head.slice('ref: '.length)
  const loose = readCommit(join(gitDir, ...ref.split('/')))
  if (loose !== undefined) return loose

  const packedRefs = join(gitDir, 'packed-refs')
  if (!existsSync(packedRefs)) return undefined
  const match = readFileSync(packedRefs, 'utf8')
    .split('\n')
    .find(line => !line.startsWith('#') && line.endsWith(` ${ref}`))
  return match === undefined ? undefined : readCommitFromPackedLine(match)
}

function readCommitFromPackedLine(line: string): string | undefined {
  const commit = line.split(' ', 1)[0]
  return COMMIT_PATTERN.test(commit) ? commit : undefined
}

export function scaffoldRepositoryStarter(
  starter: Starter,
  targetDir: string,
  runCommand: RunCommand
): RepositorySource {
  if (starter.kind !== 'repository' || starter.repository == null || starter.ref == null) {
    throw new Error(`starter ${starter.id} is not a repository starter`)
  }
  runCommand(
    'git',
    [
      'clone',
      '--depth',
      '1',
      '--branch',
      starter.ref,
      '--single-branch',
      starter.repository,
      targetDir
    ],
    { cwd: process.cwd() }
  )

  const gitDir = join(targetDir, '.git')
  let commit: string | undefined
  if (existsSync(gitDir)) {
    commit = clonedCommit(gitDir)
    rmSync(gitDir, { recursive: true, force: true })
  }
  return {
    id: starter.id,
    kind: 'repository',
    repository: starter.repository,
    ref: starter.ref,
    commit
  }
}
