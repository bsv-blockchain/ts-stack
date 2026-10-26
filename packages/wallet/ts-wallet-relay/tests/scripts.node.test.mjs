import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildWalletRelay } from '../build.mjs'
import { scaffoldWalletRelay } from '../bin/init.mjs'

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-relay-scaffold-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('scaffold help is side-effect free', () => {
  assert.deepEqual(scaffoldWalletRelay(['--help']), [])
  assert.deepEqual(scaffoldWalletRelay(['-h']), [])
})

test('scaffolds bounded backend and frontend targets without overwriting files', t => {
  const root = temporaryDirectory(t)
  const created = scaffoldWalletRelay([root])
  assert.ok(created.some(file => file === 'backend/server.ts'))
  assert.ok(created.some(file => file.endsWith('frontend/views/DesktopView.tsx')))

  const serverPath = path.join(root, 'backend', 'server.ts')
  const original = fs.readFileSync(serverPath, 'utf8')
  fs.writeFileSync(serverPath, `${original}\n// caller-owned\n`)
  assert.deepEqual(scaffoldWalletRelay([root]), [])
  assert.match(fs.readFileSync(serverPath, 'utf8'), /caller-owned/)
})

test('honors backend-only and frontend-only directory options', t => {
  const backendRoot = temporaryDirectory(t)
  const backendFiles = scaffoldWalletRelay([backendRoot, '--backend', '--backend-dir', 'service'])
  assert.ok(backendFiles.every(file => file.startsWith('service/')))
  assert.equal(fs.existsSync(path.join(backendRoot, 'frontend')), false)

  const frontendRoot = temporaryDirectory(t)
  const frontendFiles = scaffoldWalletRelay(['--frontend-dir', 'ui', '--frontend', frontendRoot])
  assert.ok(frontendFiles.every(file => file.startsWith('ui/')))
  assert.equal(fs.existsSync(path.join(frontendRoot, 'backend')), false)
})

test('scaffolds Next.js directly into the target project', t => {
  const root = temporaryDirectory(t)
  const created = scaffoldWalletRelay([root, '--nextjs'])
  assert.ok(created.includes('app/api/session/route.ts'))
  assert.ok(created.includes('app/api/request/[id]/route.ts'))
  assert.equal(fs.existsSync(path.join(root, 'backend')), false)
})

test('rejects missing, absolute, traversal, and symlink output directories', t => {
  const root = temporaryDirectory(t)
  assert.throws(() => scaffoldWalletRelay([root, '--backend-dir']), /requires a directory value/)
  assert.throws(
    () => scaffoldWalletRelay([root, '--backend-dir', path.resolve(root, 'absolute')]),
    /relative directory/
  )
  assert.throws(
    () => scaffoldWalletRelay([root, '--backend-dir', '../outside']),
    /stay inside the target project/
  )

  const outside = temporaryDirectory(t)
  fs.symlinkSync(outside, path.join(root, 'linked'))
  assert.throws(
    () => scaffoldWalletRelay([root, '--backend', '--backend-dir', 'linked']),
    /Refusing unsafe scaffold directory/
  )
})

test('builds both module formats after cleaning the output directory', async () => {
  const removals = []
  const builds = []
  await buildWalletRelay({
    watch: false,
    removeImplementation: async (...args) => removals.push(args),
    buildImplementation: async options => builds.push(options),
    contextImplementation: async () => assert.fail('watch context must not be created')
  })
  assert.equal(removals.length, 1)
  assert.equal(removals[0][1].recursive, true)
  assert.deepEqual(
    builds.map(options => options.format),
    ['esm', 'cjs']
  )
})

test('watches both module formats through injected build contexts', async () => {
  const watched = []
  const contexts = []
  await buildWalletRelay({
    watch: true,
    removeImplementation: async () => undefined,
    buildImplementation: async () => assert.fail('one-shot build must not run'),
    contextImplementation: async options => {
      contexts.push(options)
      return { watch: async () => watched.push(options.format) }
    }
  })
  assert.deepEqual(
    contexts.map(options => options.format),
    ['esm', 'cjs']
  )
  assert.deepEqual(watched, ['esm', 'cjs'])
})
