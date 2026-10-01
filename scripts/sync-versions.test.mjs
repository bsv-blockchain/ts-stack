import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { listWorkspacePackages, resolvePnpmLauncher } from './sync-versions.mjs'

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
    for (const file of ['sync-versions.mjs', 'file-system.mjs', 'peer-version-range.mjs']) {
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

function discoveryFixture(t, launcherBody) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ts-stack-pnpm path-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const bin = join(root, 'launcher with spaces')
  mkdirSync(bin)
  writeFileSync(join(bin, 'pnpm'), `#!/usr/bin/env node\n${launcherBody}\n`, { mode: 0o700 })
  const environment = { ...process.env, PATH: bin }
  delete environment.npm_execpath
  return { root, bin, environment }
}

test('shell-free discovery supports spaces and absent npm_execpath with exact listing arguments', t => {
  const expected = [{ name: '@bsv/sdk', version: '3.0.0', path: '/fixture/sdk' }]
  const { root, environment } = discoveryFixture(
    t,
    `if (JSON.stringify(process.argv.slice(2)) !== '["-r","ls","--json","--depth","0"]') process.exit(4);\nprocess.stdout.write(${JSON.stringify(JSON.stringify(expected))})`
  )
  assert.deepEqual(listWorkspacePackages(root, environment), expected)
})

test('shell-free discovery preserves launcher failure and malformed JSON failures', t => {
  const { root, bin, environment } = discoveryFixture(t, 'process.exit(7)')
  assert.throws(
    () => listWorkspacePackages(root, environment),
    error => error.status === 7
  )
  writeFileSync(join(bin, 'pnpm'), '#!/usr/bin/env node\nprocess.stdout.write("not JSON")\n')
  assert.throws(() => listWorkspacePackages(root, environment), SyntaxError)
})

test('discovery falls back to qualified pnpm npm_execpath and rejects a missing launcher', t => {
  const { root, bin, environment } = discoveryFixture(t, 'process.stdout.write("[]")')
  assert.deepEqual(
    listWorkspacePackages(root, { ...environment, PATH: '', npm_execpath: join(bin, 'pnpm') }),
    []
  )
  assert.throws(
    () => listWorkspacePackages(root, { PATH: join(root, 'absent') }),
    /Cannot locate pnpm/
  )
})

