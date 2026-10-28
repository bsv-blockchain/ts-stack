'use strict'
// Authored UNRUN. Execute only under a freshly admitted complete-source
// qualification supervisor, which owns process-tree/resource/output limits.
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { access } = require('node:fs/promises')
const { readdirSync, readFileSync } = require('node:fs')
const { createHash } = require('node:crypto')
const { join, resolve } = require('node:path')
const { performance } = require('node:perf_hooks')
const { launchOwnedNativeBrowser } = require('./native-browser-session.cjs')
const { nativeBrowserCaseTimeout } = require('./native-browser-budgets.cjs')

class PortableBrowserProgramCleanupError extends AggregateError {
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
async function runPortableBrowserProgram(executablePath, selection) {
  assert.equal(typeof executablePath, 'string', 'A reviewed installed native browser path is required')
  assert.ok(executablePath.length > 0 && executablePath.length <= 4096)
  await access(executablePath)
  const { build, stop } = await import('esbuild')
  const wallet = resolve(__dirname, '../..')
  let browser, page, session, childClosed, server, closingBrowser, closingServer, activeEvaluation, workerSha256
  let failure,
    activeCaseId,
    bundlerStopped = false,
    caseTimedOut = false,
    serverListening = false
  let browserCloseFailed = false,
    serverCloseFailed = false
  const reports = []
  const sourceInventory = () => {
    const files = [],
      cases = []
    for (const directory of ['src/storage/portable', 'src/storage/snapshot', 'src/utility']) {
      for (const item of readdirSync(join(wallet, directory), { withFileTypes: true })) {
        if (!item.name.endsWith('.browser.case.ts')) continue
        assert.ok(item.isFile(), 'Browser cases must be regular original source files')
        const source = directory + '/' + item.name,
          bytes = readFileSync(join(wallet, source)),
          text = bytes.toString('utf8')
        const matches = [...text.matchAll(/export async function\s+(\w+)\((.*?)\):\s*Promise<void>/gs)]
        assert.ok(matches.length > 0, 'Every case source needs explicit native-browser selection')
        assert.equal(
          [...text.matchAll(/\bexport\s+(?:async\s+)?function\s+/g)].length,
          matches.length,
          'Every exported browser case must keep an explicit Promise<void> catalogue contract'
        )
        for (const match of matches) cases.push({ id: match[1], source })
        files.push({ source, sha256: createHash('sha256').update(bytes).digest('hex') })
      }
    }
    return {
      files: files.sort((a, b) => a.source.localeCompare(b.source)),
      cases: cases.sort((a, b) => a.id.localeCompare(b.id))
    }
  }
  const initial = sourceInventory()
  assert.equal(initial.files.length, 20)
  assert.equal(initial.cases.length, 61)
  // The normal entry still executes the complete original catalogue. An exact
  // component selection is local feedback and cannot report full qualification.
  let selectedIds
  // Instrumentation creates its counters lazily. A case that never executes a
  // mutant location has real zero coverage, represented by these empty maps.
  const context = { mutantCoverage: { static: {}, perTest: {} } }
  if (selection !== undefined) {
    assert.ok(selection && typeof selection === 'object')
    assert.ok(Array.isArray(selection.caseIds) && selection.caseIds.length > 0 && selection.caseIds.length <= 61)
    selectedIds = [...selection.caseIds]
    assert.equal(new Set(selectedIds).size, selectedIds.length)
    for (const id of selectedIds) assert.ok(initial.cases.some(entry => entry.id === id))
    for (const key of ['currentTestId', 'activeMutant']) {
      if (selection.context?.[key] !== undefined) {
        assert.equal(typeof selection.context[key], 'string')
        assert.ok(selection.context[key].length > 0 && selection.context[key].length <= 32768)
        context[key] = selection.context[key]
      }
    }
    if (selection.context?.hitLimit !== undefined) {
      assert.ok(Number.isSafeInteger(selection.context.hitLimit) && selection.context.hitLimit > 0)
      context.hitLimit = selection.context.hitLimit
      context.hitCount = 0
    }
  }
  let coverage
  const cleanup = async () => {
    const pending = []
    if (browser !== undefined) {
      if (browserCloseFailed) {
        closingBrowser = undefined
        browserCloseFailed = false
      }
      closingBrowser ??= (async () => {
        let pageFailure
        if (page !== undefined && !page.isClosed()) {
          try {
            await bounded(page.close(), 10000, 'Native browser page close did not settle')
          } catch (cause) {
            pageFailure = cause
          }
        }
        try {
          await session.close()
        } catch (cause) {
          if (pageFailure !== undefined)
            throw new AggregateError([pageFailure, cause], 'Native page and browser cleanup failed')
          throw cause
        }
        if (pageFailure !== undefined) throw pageFailure
      })().catch(cause => {
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
        program: join(__dirname, 'portable-program-browser.ts')
      },
      bundle: true,
      write: false,
      outdir: join(wallet, 'client/.portable-program-unwritten'),
      platform: 'browser',
      format: 'esm',
      target: 'es2022',
      tsconfig: join(__dirname, 'tsconfig.browser.json'),
      splitting: false,
      ...(selection === undefined
        ? {}
        : { banner: { js: 'globalThis.__stryker__ = ' + JSON.stringify(context) + ';' } })
    })
    assert.equal(bundles.warnings.length, 0, 'Native coverage bundle warnings require review')
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
          '<!doctype html><title>Native portable program qualification</title><script type="module" src="/program.js"></script>'
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
    page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.waitForFunction('typeof globalThis.portableBrowserProgram?.run === "function"', { timeout: 30000 })
    const cases = await page.evaluate(() => globalThis.portableBrowserProgram.cases)
    assert.equal(
      cases.length,
      61,
      'Every current native-browser case must be registered; additions require a fresh catalogue'
    )
    assert.equal(new Set(cases.map(entry => entry.id)).size, cases.length)
    assert.deepEqual(
      cases.slice().sort((a, b) => a.id.localeCompare(b.id)),
      initial.cases,
      'The complete exported source cases must equal the actual native browser catalogue'
    )
    for (const entry of cases.filter(entry => selectedIds === undefined || selectedIds.includes(entry.id))) {
      assert.equal(caseTimedOut, false)
      activeCaseId = entry.id
      const began = performance.now(),
        wall = Date.now()
      activeEvaluation = page.evaluate(async id => {
        try {
          await globalThis.portableBrowserProgram.run(id)
          return { passed: true }
        } catch (cause) {
          // Read source locations inside the original browser realm; CDP's
          // exception conversion can omit private-method async frames. Never
          // return the exception message, fixture payload or browser objects.
          const locations = String(cause?.stack ?? '')
            .split('\n')
            .filter(line => /^\s+at .*\/program\.js:\d+:\d+\)?$/.test(line))
            .slice(0, 16)
          return { passed: false, locations }
        }
      }, entry.id)
      void activeEvaluation.catch(() => undefined)
      try {
        const caseMilliseconds = nativeBrowserCaseTimeout(entry.id)
        const observed = await bounded(activeEvaluation, caseMilliseconds, 'Native browser case deadline reached')
        if (!observed.passed) {
          const failure = new Error('Native browser case failed its original contract')
          failure.caseId = entry.id
          failure.stack += '\n' + observed.locations.join('\n')
          throw failure
        }
        assert.ok(
          performance.now() - began < caseMilliseconds && Date.now() - wall < caseMilliseconds,
          'A late case cannot become successful qualification'
        )
      } catch (cause) {
        caseTimedOut = true
        throw cause
      }
      activeEvaluation = undefined
      reports.push({ id: entry.id, source: entry.source, elapsedMilliseconds: performance.now() - began, passed: true })
      activeCaseId = undefined
    }
    if (selection !== undefined) coverage = await page.evaluate(() => globalThis.__stryker__?.mutantCoverage)
  } catch (cause) {
    failure = cause
    if (cause instanceof Error) {
      if (activeCaseId !== undefined) cause.caseId = activeCaseId
      cause.completedCaseCount = reports.length
    }
  }
  try {
    await cleanup()
  } catch (cause) {
    const error = new PortableBrowserProgramCleanupError(failure === undefined ? [cause] : [failure, cause], cleanup)
    error.completedCaseCount = reports.length
    throw error
  }
  if (failure !== undefined) throw failure
  assert.equal(reports.length, selectedIds?.length ?? 61)
  // The original primary browser child has emitted close. Its helper tree and
  // the esbuild service still require the outer supervisor's independent group
  // absence proof; this result deliberately supplies no kernel/resource verdict.
  assert.deepEqual(sourceInventory(), initial, 'Browser case source changed during qualification')
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
  return {
    reports,
    browserChildClose,
    workerSha256,
    coverage,
    completeCatalogueRun: selection === undefined,
    processTreeQualified: false
  }
}
async function runPortableBrowserCase(id) {
  const namespace = globalThis.__stryker__
  const context = {
    currentTestId: namespace?.currentTestId,
    activeMutant: namespace?.activeMutant ?? process.env.__STRYKER_ACTIVE_MUTANT__,
    hitLimit: namespace?.hitLimit
  }
  const result = await require('./native-browser-driver.cjs').runNativeBrowserDriver('portable-case', context, id)
  assert.equal(result.completeCatalogueRun, false)
  assert.deepEqual(
    result.reports.map(report => report.id),
    [id]
  )
  if (namespace !== undefined) {
    assert.ok(
      result.coverage && typeof result.coverage === 'object',
      'Actual browser instrumentation coverage is required'
    )
    namespace.mutantCoverage ??= { static: {}, perTest: {} }
    const add = (into, from) => {
      for (const [mutant, count] of Object.entries(from ?? {})) {
        assert.match(mutant, /^\d+$/)
        assert.ok(Number.isSafeInteger(count) && count >= 0)
        into[mutant] = (into[mutant] ?? 0) + count
        assert.ok(Number.isSafeInteger(into[mutant]))
      }
    }
    add(namespace.mutantCoverage.static, result.coverage.static)
    for (const [testId, counters] of Object.entries(result.coverage.perTest ?? {})) {
      assert.equal(testId, context.currentTestId)
      namespace.mutantCoverage.perTest[testId] ??= {}
      add(namespace.mutantCoverage.perTest[testId], counters)
    }
  }
  return result
}
module.exports = { runPortableBrowserProgram, runPortableBrowserCase, PortableBrowserProgramCleanupError }
if (require.main === module) {
  require('./native-browser-executable.cjs')
    .nativeBrowserExecutable()
    .then(path => runPortableBrowserProgram(path))
    .then(
      result => {
        process.stdout.write(JSON.stringify(result) + '\n')
      },
      cause => {
        // Fixed diagnostic: never print an archive, password, native payload or a
        // browser exception that could contain one. The supervisor owns failure/drain.
        process.stderr.write('Native portable browser qualification failed; original owners require drainage.\n')
        // Retained cleanup failures may enclose the original case failure.
        // Follow only native Error causes, with fixed traversal/output bounds.
        const pending = [cause],
          seen = new Set()
        for (let count = 0; pending.length > 0 && count < 16; count++) {
          const failure = pending.shift()
          if (!(failure instanceof Error) || seen.has(failure)) continue
          seen.add(failure)
          if (typeof failure.caseId === 'string' && /^[A-Za-z_$][\w$]{0,255}$/.test(failure.caseId)) {
            process.stderr.write('Native browser case: ' + failure.caseId + '\n')
          }
          if (
            Number.isSafeInteger(failure.completedCaseCount) &&
            failure.completedCaseCount >= 0 &&
            failure.completedCaseCount <= 61
          ) {
            process.stderr.write('Native browser completed cases: ' + failure.completedCaseCount + '\n')
          }
          const frames = String(failure.stack ?? '')
            .split('\n')
            .filter(
              line => /^\s+at /.test(line) && (line.includes(__dirname + '/') || /\/program\.js:\d+:\d+\)?$/.test(line))
            )
            .slice(0, 16)
            .map(line =>
              line
                .replaceAll(__dirname + '/', 'native-controller/')
                .replace(/http:\/\/127\.0\.0\.1:\d+\//g, 'native-browser/')
            )
          if (frames.length > 0) process.stderr.write(frames.join('\n') + '\n')
          if (failure instanceof AggregateError) pending.push(...failure.errors.slice(0, 8))
          if (failure.cause instanceof Error) pending.push(failure.cause)
        }
        process.exitCode = 1
      }
    )
}
