import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const runner = require('./pane-run-script.js')

const MAIN = '/repo/ts-stack'
const WORKTREE = '/repo/ts-stack/worktrees/feature'
const OTHER = '/repo/ts-stack/worktrees/other'

test('isOwnedPath excludes worktrees nested inside the main checkout', () => {
  const worktrees = [WORKTREE, OTHER]
  assert.equal(runner.isOwnedPath(`${MAIN}/docs-site`, MAIN, worktrees), true)
  assert.equal(runner.isOwnedPath(`${WORKTREE}/docs-site`, MAIN, worktrees), false)
  assert.equal(runner.isOwnedPath(`${WORKTREE}/docs-site`, WORKTREE, [MAIN, OTHER]), true)
  assert.equal(runner.isOwnedPath(`${OTHER}/docs-site`, WORKTREE, [MAIN, OTHER]), false)
  assert.equal(runner.isOwnedPath('/repo/ts-stack-copy/docs-site', MAIN, worktrees), false)
  assert.equal(runner.isOwnedPath('relative/path', MAIN, worktrees), false)
})

test('isOwnDevServer needs a dev-server command and an owned working directory', () => {
  const context = {
    root: WORKTREE,
    targetDir: `${WORKTREE}/docs-site`,
    otherWorktrees: [MAIN, OTHER]
  }
  const vite = `node ${WORKTREE}/node_modules/.pnpm/vite@8/node_modules/vite/bin/vite.js --port 5230`
  assert.equal(
    runner.isOwnDevServer({ commandLine: vite, cwd: `${WORKTREE}/docs-site` }, context),
    true
  )
  // Same checkout, other target directory: never killed for this target.
  assert.equal(
    runner.isOwnDevServer({ commandLine: vite, cwd: `${WORKTREE}/apps/lch-reference` }, context),
    false
  )
  // The main checkout's server, seen from a worktree.
  assert.equal(
    runner.isOwnDevServer({ commandLine: vite, cwd: `${MAIN}/docs-site` }, context),
    false
  )
  // Not a dev server, even inside the target directory.
  assert.equal(
    runner.isOwnDevServer(
      { commandLine: 'postgres -D data', cwd: `${WORKTREE}/docs-site` },
      context
    ),
    false
  )
  // Windows has no cwd: the command line must reference this checkout.
  assert.equal(runner.isOwnDevServer({ commandLine: vite, cwd: null }, context), true)
  assert.equal(
    runner.isOwnDevServer({ commandLine: vite.replaceAll(WORKTREE, OTHER), cwd: null }, context),
    false
  )
  assert.equal(runner.isOwnDevServer({ commandLine: '', cwd: null }, context), false)
})

test('commandLinePaths reads quoted and unquoted absolute paths', () => {
  assert.deepEqual(
    runner.commandLinePaths('"C:\\Program Files\\node.exe" /a/vite.js --port 1 rel/x'),
    process.platform === 'win32' ? ['C:\\Program Files\\node.exe', '/a/vite.js'] : ['/a/vite.js']
  )
})

test('portBlock uses PANE_PORT and otherwise a stable hash per checkout kind', () => {
  const worktree = { root: WORKTREE, isWorktree: true }
  const main = { root: MAIN, isWorktree: false }
  assert.deepEqual(runner.portBlock({ PANE_PORT: '5230' }, worktree), {
    start: 5230,
    source: 'PANE_PORT'
  })
  for (const value of ['', 'abc', '0', '65530']) {
    assert.notEqual(runner.portBlock({ PANE_PORT: value }, worktree).source, 'PANE_PORT')
  }
  const worktreeBlock = runner.portBlock({}, worktree)
  const mainBlock = runner.portBlock({}, main)
  assert.equal(worktreeBlock.start, runner.portBlock({}, worktree).start)
  assert.ok(worktreeBlock.start >= 4000 && worktreeBlock.start <= 4990)
  assert.ok(mainBlock.start >= 3000 && mainBlock.start <= 3990)
  assert.equal(worktreeBlock.start % 10, 0)
})

test('candidatePorts stays inside the 10-port block and starts at the target offset', () => {
  assert.deepEqual(
    runner.candidatePorts(5230, 0),
    [5230, 5231, 5232, 5233, 5234, 5235, 5236, 5237, 5238, 5239]
  )
  assert.deepEqual(runner.candidatePorts(5230, 2).slice(0, 3), [5232, 5233, 5234])
  assert.deepEqual(runner.candidatePorts(5230, 2).at(-1), 5231)
})

