import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import puppeteer from 'puppeteer-core'

import { createCommandRunner } from '../../../scripts/lib/command-runner.mjs'

const packageDirectory = fileURLToPath(new URL('../', import.meta.url))
const run = createCommandRunner({ timeoutMs: 240_000, maxBufferBytes: 4 * 1024 * 1024 })
const legacyKey = 'bsvsdk_overlay_host_reputation_v3'
const currentKey = 'bsvsdk_overlay_host_reputation_v4'
const services = ['ls_identity', 'ls_ship', 'ls_custom', 'ls_kvstore']
const host = 'https://recovered.example'
const temporary = await mkdtemp(path.join(tmpdir(), 'sdk-lookup-browser-'))

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
  throw new Error('Chrome or Chromium is required for lookup recovery tests')
}

async function preparePage(page, origin) {
  await page.goto(origin)
  await page.waitForFunction(() => globalThis.bsv?.LookupResolver !== undefined)
  assert.equal(await page.evaluate(() => typeof navigator.locks?.request), 'function')
  await page.evaluate(
    ({ services, host }) => {
      const output = {
        beef: new bsv.Transaction(
          1,
          [],
          [{ lockingScript: bsv.LockingScript.fromHex('51'), satoshis: 1 }],
          0
        ).toBEEF(),
        outputIndex: 0
      }
      globalThis.lookupFixture = {
        up: false,
        calls: 0,
        resolver: new bsv.LookupResolver({
          facilitator: {
            async lookup(url) {
              if (url !== host) return { type: 'output-list', outputs: [] }
              globalThis.lookupFixture.calls++
              if (!globalThis.lookupFixture.up) throw new Error('synthetic transport failure')
              await new Promise(resolve => setTimeout(resolve, 25))
              return { type: 'output-list', outputs: [output] }
            }
          },
          hostOverrides: Object.fromEntries(
            services.map(service => [service, ['https://empty.example', host]])
          )
        })
      }
    },
    { services, host }
  )
}

async function query(page, service, up) {
  return await page.evaluate(
    async ({ service, up }) => {
      const fixture = globalThis.lookupFixture
      fixture.up = up
      const before = fixture.calls
      try {
        const answer = await fixture.resolver.query({ service, query: {} })
        return { outputs: answer.outputs.length, probes: fixture.calls - before }
      } catch (error) {
        if (!(error instanceof bsv.LookupUnavailableError)) throw error
        return { unavailable: error.retryable, probes: fixture.calls - before }
      }
    },
    { service, up }
  )
}

let browser
let server
try {
  // Exercise the published UMD payload, extracted from a real package tarball.
  const { stdout } = await run('pnpm', ['pack', '--json', '--pack-destination', temporary], {
    cwd: packageDirectory,
    env: { ...process.env, npm_config_ignore_scripts: 'true' }
  })
  await run('tar', ['-xzf', JSON.parse(stdout).filename, '-C', temporary])
  const bundle = await readFile(path.join(temporary, 'package/dist/umd/bundle.js'))
  server = createServer((request, response) => {
    if (request.url === '/bundle.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript' })
      response.end(bundle)
    } else {
      response.writeHead(200, { 'Content-Type': 'text/html' })
      response.end(
        '<!doctype html><title>Lookup recovery fixture</title><script src="/bundle.js"></script>'
      )
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  browser = await puppeteer.launch({
    executablePath: await chromePath(),
    headless: true,
    args: ['--no-sandbox']
  })
  const pages = await Promise.all([browser.newPage(), browser.newPage()])
  await Promise.all(pages.map(page => preparePage(page, origin)))
  const poison = JSON.stringify({
    [host]: {
      backoffUntil: Date.now() + 365 * 86400000,
      failCount: 100,
      lastUpdated: Date.now() + 86400000
    }
  })
  await pages[0].evaluate(({ legacyKey, poison }) => localStorage.setItem(legacyKey, poison), {
    legacyKey,
    poison
  })

  for (let cycle = 0; cycle < 5; cycle++) {
    // Independent tabs write different services concurrently: neither may lose the other's update.
    for (let offset = 0; offset < services.length; offset += 2) {
      const pair = services.slice(offset, offset + 2)
      const failed = await Promise.all(
        pair.map((service, index) => query(pages[index], service, false))
      )
      assert.deepEqual(
        failed,
        pair.map(() => ({ unavailable: true, probes: 1 }))
      )
      await pages[0].evaluate(key => navigator.locks.request(key, () => {}), currentKey)
      const entries = await pages[0].evaluate(
        key => JSON.parse(localStorage.getItem(key)).entries,
        currentKey
      )
      for (const service of pair)
        assert.ok(entries[JSON.stringify(['mainnet', service, host])].penalty > 0)
      // Reload while the penalty is still active; success must be possible without clearing state.
      await Promise.all(pages.map(page => preparePage(page, origin)))
      const recovered = await Promise.all(
        pair.map((service, index) => query(pages[index], service, true))
      )
      assert.deepEqual(
        recovered,
        pair.map(() => ({ outputs: 1, probes: 1 }))
      )
      await pages[0].evaluate(key => navigator.locks.request(key, () => {}), currentKey)
      const healed = await pages[0].evaluate(
        key => JSON.parse(localStorage.getItem(key)).entries,
        currentKey
      )
      for (const service of pair)
        assert.equal(healed[JSON.stringify(['mainnet', service, host])].penalty, 0)
      assert.equal(await pages[0].evaluate(key => localStorage.getItem(key), legacyKey), poison)
    }
  }
  console.log(
    'Browser lookup recovery passed: 4 services, 5 outage/recovery cycles, 2 concurrent tabs, active v4 cooldowns, legacy poison preserved, 20 reloads, exact packed UMD.'
  )
} finally {
  await browser?.close()
  if (server) await new Promise(resolve => server.close(resolve))
  await rm(temporary, { recursive: true, force: true })
}
