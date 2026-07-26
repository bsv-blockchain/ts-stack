import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { createServer } from 'vite'
import puppeteer from 'puppeteer-core'

const packageDir = new URL('../', import.meta.url)
const chromeCandidates = [
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
assert.ok(executablePath, 'Chrome or Chromium was not found in a supported default location')

const server = await createServer({
  root: packageDir.pathname,
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
  const url = new URL('browser/index.html', server.resolvedUrls.local[0]).href
  browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox']
  })
  const page = await browser.newPage()
  const browserErrors = []
  page.on('pageerror', error => browserErrors.push(error.stack ?? error.message))
  await page.goto(url, { waitUntil: 'networkidle0' })
  await page.waitForFunction(
    () => window.__VERIFAST_RESULT__ !== undefined || window.__VERIFAST_ERROR__ !== undefined,
    {
      timeout: 60_000
    }
  )
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
  assert.equal(state.result.workerBatch.count, 250)
  assert.equal(state.result.workerBatch.allValid, true)
  assert.equal(state.result.benchmark.cases.length, 3)
  for (const benchmark of state.result.benchmark.cases) {
    assert.ok(Number.isFinite(benchmark.speedup))
    assert.ok(benchmark.jsInputsPerSecond > 0)
    assert.ok(benchmark.bdkInputsPerSecond > 0)
  }

  const umdPage = await browser.newPage()
  const umdErrors = []
  umdPage.on('pageerror', error => umdErrors.push(error.stack ?? error.message))
  await umdPage.goto(new URL('umd.html', url).href, { waitUntil: 'networkidle0' })
  await umdPage.waitForFunction(
    () =>
      window.__VERIFAST_UMD_RESULT__ !== undefined || window.__VERIFAST_UMD_ERROR__ !== undefined,
    { timeout: 60_000 }
  )
  const umdState = await umdPage.evaluate(() => ({
    result: window.__VERIFAST_UMD_RESULT__,
    error: window.__VERIFAST_UMD_ERROR__
  }))
  assert.equal(umdState.error, undefined, umdState.error)
  assert.equal(umdState.result, true)
  assert.deepEqual(umdErrors, [])
  console.log('ok - browser UMD loader and package wrapper')
  console.log(JSON.stringify(state.result, null, 2))
} finally {
  await browser?.close()
  await server.close()
}