test('direct node checker CLI preserves all policy diagnostics and failure status', t => {
  const { root, environment } = discoveryFixture(t, '')
  const scripts = join(root, 'scripts')
  mkdirSync(scripts)
  for (const file of [
    'check-versions.mjs',
    'sync-versions.mjs',
    'file-system.mjs',
    'peer-version-range.mjs'
  ])
    copyFileSync(join(scriptDirectory, file), join(scripts, file))
  const parent = join(root, 'packages', 'parent')
  const child = join(parent, 'child')
  mkdirSync(child, { recursive: true })
  const policyDirectory = join(root, 'governance', 'repository-health')
  mkdirSync(policyDirectory, { recursive: true })
  writeFileSync(
    join(policyDirectory, 'projects.json'),
    JSON.stringify({
      projects: [
        {
          name: '@bsv/parent',
          declarationDependencies: ['@types/express', '@types/scope__runtime']
        }
      ]
    })
  )
  writeFileSync(
    join(parent, 'package.json'),
    JSON.stringify({
      name: '@bsv/parent',
      version: '3.0.0',
      dependencies: {
        jest: '^30.0.0',
        '@types/unapproved': '^1.0.0',
        '@bsv/child': '^2.0.0',
        '@types/express': '^5.0.0'
      },
      peerDependencies: { '@bsv/child': '^2.0.0 || ^3.0.0' },
      scripts: {
        test: 'jest --passWithNoTests --experimental-vm-modules',
        'test:coverage': 'jest --coverageReporters=text'
      }
    })
  )
  writeFileSync(
    join(child, 'package.json'),
    JSON.stringify({ name: '@bsv/child', version: '2.0.0' })
  )
  const listing = [
    { name: '@bsv/parent', version: '3.0.0', path: parent },
    { name: '@bsv/child', version: '2.0.0', path: child }
  ]
  writeFileSync(
    join(environment.PATH, 'pnpm'),
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(listing))})\n`
  )
  const result = spawnSync(process.execPath, [join(scripts, 'check-versions.mjs')], {
    cwd: root,
    env: environment,
    encoding: 'utf8'
  })
  assert.equal(result.status, 1)
  assert.equal(
    result.stdout,
    [
      'PUBLISH SURFACE  @bsv/parent exposes development-only dependency jest',
      'PUBLISH SURFACE  @bsv/parent exposes development-only dependency @types/unapproved',
      'DECLARATION DEPENDENCY  @bsv/parent publishes @types/express without express',
      'DECLARATION DEPENDENCY  @bsv/parent must publish governed dependency @types/scope__runtime',
      'DECLARATION DEPENDENCY  @bsv/parent publishes @types/scope__runtime without @scope/runtime',
      'COVERAGE MISMATCH  @bsv/parent test:coverage is missing --passWithNoTests, --experimental-vm-modules, --coverageReporters=lcov',
      'STALE  @bsv/parent  @bsv/child  ^2.0.0  (current: 2.0.0)',
      'VERSION MISMATCH  @bsv/child@2.0.0  must match enclosing  @bsv/parent@3.0.0',
      ''
    ].join('\n')
  )
  assert.equal(
    result.stderr,
    [
      '',
      '1 stale references. Run: node scripts/sync-versions.mjs --workspace-only',
      '',
      '1 nested package(s) out of lockstep with their enclosing package. Bump them to match.',
      '',
      '1 coverage script(s) disagree with their package test semantics.',
      '',
      '5 development-only dependency entries would leak into published runtime installs.',
      ''
    ].join('\n')
  )
  writeFileSync(
    join(parent, 'package.json'),
    JSON.stringify({
      name: '@bsv/parent',
      version: '3.0.0',
      private: true,
      dependencies: { '@bsv/child': 'workspace:^' },
      peerDependencies: { '@bsv/child': '^2.0.0 || ^3.0.0' }
    })
  )
  writeFileSync(
    join(child, 'package.json'),
    JSON.stringify({ name: '@bsv/child', version: '2.0.0', private: true })
  )
  assert.equal(
    execFileSync(process.execPath, [join(scripts, 'check-versions.mjs')], {
      cwd: root,
      env: environment,
      encoding: 'utf8'
    }),
    'All cross-package version references up to date.\n'
  )
})

function windowsPackageLauncher(bin, packageName, relativeLauncher, output) {
  const packageDirectory = join(bin, 'node_modules', packageName)
  const launcher = join(packageDirectory, relativeLauncher)
  mkdirSync(dirname(launcher), { recursive: true })
  writeFileSync(join(packageDirectory, 'package.json'), JSON.stringify({ name: packageName }))
  writeFileSync(
    launcher,
    `if (JSON.stringify(process.argv.slice(2)) !== '["-r","ls","--json","--depth","0"]') process.exit(4);\nprocess.stdout.write(${JSON.stringify(JSON.stringify(output))})\n`
  )
  return realpathSync(launcher)
}

function writeWindowsShim(bin, shim, route) {
  const body =
    shim === 'pnpm.cmd'
      ? `@echo off\r\n"%~dp0\\node.exe" "%~dp0\\node_modules\\${route.replaceAll('/', '\\')}" %*\r\n`
      : `#!/usr/bin/env pwsh\n$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\n& "node$exe" "$basedir/node_modules/${route}" $args\n`
  writeFileSync(join(bin, shim), body)
}

test('win32 direct discovery executes validated npm pnpm JS behind cmd and ignores the shell shim', t => {
  const { root, bin, environment } = discoveryFixture(t, 'process.exit(31)')
  writeFileSync(join(bin, 'pnpm'), '#!/bin/sh\nexit 31\n')
  writeWindowsShim(bin, 'pnpm.cmd', 'pnpm/bin/pnpm.cjs')
  const expected = [{ name: 'windows-pnpm', version: '1.0.0' }]
  const launcher = windowsPackageLauncher(bin, 'pnpm', 'bin/pnpm.cjs', expected)
  assert.deepEqual(resolvePnpmLauncher(root, environment, 'win32'), {
    executable: launcher,
    nodeLauncher: true
  })
  assert.deepEqual(listWorkspacePackages(root, environment, 'win32'), expected)
})

test('win32 direct discovery executes validated Corepack JS behind ps1 without a shell', t => {
  const { root, bin, environment } = discoveryFixture(t, 'process.exit(31)')
  writeWindowsShim(bin, 'pnpm.ps1', 'corepack/dist/pnpm.js')
  const expected = [{ name: 'windows-corepack', version: '1.0.0' }]
  const launcher = windowsPackageLauncher(bin, 'corepack', 'dist/pnpm.js', expected)
  assert.deepEqual(resolvePnpmLauncher(root, environment, 'win32'), {
    executable: launcher,
    nodeLauncher: true
  })
  assert.deepEqual(listWorkspacePackages(root, environment, 'win32'), expected)
  assert.deepEqual(
    listWorkspacePackages(
      root,
      { ...environment, PATH: join(root, 'absent'), npm_execpath: join(bin, 'pnpm.ps1') },
      'win32'
    ),
    expected
  )
})

