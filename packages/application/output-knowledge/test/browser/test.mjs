import assert from 'node:assert/strict'
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'
import { createServer } from 'vite'
import { createCommandRunner } from '../../../../../scripts/lib/command-runner.mjs'

const packageDirectory = fileURLToPath(new URL('../../', import.meta.url))
const repositoryRoot = path.resolve(packageDirectory, '../../..')
const run = createCommandRunner({
  timeoutMs: 240000,
  maxBufferBytes: 30 * 1024 * 1024,
  maxErrorOutputCharacters: 16000
})
const CSP =
  "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'none'; " +
  "img-src 'none'; object-src 'none'; base-uri 'none'"

async function chromePath() {
  for (const candidate of [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium'
  ]) {
    try {
      await access(candidate)
      return candidate
    } catch {}
  }
  throw new Error('Chrome or Chromium is required for native IndexedDB qualification')
}
async function pack(directory, destination) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'))
  const { stdout } = await run('pnpm', ['pack', '--json', '--pack-destination', destination], {
    cwd: directory,
    env: { ...process.env, npm_config_ignore_scripts: 'true' }
  })
  const result = JSON.parse(stdout)
  assert.equal(result.name, manifest.name)
  return path.resolve(result.filename)
}
async function createConsumer(root) {
  const directory = path.join(root, 'consumer')
  await mkdir(directory)
  const tarballs = await Promise.all([
    pack(packageDirectory, root),
    pack(path.join(repositoryRoot, 'packages/sdk'), root)
  ])
  await writeFile(path.join(directory, 'package.json'), '{"private":true,"type":"module"}\n')
  await run(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      '--omit=dev',
      ...tarballs
    ],
    { cwd: directory }
  )
  await mkdir(path.join(directory, 'browser'))
  await Promise.all(
    ['index.html', 'main.ts', 'proposals.ts', 'protected.ts'].map(file =>
      cp(path.join(packageDirectory, 'test/browser', file), path.join(directory, 'browser', file))
    )
  )
  return directory
}
async function openPage(browser, baseURL, errors) {
  const page = await browser.newPage()
  page.on('pageerror', error => errors.push(error.message))
  page.on('requestfailed', request => errors.push(request.failure()?.errorText ?? 'request failed'))
  const response = await page.goto(new URL('browser/index.html', baseURL).href, {
    waitUntil: 'networkidle0'
  })
  assert.equal(response.headers()['content-security-policy'], CSP)
  await page.waitForFunction(() => Reflect.has(window, 'outputKnowledgeBrowser'), {
    timeout: 30000
  })
  return page
}

