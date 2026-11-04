import { afterEach, describe, expect, jest, test } from '@jest/globals'
import { CLI_HELP, main, start } from '../cli'
import { ConfigError } from '../config/validate'
import type { RunResult } from '../pipeline'

// main() is the whole CLI: what it prints and the exit code index.ts sets.

const base: RunResult = {
  targetDir: 'my-app',
  deps: { root: {}, client: {}, server: {} },
  written: ['package.json'],
  skipped: [],
  dependencyChanges: [],
  pulled: []
}

async function runMain(argv: string[], result: RunResult | Error) {
  const out: string[] = []
  const err: string[] = []
  const run = jest.fn(async () => {
    if (result instanceof Error) throw result
    return result
  })
  const code = await main(argv, undefined, {
    log: line => out.push(line),
    error: line => err.push(line),
    run
  })
  return { code, out: out.join('\n'), err: err.join('\n'), run }
}

describe('main', () => {
  test.each([['--help'], ['-h']])('%s prints the help and exits 0 without running', async flag => {
    const { code, out, run } = await runMain(['new', flag], base)
    expect(code).toBe(0)
    expect(out).toBe(CLI_HELP)
    expect(run).not.toHaveBeenCalled()
  })

  test('a new project prints Scaffolded, the dev command and the provenance note', async () => {
    const { code, out } = await runMain(['--yes'], { ...base, packageManager: 'pnpm' })
    expect(code).toBe(0)
    expect(out).toContain('Scaffolded my-app (1 file(s) written).')
    expect(out).toContain('Next:\n  cd my-app\n  pnpm run dev')
    expect(out).toContain('bsv-scaffold.json for exact provenance')
    expect(out).not.toContain('Dependency ranges:')
    expect(out).not.toContain('Dependencies')
  })

  test('skipped files or nothing written print Updated; the dev command defaults to npm', async () => {
    expect((await runMain(['--yes'], { ...base, skipped: ['a'] })).out).toContain(
      'Updated my-app (1 file(s) written).'
    )
    const none = await runMain(['--yes'], { ...base, written: [] })
    expect(none.out).toContain('Updated my-app (0 file(s) written).')
    expect(none.out).toContain('  npm run dev')
  })

  test('prints the pulled notice and dependency changes after the summary', async () => {
    const { out } = await runMain(['--capabilities', 'tx-core', '--yes'], {
      ...base,
      pulled: [{ id: 'wallet-connect', requiredBy: ['tx-core'] }],
      dependencyChanges: [
        { target: 'root', name: '@bsv/sdk', from: '^2.0.0', to: '^4.0.1', action: 'raised' }
      ]
    })
    const summary = out.indexOf('Scaffolded')
    expect(out.indexOf('Also adding wallet-connect (required by tx-core).')).toBeGreaterThan(
      summary
    )
    expect(out).toContain('\nDependency ranges:\n  ')
    expect(out).toContain('@bsv/sdk')
  })

  test('reports whether dependencies were installed', async () => {
    expect((await runMain(['--yes'], { ...base, installed: false })).out).toContain(
      'Dependencies were not installed.'
    )
    expect((await runMain(['--yes'], { ...base, installed: true })).out).toContain(
      'Dependencies installed.'
    )
  })

  test('a repository starter points at its README instead of a dev command', async () => {
    const { out } = await runMain(['--yes'], { ...base, starter: 'brc102-frontend' })
    expect(out).toContain('Follow the starter README for its development commands.')
    expect(out).not.toContain('run dev')
  })

  test('a failed run prints the formatted error and exits 1', async () => {
    const { code, out, err } = await runMain(['--yes'], new ConfigError('bad flag'))
    expect(code).toBe(1)
    expect(err).toContain('bad flag')
    expect(out).toBe('')
  })
})

describe('start', () => {
  afterEach(() => {
    process.exitCode = undefined
  })

  test('sets the exit code main() resolves to', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined)
    process.exitCode = 9
    start(['--help'])
    await new Promise(resolve => setImmediate(resolve))
    expect(process.exitCode).toBe(0)
    expect(log).toHaveBeenCalledWith(CLI_HELP)
    log.mockRestore()
  })
})
