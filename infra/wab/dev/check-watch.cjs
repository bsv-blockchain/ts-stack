'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const { readFileSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { test } = require('node:test')
const applyOptions = require('./bin/nodemon.js')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

test('development ignore options retain legacy glob, literal-directory, regex, function, cwd and dotfile behavior', () => {
  const cases = [
    { ignored: '/repo/cache', file: '/repo/cache/child/file.ts', expected: true },
    { ignored: '/repo/cache', file: '/repo/cache-other/file.ts', expected: false },
    { ignored: 'cache', cwd: '/repo', file: '/repo/cache/file.ts', expected: true },
    {
      ignored: String.raw`cache\nested`,
      cwd: '/repo',
      file: '/repo/cache/nested/file.ts',
      expected: true
    },
    { ignored: '**/generated/**', file: '/repo/generated/file.ts', expected: true },
    { ignored: '**/generated/**', file: '/repo/src/file.ts', expected: false },
    { ignored: ['**/*.ts', '!**/keep.ts'], file: '/repo/src/drop.ts', expected: true },
    { ignored: ['**/*.ts', '!**/keep.ts'], file: '/repo/src/keep.ts', expected: false },
    { ignored: /\.map$/, file: '/repo/file.map', expected: true },
    { ignored: /\.map$/, file: '/repo/file.ts', expected: false },
    {
      ignored: (_file, stats) => stats?.marker === true,
      file: '/repo/a.ts',
      stats: { marker: true },
      expected: true
    },
    { ignored: (_file, stats) => stats?.marker === true, file: '/repo/a.ts', expected: false },
    { ignored: undefined, file: '/repo/a.ts', expected: false },
    { ignored: [], file: '/repo/a.ts', expected: false }
  ]
  for (const item of cases) {
    const config = {
      dirs: ['/repo/src'],
      options: {
        ignore: [],
        watchOptions: { ignored: item.ignored, cwd: item.cwd, usePolling: true, interval: 71 }
      }
    }
    applyOptions(config)
    assert.equal(
      config.options.watchOptions.ignored(item.file, item.stats),
      item.expected,
      item.file
    )
    assert.equal(config.options.watchOptions.usePolling, true)
    assert.equal(config.options.watchOptions.interval, 71)
  }
  const defaults = { dirs: ['/repo/src'], options: { ignore: ['**/node_modules/**'] } }
  applyOptions(defaults)
  assert.equal(defaults.options.watchOptions.ignored('/repo/src/.hidden.ts'), true)
  assert.equal(defaults.options.watchOptions.ignored('/repo/src/node_modules/pkg/a.ts'), true)
  assert.equal(defaults.options.watchOptions.ignored('/repo/src/a.ts'), false)
  const explicitDotfile = { dirs: ['/repo/.env', '/repo/src'], options: { ignore: [] } }
  applyOptions(explicitDotfile)
  assert.equal(explicitDotfile.options.watchOptions.ignored('/repo/.env'), false)
})

test(
  'actual locked watcher restarts TS, env and new source, retains preloads/manual restart, ignores dependencies and stops',
  { timeout: 60000 },
  async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ts-stack-dev-watch-'))
    let child,
      exited,
      output = '',
      errors = '',
      forced = false
    const starts = () => [...output.matchAll(/READY:(\d+):(\d+)/g)]
    async function waitFor(predicate, description, remaining = 400) {
      if (remaining === 0) throw new Error(`Watcher did not ${description}: ${output}\n${errors}`)
      if (predicate()) return
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`Watcher exited during ${description}: ${errors}`)
      await delay(25)
      return waitFor(predicate, description, remaining - 1)
    }
    try {
      await fs.mkdir(path.join(directory, 'src/node_modules'), { recursive: true })
      await fs.mkdir(path.join(directory, 'src/generated'), { recursive: true })
      await fs.symlink(
        path.resolve(__dirname, '../node_modules'),
        path.join(directory, 'node_modules'),
        'junction'
      )
      await fs.writeFile(
        path.join(directory, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            module: 'commonjs',
            target: 'es2022',
            strict: true,
            skipLibCheck: true,
            types: ['node']
          }
        })
      )
      await fs.writeFile(path.join(directory, '.env'), 'synthetic ordinary configuration')
      await fs.writeFile(path.join(directory, 'src/dependency.ts'), 'export const value = 1')
      await fs.writeFile(
        path.join(directory, 'src/telemetry.ts'),
        "console.log('PRELOAD:' + process.pid)"
      )
      const recipe = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'))
        .scripts.dev
      const prefix = 'node dev/bin/nodemon.js '
      assert.ok(recipe.startsWith(prefix) && recipe.endsWith('"'))
      const [watch, execution] = recipe.slice(prefix.length, -1).split(' --exec "')
      assert.ok(execution)
      const options = watch.split(/\s+/)
      const entry = execution.match(/src\/(index|server)\.ts$/)?.[0]
      assert.ok(entry)
      await fs.writeFile(
        path.join(directory, entry),
        "import { value } from './dependency'; console.log('READY:' + process.pid + ':' + value); setInterval(() => {}, 1000)"
      )
      child = spawn(
        process.execPath,
        [
          path.join(__dirname, 'bin/nodemon.js'),
          ...options,
          '--ignore',
          'src/generated/**',
          '--exec',
          execution
        ],
        {
          cwd: directory,
          detached: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, CI: '1', NO_UPDATE_NOTIFIER: '1' }
        }
      )
      exited = new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', (code, signal) => resolve({ code, signal }))
      })
      child.stdout.on('data', data => {
        output += data.toString()
      })
      child.stderr.on('data', data => {
        errors += data.toString()
      })
      await waitFor(() => starts().length === 1, 'start the synthetic TypeScript process')
      await delay(500)
      await fs.writeFile(path.join(directory, 'src/dependency.ts'), 'export const value = 2')
      await waitFor(() => starts().length === 2, 'restart for a TypeScript dependency')
      assert.equal(starts()[1][2], '2')
      await delay(500)
      await fs.writeFile(path.join(directory, 'src/node_modules/ignored.js'), 'module.exports = 1')
      await fs.writeFile(
        path.join(directory, 'src/generated/ignored.ts'),
        'export const ignored = 1'
      )
      await delay(700)
      assert.equal(starts().length, 2)
      await fs.writeFile(path.join(directory, '.env'), 'synthetic changed configuration')
      await waitFor(() => starts().length === 3, 'restart for the explicitly watched env file')
      await delay(500)
      await fs.writeFile(path.join(directory, 'src/new-file.ts'), 'export const newFile = 1')
      await waitFor(() => starts().length === 4, 'restart for a new TypeScript source file')
      child.stdin.write('rs\n')
      await waitFor(() => starts().length === 5, 'accept a manual restart')
      if (options.includes('tsconfig.json')) {
        await delay(500)
        await fs.appendFile(path.join(directory, 'tsconfig.json'), '\n')
        await waitFor(() => starts().length === 6, 'restart for the watched compiler configuration')
      }
      assert.equal([...output.matchAll(/PRELOAD:/g)].length, starts().length)
    } finally {
      if (child?.exitCode === null && child.signalCode === null) {
        process.kill(-child.pid, 'SIGTERM')
        const escalation = setTimeout(() => {
          forced = true
          process.kill(-child.pid, 'SIGKILL')
        }, 5000)
        try {
          await exited
        } finally {
          clearTimeout(escalation)
        }
      }
      await fs.rm(directory, { recursive: true, force: true })
    }
    assert.equal(forced, false, 'the CLI and owned child must exit without forced termination')
  }
)
