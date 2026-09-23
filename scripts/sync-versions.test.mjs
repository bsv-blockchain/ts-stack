import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))

test('release sync covers the separately deployed notifier without traversing arbitrary children', () => {
  const root = mkdtempSync(join(tmpdir(), 'ts-stack-release-sync-'))
  const writeJson = (relative, value) => {
    const file = join(root, relative)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
  }
  const readJson = relative => JSON.parse(readFileSync(join(root, relative), 'utf8'))
  const service = 'infra/uhrp-server-cloud-bucket/package.json'
  const notifier = 'infra/uhrp-server-cloud-bucket/notifier/package.json'
  const ignored = 'infra/uhrp-server-cloud-bucket/examples/package.json'
  try {
    mkdirSync(join(root, 'scripts'))
    for (const file of ['sync-versions.mjs', 'file-system.mjs']) {
      copyFileSync(join(scriptDirectory, file), join(root, 'scripts', file))
    }
    writeJson('package.json', { name: 'release-sync-fixture', private: true })
    writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n")
    writeJson('packages/sdk/package.json', { name: '@bsv/sdk', version: '2.8.0' })
    // Repository-health CI intentionally runs before package-manager setup.
    // Supply only the unchanged workspace-discovery boundary to this fixture.
    const bin = join(root, 'bin')
    mkdirSync(bin)
    const workspaceListing = JSON.stringify([
      { name: '@bsv/sdk', version: '2.8.0', path: join(root, 'packages/sdk') }
    ])
    writeFileSync(
      join(bin, 'pnpm'),
      `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(workspaceListing)})\n`,
      { mode: 0o700 }
    )
    const oldManifest = {
      name: 'standalone-consumer',
      version: '1.0.0',
      dependencies: { '@bsv/sdk': '^2.1.9', axios: '^1.18.1' }
    }
    for (const path of [service, notifier, ignored]) writeJson(path, oldManifest)
    const run = (...args) =>
      execFileSync(process.execPath, [join(root, 'scripts/sync-versions.mjs'), ...args], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${dirname(process.execPath)}` }
      })

    assert.match(
      run('--dry-run'),
      /Would update 2 infra dep reference\(s\) across 2 component\(s\)/
    )
    for (const path of [service, notifier, ignored]) assert.deepEqual(readJson(path), oldManifest)
    run('--workspace-only')
    assert.deepEqual(readJson(notifier), oldManifest)

    run()
    for (const path of [service, notifier]) {
      assert.deepEqual(readJson(path), {
        ...oldManifest,
        version: '1.0.1',
        dependencies: { '@bsv/sdk': '^2.8.0', axios: '^1.18.1' }
      })
    }
    assert.deepEqual(readJson(ignored), oldManifest)
    assert.match(run(), /Updated 0 infra dep reference\(s\) across 0 component\(s\)/)
    assert.equal(readJson(notifier).version, '1.0.1')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