test('parseNetstatPids finds IPv4 and IPv6 listeners for the exact port only', () => {
  const output = [
    '  TCP    0.0.0.0:5230           0.0.0.0:0              LISTENING       4242',
    '  TCP    [::]:5230              [::]:0                 LISTENING       4243',
    '  TCP    0.0.0.0:52300          0.0.0.0:0              LISTENING       9999',
    '  TCP    127.0.0.1:5230         127.0.0.1:61000        ESTABLISHED     7777',
    '  TCP    0.0.0.0:5230           0.0.0.0:0              LISTENING       0'
  ].join('\r\n')
  assert.deepEqual(runner.parseNetstatPids(output, 5230), [4242, 4243])
})

test('parseWorktreeList reads porcelain output', () => {
  const output = `worktree ${MAIN}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${WORKTREE}\nHEAD def\n`
  assert.deepEqual(runner.parseWorktreeList(output), [MAIN, WORKTREE])
})

test('packageEntryFiles lists the root export, main and module', () => {
  assert.deepEqual(
    runner
      .packageEntryFiles({
        main: './dist/cjs/mod.js',
        exports: {
          '.': { import: { types: './dist/types/mod.d.ts', default: './dist/esm/mod.js' } },
          './*': './dist/esm/*.js'
        }
      })
      .sort(),
    ['./dist/cjs/mod.js', './dist/esm/mod.js', './dist/types/mod.d.ts']
  )
  assert.deepEqual(runner.packageEntryFiles({ exports: './index.js' }), ['./index.js'])
})

test('nodeInstallIsStale compares the pnpm lock file with the installed copy', t => {
  const dir = mkdtempSync(join(tmpdir(), 'pane-run-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const manager = { name: 'pnpm', lock: 'pnpm-lock.yaml', lockDir: dir }
  assert.match(runner.nodeInstallIsStale(manager), /node_modules is missing/)
  mkdirSync(join(dir, 'node_modules', '.pnpm'), { recursive: true })
  writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  writeFileSync(join(dir, 'node_modules', '.pnpm', 'lock.yaml'), 'lockfileVersion: 9\n')
  assert.equal(runner.nodeInstallIsStale(manager), null)
  writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\nchanged: true\n')
  assert.match(runner.nodeInstallIsStale(manager), /changed since the last install/)
})

test('nodeInstallIsStale uses marker mtimes for npm', t => {
  const dir = mkdtempSync(join(tmpdir(), 'pane-run-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const manager = { name: 'npm', lock: 'package-lock.json', lockDir: dir }
  mkdirSync(join(dir, 'node_modules'))
  writeFileSync(join(dir, 'package-lock.json'), '{}')
  writeFileSync(join(dir, 'node_modules', '.package-lock.json'), '{}')
  utimesSync(join(dir, 'package-lock.json'), 1000, 1000)
  assert.equal(runner.nodeInstallIsStale(manager), null)
  utimesSync(join(dir, 'package-lock.json'), Date.now() / 1000 + 60, Date.now() / 1000 + 60)
  assert.match(runner.nodeInstallIsStale(manager), /newer than node_modules/)
})

test('detectProject identifies this repository and other project types', t => {
  const dir = mkdtempSync(join(tmpdir(), 'pane-run-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (const [file, type] of [
    ['Cargo.toml', 'rust'],
    ['go.mod', 'go'],
    ['requirements.txt', 'python']
  ]) {
    const project = join(dir, type)
    mkdirSync(project)
    writeFileSync(join(project, file), '')
    assert.equal(runner.detectProject(project, project).type, type)
  }
  const docs = runner.detectProject(
    join(import.meta.dirname, '..', 'docs-site'),
    join(import.meta.dirname, '..')
  )
  assert.equal(docs.type, 'node')
  assert.equal(docs.framework, 'vite')
  assert.equal(docs.manager.name, 'pnpm')
})

test('isPortFree sees a listener on any address family', async t => {
  for (const host of ['127.0.0.1', '::1', '::']) {
    const server = net.createServer()
    const listening = await new Promise(resolve => {
      server.once('error', () => resolve(false))
      server.listen({ port: 0, host, ipv6Only: true }, () => resolve(true))
    })
    if (!listening) {
      t.diagnostic(`${host} is not available on this host`)
      continue
    }
    const { port } = server.address()
    assert.equal(await runner.isPortFree(port), false, `listener on ${host}`)
    await new Promise(resolve => server.close(resolve))
  }
})
