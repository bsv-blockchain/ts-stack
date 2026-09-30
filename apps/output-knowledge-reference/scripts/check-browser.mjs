import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import puppeteer from 'puppeteer-core'

const directory = fileURLToPath(new URL('../', import.meta.url))
const temporary = await mkdtemp(path.join(tmpdir(), 'output-reference-browser-'))
const servers = []
let browser
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
  throw new Error('Chrome or Chromium is required; this check cannot substitute fake IndexedDB')
}
async function start(role) {
  const child = spawn(process.execPath, ['dist-server/nodeServer.js'], {
    cwd: directory,
    env: { ...process.env, REFERENCE_HOST: role, REFERENCE_CREATE: '1', REFERENCE_DATA: temporary },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  servers.push(child)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Reference server startup deadline')), 15000)
    let output = ''
    child.stderr.on('data', chunk => {
      output = (output + chunk).slice(-4096)
    })
    child.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', code => {
      clearTimeout(timer)
      reject(new Error('Reference server exit ' + code + ': ' + output))
    })
    child.stdout.on('data', chunk => {
      if (String(chunk).includes('Synthetic output-knowledge workbench:')) {
        clearTimeout(timer)
        resolve()
      }
    })
  })
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    child.kill('SIGTERM')
  })
}
const errors = []
async function page(account, resume = false, origin = 'http://127.0.0.1:4174', federate = true) {
  console.log('Browser opening', account, resume, origin)
  const tab = await browser.newPage()
  tab.on('pageerror', error => errors.push(error.message))
  await tab.goto(origin, { waitUntil: 'networkidle0' })
  console.log('Browser loaded', account)
  await tab.select('#account', account)
  if (federate) await tab.click('#federate')
  console.log('Browser starting', account)
  await tab.click(resume ? '#resume' : '#start')
  await tab.waitForFunction(
    () => document.querySelector('#status')?.textContent.includes('Connected as'),
    { timeout: 30000 }
  )
  console.log('Browser connected', account)
  return tab
}
async function click(tab, selector) {
  await tab.bringToFront()
  await tab.click(selector)
}
async function record(tab, name, attribute, value) {
  console.log('Browser awaiting', name, attribute, value)
  await tab
    .waitForFunction(
      (name, attribute, value) =>
        document
          .querySelector('[data-record="' + name + '"]')
          ?.getAttribute('data-' + attribute) === value,
      { timeout: 15000, polling: 'mutation' },
      name,
      attribute,
      value
    )
    .catch(async error => {
      console.log(
        'Browser diagnostic',
        await tab.$eval('#status', element => element.textContent),
        await tab.$eval('#activity', element => element.textContent),
        await tab.$eval('#records', element => element.innerText)
      )
      throw error
    })
}

try {
  await start('one')
  await start('two')
  browser = await puppeteer.launch({
    executablePath: await executable(),
    headless: true,
    userDataDir: path.join(temporary, 'profile'),
    args: ['--no-sandbox'],
    protocolTimeout: 30000
  })
  const alice = await page('alice')
  let bob = await page('bob')
  console.log('Browser publishing')
  await click(alice, '[data-command="publish"]')
  await record(alice, 'A', 'verified', 'true')
  await record(bob, 'Q', 'verified', 'true')
  await click(bob, '#offline')
  await bob.waitForFunction(() =>
    document.querySelector('#status')?.textContent.startsWith('Offline.')
  )
  await click(alice, '[data-command="replace"]')
  await record(alice, 'A', 'spent', 'true')
  await click(alice, '[data-command="withdraw"]')
  await record(alice, 'Q', 'memberships', '0')
  assert.equal(await bob.$eval('[data-record="A"]', element => element.dataset.spent), 'false')
  // Close without application shutdown hooks. Only committed native IndexedDB survives.
  await bob.close()
  bob = await page('bob', true)
  await record(bob, 'A', 'spent', 'true')
  await record(bob, 'Q', 'memberships', '0')
  assert.equal(await bob.$eval('[data-record="Q"]', element => element.dataset.spent), 'false')
  await click(alice, '[data-command="reintroduce"]')
  await record(bob, 'A', 'memberships', '1')
  await record(bob, 'A', 'spent', 'true')
  const producerTwo = await page('alice', false, 'http://127.0.0.1:4175', false)
  await click(producerTwo, '[data-command="publish"]')
  await record(bob, 'A', 'memberships', '2')
  await record(bob, 'Q', 'memberships', '1')
  await record(bob, 'A', 'spent', 'true')
  await record(alice, 'A', 'memberships', '2')
  await record(alice, 'Q', 'memberships', '1')
  await alice.setViewport({ width: 1440, height: 1180 })
  const artifacts = path.resolve(directory, '../../artifacts/reference-workbench')
  await mkdir(artifacts, { recursive: true })
  await alice.screenshot({ path: path.join(artifacts, 'workbench.png'), fullPage: true })
  await alice.setViewport({ width: 390, height: 844 })
  assert.equal(await alice.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await alice.screenshot({ path: path.join(artifacts, 'workbench-narrow.png'), fullPage: true })
  assert.deepEqual(errors, [])
  console.log(
    'Native browser: two authenticated hosts, two clients, live Script/SPV updates, offline replay, reload, independent source membership and persistent spent state passed.'
  )
} finally {
  if (browser) await browser.close()
  await Promise.all(servers.map(child => stop(child)))
  await rm(temporary, { recursive: true, force: true })
}
