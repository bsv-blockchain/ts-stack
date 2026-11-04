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

class SnapshotBrowserMeasurementCleanupError extends AggregateError {
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
async function runSnapshotBrowserMeasurement(executablePath) {
  assert.equal(typeof executablePath, 'string', 'A reviewed installed native browser path is required')
  assert.ok(executablePath.length > 0 && executablePath.length <= 4096)
  await access(executablePath)
  const { build, stop } = await import('esbuild')
  const { default: puppeteer } = await import('puppeteer-core')
  const wallet = resolve(__dirname, '../..')
  let browser, childClosed, server, closingBrowser, closingServer, activeEvaluation, workerSha256
  let failure,
    bundlerStopped = false,
    caseTimedOut = false,
    serverListening = false
  let browserCloseFailed = false,
    serverCloseFailed = false
  const reports = []
  const sourceInventory = () => {
    const sources = [
      'benchmarks/snapshot-program-browser.ts',
      'benchmarks/snapshot-measurement-cases.ts',
      'test/utils/browserSnapshotRestoreFixture.ts',
      'client/test/snapshot-measurement-browser.ts'
    ]
    return sources.map(source => ({
      source,
      sha256: createHash('sha256')
        .update(readFileSync(join(wallet, source)))
        .digest('hex')
    }))
  }
  const initial = sourceInventory()
  const cleanup = async () => {
    const pending = []
    if (browser !== undefined) {
      if (browserCloseFailed) {
        closingBrowser = undefined
        browserCloseFailed = false
      }
      closingBrowser ??= browser.close().catch(cause => {
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
        program: join(__dirname, 'snapshot-measurement-browser.ts')
      },
      bundle: true,
      write: false,
      outdir: join(wallet, 'client/.snapshot-measurement-unwritten'),
      platform: 'browser',
      format: 'esm',
      target: 'es2022',
      splitting: false
    })
    const program = bundles.outputFiles.find(file => file.path.endsWith('/program.js'))
    assert.ok(program && bundles.outputFiles.length === 1, 'The exact browser catalogue bundle is required')
    const workerPath = join(wallet, 'client/out/argon2id-worker.mjs')
    const worker = readFileSync(workerPath)
    assert.ok(worker.length > 0, 'Build the fixed client worker asset before qualification')
    workerSha256 = createHash('sha256').update(worker).digest('hex')
    server = createServer((request, response) => {
      response.setHeader('Cache-Control', 'no-store')
      if (request.url === '/program.js' || request.url === '/argon-worker.js') {
        response.setHeader('Content-Type', 'text/javascript')
        response.end(request.url === '/program.js' ? program.contents : worker)
      } else if (request.url === '/') {
        response.setHeader('Content-Type', 'text/html')
        response.end(
          '<!doctype html><title>Native snapshot program measurement</title><script type="module" src="/program.js"></script>'
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
    browser = await puppeteer.launch({ executablePath, headless: true })
    const child = browser.process()
    assert.ok(
      child && Number.isSafeInteger(child.pid) && child.exitCode === null,
      'A fresh owned browser process, not a borrowed connection, is required'
    )
    childClosed = new Promise(resolveClose => child.once('close', (code, signal) => resolveClose({ code, signal })))
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.waitForFunction('typeof globalThis.snapshotBrowserMeasurement?.run === "function"', { timeout: 30000 })
    const cdp = await page.createCDPSession()
    await cdp.send('Performance.enable')
    const starts = new Map(),
      metrics = []
    await page.exposeFunction('snapshotMeasurementPhase', async (phase, boundary) => {
      assert.ok(typeof phase === 'string' && phase.length <= 128)
      assert.ok(boundary === 'start' || boundary === 'end')
      const { metrics: values } = await cdp.send('Performance.getMetrics')
      const value = Object.fromEntries(values.map(item => [item.name, item.value]))
      assert.ok(Number.isFinite(value.TaskDuration) && Number.isFinite(value.JSHeapUsedSize))
      if (boundary === 'start') {
        assert.equal(starts.has(phase), false)
        starts.set(phase, value)
      } else {
        const before = starts.get(phase)
        assert.ok(before)
        starts.delete(phase)
        assert.ok(metrics.length < 32)
        metrics.push({
          phase,
          browserTaskCpuMs: 1000 * (value.TaskDuration - before.TaskDuration),
          jsHeapBefore: before.JSHeapUsedSize,
          jsHeapAfter: value.JSHeapUsedSize,
          // CDP does not supply a process-tree RSS high-water mark. The outer
          // resource supervisor independently observes all admitted processes.
          processTreeRssQualified: false
        })
      }
    })
    const shapes = await page.evaluate(() => globalThis.snapshotBrowserMeasurement.shapes)
    assert.deepEqual(
      shapes.map(shape => shape.name),
      ['small', 'large', 'large-record']
    )
    for (const shape of shapes)
      for (const readDelayMs of [0, 15]) {
        assert.equal(caseTimedOut, false)
        metrics.length = 0
        const began = performance.now(),
          wall = Date.now()
        activeEvaluation = page.evaluate(
          async ({ name, delay }) => await globalThis.snapshotBrowserMeasurement.run(name, delay),
          { name: shape.name, delay: readDelayMs }
        )
        void activeEvaluation.catch(() => undefined)
        let actual
        try {
          actual = await bounded(activeEvaluation, 300000, 'Native browser measurement deadline reached')
          assert.ok(
            performance.now() - began < 300000 && Date.now() - wall < 300000,
            'Late browser measurements cannot qualify'
          )
        } catch (cause) {
          caseTimedOut = true
          throw cause
        }
        activeEvaluation = undefined
        assert.equal(starts.size, 0)
        assert.deepEqual(
          actual.map(row => row.phase),
          [
            'encrypted-import',
            'cold',
            'unchanged',
            'incremental',
            'cancel-after-commit',
            'resume-after-cancel',
            'lost-commit-acknowledgement',
            'recover-lost-acknowledgement',
            'encrypted-export'
          ]
        )
        assert.deepEqual(
          metrics.map(row => row.phase),
          actual.map(row => row.phase)
        )
        reports.push({
          fixture: shape.name,
          readDelayMs,
          measurements: actual.map((row, index) => ({ ...row, ...metrics[index] }))
        })
      }
    await cdp.detach()
  } catch (cause) {
    failure = cause
  }
  try {
    await cleanup()
  } catch (cause) {
    throw new SnapshotBrowserMeasurementCleanupError(failure === undefined ? [cause] : [failure, cause], cleanup)
  }
  if (failure !== undefined) throw failure
  assert.equal(reports.length, 6)
  // The original primary browser child has emitted close. Its helper tree and
  // the esbuild service still require the outer supervisor's independent group
  // absence proof; this result deliberately supplies no kernel/resource verdict.
  assert.deepEqual(sourceInventory(), initial, 'Browser measurement source changed during qualification')
  assert.equal(
    createHash('sha256')
      .update(readFileSync(join(wallet, 'client/out/argon2id-worker.mjs')))
      .digest('hex'),
    workerSha256,
    'The delivered worker asset changed during qualification'
  )
  const browserChildClose = await childClosed
  assert.equal(browserChildClose.code, 0, 'A native browser fault cannot qualify successful case results')
  assert.equal(browserChildClose.signal, null, 'A signalled browser exit requires independent failure/drain review')
  return { reports, browserChildClose, workerSha256, processTreeQualified: false }
}
module.exports = { runSnapshotBrowserMeasurement, SnapshotBrowserMeasurementCleanupError }
if (require.main === module) {
  require('./native-browser-executable.cjs')
    .nativeBrowserExecutable()
    .then(path => runSnapshotBrowserMeasurement(path))
    .then(
      result => {
        process.stdout.write(JSON.stringify(result) + '\n')
      },
      () => {
        // Fixed diagnostic: never print an archive, password, native payload or a
        // browser exception that could contain one. The supervisor owns failure/drain.
        process.stderr.write('Native portable browser qualification failed; original owners require drainage.\n')
        process.exitCode = 1
      }
    )
}
