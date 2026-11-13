#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { appendFile, chmod, copyFile, lstat, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, matchesGlob, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildMutationTargets } from '../governance/mutation-testing/targets.mjs'
import {
  installNativeBrowserSandbox,
  removeNativeBrowserSandbox
} from './wallet-native-browser-sandbox.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const browserPin = Object.freeze(
  JSON.parse(readFileSync(new URL('./wallet-native-browser.json', import.meta.url), 'utf8'))
)
export const browserPins = Object.freeze({
  arm64: browserPin,
  x64: Object.freeze(
    JSON.parse(
      readFileSync(new URL('./wallet-native-browser-linux-x64.json', import.meta.url), 'utf8')
    )
  )
})
export function nativeBrowserPlan(platform = process.platform, architecture = process.arch) {
  if (platform !== 'linux' || !['arm64', 'x64'].includes(architecture))
    throw new Error('Pinned browser delivery requires the native Linux ARM64/x64 worker')
  return browserPins[architecture]
}
export function needsNativeBrowserDelivery(target) {
  if (target.packageDirectory !== 'packages/wallet/wallet-toolbox' || target.testRunner !== 'jest')
    return false
  const selected = target.runnerOptions?.jest?.config?.testMatch
  if (selected === undefined) return true
  const browserTests = [
    'src/storage/portable/Brc38NativeBrowserComponents.test.cjs',
    'src/utility/BrowserArgon2idWorker.native.test.cjs',
    'src/storage/snapshot/PackedIdbCurrentStructuredRead.test.ts'
  ]
  return browserTests.some(file => {
    let included = false
    for (const pattern of selected) {
      const excluded = pattern.startsWith('!') && !pattern.startsWith('!(')
      const glob = excluded ? pattern.slice(1) : pattern
      const candidate = glob.includes('<rootDir>') ? '/wallet-root/' + file : file
      if (matchesGlob(candidate, glob.replaceAll('<rootDir>', '/wallet-root'))) included = !excluded
    }
    return included
  })
}
export async function verifyBrowserFile(file, bytes, sha256) {
  const info = await lstat(file)
  assert.ok(
    info.isFile() && !info.isSymbolicLink(),
    'Browser artifact must be a regular owned file'
  )
  assert.equal(info.size, bytes, 'Browser artifact bytes differ from the source pin')
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(file)) digest.update(chunk)
  assert.equal(digest.digest('hex'), sha256, 'Browser artifact digest differs from the source pin')
}
function execute(program, args, timeout, maximum = 65536) {
  const result = spawnSync(program, args, {
    encoding: 'utf8',
    timeout,
    maxBuffer: maximum,
    killSignal: 'SIGTERM'
  })
  if (result.error || result.status !== 0 || result.signal !== null)
    throw new Error('Native browser delivery step failed or exceeded its bound', {
      cause: result.error
    })
  return result.stdout
}
export async function provisionNativeBrowser({
  archive,
  parent = process.env.RUNNER_TEMP ?? tmpdir()
} = {}) {
  const pin = nativeBrowserPlan()
  const privateRoot = await mkdtemp(join(parent, 'ts-wallet-native-browser-'))
  await chmod(privateRoot, 0o700)
  let sandbox,
    executable,
    sandboxAttempted = false
  try {
    const ownedArchive = join(privateRoot, 'chrome.zip')
    if (archive !== undefined) {
      const info = await lstat(archive)
      assert.ok(
        info.isFile() && !info.isSymbolicLink(),
        'A supplied archive must be a regular file'
      )
      await copyFile(archive, ownedArchive, constants.COPYFILE_EXCL)
    } else {
      execute(
        'curl',
        [
          '--fail',
          '--silent',
          '--show-error',
          '--location',
          '--proto',
          '=https',
          '--max-time',
          '150',
          '--max-filesize',
          String(pin.archiveBytes),
          '--output',
          ownedArchive,
          pin.url
        ],
        180000
      )
    }
    await chmod(ownedArchive, 0o400)
    await verifyBrowserFile(ownedArchive, pin.archiveBytes, pin.archiveSha256)
    const entries = execute('unzip', ['-Z', '-1', ownedArchive], 10000, 1048576).trim().split('\n')
    assert.equal(entries.length, pin.archiveEntries)
    assert.ok(
      entries.every(
        entry =>
          entry.startsWith(
            pin.executableRelativePath.slice(0, pin.executableRelativePath.indexOf('/') + 1)
          ) &&
          !entry.split('/').includes('..') &&
          !entry.includes('\\')
      )
    )
    execute('unzip', ['-q', ownedArchive, '-d', privateRoot], 60000)
    executable = join(privateRoot, pin.executableRelativePath)
    await verifyBrowserFile(executable, pin.executableBytes, pin.executableSha256)
    await chmod(executable, 0o500)
    sandboxAttempted = true
    sandbox = await installNativeBrowserSandbox(executable)
    await rm(ownedArchive)
    const sourceSha = execute('git', ['-C', root, 'rev-parse', 'HEAD'], 5000).trim()
    assert.match(sourceSha, /^[a-f0-9]{40}$/)
    const receipt = {
      kind: 'native-browser-delivery',
      sourceSha,
      ...pin,
      executable,
      sandbox,
      runtimeQualified: false,
      processTreeQualified: false
    }
    await writeFile(
      join(privateRoot, 'component-delivery.json'),
      JSON.stringify(receipt, null, 2) + '\n',
      { mode: 0o600, flag: 'wx' }
    )
    return receipt
  } catch (cause) {
    // Successful delivery retains its exact attachment and bytes for the job.
    // On failure, remove the kernel attachment before retiring its files.
    const failures = []
    if (sandbox !== undefined)
      try {
        await removeNativeBrowserSandbox(executable, sandbox)
        sandboxAttempted = false
      } catch (error_) {
        failures.push(error_)
      }
    // If kernel cleanup is uncertain, retain the exact executable/owner path
    // for a concrete retry rather than leaving an attachment to a retired path.
    if (!sandboxAttempted)
      try {
        await rm(privateRoot, { recursive: true, force: true })
      } catch (error_) {
        failures.push(error_)
      }
    if (failures.length)
      throw new AggregateError(
        [cause, ...failures],
        'Native browser delivery retains concrete cleanup'
      )
    throw cause
  }
}

