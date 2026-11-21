'use strict'

// Bounded build DATA I/O only. No fake compiled JS, compiler, SDK or native
// engine is loaded/executed, and no manifest becomes qualification evidence.
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { copyWalletNativeArtifacts, assets, compiled } = require('./copy_artifacts.cjs')
const { NativeSourceCleanupError } = require('./prepare_source.cjs')
let root, source, output
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-artifact-data-'))
  source = path.join(root, 'src/storage/portable')
  output = path.join(root, 'out/src/storage/portable')
  await fs.mkdir(path.join(source, 'native'), { recursive: true })
  await fs.mkdir(path.join(output, 'native'), { recursive: true })
  for (const asset of assets) await fs.copyFile(path.join(__dirname, '..', asset), path.join(source, asset))
  for (const asset of compiled)
    await fs.writeFile(path.join(output, asset), 'throw new Error("must not execute build data");\n')
})
afterEach(async () => {
  jest.restoreAllMocks()
  await fs.rm(root, { recursive: true, force: true })
})
test('copies only fixed source/runtime assets and independently records actual package postimages without executing JS', async () => {
  await fs.writeFile(path.join(source, 'native/secret.sqlite'), 'never packaged')
  const result = await copyWalletNativeArtifacts(root),
    actual = JSON.parse(await fs.readFile(path.join(output, 'native/source-artifacts.json'), 'utf8'))
  expect(actual).toEqual(result)
  expect(result.engineCompiled).toBe(false)
  expect(result.engineExecuted).toBe(false)
  expect(result.qualified).toBe(false)
  expect(result.assets.map(value => value.path)).toEqual(assets)
  const recipe = require('./source_recipe.cjs')
  expect(assets).toContain('native/source_recipe.cjs')
  for (const name of [...recipe.driverSources, ...recipe.windowsAddonSources])
    expect(assets).toContain('native/' + name)
  expect(new Set(assets).size).toBe(assets.length)
  expect(result.compiled.map(value => value.path)).toEqual(compiled)
  for (const record of [...result.assets, ...result.compiled]) {
    const bytes = await fs.readFile(path.join(output, record.path))
    expect(bytes.length).toBe(record.bytes)
    expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(record.sha256)
  }
  await expect(fs.stat(path.join(output, 'native/secret.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await fs.readdir(output)).filter(value => value.startsWith('.native-artifact-source-'))).toEqual([])
})
test('requires actual ordinary compiled siblings before installing any native asset', async () => {
  await fs.rm(path.join(output, compiled[0]))
  await expect(copyWalletNativeArtifacts(root)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(fs.stat(path.join(output, assets[0]))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await fs.readdir(path.join(output, 'native'))).toEqual([])
  expect((await fs.readdir(output)).filter(value => value.startsWith('.native-artifact-source-'))).toEqual([])
})
test('refuses a destination artifact symlink and preserves its unrelated target', async () => {
  const neighbor = path.join(root, 'unrelated')
  await fs.writeFile(neighbor, 'preserved')
  await fs.symlink(neighbor, path.join(output, assets[0]))
  await expect(copyWalletNativeArtifacts(root)).rejects.toThrow('destination artifact differs')
  expect(await fs.readFile(neighbor, 'utf8')).toBe('preserved')
  expect((await fs.lstat(path.join(output, assets[0]))).isSymbolicLink()).toBe(true)
  await expect(fs.stat(path.join(output, 'native/source-artifacts.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})
test('retains an actual final-receipt descriptor through independent close failures and retries disposal', async () => {
  const original = fs.open,
    reason = new Error('synthetic artifact descriptor close failure')
  let failures = 0
  jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const file = await original(...args)
    if (String(args[0]).endsWith('/source-artifacts.json') && args[1] === 'wx') {
      const close = file.close.bind(file)
      file.close = async () => {
        if (failures++ < 2) throw reason
        await close()
      }
    }
    return file
  })
  const failure = await copyWalletNativeArtifacts(root).then(
    () => undefined,
    cause => cause
  )
  expect(failure).toBeInstanceOf(NativeSourceCleanupError)
  await expect(fs.stat(path.join(output, 'native/source-artifacts.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await fs.readdir(output)).filter(value => value.startsWith('.native-artifact-source-'))).toHaveLength(1)
  await failure.retryCleanup()
  expect((await fs.readdir(output)).filter(value => value.startsWith('.native-artifact-source-'))).toEqual([])
  await failure.retryCleanup()
})