test('win32 discovery retains directory precedence and qualifies native exe as a native launcher', t => {
  const { root, bin, environment } = discoveryFixture(t, 'process.exit(31)')
  const first = windowsPackageLauncher(bin, 'pnpm', 'bin/pnpm.cjs', [])
  writeWindowsShim(bin, 'pnpm.cmd', 'pnpm/bin/pnpm.cjs')
  const secondBin = join(root, 'second bin')
  mkdirSync(secondBin)
  const native = join(secondBin, 'pnpm.exe')
  writeFileSync(native, 'native executable fixture; resolved but not executed on the host')
  const secondEnvironment = { ...environment, PATH: `${bin};${secondBin}` }
  assert.deepEqual(resolvePnpmLauncher(root, secondEnvironment, 'win32'), {
    executable: first,
    nodeLauncher: true
  })
  assert.deepEqual(resolvePnpmLauncher(root, { ...environment, PATH: secondBin }, 'win32'), {
    executable: realpathSync(native),
    nodeLauncher: false
  })
})

test('win32 discovery rejects unqualified shell-only shims and incorrect package metadata', t => {
  const { root, bin, environment } = discoveryFixture(t, 'process.exit(31)')
  writeFileSync(join(bin, 'pnpm'), '#!/bin/sh\nexit 31\n')
  writeFileSync(join(bin, 'pnpm.cmd'), '@echo off\r\nexit /b 31\r\n')
  assert.throws(() => listWorkspacePackages(root, environment, 'win32'), /Cannot locate pnpm/)
  windowsPackageLauncher(bin, 'pnpm', 'bin/pnpm.cjs', [])
  writeWindowsShim(bin, 'pnpm.cmd', 'pnpm/bin/pnpm.cjs')
  writeFileSync(
    join(bin, 'node_modules', 'pnpm', 'package.json'),
    JSON.stringify({ name: 'unrelated-tool' })
  )
  assert.throws(() => listWorkspacePackages(root, environment, 'win32'), /Cannot locate pnpm/)
})

for (const [packageName, route] of [
  ['pnpm', 'pnpm/bin/pnpm.cjs'],
  ['corepack', 'corepack/dist/pnpm.js']
]) {
  test(`win32 coexistence preserves the actual shim-selected ${packageName} route`, t => {
    const { root, bin, environment } = discoveryFixture(t, 'process.exit(31)')
    const pnpm = windowsPackageLauncher(bin, 'pnpm', 'bin/pnpm.cjs', [
      { name: 'selected-pnpm', version: '1.0.0' }
    ])
    const corepack = windowsPackageLauncher(bin, 'corepack', 'dist/pnpm.js', [
      { name: 'selected-corepack', version: '1.0.0' }
    ])
    writeWindowsShim(bin, 'pnpm.cmd', route)
    writeWindowsShim(
      bin,
      'pnpm.ps1',
      packageName === 'pnpm' ? 'corepack/dist/pnpm.js' : 'pnpm/bin/pnpm.cjs'
    )
    assert.deepEqual(resolvePnpmLauncher(root, environment, 'win32'), {
      executable: packageName === 'pnpm' ? pnpm : corepack,
      nodeLauncher: true
    })
    assert.deepEqual(listWorkspacePackages(root, environment, 'win32'), [
      { name: `selected-${packageName}`, version: '1.0.0' }
    ])
    assert.deepEqual(
      listWorkspacePackages(
        root,
        { ...environment, PATH: join(root, 'absent'), npm_execpath: join(bin, 'pnpm.cmd') },
        'win32'
      ),
      [{ name: `selected-${packageName}`, version: '1.0.0' }]
    )
  })
}

test('win32 shim qualification rejects conflicting and oversized route bytes', t => {
  const { root, bin, environment } = discoveryFixture(t, 'process.exit(31)')
  windowsPackageLauncher(bin, 'pnpm', 'bin/pnpm.cjs', [])
  windowsPackageLauncher(bin, 'corepack', 'dist/pnpm.js', [])
  writeWindowsShim(bin, 'pnpm.cmd', 'pnpm/bin/pnpm.cjs')
  const original = readFileSync(join(bin, 'pnpm.cmd'), 'utf8')
  writeWindowsShim(bin, 'pnpm.cmd', 'corepack/dist/pnpm.js')
  writeFileSync(join(bin, 'pnpm.cmd'), original + readFileSync(join(bin, 'pnpm.cmd'), 'utf8'))
  assert.throws(
    () => listWorkspacePackages(root, environment, 'win32'),
    /unknown or incoherent Windows shim route/
  )
  writeFileSync(join(bin, 'pnpm.cmd'), original + ' '.repeat(8193))
  assert.throws(
    () => listWorkspacePackages(root, environment, 'win32'),
    /unknown or incoherent Windows shim route/
  )
})
