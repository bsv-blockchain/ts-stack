/**
 * Sync GitHub Environment Secrets for staging/prod.
 *
 * Requirements:
 * - GitHub CLI installed: https://cli.github.com/
 * - Logged in: `gh auth login`
 * - Optional absolute CLI overrides: `GH_CLI_PATH`, `GIT_CLI_PATH`
 *
 * Usage:
 *   npm run secrets:staging
 *   npm run secrets:prod
 *
 * Reads from: secrets/<env>.env (KEY=VALUE lines)
 * Writes: Environment Secrets named KEY (unprefixed), scoped to the selected environment.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

type EnvName = 'staging' | 'prod'

const args = process.argv.slice(2)
const repo = getFlag('--repo') || getRepoFromGit()
const envName = (getFlag('--env') as EnvName) || 'staging'
const createEnv = hasFlag('--create-env')

if (!repo) die('Missing --repo owner/name')
if (!['staging', 'prod'].includes(envName)) die('--env must be staging or prod')

ensureGhAuth()

const secretsFile = join(process.cwd(), 'secrets', `${envName}.env`)
if (!existsSync(secretsFile)) {
  die(`Secrets file not found: ${secretsFile}`)
}

const kv = parseEnvFile(readFileSync(secretsFile, 'utf8'))
const envLabel = envName === 'prod' ? 'production' : 'staging' // GitHub Environment name

// Ensure the GitHub Environment exists
if (createEnv) ensureEnvironment(repo, envLabel)

const keys = Object.keys(kv)
console.log(`Syncing ${keys.length} secrets to ${repo} environment=${envLabel} (unprefixed names)`)

bulkSetSecrets(repo, envLabel, kv)

console.log(`Done. Pushed ${keys.length} secrets to ${repo} (${envLabel})`)

function ensureGhAuth() {
  const res = spawnSync(getGhExecutable(), ['auth', 'status'], { stdio: 'ignore' })
  if (res.status !== 0) die('GitHub CLI not authenticated. Run: gh auth login')
}

function ensureEnvironment(repository: string, env: string) {
  // 1) Check if the environment exists
  const check = spawnSync(
    getGhExecutable(),
    ['api', `repos/${repository}/environments/${encodeURIComponent(env)}`],
    { stdio: 'ignore' }
  )
  if (check.status === 0) return // already exists

  console.log(`Creating environment '${env}' in ${repository}...`)
  // 2) Create it (no body needed for basic create)
  const res = spawnSync(
    getGhExecutable(),
    ['api', '-X', 'PUT', `repos/${repository}/environments/${encodeURIComponent(env)}`],
    { stdio: 'inherit' }
  )
  if (res.status !== 0) die(`Failed to create environment '${env}'.`)
}

function parseEnvFile(src: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const idx = line.indexOf('=')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    const val = line.slice(idx + 1).trim()
    if (!key) continue
    out[key] = val
  }
  return out
}

function getFlag(name: string): string | undefined {
  const i = args.indexOf(name)
  if (i === -1 || i === args.length - 1) return undefined
  return args[i + 1]
}
function hasFlag(name: string): boolean {
  return args.includes(name)
}
function die(msg: string): never {
  console.error(`✖ ${msg}`)
  process.exit(1)
}

function getRepoFromGit(): string {
  try {
    const url = execFileSync(
      getTrustedExecutable('GIT_CLI_PATH', [
        '/usr/bin/git',
        '/opt/homebrew/bin/git',
        '/usr/local/bin/git'
      ]),
      ['config', '--get', 'remote.origin.url'],
      { encoding: 'utf8' }
    ).trim()
    if (url.startsWith('git@github.com:')) {
      return stripGitSuffix(url.slice('git@github.com:'.length))
    }
    const parsed = new URL(url)
    if (parsed.hostname === 'github.com') {
      const repo = parsed.pathname.split('/').filter(Boolean).join('/')
      return stripGitSuffix(repo)
    }
  } catch {}
  throw new Error('Unable to determine repo from git config. Pass --repo instead.')
}

function stripGitSuffix(repo: string): string {
  return repo.endsWith('.git') ? repo.slice(0, -4) : repo
}

function getGhExecutable(): string {
  return getTrustedExecutable('GH_CLI_PATH', [
    '/usr/bin/gh',
    '/opt/homebrew/bin/gh',
    '/usr/local/bin/gh'
  ])
}

function getTrustedExecutable(environmentName: string, defaults: string[]): string {
  const configured = process.env[environmentName]
  const candidates = configured === undefined ? defaults : [configured]
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue
    try {
      accessSync(candidate, constants.X_OK)
      return realpathSync(candidate)
    } catch {}
  }
  const instruction =
    configured === undefined
      ? `Install the CLI in one of: ${defaults.join(', ')}`
      : `${environmentName} must name an existing executable by absolute path`
  throw new Error(instruction)
}

function bulkSetSecrets(repository: string, env: string, kv: Record<string, string>) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'uhrp-secrets-'))
  const temporaryFile = join(temporaryDirectory, `${env}.env`)
  const escapedNewline = String.raw`\n`
  const lines = Object.entries(kv).map(([key, value]) => {
    return `${key}=${value.split('\n').join(escapedNewline)}`
  })
  let status: number | null = null
  try {
    writeFileSync(temporaryFile, lines.join('\n'), { encoding: 'utf8', mode: 0o600 })
    status = spawnSync(
      getGhExecutable(),
      ['secret', 'set', '-R', repository, '-e', env, '-f', temporaryFile],
      { stdio: 'inherit' }
    ).status
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
  if (status !== 0) die(`Bulk secret set failed for env ${env}`)
}
