import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import puppeteer from 'puppeteer-core'
import { createServer } from 'vite'

import { createCommandRunner } from '../../../scripts/lib/command-runner.mjs'

const COMMAND_TIMEOUT_MS = 240_000
const CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; " +
  "connect-src 'self'; style-src 'none'; img-src 'none'; object-src 'none'; base-uri 'none'"
const packageDirectory = fileURLToPath(new URL('../', import.meta.url))
const repositoryRoot = path.resolve(packageDirectory, '../..')
const run = createCommandRunner({
  timeoutMs: COMMAND_TIMEOUT_MS,
  maxBufferBytes: 30 * 1024 * 1024,
  maxErrorOutputCharacters: 16_000
})
const chromeCandidates = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
]

async function removeTemporaryDirectory(directory) {
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100
  })
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

async function createExactPackageConsumer() {
  const packDirectory = await mkdtemp(path.join(tmpdir(), 'verifast-browser-pack-'))
  const consumerDirectory = await mkdtemp(path.join(tmpdir(), 'verifast-browser-consumer-'))
  try {
    const tarballs = await Promise.all([
      pack(packageDirectory, packDirectory),
      pack(path.join(repositoryRoot, 'packages/sdk'), packDirectory)
    ])
    await writeFile(
      path.join(consumerDirectory, 'package.json'),
      `${JSON.stringify({ private: true, type: 'module' }, null, 2)}\n`
    )
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
      { cwd: consumerDirectory }
    )
    await Promise.all([
      mkdir(path.join(consumerDirectory, 'browser')),
      mkdir(path.join(consumerDirectory, 'bench'))
    ])
    await Promise.all(
      ['fallback.html', 'fallback.ts', 'index.html', 'main.ts', 'umd.html', 'umd-main.js'].map(
        file =>
          cp(
            path.join(packageDirectory, 'browser', file),
            path.join(consumerDirectory, 'browser', file)
          )
      )
    )
    await cp(
      path.join(packageDirectory, 'bench/corpus.ts'),
      path.join(consumerDirectory, 'bench/corpus.ts')
    )
    return { consumerDirectory, packDirectory }
  } catch (error) {
    await Promise.all([
      removeTemporaryDirectory(packDirectory),
      removeTemporaryDirectory(consumerDirectory)
    ])
    throw error
  }
}

async function executablePath() {
  const { access } = await import('node:fs/promises')
  for (const candidate of chromeCandidates) {
    try {
      await access(candidate)
      return candidate
    } catch {}
  }
  throw new Error('Chrome or Chromium was not found in a supported default location')
}

function collectPageErrors(page) {
  const errors = []
  page.on('pageerror', error => errors.push(error.stack ?? error.message))
  page.on('requestfailed', request => {
    errors.push(`${request.url()}: ${request.failure()?.errorText ?? 'request failed'}`)
  })
  return errors
}

async function forceStreamingFallback(page) {
  const session = await page.createCDPSession()
  let interceptions = 0
  const failures = []
  await session.send('Fetch.enable', {
    patterns: [{ urlPattern: '*.wasm*', requestStage: 'Response' }]
  })
  session.on('Fetch.requestPaused', event => {
    void (async () => {
      try {
        if (event.responseStatusCode === undefined) {
          await session.send('Fetch.continueRequest', { requestId: event.requestId })
          return
        }
        const response = await session.send('Fetch.getResponseBody', {
          requestId: event.requestId
        })
        const responseHeaders = (event.responseHeaders ?? []).filter(
          header => header.name.toLowerCase() !== 'content-type'
        )
        responseHeaders.push({ name: 'Content-Type', value: 'application/octet-stream' })
        await session.send('Fetch.fulfillRequest', {
          requestId: event.requestId,
          responseCode: event.responseStatusCode,
          responsePhrase: event.responseStatusText,
          responseHeaders,
          body: response.base64Encoded
            ? response.body
            : Buffer.from(response.body).toString('base64')
        })
        interceptions += 1
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error))
      }
    })()
  })
  return {
    close: async () => await session.send('Fetch.disable'),
    failures,
    interceptions: () => interceptions
  }
}

