'use strict'
// Authored UNRUN. Execute only under a freshly admitted complete-source
// qualification supervisor, which owns process-tree/resource/output limits.
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { access } = require('node:fs/promises')
const { readFileSync } = require('node:fs')
const { createHash } = require('node:crypto')
const { join, resolve } = require('node:path')
const { performance } = require('node:perf_hooks')
const { launchOwnedNativeBrowser } = require('./native-browser-session.cjs')

class Argon2idBrowserCoverageCleanupError extends AggregateError {
  constructor(causes, retryCleanup) {
    super(causes, 'Native browser program retains original cleanup ownership', { cause: causes[0] })
    this.retryCleanup = retryCleanup
  }
}
function bounded(promise, milliseconds, message) {
  let timer
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds)
    })
  ]).finally(() => clearTimeout(timer))
}
async function runArgon2idBrowserCoverage(executablePath, context = {}) {
  assert.equal(typeof executablePath, 'string', 'A reviewed installed native browser path is required')
  assert.ok(executablePath.length > 0 && executablePath.length <= 4096)
  await access(executablePath)
  const { build, stop } = await import('esbuild')
  const wallet = resolve(__dirname, '../..')
  let browser, session, childClosed, server, closingBrowser, closingServer, activeEvaluation, workerSha256
  let failure,
    bundlerStopped = false,
    serverListening = false
  let browserCloseFailed = false,
    serverCloseFailed = false
  assert.equal(typeof context, 'object')
  const selectedContext = { mutantCoverage: { static: {}, perTest: {} } }
  for (const key of ['currentTestId', 'activeMutant']) {
    if (context[key] !== undefined) {
      assert.equal(typeof context[key], 'string')
      assert.ok(context[key].length > 0 && context[key].length <= 32768)
      selectedContext[key] = context[key]
    }
  }
  if (context.hitLimit !== undefined) {
    assert.ok(Number.isSafeInteger(context.hitLimit) && context.hitLimit > 0)
    selectedContext.hitLimit = context.hitLimit
    selectedContext.hitCount = 0
  }
  const sourceInventory = () =>
    [
      'client/test/argon2id-coverage-browser.ts',
      'client/test/argon2id-coverage-worker.ts',
      'src/utility/BrowserArgon2idWorker.ts',
      'src/utility/installBrowserArgon2idWorker.ts',
      'src/utility/BrowserArgon2idWorker.browser.case.ts',
      'src/utility/hashWasm.ts',
      'src/utility/Argon2idBackend.ts',
      'src/storage/portable/Brc39OwnedBrowserKey.ts'
    ].map(source => ({
      source,
      sha256: createHash('sha256')
        .update(readFileSync(join(wallet, source)))
        .digest('hex')
    }))
  const initial = sourceInventory()
  let coverageResult
  const cleanup = async () => {
    const pending = []
    if (browser !== undefined) {
      if (browserCloseFailed) {
        closingBrowser = undefined
        browserCloseFailed = false
      }
      closingBrowser ??= session.close().catch(cause => {
        browserCloseFailed = true
        throw cause
      })
      pending.push(closingBrowser)
      if (childClosed !== undefined) pending.push(childClosed)
    }
    if (activeEvaluation !== undefined) pending.push(activeEvaluation.catch(() => undefined))
    if (server !== undefined && serverListening) {
      if (serverCloseFailed) {
        closingServer = undefined
        serverCloseFailed = false
      }
      closingServer ??= new Promise((resolveClose, rejectClose) =>
        server.close(error => (error ? rejectClose(error) : resolveClose()))
      ).catch(cause => {
        serverCloseFailed = true
        throw cause
      })
      pending.push(closingServer)
    }
    // Do not reissue close on a still-pending original browser/server owner.
    const drained = await bounded(
      Promise.allSettled(pending),
      30000,
      'Native browser program original owners did not settle within cleanup bound'
    )
    const failures = drained.filter(result => result.status === 'rejected').map(result => result.reason)
    if (!bundlerStopped) {
      await stop()
      bundlerStopped = true
    }
    if (failures.length !== 0) throw new AggregateError(failures, 'Native browser API cleanup failed')
  }
  try {
    const bundles = await build({
      entryPoints: {
        program: join(__dirname, 'argon2id-coverage-browser.ts'),
        worker: join(__dirname, 'argon2id-coverage-worker.ts')
      },
      bundle: true,
      write: false,
      outdir: join(wallet, 'client/.argon2id-coverage-unwritten'),
      platform: 'browser',
      format: 'esm',
      target: 'es2022',
      tsconfig: join(__dirname, 'tsconfig.browser.json'),
      splitting: false,
      logLevel: 'silent',
      banner: { js: 'globalThis.__stryker__ = ' + JSON.stringify(selectedContext) + ';' }
    })
    assert.equal(bundles.warnings.length, 0, 'Native coverage bundle warnings require review')
    const program = bundles.outputFiles.find(file => file.path.endsWith('/program.js'))
    const worker = bundles.outputFiles.find(file => file.path.endsWith('/worker.js'))
    assert.ok(program && worker && bundles.outputFiles.length === 2, 'Exact main and dedicated worker bundles required')
    workerSha256 = createHash('sha256').update(worker.contents).digest('hex')
    server = createServer((request, response) => {
      response.setHeader('Cache-Control', 'no-store')
      if (request.url === '/program.js' || request.url === '/coverage-worker.js') {
        response.setHeader('Content-Type', 'text/javascript')
        response.end(request.url === '/program.js' ? program.contents : worker.contents)
      } else if (request.url === '/') {
        response.setHeader('Content-Type', 'text/html')
        response.end(
          '<!doctype html><title>Native worker mutation coverage</title><script type="module" src="/program.js"></script>'
        )
      } else {
        response.statusCode = 404
        response.end()
      }
    })
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', rejectListen)
        serverListening = true
        resolveListen()
      })
    })
    session = await launchOwnedNativeBrowser(executablePath)
    browser = session.browser
    const child = session.child
    assert.ok(
      child && Number.isSafeInteger(child.pid) && child.exitCode === null,
      'A fresh owned browser process, not a borrowed connection, is required'
    )
    childClosed = session.childClosed
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.waitForFunction('typeof globalThis.argon2idCoverageCase === "function"', { timeout: 30000 })
    const began = performance.now(),
      wall = Date.now()
    activeEvaluation = page.evaluate(async () => await globalThis.argon2idCoverageCase())
    void activeEvaluation.catch(() => undefined)
    coverageResult = await bounded(activeEvaluation, 30000, 'Native worker coverage case deadline reached')
    assert.ok(
      performance.now() - began < 30000 && Date.now() - wall < 30000,
      'Late browser worker coverage cannot qualify'
    )
    activeEvaluation = undefined
    assert.equal(coverageResult.nativeWorkerCount, 2)
  } catch (cause) {
    failure = cause
  }
  try {
    await cleanup()
  } catch (cause) {
    throw new Argon2idBrowserCoverageCleanupError(failure === undefined ? [cause] : [failure, cause], cleanup)
  }
  if (failure !== undefined) throw failure
  // The original primary browser child has emitted close. Its helper tree and
  // the esbuild service still require the outer supervisor's independent group
  // absence proof; this result deliberately supplies no kernel/resource verdict.
  assert.deepEqual(sourceInventory(), initial, 'Browser case source changed during qualification')
  const browserChildClose = await childClosed
  assert.equal(browserChildClose.code, 0, 'A native browser fault cannot qualify successful case results')
  assert.equal(browserChildClose.signal, null, 'A signalled browser exit requires independent failure/drain review')
  return { ...coverageResult, browserChildClose, workerSha256, sourceInventory: initial, processTreeQualified: false }
}
module.exports = { runArgon2idBrowserCoverage, Argon2idBrowserCoverageCleanupError }
