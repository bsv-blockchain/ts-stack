'use strict'

// Test delivery only: physical Worker threads need JavaScript siblings even
// when Jest loads their parents from TypeScript. These exact ordinary build
// outputs are disposable; no production loader or worker options are changed.
const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { copyNativeSourceInput } = require('../../src/storage/portable/native/prepare_source.cjs')
const assets = Object.freeze([
  'src/storage/portable/Brc39Argon2Worker.js',
  'src/utility/hashWasm.js',
  'src/utility/Argon2idBackend.js'
])
const maximum = 262144
const location = root => path.join(path.resolve(root), 'test/.jest-worker-assets')
const missing = cause => cause.code === 'ENOENT'
const identity = stat => ({ device: stat.dev.toString(), inode: stat.ino.toString() })
const same = (stat, record) => stat.dev.toString() === record.device && stat.ino.toString() === record.inode
async function statOrMissing(filename) {
  try {
    return await fs.lstat(filename, { bigint: true })
  } catch (cause) {
    if (!missing(cause)) throw cause
  }
}
function live(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid worker asset owner')
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    if (cause.code !== 'ESRCH') throw cause
    return false
  }
}
async function save(directory, state) {
  const next = path.join(directory, 'manifest.next')
  await fs.writeFile(next, JSON.stringify(state), { flag: 'wx', mode: 0o600 })
  await fs.rename(next, path.join(directory, 'manifest.json'))
}
async function read(directory) {
  const stat = await fs.lstat(directory, { bigint: true })
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077n) !== 0n)
    throw new Error('Worker asset ownership directory differs')
  const filename = path.join(directory, 'manifest.json'),
    file = await fs.open(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW).catch(cause => {
      if (cause.code === 'ELOOP') throw new Error('Worker asset ownership manifest differs')
      throw cause
    })
  let state
  try {
    const metadata = await file.stat()
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > 8192)
      throw new Error('Worker asset ownership manifest differs')
    const bytes = Buffer.alloc(8193)
    let length = 0
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length > 8192 || length !== metadata.size) throw new Error('Worker asset ownership manifest differs')
    const currentDirectory = await fs.lstat(directory, { bigint: true })
    if (!same(currentDirectory, identity(stat))) throw new Error('Worker asset ownership directory differs')
    state = JSON.parse(bytes.subarray(0, length).toString('utf8'))
  } finally {
    await file.close()
  }
  if (
    state.protocol !== 'wallet-jest-worker-assets/v1' ||
    !same(stat, state.directory) ||
    !Array.isArray(state.assets) ||
    state.assets.length > assets.length ||
    state.assets.some((record, index) => record.path !== assets[index])
  )
    throw new Error('Worker asset ownership record differs')
  return state
}
async function cleanupOwnedWorkerAssets(root, allowCurrentOwner = true) {
  root = path.resolve(root)
  const directory = location(root)
  if ((await statOrMissing(directory)) === undefined) return
  const state = await read(directory)
  if (live(state.pid) && !(allowCurrentOwner && state.pid === process.pid))
    throw new Error('Another live test run owns the physical Worker assets')
  for (const [index, record] of state.assets.entries()) {
    const target = path.join(root, record.path),
      stage = path.join(directory, 'asset-' + index)
    const actual = await statOrMissing(target)
    if (actual !== undefined && same(actual, record)) {
      if (
        !actual.isFile() ||
        actual.isSymbolicLink() ||
        actual.size !== BigInt(record.bytes) ||
        actual.nlink < 1n ||
        actual.nlink > 2n
      )
        throw new Error('Original worker asset changed; cleanup remains owned')
      // Remove a retained original staging link before the independent bounded
      // reread, which requires one physical link. Never touch a foreign inode.
      const staged = await statOrMissing(stage)
      if (staged !== undefined) {
        if (!same(staged, record)) throw new Error('Original worker staging inode differs')
        await fs.unlink(stage)
      }
      const checked = path.join(directory, 'check-' + index)
      const postimage = await copyNativeSourceInput(target, checked, maximum)
      await fs.unlink(checked)
      if (
        postimage.bytes !== record.bytes ||
        postimage.sha256 !== record.sha256 ||
        !same(await fs.lstat(target, { bigint: true }), record)
      )
        throw new Error('Original worker asset content changed; cleanup remains owned')
      await fs.unlink(target)
    } else if (actual !== undefined && record.linked) {
      throw new Error('Original worker asset was replaced; cleanup remains owned')
    }
    const staged = await statOrMissing(stage)
    if (staged !== undefined) {
      if (!same(staged, record)) throw new Error('Original worker staging inode differs')
      await fs.unlink(stage)
    }
  }
  const entries = await fs.readdir(directory)
  if (entries.some(name => name !== 'manifest.json'))
    throw new Error('Worker asset ownership directory retains unexpected entries')
  await fs.unlink(path.join(directory, 'manifest.json'))
  await fs.rmdir(directory)
}
async function prepareOwnedWorkerAssets(root) {
  root = path.resolve(root)
  const directory = location(root)
  if ((await statOrMissing(directory)) !== undefined) await cleanupOwnedWorkerAssets(root, false)
  await fs.mkdir(directory, { mode: 0o700 })
  const state = {
    protocol: 'wallet-jest-worker-assets/v1',
    id: randomUUID(),
    pid: process.pid,
    directory: identity(await fs.lstat(directory, { bigint: true })),
    assets: []
  }
  await save(directory, state)
  try {
    for (const [index, input] of assets.entries()) {
      const stage = path.join(directory, 'asset-' + index),
        target = path.join(root, input)
      const copied = await copyNativeSourceInput(path.join(root, 'out', input), stage, maximum)
      const record = { path: input, ...copied, ...identity(await fs.lstat(stage, { bigint: true })), linked: false }
      state.assets.push(record)
      await save(directory, state)
      // Hard-link creation is atomic and refuses an existing destination;
      // renaming here would silently overwrite an unrelated source artifact.
      await fs.link(stage, target)
      record.linked = true
      await save(directory, state)
      await fs.unlink(stage)
    }
    return Object.freeze({ id: state.id, assets: Object.freeze(state.assets.map(record => record.path)) })
  } catch (cause) {
    try {
      await cleanupOwnedWorkerAssets(root)
    } catch (error_) {
      throw new AggregateError([cause, error_], 'Worker asset preparation retains its original cleanup owner')
    }
    throw cause
  }
}
module.exports = Object.freeze({ assets, prepareOwnedWorkerAssets, cleanupOwnedWorkerAssets })