const root = await mkdtemp(path.join(tmpdir(), 'output-knowledge-browser-'))
let server, browser
const errors = []
try {
  const consumer = await createConsumer(root)
  server = await createServer({
    root: consumer,
    logLevel: 'error',
    optimizeDeps: { exclude: ['@bsv/sdk', '@bsv/output-knowledge'] },
    server: {
      host: '127.0.0.1',
      port: 0,
      headers: { 'Content-Security-Policy': CSP, 'Cache-Control': 'no-store' },
      fs: { allow: [consumer, await realpath(consumer)] }
    }
  })
  await server.listen()
  const baseURL = server.resolvedUrls.local[0]
  const launch = {
    executablePath: await chromePath(),
    headless: true,
    protocolTimeout: 30000,
    userDataDir: path.join(root, 'profile'),
    args: ['--no-sandbox']
  }
  browser = await puppeteer.launch(launch)
  let page = await openPage(browser, baseURL, errors)
  const first = await page.evaluate(() => window.outputKnowledgeBrowser.initialize(true))
  assert.equal(first.revision.received, '1')
  assert.equal(first.requests.length, 1)
  assert.equal(first.saved.value.job, '0')
  assert.equal(first.saved.value.pending.coverage.phase, 'snapshot')
  // Leave every source/database handle open: recovery must depend on committed
  // IndexedDB transactions, not an application close hook.
  await page.close()
  await browser.close()
  browser = await puppeteer.launch(launch)
  page = await openPage(browser, baseURL, errors)
  const recovered = await page.evaluate(() => window.outputKnowledgeBrowser.initialize(false))
  assert.deepEqual(recovered.saved, first.saved)
  assert.equal(recovered.requests.length, 0, 'captured opening is replayed without I/O')
  assert.deepEqual(
    await page.evaluate(() => window.outputKnowledgeBrowser.pull()),
    first.saved.value.pending
  )
  assert.equal(
    (await page.evaluate(() => window.outputKnowledgeBrowser.receive())).status,
    'committed'
  )
  const live = await page.evaluate(() => window.outputKnowledgeBrowser.pull())
  assert.equal(live.coverage.phase, 'live')
  const advanced = await page.evaluate(() => window.outputKnowledgeBrowser.inspect())
  assert.equal(advanced.saved.value.job, '1')
  assert.equal(advanced.saved.value.previousReceipt.received, '2')
  assert.equal(advanced.requests.length, 1)
  assert.equal(advanced.requests[0].cursor, 'snapshot-cursor')
  assert.equal(advanced.requests[0].requestId, undefined)
  await page.close()
  page = await openPage(browser, baseURL, errors)
  const afterLiveCapture = await page.evaluate(() =>
    window.outputKnowledgeBrowser.initialize(false)
  )
  assert.deepEqual(afterLiveCapture.saved, advanced.saved)
  assert.equal(afterLiveCapture.requests.length, 0)
  assert.deepEqual(await page.evaluate(() => window.outputKnowledgeBrowser.pull()), live)
  await page.evaluate(() => window.outputKnowledgeBrowser.receive())
  const received = await page.evaluate(() => window.outputKnowledgeBrowser.inspect())
  assert.equal(received.revision.received, '3')
  assert.equal(received.saved.value.job, '1', 'receipt alone does not start another request')

  const empty = await page.evaluate(() => window.outputKnowledgeBrowser.cas(true))
  const peer = await openPage(browser, baseURL, errors)
  const writers = await Promise.all([
    page.evaluate(
      revision => window.outputKnowledgeBrowser.cas(false, revision, 'one'),
      empty.revision
    ),
    peer.evaluate(
      revision => window.outputKnowledgeBrowser.cas(false, revision, 'two'),
      empty.revision
    )
  ])
  assert.equal(writers.filter(result => result.status === 'updated').length, 1)
  assert.equal(writers.filter(result => result.status === 'conflict').length, 1)
  const winner = await peer.evaluate(() => window.outputKnowledgeBrowser.cas(false))
  assert.equal(winner.revision, '1')
  assert.equal(winner.value.candidate, writers[0].status === 'updated' ? 'one' : 'two')
  const missing = await page.evaluate(() => window.outputKnowledgeBrowser.missing())
  assert.equal(missing.code, 'unavailable')
  assert.equal(missing.databases.includes('missing-control'), false)
  const lostCore = await page.evaluate(() => window.outputKnowledgeBrowser.loseCore())
  assert.deepEqual(lostCore, { code: 'reset-required', requests: [] })
  const proposalReceipt = await page.evaluate(() =>
    window.outputKnowledgeBrowser.proposals.initialize(true)
  )
  assert.equal(proposalReceipt.input.revision.received, '2')
  assert.deepEqual(proposalReceipt.input.proposals.heads, [])
  await page.close()
  await browser.close()
  browser = await puppeteer.launch(launch)
  page = await openPage(browser, baseURL, errors)
  assert.deepEqual(
    await page.evaluate(() => window.outputKnowledgeBrowser.proposals.initialize(false)),
    proposalReceipt
  )
  const intent = await page.evaluate(() => window.outputKnowledgeBrowser.proposals.accept())
  assert.equal(intent.bitcoinChecks, 0)
  assert.deepEqual(intent.input.facts, [])
  assert.equal(intent.input.proposals.heads.length, 1)
  assert.equal(intent.input.proposals.heads[0].firstReceivedAt, '1000')
  assert.equal(intent.input.proposals.heads[0].lifetime, 'unexpired')
  assert.deepEqual(
    await page.evaluate(() => window.outputKnowledgeBrowser.proposals.read(1100000)),
    {
      code: 'expired',
      bitcoinChecks: 0
    }
  )
  const expired = await page.evaluate(() => window.outputKnowledgeBrowser.proposals.accept())
  assert.equal(expired.input.proposals.heads[0].lifetime, 'expired')
  await page.close()
  page = await openPage(browser, baseURL, errors)
  assert.deepEqual(
    await page.evaluate(() => window.outputKnowledgeBrowser.proposals.initialize(false)),
    expired,
    'offline reopen with a rolled-back clock retains accepted expiry'
  )
  const protectedInitial = await page.evaluate(() =>
    window.outputKnowledgeBrowser.protected.initialize(true)
  )
  assert.equal(protectedInitial.saved.revision, '1')
  assert.equal(protectedInitial.saved.value.privateRequest, 'synthetic-recipient-context')
  assert.ok(!protectedInitial.raw.includes('synthetic-recipient-context'))
  assert.ok(!protectedInitial.raw.includes('privateRequest'))
  assert.deepEqual(
    await page.evaluate(() => window.outputKnowledgeBrowser.protected.cas('1', 'signed')),
    { status: 'updated', revision: '2' }
  )
  await page.close()
  await browser.close()
  browser = await puppeteer.launch(launch)
  page = await openPage(browser, baseURL, errors)
  const protectedReopened = await page.evaluate(() =>
    window.outputKnowledgeBrowser.protected.initialize(false)
  )
  assert.equal(protectedReopened.saved.revision, '2')
  assert.equal(protectedReopened.saved.value.phase, 'signed')
  const protectedPeer = await openPage(browser, baseURL, errors)
  await protectedPeer.evaluate(() => window.outputKnowledgeBrowser.protected.initialize(false))
  const protectedWriters = await Promise.all([
    page.evaluate(() => window.outputKnowledgeBrowser.protected.cas('2', 'left')),
    protectedPeer.evaluate(() => window.outputKnowledgeBrowser.protected.cas('2', 'right'))
  ])
  assert.deepEqual(protectedWriters.map(result => result.status).sort(), ['conflict', 'updated'])
  const protectedFinal = await protectedPeer.evaluate(() =>
    window.outputKnowledgeBrowser.protected.inspect()
  )
  assert.equal(protectedFinal.saved.revision, '3')
  assert.equal(
    protectedFinal.saved.value.phase,
    protectedWriters[0].status === 'updated' ? 'left' : 'right'
  )
  assert.ok(!protectedFinal.raw.includes('synthetic-recipient-context'))
  assert.equal(
    await page.evaluate(() => window.outputKnowledgeBrowser.protected.wrongWallet()),
    'context-changed'
  )
  assert.deepEqual(errors, [])
  console.log(
    'ok - exact packed browser imports, strict CSP, native IndexedDB, browser/page restart, receipt-before-cursor, cross-tab CAS, missing-store recovery, lost-core fence, proposal receipt/replay, durable exclusive expiry and protected recipient custody/restart/concurrent CAS'
  )
} finally {
  await browser?.close()
  await server?.close()
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
