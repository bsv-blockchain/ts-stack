import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const cli = path.resolve(__dirname, '../bin/init.mjs')

function run(args: string[], cwd = process.cwd()) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' })
}

describe('wallet-relay initializer filesystem authority', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'wallet-relay-init-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('keeps custom output directories inside the explicit target', () => {
    const target = path.join(root, 'project')
    const result = run([target, '--backend', '--backend-dir', '../escape'])

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('must stay inside the target project')
    expect(existsSync(path.join(root, 'escape', 'server.ts'))).toBe(false)
  })

  it('refuses to write through an existing symlinked directory', () => {
    const target = path.join(root, 'project')
    const outside = path.join(root, 'outside')
    mkdirSync(target)
    mkdirSync(outside)
    symlinkSync(outside, path.join(target, 'backend'), 'dir')

    const result = run([target, '--backend'])

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Refusing unsafe scaffold directory')
    expect(existsSync(path.join(outside, 'server.ts'))).toBe(false)
  })

  it('does not mistake a flag value for the positional target', () => {
    const target = path.join(root, 'project')
    const result = run(['--backend', '--backend-dir', 'server', target], root)

    expect(result.status).toBe(0)
    expect(existsSync(path.join(target, 'server', 'server.ts'))).toBe(true)
    expect(existsSync(path.join(root, 'server', 'server', 'server.ts'))).toBe(false)
  })
})
