import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { createServer } from 'vite'
import puppeteer from 'puppeteer-core'

const packageDir = new URL('../', import.meta.url)
const browserDir = new URL('./', import.meta.url)
const chromeCandidates = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
].filter(Boolean)

let executablePath
for (const candidate of chromeCandidates) {
  try {
    await access(candidate)
    executablePath = candidate
    break
  } catch {}
}
assert.ok(executablePath, 'Chrome or Chromium was not found; set CHROME_BIN')

const server = await createServer({
  root: browserDir.pathname,
  logLevel: 'error',
  server: {
    host: '127.0.0.1',
    port: 0,
    fs: { allow: [packageDir.pathname] }
  }
})

let browser
try {
  await server.listen()
  const url = server.resolvedUrls.local[0]
  browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox']
  })
  const page = await browser.newPage()
  const browserErrors = []
  page.on('pageerror', (error) => browserErrors.push(error.stack ?? error.message))
  await page.goto(url, { waitUntil: 'networkidle0' })
  await page.waitForFunction(() => window.__VERIFAST_RESULT__ !== undefined || window.__VERIFAST_ERROR__ !== undefined, {
    timeout: 60_000
  })
  const state = await page.evaluate(() => ({
    result: window.__VERIFAST_RESULT__,
    error: window.__VERIFAST_ERROR__
  }))
  assert.equal(state.error, undefined, state.error)
  assert.deepEqual(browserErrors, [])
  for (const vector of state.result.vectors) {
    assert.equal(vector.js, vector.expected, `${vector.name} JS`)
    assert.equal(vector.bdk, vector.expected, `${vector.name} BDK`)
  }
  assert.equal(state.result.benchmark.cases.length, 3)
  for (const benchmark of state.result.benchmark.cases) {
    assert.ok(Number.isFinite(benchmark.speedup))
    assert.ok(benchmark.jsInputsPerSecond > 0)
    assert.ok(benchmark.bdkInputsPerSecond > 0)
  }
  console.log(JSON.stringify(state.result, null, 2))
} finally {
  await browser?.close()
  await server.close()
}
