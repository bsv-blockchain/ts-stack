import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { spawn, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'
import { createMongoReplicaFixture } from '../../../packages/overlays/overlay/src/__tests/mongo/MongoReplicaFixture.ts'

const directory = fileURLToPath(new URL('../', import.meta.url)),
  temporary = await mkdtemp(path.join(tmpdir(), 'private-proposal-browser-')),
  certificate = path.join(temporary, 'loopback-cert.pem'),
  key = path.join(temporary, 'loopback-key.pem'),
  database = 'output_reference_' + randomUUID().replaceAll('-', ''),
  workspace = randomUUID(),
  origin = 'https://127.0.0.1:4176',
  receipt = { opens: 0, errors: [], requests: 0 }
let replica,
  server,
  browser,
  interrupted = false
const stop = async child => {
  if (child?.exitCode !== null || child.signalCode !== null) return
  await new Promise(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    child.kill('SIGTERM')
  })
}
const interrupt = () => {
  interrupted = true
  void browser?.close()
  void stop(server)
}
process.once('SIGINT', interrupt)
process.once('SIGTERM', interrupt)
async function executable() {
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
  throw new Error('Native Chrome/Chromium is required')
}
async function start(create) {
  if (interrupted) throw new Error('Proposal browser check interrupted')
  server = spawn(process.execPath, ['dist-proposals/proposalNodeServer.js'], {
    cwd: directory,
    env: {
      ...process.env,
      REFERENCE_CREATE: create ? '1' : '0',
      REFERENCE_DATA: path.join(temporary, 'data'),
      REFERENCE_ADMISSION_URI: replica.uri.replace(/,127\.0\.0\.1:\d+/g, ''),
      REFERENCE_ADMISSION_DATABASE: database,
      REFERENCE_TLS_CERT: certificate,
      REFERENCE_TLS_KEY: key,
      NODE_EXTRA_CA_CERTS: certificate
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Proposal server startup deadline')), 15000)
    let output = ''
    server.stderr.on('data', bytes => {
      output = (output + bytes).slice(-8192)
    })
    server.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    server.once('exit', code => {
      clearTimeout(timer)
      reject(new Error('Proposal server exit ' + code + ': ' + output))
    })
    server.stdout.on('data', bytes => {
      if (String(bytes).includes('Synthetic private proposal workbench:')) {
        clearTimeout(timer)
        resolve()
      }
    })
  })
}
async function page(account, fresh) {
  const current = await browser.newPage()
  current.on('pageerror', error => receipt.errors.push(error.message))
  current.on('request', request => {
    if (request.url().endsWith('/lookup/open')) receipt.opens++
    if (request.url().includes('/overlay/')) receipt.requests++
  })
  await current.setViewport({ width: 1360, height: 1000 })
  await current.goto(origin + '/proposal.html', { waitUntil: 'networkidle0' })
  await current.select('#account', account)
  await current.$eval(
    '#workspace',
    (element, value) => {
      element.value = value
    },
    workspace
  )
  await current.bringToFront()
  await current.click(fresh ? '#start' : '#resume')
  try {
    await current.waitForFunction(() => document.querySelector('#offline').disabled === false, {
      timeout: 15000
    })
  } catch (error) {
    console.error(
      JSON.stringify({
        account,
        fresh,
        status: await current.$eval('#status', element => element.textContent),
        pageErrors: receipt.errors
      })
    )
    throw error
  }
  return current
}
async function publish(page, text) {
  await page.bringToFront()
  await page.$eval(
    '#text',
    (element, value) => {
      element.value = value
    },
    text
  )
  await page.click('#publish')
  await page.waitForFunction(
    () => document.querySelector('#status').textContent.includes('proposal is recorded'),
    { timeout: 15000 }
  )
  await page.waitForFunction(
    value =>
      [...document.querySelectorAll('[data-proposal]')].some(
        card => card.textContent.includes(value) && card.dataset.active === 'true'
      ),
    { timeout: 10000 },
    text
  )
}
try {
  execFileSync(
    '/usr/bin/openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      certificate,
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1'
    ],
    { stdio: 'ignore' }
  )
  replica = await createMongoReplicaFixture()
  await start(true)
  // Only this owned synthetic browser context trusts its ephemeral loopback certificate.
  browser = await puppeteer.launch({
    executablePath: await executable(),
    headless: true,
    acceptInsecureCerts: true,
    userDataDir: path.join(temporary, 'chrome'),
    args: ['--no-sandbox']
  })
  const alice = await page('alice', true)
  let bob = await page('bob', true)
  assert.equal(receipt.opens, 2)
  await publish(alice, 'First private working state')
  await bob.bringToFront()
  await bob.waitForFunction(() => document.querySelector('[data-active="true"]') !== null, {
    timeout: 10000
  })
  await bob.click('#offline')
  await bob.waitForFunction(() => document.querySelector('#offline').disabled === true)
  await publish(alice, 'Missed while offline')
  await bob.bringToFront()
  await bob.click('#reconnect')
  await bob.waitForFunction(
    () =>
      [...document.querySelectorAll('[data-proposal]')].some(
        card => card.textContent.includes('Missed while offline') && card.dataset.active === 'true'
      ),
    { timeout: 10000 }
  )
  assert.equal(receipt.opens, 2, 'Reconnect must not create another Open')
  const databases = await bob.evaluate(async () =>
    (await indexedDB.databases()).map(row => row.name)
  )
  assert.ok(databases.includes('reference-working-documents-' + workspace + '-alice'))
  assert.ok(databases.includes('reference-working-documents-' + workspace + '-bob'))
  // Hide Bob beyond both intent cutoffs. His first foreground render must retire
  // old activity, and the retained feed must deliver the durable host expiry.
  await alice.bringToFront()
  await alice.waitForFunction(() => document.querySelector('[data-active="true"]') === null, {
    timeout: 25000
  })
  await bob.bringToFront()
  await bob.waitForFunction(() => document.querySelector('[data-active="true"]') === null)
  await bob.waitForFunction(
    () => document.querySelectorAll('[data-status="expired"]').length === 2,
    { timeout: 15000 }
  )
  await bob.close()
  bob = await page('bob', false)
  await bob.waitForFunction(() => document.querySelectorAll('[data-status="expired"]').length === 2)
  assert.equal(receipt.opens, 2, 'Page-close recovery must retain original custody')
  await alice.close()
  await bob.close()
  await stop(server)
  await start(false)
  bob = await page('bob', false)
  await bob.waitForFunction(
    () => document.querySelectorAll('[data-status="expired"]').length === 2,
    { timeout: 15000 }
  )
  assert.equal(receipt.opens, 2, 'Provider restart must resume original sessions')
  assert.deepEqual(receipt.errors, [])
  const screenshots = path.join(directory, '../../artifacts/reference-workbench-proposals')
  await mkdir(screenshots, { recursive: true })
  await bob.screenshot({
    path: path.join(screenshots, 'private-proposals-recovered.png'),
    fullPage: true
  })
  console.log(
    JSON.stringify({
      ...receipt,
      nativeIndexedDB: true,
      ownedHTTPS: true,
      producerRestart: true,
      proposalExpiry: true,
      screenshot: 'artifacts/reference-workbench-proposals/private-proposals-recovered.png'
    })
  )
} finally {
  process.removeListener('SIGINT', interrupt)
  process.removeListener('SIGTERM', interrupt)
  try {
    await browser?.close()
  } finally {
    try {
      await stop(server)
    } finally {
      await replica?.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
}
