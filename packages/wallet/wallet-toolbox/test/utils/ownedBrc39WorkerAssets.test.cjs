'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { assets, prepareOwnedWorkerAssets, cleanupOwnedWorkerAssets } = require('./ownedBrc39WorkerAssets.cjs')
async function fixture(work) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wallet-worker-assets-contract-'))
  try {
    await fs.mkdir(path.join(root, 'test'))
    for (const [index, asset] of assets.entries()) {
      await fs.mkdir(path.dirname(path.join(root, asset)), { recursive: true })
      await fs.mkdir(path.dirname(path.join(root, 'out', asset)), { recursive: true })
      await fs.writeFile(path.join(root, 'out', asset), 'original compiled fixture ' + index)
    }
    await work(root)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}
test('all three actual compiled siblings install exactly once and original unchanged assets drain', async () => {
  await fixture(async root => {
    const receipt = await prepareOwnedWorkerAssets(root)
    assert.deepEqual(receipt.assets, assets)
    for (const asset of assets) {
      assert.deepEqual(await fs.readFile(path.join(root, asset)), await fs.readFile(path.join(root, 'out', asset)))
      assert.equal((await fs.lstat(path.join(root, asset))).nlink, 1)
    }
    await assert.rejects(prepareOwnedWorkerAssets(root), /Another live test run/)
    await cleanupOwnedWorkerAssets(root)
    for (const asset of assets) await assert.rejects(fs.lstat(path.join(root, asset)), { code: 'ENOENT' })
    await assert.rejects(fs.lstat(path.join(root, 'test/.jest-worker-assets')), { code: 'ENOENT' })
    await cleanupOwnedWorkerAssets(root)
  })
})
test('a preexisting foreign source artifact is preserved and all previously installed owned siblings drain', async () => {
  await fixture(async root => {
    const foreign = path.join(root, assets[1])
    await fs.writeFile(foreign, 'independent preexisting source artifact')
    await assert.rejects(prepareOwnedWorkerAssets(root), { code: 'EEXIST' })
    assert.equal(await fs.readFile(foreign, 'utf8'), 'independent preexisting source artifact')
    await assert.rejects(fs.lstat(path.join(root, assets[0])), { code: 'ENOENT' })
    await assert.rejects(fs.lstat(path.join(root, 'test/.jest-worker-assets')), { code: 'ENOENT' })
  })
})
test('missing ordinary build refuses preparation without retaining generated source or ownership', async () => {
  await fixture(async root => {
    await fs.unlink(path.join(root, 'out', assets[2]))
    await assert.rejects(prepareOwnedWorkerAssets(root), { code: 'ENOENT' })
    for (const asset of assets) await assert.rejects(fs.lstat(path.join(root, asset)), { code: 'ENOENT' })
    await assert.rejects(fs.lstat(path.join(root, 'test/.jest-worker-assets')), { code: 'ENOENT' })
  })
})
test('changed content and replacement inodes refuse cleanup and remain independently visible', async () => {
  await fixture(async root => {
    await prepareOwnedWorkerAssets(root)
    const target = path.join(root, assets[0])
    await fs.chmod(target, 0o600)
    await fs.writeFile(target, 'independent changed content')
    await assert.rejects(cleanupOwnedWorkerAssets(root), /changed/)
    assert.equal(await fs.readFile(target, 'utf8'), 'independent changed content')
    const replacement = path.join(root, 'independent-worker-replacement.js')
    await fs.writeFile(replacement, 'independent replacement inode')
    await fs.rename(replacement, target)
    await assert.rejects(cleanupOwnedWorkerAssets(root), /replaced/)
    assert.equal(await fs.readFile(target, 'utf8'), 'independent replacement inode')
  })
})
test('a symbolic build input refuses before creating any source worker', async () => {
  await fixture(async root => {
    const compiled = path.join(root, 'out', assets[0])
    await fs.unlink(compiled)
    await fs.symlink(path.join(root, 'out', assets[1]), compiled)
    await assert.rejects(prepareOwnedWorkerAssets(root))
    await assert.rejects(fs.lstat(path.join(root, assets[0])), { code: 'ENOENT' })
    await assert.rejects(fs.lstat(path.join(root, 'test/.jest-worker-assets')), { code: 'ENOENT' })
  })
})

test('malformed or oversized ownership manifests refuse cleanup, retain every original asset and close their descriptor', async () => {
  await fixture(async root => {
    await prepareOwnedWorkerAssets(root)
    const filename = path.join(root, 'test/.jest-worker-assets/manifest.json'),
      original = await fs.readFile(filename),
      originalOpen = fs.open,
      handles = [],
      spy = jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
        const file = await originalOpen(...args)
        if (args[0] === filename) handles.push(file)
        return file
      })
    try {
      for (const bytes of [Buffer.alloc(8193, 32), Buffer.from('{]')]) {
        await fs.writeFile(filename, bytes)
        await assert.rejects(cleanupOwnedWorkerAssets(root))
        assert.equal(handles.at(-1).fd, -1)
        for (const asset of assets)
          assert.deepEqual(await fs.readFile(path.join(root, asset)), await fs.readFile(path.join(root, 'out', asset)))
      }
      await fs.writeFile(filename, original)
      await cleanupOwnedWorkerAssets(root)
      assert.equal(handles.at(-1).fd, -1)
    } finally {
      spy.mockRestore()
    }
  })
})