/** Read the checked receipt through one no-follow descriptor and a fixed byte bound. */
export async function readNativeBrowserDeliveryReceipt(receiptFile) {
  assert.equal(typeof receiptFile, 'string')
  assert.equal(resolve(receiptFile), receiptFile)
  assert.equal(receiptFile, join(dirname(receiptFile), 'component-delivery.json'))
  const uid = process.getuid?.()
  assert.ok(Number.isSafeInteger(uid), 'Browser receipt requires a POSIX owner')
  const file = await open(
    receiptFile,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  )
  try {
    const before = await file.stat({ bigint: true })
    assert.ok(
      before.isFile() &&
        before.nlink === 1n &&
        before.uid === BigInt(uid) &&
        (before.mode & 0o777n) === 0o600n &&
        before.size >= 0n &&
        before.size <= 16384n,
      'Browser receipt requires its private regular owned file within 16 KiB'
    )
    const buffer = Buffer.alloc(16385)
    let used = 0
    while (used < buffer.length) {
      const read = await file.read(buffer, used, buffer.length - used, used)
      if (read.bytesRead === 0) break
      used += read.bytesRead
    }
    assert.equal(used, Number(before.size), 'Browser receipt changed its bounded length')
    const after = await file.stat({ bigint: true })
    for (const field of ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'])
      assert.equal(
        after[field],
        before[field],
        'Browser receipt identity or bytes changed during read'
      )
    return JSON.parse(buffer.toString('utf8', 0, used))
  } finally {
    await file.close()
  }
}

export async function cleanupNativeBrowserDelivery(receiptFile) {
  if (receiptFile === undefined) return { allocated: false }
  const pin = nativeBrowserPlan(),
    privateRoot = dirname(receiptFile)
  const receipt = await readNativeBrowserDeliveryReceipt(receiptFile)
  const executable = receipt.executable
  assert.equal(receiptFile, join(privateRoot, 'component-delivery.json'))
  assert.equal(receipt.executableSha256, pin.executableSha256)
  assert.equal(receipt.buildId, pin.buildId)
  assert.equal(join(privateRoot, pin.executableRelativePath), executable)
  const result = await removeNativeBrowserSandbox(executable, receipt.sandbox)
  await writeFile(
    join(privateRoot, 'component-sandbox-cleanup-' + randomUUID() + '.json'),
    JSON.stringify(result) + '\n',
    { mode: 0o600, flag: 'wx' }
  )
  return result
}
async function main() {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--cleanup') {
    console.log(
      JSON.stringify(
        await cleanupNativeBrowserDelivery(process.env.TS_STACK_NATIVE_BROWSER_DELIVERY)
      )
    )
    return
  }
  let archive, targetId
  while (args.length) {
    const flag = args.shift(),
      value = args.shift()
    if (!value || !['--archive', '--target'].includes(flag))
      throw new Error('Expected an exact --archive path or --target ID')
    if (flag === '--archive') {
      assert.equal(archive, undefined)
      archive = value
    } else {
      assert.equal(targetId, undefined)
      targetId = value
    }
  }
  if (targetId !== undefined) {
    const target = buildMutationTargets(root)[targetId]
    assert.ok(target, 'Unknown canonical mutation target')
    if (!needsNativeBrowserDelivery(target)) return
  }
  const receipt = await provisionNativeBrowser({ archive })
  try {
    if (process.env.GITHUB_ENV)
      await appendFile(
        process.env.GITHUB_ENV,
        'CHROME_BIN=' +
          receipt.executable +
          '\nTS_STACK_NATIVE_BROWSER_DELIVERY=' +
          join(dirname(dirname(receipt.executable)), 'component-delivery.json') +
          '\n'
      )
    console.log(JSON.stringify(receipt))
  } catch (cause) {
    try {
      await removeNativeBrowserSandbox(receipt.executable, receipt.sandbox)
    } catch (error_) {
      throw new AggregateError(
        [cause, error_],
        'Native browser environment handoff retains sandbox cleanup'
      )
    }
    throw cause
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error(
      'Pinned native browser delivery failed; no browser may be substituted or skipped.'
    )
    process.exitCode = 1
  })
}
