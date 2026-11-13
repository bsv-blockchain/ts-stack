'use strict'
const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { mkdtemp, rm } = require('node:fs/promises')
const { createRequire } = require('node:module')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')
const { promisify } = require('node:util')

const { nativeBrowserProtocolTimeout } = require('./native-browser-budgets.cjs')

const execute = promisify(execFile)
class NativeBrowserSessionCleanupError extends AggregateError {
  constructor(causes, retryCleanup) {
    super(causes, 'Native browser retains its original process and profile cleanup', { cause: causes[0] })
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

// The reviewed launcher otherwise detaches Chrome on Unix. Keep the genuine
// browser and its ordinary descendants inside the outer supervisor's group.
// This verifies primary membership only; independent complete tree absence and
// physical memory limits remain requirements of the qualification supervisor.
async function launchOwnedNativeBrowser(executablePath) {
  assert.ok(
    ['darwin', 'linux', 'win32'].includes(process.platform),
    'An admitted native browser supervisor is required'
  )
  const { default: puppeteer } = await import('puppeteer-core')
  const dependency = createRequire(require.resolve('puppeteer-core')).resolve('@puppeteer/browsers')
  const { launch, CDP_WEBSOCKET_ENDPOINT_REGEX } = await import(pathToFileURL(dependency).href)
  const profile = await mkdtemp(join(tmpdir(), 'wallet-native-browser-'))
  let nativeProcess, child, childClosed, browser, closingBrowser, failure, outputFailure, processGroup
  let outputBytes = 0
  let profileRemoved = false,
    physicalChildClosed = false
  const cleanup = async () => {
    const failures = []
    if (browser !== undefined) {
      closingBrowser ??= browser.close().catch(cause => {
        closingBrowser = undefined
        throw cause
      })
      try {
        await bounded(closingBrowser, 10000, 'Native browser close did not settle')
      } catch (cause) {
        failures.push(cause)
      }
    }
    if (nativeProcess !== undefined) {
      try {
        // A CDP close acknowledgement can precede the physical child close.
        // Let its original streams/exit settle before the launcher's fallback
        // kill; a forced exit must never turn into a successful browser case.
        if (browser !== undefined) {
          try {
            await bounded(childClosed, 10000, 'Native browser graceful physical close did not settle')
          } catch (cause) {
            failures.push(cause)
          }
        }
        await bounded(nativeProcess.close(), 10000, 'Native browser process close did not settle')
        await bounded(childClosed, 10000, 'Native browser child did not emit close')
      } catch (cause) {
        failures.push(cause)
      }
    }
    // Keep the original profile when physical child closure is still pending.
    if (nativeProcess === undefined || physicalChildClosed) {
      try {
        if (!profileRemoved) {
          await rm(profile, { recursive: true, force: true })
          profileRemoved = true
        }
      } catch (cause) {
        failures.push(cause)
      }
    }
    if (failures.length > 0) throw new NativeBrowserSessionCleanupError(failures, cleanup)
    if (outputFailure !== undefined) throw outputFailure
  }
  try {
    const args = await puppeteer.defaultArgs({ headless: true, userDataDir: profile })
    assert.equal(
      args.some(arg => arg.startsWith('--remote-debugging-')),
      false
    )
    args.push('--remote-debugging-port=0')
    nativeProcess = launch({
      executablePath,
      args,
      detached: false,
      env: process.env,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false
    })
    child = nativeProcess.nodeProcess
    child.once('exit', () => {
      // The kernel has reaped this actual primary process. Its descendants can
      // inherit the diagnostic pipes and keep Node's close event pending after
      // that exit. Release our now-ended primary's observer handles; this is
      // not a descendant-absence receipt. The enclosing supervisor still owns
      // group drainage, and a signal/nonzero exit still fails qualification.
      child.stdin?.destroy()
      child.stdout?.destroy()
      child.stderr?.destroy()
    })
    childClosed = new Promise((resolveClose, rejectClose) => {
      child.once('close', (code, signal) => {
        physicalChildClosed = true
        resolveClose({ code, signal })
      })
      child.once('error', rejectClose)
    })
    void childClosed.catch(() => undefined)
    assert.ok(child && Number.isSafeInteger(child.pid) && child.exitCode === null)
    const countOutput = chunk => {
      outputBytes += chunk.byteLength
      if (outputBytes > 65536 && outputFailure === undefined) {
        outputFailure = new Error('Native browser diagnostic output exceeded its 64KiB bound')
        // The enclosing admitted group/job remains the complete-tree owner.
        // Keep a stream callback from throwing before retained cleanup runs.
        child.kill('SIGTERM')
      }
    }
    child.stdout?.on('data', countOutput)
    child.stderr?.on('data', countOutput)
    if (process.platform !== 'win32') {
      const { stdout } = await execute('ps', ['-p', `${process.pid},${child.pid}`, '-o', 'pid=,ppid=,pgid='], {
        timeout: 5000,
        maxBuffer: 4096
      })
      const rows = stdout
        .trim()
        .split('\n')
        .map(line => line.trim().split(/\s+/).map(Number))
      const parent = rows.find(row => row[0] === process.pid)
      const owned = rows.find(row => row[0] === child.pid)
      assert.ok(parent && owned && parent.every(Number.isSafeInteger) && owned.every(Number.isSafeInteger))
      assert.equal(owned[1], process.pid, 'The browser must be our actual direct child')
      assert.equal(owned[2], parent[2], 'A detached browser is outside the supervising process group')
      processGroup = parent[2]
    }
    // Windows qualification must supply its actual enclosing job evidence;
    // detached:false alone does not prove a Job Object or descendant cleanup.
    const endpoint = await nativeProcess.waitForLineOutput(CDP_WEBSOCKET_ENDPOINT_REGEX, 10000)
    assert.equal(outputFailure, undefined)
    browser = await puppeteer.connect({ browserWSEndpoint: endpoint, protocolTimeout: nativeBrowserProtocolTimeout })
    return Object.freeze({ browser, child, childClosed, close: cleanup, processGroup })
  } catch (cause) {
    failure = cause
  }
  try {
    await cleanup()
  } catch (cause) {
    throw new NativeBrowserSessionCleanupError([failure, cause], cleanup)
  }
  throw failure
}
module.exports = { launchOwnedNativeBrowser, NativeBrowserSessionCleanupError }