const temporary = await createExactPackageConsumer()
const realConsumerDirectory = await realpath(temporary.consumerDirectory)
const server = await createServer({
  root: temporary.consumerDirectory,
  logLevel: 'error',
  optimizeDeps: {
    exclude: ['@bsv/sdk', '@bsv/verifast']
  },
  server: {
    headers: { 'Content-Security-Policy': CSP },
    host: '127.0.0.1',
    port: 0,
    fs: { allow: [temporary.consumerDirectory, realConsumerDirectory] }
  }
})

let browser
try {
  await server.listen()
  const baseUrl = server.resolvedUrls.local[0]
  browser = await puppeteer.launch({
    executablePath: await executablePath(),
    headless: true,
    args: ['--no-sandbox']
  })

  const page = await browser.newPage()
  const browserErrors = collectPageErrors(page)
  const wasmContentTypes = []
  page.on('response', response => {
    if (new URL(response.url()).pathname.endsWith('.wasm')) {
      wasmContentTypes.push(response.headers()['content-type'])
    }
  })
  const response = await page.goto(new URL('browser/index.html', baseUrl).href, {
    waitUntil: 'networkidle0'
  })
  assert.equal(response.headers()['content-security-policy'], CSP)
  await page.waitForFunction(
    () => window.__VERIFAST_RESULT__ !== undefined || window.__VERIFAST_ERROR__ !== undefined,
    { timeout: 60_000 }
  )
  const state = await page.evaluate(() => ({
    result: window.__VERIFAST_RESULT__,
    error: window.__VERIFAST_ERROR__
  }))
  assert.equal(state.error, undefined, state.error)
  assert.deepEqual(browserErrors, [])
  assert.ok(wasmContentTypes.includes('application/wasm'), 'normal WASM uses streaming MIME')
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

  const fallbackPage = await browser.newPage()
  const fallbackErrors = collectPageErrors(fallbackPage)
  const fallbackLogs = []
  fallbackPage.on('console', message => fallbackLogs.push(message.text()))
  const fallback = await forceStreamingFallback(fallbackPage)
  await fallbackPage.goto(new URL('browser/fallback.html', baseUrl).href, {
    waitUntil: 'networkidle0'
  })
  await fallbackPage.waitForFunction(
    () =>
      window.__VERIFAST_FALLBACK_RESULT__ !== undefined ||
      window.__VERIFAST_FALLBACK_ERROR__ !== undefined,
    { timeout: 60_000 }
  )
  const fallbackState = await fallbackPage.evaluate(() => ({
    result: window.__VERIFAST_FALLBACK_RESULT__,
    error: window.__VERIFAST_FALLBACK_ERROR__
  }))
  await fallback.close()
  assert.equal(fallbackState.error, undefined, fallbackState.error)
  assert.equal(fallbackState.result, true)
  assert.deepEqual(fallbackErrors, [])
  assert.deepEqual(fallback.failures, [])
  assert.ok(fallback.interceptions() > 0, 'WASM response MIME was intercepted')
  assert.ok(
    fallbackLogs.some(message => message.includes('falling back to ArrayBuffer instantiation')),
    'Emscripten reported its ArrayBuffer fallback'
  )

  const umdPage = await browser.newPage()
  const umdErrors = collectPageErrors(umdPage)
  await umdPage.goto(new URL('browser/umd.html', baseUrl).href, { waitUntil: 'networkidle0' })
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
  console.log('ok - exact packed browser ESM, WASM, workers, strict CSP, fallback, and UMD')
  console.log(JSON.stringify(state.result, null, 2))
} finally {
  await browser?.close()
  await server.close()
  await Promise.all([
    removeTemporaryDirectory(temporary.packDirectory),
    removeTemporaryDirectory(temporary.consumerDirectory)
  ])
}
