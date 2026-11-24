#!/usr/bin/env node
'use strict'

/**
 * Pane dev-server runner for ts-stack.
 *
 * Usage:
 *   node scripts/pane-run-script.js [target] [-- extra dev-server args]
 *
 * Targets:
 *   docs-site (default)          Vite docs site, served at /ts-stack/
 *   lch-reference                apps/lch-reference (Vite)
 *   output-knowledge-reference   apps/output-knowledge-reference (Vite)
 *   <relative directory>         any other project; its type is auto-detected
 *
 * Every Pane terminal has its own block of 10 ports that starts at PANE_PORT.
 * Without PANE_PORT the block comes from a hash of the checkout path, with
 * separate ranges for the main checkout and for worktrees.
 *
 * The script verifies the install, rebuilds stale inputs, reclaims its own port
 * from a crashed earlier run, removes stale framework locks, and stops the
 * whole dev-server process tree on Ctrl+C, SIGTERM, or terminal close.
 */

const { execFileSync, spawn, spawnSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')

const IS_WINDOWS = process.platform === 'win32'
const PORT_BLOCK_SIZE = 10
const FALLBACK_BASE_MAIN = 3000
const FALLBACK_BASE_WORKTREE = 4000
const PROBE_HOSTS = ['0.0.0.0', '::', '127.0.0.1', '::1']
const STOP_GRACE_MS = 5000

/** Dev servers that this repository ships. `offset` keeps targets apart inside one port block. */
const KNOWN_TARGETS = {
  'docs-site': {
    dir: 'docs-site',
    offset: 0,
    urlPath: '/ts-stack/',
    prepare: prepareDocsManifest
  },
  'lch-reference': { dir: 'apps/lch-reference', offset: 1, urlPath: '/' },
  'output-knowledge-reference': {
    dir: 'apps/output-knowledge-reference',
    offset: 2,
    urlPath: '/'
  }
}

/** Framework leftovers from a killed session. Patterns are relative to the target directory. */
const STALE_LOCK_PATTERNS = [
  '.next/dev/lock',
  '.next/lock',
  '.cache/lock',
  '.parcel-cache/lock',
  '.svelte-kit/lock',
  '.nuxt/lock',
  'node_modules/.vite/deps_temp_*',
  'node_modules/.vite-temp/*',
  'vite.config.*.timestamp-*',
  'vitest.config.*.timestamp-*'
]

function log(message) {
  process.stdout.write(`[pane-run] ${message}\n`)
}

const SYSTEM32 = path.join(process.env.SystemRoot ?? String.raw`C:\Windows`, 'System32')
const WINDOWS_TOOLS = {
  netstat: path.join(SYSTEM32, 'netstat.exe'),
  taskkill: path.join(SYSTEM32, 'taskkill.exe'),
  powershell: path.join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}
const UNIX_SYSTEM_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']
const executableCache = new Map()

function isFile(file) {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/**
 * Absolute path of `name`, found on PATH (plus the system directories on Unix).
 * Commands are never spawned by bare name, so a relative PATH entry or the
 * current directory cannot supply the binary.
 */
function resolveExecutable(name) {
  if (IS_WINDOWS && WINDOWS_TOOLS[name]) return WINDOWS_TOOLS[name]
  if (executableCache.has(name)) return executableCache.get(name)
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(dir => path.isAbsolute(dir))
  if (!IS_WINDOWS) dirs.push(...UNIX_SYSTEM_DIRS)
  const extensions = IS_WINDOWS ? ['.exe', '.cmd', '.bat'] : ['']
  let found = null
  for (const dir of dirs) {
    found = extensions.map(ext => path.join(dir, name + ext)).find(isFile) ?? null
    if (found) break
  }
  executableCache.set(name, found)
  return found
}

/** Windows runs .cmd and .bat files (pnpm.cmd, npm.cmd) only through a shell. */
function needsShell(file) {
  return IS_WINDOWS && /\.(cmd|bat)$/i.test(file)
}

function run(command, args, options = {}) {
  const file = path.isAbsolute(command) ? command : resolveExecutable(command)
  if (!file) return ''
  try {
    return execFileSync(file, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      ...options
    }).trim()
  } catch {
    return ''
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Checkout detection
// ---------------------------------------------------------------------------

function isInside(child, parent) {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** Parse `git worktree list --porcelain` into absolute paths. */
function parseWorktreeList(output) {
  return output
    .split(/\r?\n/)
    .filter(line => line.startsWith('worktree '))
    .map(line => path.resolve(line.slice('worktree '.length)))
}

function detectCheckout(cwd) {
  const root = run('git', ['rev-parse', '--show-toplevel'], { cwd })
  if (!root) {
    return { root: cwd, isWorktree: false, mainRoot: cwd, otherWorktrees: [] }
  }
  const resolvedRoot = path.resolve(root)
  const gitDir = path.resolve(resolvedRoot, run('git', ['rev-parse', '--git-dir'], { cwd }))
  const commonDir = path.resolve(
    resolvedRoot,
    run('git', ['rev-parse', '--git-common-dir'], { cwd })
  )
  const worktrees = parseWorktreeList(run('git', ['worktree', 'list', '--porcelain'], { cwd }))
  return {
    root: resolvedRoot,
    isWorktree: gitDir !== commonDir,
    mainRoot: path.dirname(commonDir),
    otherWorktrees: worktrees.filter(dir => dir !== resolvedRoot)
  }
}

/**
 * True when `candidate` is inside `owner` and not inside a different worktree
 * nested below it. The main checkout contains `worktrees/*` checkouts, so a
 * plain prefix match would claim their processes.
 */
function isOwnedPath(candidate, owner, otherWorktrees) {
  if (!candidate || !path.isAbsolute(candidate) || !isInside(candidate, owner)) return false
  return !otherWorktrees.some(
    other => other !== owner && isInside(other, owner) && isInside(candidate, other)
  )
}

// ---------------------------------------------------------------------------
// Project type detection
// ---------------------------------------------------------------------------

function exists(file) {
  return fs.existsSync(file)
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** Find the nearest directory at or above `dir` (but not above `root`) that holds `name`. */
function findUp(dir, root, name) {
  let current = dir
  for (;;) {
    if (exists(path.join(current, name))) return current
    if (current === root || path.dirname(current) === current) return null
    current = path.dirname(current)
  }
}

function detectNodePackageManager(dir, root) {
  const managers = [
    { name: 'pnpm', lock: 'pnpm-lock.yaml' },
    { name: 'yarn', lock: 'yarn.lock' },
    { name: 'bun', lock: 'bun.lockb' },
    { name: 'npm', lock: 'package-lock.json' }
  ]
  for (const manager of managers) {
    const lockDir = findUp(dir, root, manager.lock)
    if (lockDir) return { ...manager, lockDir }
  }
  return { name: 'npm', lock: null, lockDir: dir }
}

function detectProject(dir, root) {
  if (exists(path.join(dir, 'package.json'))) {
    const pkg = readJson(path.join(dir, 'package.json')) ?? {}
    const scripts = pkg.scripts ?? {}
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    let framework = 'node'
    if (deps.next) framework = 'next'
    else if (deps.vite || /\bvite\b/.test(scripts.dev ?? '')) framework = 'vite'
    return { type: 'node', framework, pkg, manager: detectNodePackageManager(dir, root) }
  }
  if (exists(path.join(dir, 'Cargo.toml'))) return { type: 'rust', framework: 'cargo' }
  if (exists(path.join(dir, 'go.mod'))) return { type: 'go', framework: 'go' }
  if (exists(path.join(dir, 'manage.py'))) return { type: 'python', framework: 'django' }
  if (exists(path.join(dir, 'requirements.txt')) || exists(path.join(dir, 'pyproject.toml'))) {
    return { type: 'python', framework: 'python' }
  }
  return null
}

// ---------------------------------------------------------------------------
// Dependency freshness
// ---------------------------------------------------------------------------

function mtimeMs(file) {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return 0
  }
}

function sameContent(a, b) {
  try {
    return fs.readFileSync(a).equals(fs.readFileSync(b))
  } catch {
    return false
  }
}

/**
 * Decide whether node_modules is out of date with the lock file. pnpm keeps a
 * copy of the lock file in node_modules/.pnpm/lock.yaml, so a content
 * comparison works even after Pane copies node_modules with new mtimes.
 */
function nodeInstallIsStale(manager) {
  const dir = manager.lockDir
  const modules = path.join(dir, 'node_modules')
  if (!exists(modules)) return 'node_modules is missing'
  if (!manager.lock) return null
  const lockFile = path.join(dir, manager.lock)
  if (manager.name === 'pnpm') {
    const installed = path.join(modules, '.pnpm', 'lock.yaml')
    if (!exists(installed)) return 'node_modules/.pnpm/lock.yaml is missing'
    return sameContent(lockFile, installed) ? null : 'pnpm-lock.yaml changed since the last install'
  }
  const markers = {
    npm: '.package-lock.json',
    yarn: exists(path.join(modules, '.yarn-state.yml')) ? '.yarn-state.yml' : '.yarn-integrity',
    bun: '.bun-tag'
  }
  const marker = path.join(modules, markers[manager.name] ?? '.package-lock.json')
  if (!exists(marker)) return null
  return mtimeMs(lockFile) > mtimeMs(marker) ? `${manager.lock} is newer than node_modules` : null
}

function installCommand(manager) {
  switch (manager.name) {
    case 'pnpm':
      return ['pnpm', ['install', '--frozen-lockfile']]
    case 'yarn':
      return ['yarn', ['install', '--frozen-lockfile']]
    case 'bun':
      return ['bun', ['install', '--frozen-lockfile']]
    default:
      return ['npm', [manager.lock ? 'ci' : 'install']]
  }
}

function runVisible(command, args, cwd) {
  log(`$ ${command} ${args.join(' ')}`)
  const file = path.isAbsolute(command) ? command : resolveExecutable(command)
  if (!file) throw new Error(`${command} is not on PATH`)
  // Arguments here are fixed by this script (install and build commands), never user input.
  const result = spawnSync(file, args, { cwd, stdio: 'inherit', shell: needsShell(file) })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`)
  }
}

function ensureDependencies(project, dir) {
  if (project.type === 'node') {
    const reason = nodeInstallIsStale(project.manager)
    if (!reason) return log('dependencies are up to date')
    log(`reinstalling dependencies: ${reason}`)
    const [command, args] = installCommand(project.manager)
    return runVisible(command, args, project.manager.lockDir)
  }
  if (project.type === 'python' && exists(path.join(dir, 'requirements.txt'))) {
    const venv = path.join(dir, '.venv')
    const marker = path.join(venv, '.pane-installed')
    if (exists(venv) && mtimeMs(path.join(dir, 'requirements.txt')) > mtimeMs(marker)) {
      log('reinstalling Python requirements: requirements.txt changed')
      runVisible(pythonIn(venv), ['-m', 'pip', 'install', '-r', 'requirements.txt'], dir)
      fs.writeFileSync(marker, new Date().toISOString())
    }
  }
  return undefined
}

function pythonIn(venv) {
  return IS_WINDOWS ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python')
}

// ---------------------------------------------------------------------------
// Build staleness
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'coverage', '.turbo'])

/** Newest mtime of the files below `dir` whose name passes `filter`. */
function newestMtime(dir, filter = () => true) {
  let newest = 0
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) newest = Math.max(newest, newestMtime(full, filter))
    } else if (filter(entry.name)) {
      newest = Math.max(newest, mtimeMs(full))
    }
  }
  return newest
}

function isStale(sourceTimes, outputFile) {
  const output = mtimeMs(outputFile)
  return output === 0 || Math.max(...sourceTimes) > output
}

/** docs-site imports src/manifest.json, which only `build` and `typecheck` generate. */
function prepareDocsManifest(context) {
  const docsSite = path.join(context.root, 'docs-site')
  const generator = path.join(docsSite, 'scripts', 'build-manifest.mjs')
  const manifest = path.join(docsSite, 'src', 'manifest.json')
  const sources = [
    newestMtime(path.join(context.root, 'docs'), name => /\.mdx?$/.test(name)),
    mtimeMs(generator)
  ]
  if (!isStale(sources, manifest)) return log('docs manifest is up to date')
  log('docs manifest is missing or older than docs/ — regenerating')
  return runVisible(process.execPath, [generator], docsSite)
}

/** Workspace packages that `pkg` depends on, in build order (dependencies first). */
function workspaceDependencies(packageDir, seen = new Map()) {
  const pkg = readJson(path.join(packageDir, 'package.json')) ?? {}
  // devDependencies of a dependency are not needed to consume its dist/.
  const deps =
    seen.size === 0 ? { ...pkg.dependencies, ...pkg.devDependencies } : (pkg.dependencies ?? {})
  for (const [name, spec] of Object.entries(deps)) {
    if (typeof spec !== 'string' || !spec.startsWith('workspace:') || seen.has(name)) continue
    let depDir
    try {
      depDir = fs.realpathSync(path.join(packageDir, 'node_modules', name))
    } catch {
      continue
    }
    seen.set(name, null)
    workspaceDependencies(depDir, seen)
    seen.delete(name)
    seen.set(name, depDir)
  }
  return seen
}

/** Files that package.json says the build produces (`exports["."]`, `main`, `module`). */
function packageEntryFiles(pkg) {
  const files = new Set()
  const collect = value => {
    if (typeof value === 'string') files.add(value)
    else if (value && typeof value === 'object') Object.values(value).forEach(collect)
  }
  const exportsField = pkg.exports
  collect(
    typeof exportsField === 'object' && exportsField !== null && '.' in exportsField
      ? exportsField['.']
      : exportsField
  )
  collect(pkg.main)
  collect(pkg.module)
  return [...files].filter(file => !file.includes('*'))
}

/** Why the build of a workspace package is stale, or null when it is current. */
function workspaceBuildStaleReason(pkg, depDir) {
  const entries = packageEntryFiles(pkg).map(file => path.join(depDir, file))
  const missing = entries.find(file => !exists(file))
  if (missing) return `${path.relative(depDir, missing)} is missing`
  // Some packages (wallet-toolbox-client) build from shared source outside src/.
  // For them, a present entry file is the only check.
  if (!exists(path.join(depDir, 'src'))) return null
  const outputTime = entries.length > 0 ? Math.min(...entries.map(mtimeMs)) : 0
  const builtAt = outputTime || newestMtime(path.join(depDir, 'dist'))
  if (builtAt === 0) return 'dist/ is missing'
  return newestMtime(path.join(depDir, 'src')) > builtAt
    ? 'src/ is newer than its build output'
    : null
}

/**
 * Pane copies node_modules from the main checkout, including the incremental
 * TypeScript caches in node_modules/.cache. dist/ is not copied, so `tsc -b`
 * reads a cache that says every file is already emitted and skips them.
 */
function clearTypeScriptBuildInfo(depDir) {
  for (const dir of [depDir, path.join(depDir, 'node_modules', '.cache')]) {
    for (const file of expandPattern(dir, '*.tsbuildinfo')) fs.rmSync(file, { force: true })
  }
}

/** Rebuild any workspace dependency whose output is missing or older than src/. */
function rebuildStaleWorkspaceDependencies(context) {
  const deps = workspaceDependencies(context.targetDir)
  for (const [name, depDir] of deps) {
    if (!depDir) continue
    const pkg = readJson(path.join(depDir, 'package.json')) ?? {}
    if (!pkg.scripts?.build) continue
    const reason = workspaceBuildStaleReason(pkg, depDir)
    if (!reason) continue
    log(`${name} build is stale (${reason}) — rebuilding`)
    if (reason.endsWith('missing')) clearTypeScriptBuildInfo(depDir)
    runVisible('pnpm', ['--filter', name, 'run', 'build'], context.root)
  }
  if (deps.size > 0) log('workspace dependency builds are up to date')
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

function hashPath(value) {
  return crypto.createHash('sha256').update(value).digest().readUInt32BE(0)
}

/** The 10-port block for this terminal. */
function portBlock(env, checkout) {
  const panePort = Number.parseInt(env.PANE_PORT ?? '', 10)
  if (Number.isInteger(panePort) && panePort > 0 && panePort + PORT_BLOCK_SIZE <= 65536) {
    return { start: panePort, source: 'PANE_PORT' }
  }
  const base = checkout.isWorktree ? FALLBACK_BASE_WORKTREE : FALLBACK_BASE_MAIN
  // Round down to a multiple of 10 so that two checkouts never share part of a block.
  const start = base + Math.floor((hashPath(checkout.root) % 1000) / PORT_BLOCK_SIZE) * 10
  return { start, source: checkout.isWorktree ? 'worktree hash' : 'main checkout hash' }
}

/** Ports to try, preferred first, all inside the block. */
function candidatePorts(blockStart, offset) {
  const ports = []
  for (let i = 0; i < PORT_BLOCK_SIZE; i += 1) {
    ports.push(blockStart + ((offset + i) % PORT_BLOCK_SIZE))
  }
  return ports
}

/** Resolve true when `host:port` can be bound right now. */
function canBind(port, host) {
  return new Promise(resolve => {
    const server = net.createServer()
    server.unref()
    server.once('error', error => {
      // A host without IPv6 cannot hold an IPv6 listener, so that address is free.
      resolve(error.code === 'EADDRNOTAVAIL' || error.code === 'EAFNOSUPPORT')
    })
    server.listen({ port, host, ipv6Only: host === '::', exclusive: true }, () => {
      server.close(() => resolve(true))
    })
  })
}

/**
 * A port is free only when every address family accepts it. Dev servers often
 * bind `::` or `localhost` (::1), so a single 127.0.0.1 probe is not enough.
 */
async function isPortFree(port) {
  for (const host of PROBE_HOSTS) {
    if (!(await canBind(port, host))) return false
  }
  return findListeningPids(port).length === 0
}

/** Parse `netstat -ano` output into the PIDs that listen on `port`. */
function parseNetstatPids(output, port) {
  const pids = new Set()
  const pattern = new RegExp(String.raw`^\s*TCP\s+\S*:${port}\s+\S+\s+LISTENING\s+(\d+)\s*$`, 'i')
  for (const line of output.split(/\r?\n/)) {
    const match = pattern.exec(line)
    if (match && match[1] !== '0') pids.add(Number(match[1]))
  }
  return [...pids]
}

function findListeningPids(port) {
  if (IS_WINDOWS)
    return parseNetstatPids(run('netstat', ['-ano', '-p', 'TCP']), port).concat(
      parseNetstatPids(run('netstat', ['-ano', '-p', 'TCPv6']), port)
    )
  const output = run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])
  return [...new Set(output.split(/\s+/).filter(Boolean).map(Number))]
}

function processCommandLine(pid) {
  if (IS_WINDOWS) {
    return run('powershell', [
      '-NoProfile',
      '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`
    ])
  }
  return run('ps', ['-o', 'command=', '-p', String(pid)])
}

function processCwd(pid) {
  if (IS_WINDOWS) return null
  if (process.platform === 'linux') {
    try {
      return fs.readlinkSync(`/proc/${pid}/cwd`)
    } catch {
      return null
    }
  }
  const output = run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
  const line = output.split('\n').find(entry => entry.startsWith('n'))
  return line ? line.slice(1) : null
}

/** Absolute paths that appear in a command line, quoted or not. */
function commandLinePaths(commandLine) {
  const tokens = commandLine.match(/"[^"]+"|'[^']+'|\S+/g) ?? []
  return tokens
    .map(token => token.replaceAll(/^["']|["']$/g, ''))
    .filter(token => path.isAbsolute(token))
}

const DEV_SERVER_PATTERN = /\b(vite|next|node|tsx|webpack|astro|cargo|go|python[\d.]*|uvicorn)\b/i

/**
 * Decide whether `holder` is this target's own dev server. When the working
 * directory is known it must be inside the target directory. Without it
 * (Windows), the command line must be a dev-server binary that runs from this
 * checkout. Anything else is an unrelated process and is never killed.
 */
function isOwnDevServer(holder, context) {
  if (!holder.commandLine || !DEV_SERVER_PATTERN.test(holder.commandLine)) return false
  if (holder.cwd) return isOwnedPath(holder.cwd, context.targetDir, context.otherWorktrees)
  return commandLinePaths(holder.commandLine).some(file =>
    isOwnedPath(file, context.root, context.otherWorktrees)
  )
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/** Stop a process and every child. Unix tries the process group first. */
function killTree(pid, signal = 'SIGTERM') {
  if (IS_WINDOWS) {
    run('taskkill', ['/PID', String(pid), '/T', '/F'])
    return
  }
  try {
    process.kill(-pid, signal)
    return
  } catch {
    // Not a group leader: kill the process itself.
  }
  try {
    process.kill(pid, signal)
  } catch {
    // Already gone.
  }
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  const poll = async () => {
    if (await predicate()) return true
    if (Date.now() >= deadline) return false
    await sleep(150)
    return poll()
  }
  return poll()
}

/** Try to free `port` from an earlier run of this target. */
async function reclaimPort(port, context) {
  const pids = findListeningPids(port)
  if (pids.length === 0) return false
  const holders = pids.map(pid => ({
    pid,
    commandLine: processCommandLine(pid),
    cwd: processCwd(pid)
  }))
  const foreign = holders.filter(holder => !isOwnDevServer(holder, context))
  if (foreign.length > 0) {
    for (const holder of foreign) {
      log(`port ${port} is held by an unrelated process (pid ${holder.pid}); leaving it alone`)
    }
    return false
  }
  for (const holder of holders) {
    log(
      `port ${port} is held by a stale dev server from this checkout (pid ${holder.pid}); stopping it`
    )
    killTree(holder.pid, 'SIGTERM')
  }
  if (await waitFor(() => isPortFree(port), STOP_GRACE_MS)) return true
  for (const holder of holders) killTree(holder.pid, 'SIGKILL')
  return waitFor(() => isPortFree(port), STOP_GRACE_MS)
}

async function choosePort(context) {
  const block = portBlock(process.env, context)
  const ports = candidatePorts(block.start, context.offset)
  for (const port of ports) {
    if (await isPortFree(port)) return { port, block }
    if (await reclaimPort(port, context)) return { port, block, reclaimed: true }
  }
  throw new Error(
    `no free port in ${block.start}-${block.start + PORT_BLOCK_SIZE - 1} (${block.source})`
  )
}

// ---------------------------------------------------------------------------
// Stale state and locks
// ---------------------------------------------------------------------------

function stateFile(context) {
  return path.join(context.root, 'node_modules', '.cache', 'pane-run', `${context.name}.json`)
}

/** Stop the process group that a crashed earlier run of this target left behind. */
async function stopPreviousRun(context) {
  const file = stateFile(context)
  const state = readJson(file)
  if (!state?.pid) return
  const holder = {
    pid: state.pid,
    commandLine: processCommandLine(state.pid),
    cwd: processCwd(state.pid)
  }
  if (isAlive(state.pid) && isOwnDevServer(holder, context)) {
    log(`stopping the dev server of an earlier run (pid ${state.pid})`)
    killTree(state.pid, 'SIGTERM')
    if (!(await waitFor(() => !isAlive(state.pid), STOP_GRACE_MS))) {
      killTree(state.pid, 'SIGKILL')
    }
  }
  fs.rmSync(file, { force: true })
}

function writeState(context, pid, port) {
  const file = stateFile(context)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ pid, port, startedAt: new Date().toISOString() }))
}

/** Expand one STALE_LOCK_PATTERNS entry. Only the last path segment may hold `*`. */
function expandPattern(baseDir, pattern) {
  const dir = path.join(baseDir, path.dirname(pattern))
  const leaf = path.basename(pattern)
  if (!leaf.includes('*')) return exists(path.join(dir, leaf)) ? [path.join(dir, leaf)] : []
  const escaped = leaf.replaceAll(/[.+?^${}()|[\]\\]/g, String.raw`\$&`).replaceAll('*', '.*')
  const regex = new RegExp(`^${escaped}$`)
  try {
    return fs
      .readdirSync(dir)
      .filter(name => regex.test(name))
      .map(name => path.join(dir, name))
  } catch {
    return []
  }
}

function removeStaleLocks(targetDir) {
  let removed = 0
  for (const pattern of STALE_LOCK_PATTERNS) {
    for (const file of expandPattern(targetDir, pattern)) {
      fs.rmSync(file, { recursive: true, force: true })
      log(`removed stale ${path.relative(targetDir, file)}`)
      removed += 1
    }
  }
  if (removed === 0) log('no stale framework locks')
}

// ---------------------------------------------------------------------------
// Dev server command
// ---------------------------------------------------------------------------

function viteBin(targetDir) {
  const pkgDir = fs.realpathSync(path.join(targetDir, 'node_modules', 'vite'))
  const pkg = readJson(path.join(pkgDir, 'package.json')) ?? {}
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.vite
  return path.join(pkgDir, bin ?? 'bin/vite.js')
}

function devCommand(project, context, port, extraArgs) {
  const { targetDir } = context
  if (project.type === 'node' && project.framework === 'vite') {
    // Run the Vite binary directly (not through pnpm) so that the process
    // group, and the PID that holds the port, belong to this script.
    // --strictPort makes Vite fail instead of silently moving to another port.
    return {
      command: process.execPath,
      args: [viteBin(targetDir), '--port', String(port), '--strictPort', ...extraArgs]
    }
  }
  if (project.type === 'node' && project.framework === 'next') {
    const nextBin = path.join(targetDir, 'node_modules', 'next', 'dist', 'bin', 'next')
    return { command: process.execPath, args: [nextBin, 'dev', '-p', String(port), ...extraArgs] }
  }
  if (project.type === 'node') {
    const script = project.pkg.scripts?.dev ? 'dev' : 'start'
    const file = resolveExecutable(project.manager.name)
    // A .cmd shim runs through cmd.exe, so user arguments are not forwarded there.
    const forwarded = file && needsShell(file) ? [] : extraArgs
    return { command: project.manager.name, args: ['run', script, ...forwarded] }
  }
  if (project.type === 'rust') return { command: 'cargo', args: ['run', ...extraArgs] }
  if (project.type === 'go') return { command: 'go', args: ['run', '.', ...extraArgs] }
  const venv = path.join(targetDir, '.venv')
  let python = IS_WINDOWS ? 'python' : 'python3'
  if (exists(venv)) python = pythonIn(venv)
  if (project.framework === 'django') {
    return { command: python, args: ['manage.py', 'runserver', `127.0.0.1:${port}`, ...extraArgs] }
  }
  const entry = ['main.py', 'app.py'].find(file => exists(path.join(targetDir, file)))
  return { command: python, args: [entry ?? 'main.py', ...extraArgs] }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const separator = argv.indexOf('--')
  const own = separator === -1 ? argv : argv.slice(0, separator)
  const extraArgs = separator === -1 ? [] : argv.slice(separator + 1)
  return { target: own[0] ?? 'docs-site', extraArgs }
}

function resolveTarget(target, checkout) {
  const known = KNOWN_TARGETS[target]
  if (known) {
    return { name: target, ...known, targetDir: path.join(checkout.root, known.dir) }
  }
  const targetDir = path.resolve(checkout.root, target)
  if (!exists(targetDir)) {
    const names = Object.keys(KNOWN_TARGETS).join(', ')
    throw new Error(`unknown target "${target}". Use one of: ${names}, or a directory`)
  }
  const name = path.relative(checkout.root, targetDir).replaceAll(/[\\/]/g, '__') || 'root'
  return { name, dir: target, offset: 0, urlPath: '/', targetDir }
}

function startDevServer(command, context, port) {
  const file = path.isAbsolute(command.command)
    ? command.command
    : resolveExecutable(command.command)
  if (!file) throw new Error(`${command.command} is not on PATH`)
  const child = spawn(file, command.args, {
    cwd: context.targetDir,
    stdio: 'inherit',
    env: { ...process.env, PORT: String(port) },
    // A separate process group lets one signal stop the whole tree on Unix.
    // On Windows a detached child would open a new console window.
    detached: !IS_WINDOWS,
    shell: needsShell(file),
    windowsHide: false
  })
  writeState(context, child.pid, port)

  let stopping = false
  const stop = signal => {
    if (stopping) return
    stopping = true
    log(`received ${signal}; stopping the dev server`)
    killTree(child.pid, 'SIGTERM')
    setTimeout(() => {
      killTree(child.pid, 'SIGKILL')
      process.exit(130)
    }, STOP_GRACE_MS).unref()
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => stop(signal))
  if (IS_WINDOWS) process.on('SIGBREAK', () => stop('SIGBREAK'))

  child.on('exit', (code, signal) => {
    fs.rmSync(stateFile(context), { force: true })
    // Vite can leave children (esbuild, workers) in its group.
    if (!IS_WINDOWS) killTree(child.pid, 'SIGKILL')
    if (stopping) process.exit(0)
    const reason = signal ?? `code ${code}`
    log(`dev server exited (${reason})`)
    process.exit(code ?? 1)
  })
  child.on('error', error => {
    log(`failed to start: ${error.message}`)
    process.exit(1)
  })
}

async function main() {
  const { target, extraArgs } = parseArgs(process.argv.slice(2))
  const checkout = detectCheckout(process.cwd())
  const context = { ...checkout, ...resolveTarget(target, checkout) }
  log(
    `${checkout.isWorktree ? 'git worktree' : 'main checkout'}: ${checkout.root}` +
      (checkout.isWorktree ? ` (main: ${checkout.mainRoot})` : '')
  )

  const project = detectProject(context.targetDir, checkout.root)
  if (!project) throw new Error(`cannot detect a project type in ${context.targetDir}`)
  log(`target ${context.name}: ${project.type}/${project.framework} in ${context.dir}`)

  ensureDependencies(project, context.targetDir)
  if (project.type === 'node') rebuildStaleWorkspaceDependencies(context)
  if (context.prepare) context.prepare(context)

  await stopPreviousRun(context)
  const { port, block, reclaimed } = await choosePort(context)
  removeStaleLocks(context.targetDir)

  const command = devCommand(project, context, port, extraArgs)
  const blockEnd = block.start + PORT_BLOCK_SIZE - 1
  log(
    `port ${port}${reclaimed ? ' (reclaimed)' : ''} from block ${block.start}-${blockEnd} (${block.source})`
  )
  log(`open http://localhost:${port}${context.urlPath}`)
  startDevServer(command, context, port)
}

if (require.main === module) {
  main().catch(error => {
    log(`error: ${error.message}`)
    process.exit(1)
  })
}

module.exports = {
  candidatePorts,
  commandLinePaths,
  detectProject,
  isOwnDevServer,
  isOwnedPath,
  isPortFree,
  nodeInstallIsStale,
  packageEntryFiles,
  parseNetstatPids,
  parseWorktreeList,
  portBlock
}
