'use strict'
const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')

const { nativeBrowserDriverTimeout, nativeBrowserTestTimeout } = require('./native-browser-budgets.cjs')

// Jest's CommonJS VM does not provide native ESM loaders for the installed
// browser tools. Execute the genuine controller in a fresh inherited-group
// Node child, rather than substituting implementations or VM globals.
async function runNativeBrowserDriver(kind, context, id = '') {
  assert.ok(kind === 'portable-case' || kind === 'argon2id-coverage')
  assert.equal(typeof id, 'string')
  assert.ok(id.length <= 256)
  const encoded = JSON.stringify(context)
  assert.ok(encoded.length <= 131072)
  return await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['--max-old-space-size=1536', __filename, kind, id, encoded],
      { timeout: nativeBrowserDriverTimeout(id), maxBuffer: 1048576, killSignal: 'SIGTERM' },
      (cause, stdout) => {
        if (cause !== null) {
          reject(new Error('Native browser driver failed or reached its enclosing driver bound', { cause }))
          return
        }
        try {
          const result = JSON.parse(stdout)
          assert.ok(result && typeof result === 'object')
          resolve(result)
        } catch (error_) {
          reject(error_)
        }
      }
    )
  })
}
module.exports = { runNativeBrowserDriver, nativeBrowserDriverTimeout, nativeBrowserTestTimeout }

if (require.main === module) {
  const run = async () => {
    assert.equal(process.argv.length, 5)
    const [kind, id, encoded] = process.argv.slice(2)
    assert.ok(encoded.length <= 131072)
    const context = JSON.parse(encoded)
    assert.ok(context && typeof context === 'object' && !Array.isArray(context))
    const executable = await require('./native-browser-executable.cjs').nativeBrowserExecutable()
    let result
    if (kind === 'portable-case') {
      result = await require('./portable-program-browser.cjs').runPortableBrowserProgram(executable, {
        caseIds: [id],
        context
      })
    } else {
      assert.equal(kind, 'argon2id-coverage')
      assert.equal(id, '')
      result = await require('./argon2id-coverage-browser.cjs').runArgon2idBrowserCoverage(executable, context)
    }
    process.stdout.write(JSON.stringify(result) + '\n')
  }
  run().catch(cause => {
    // Never emit browser exceptions that could include fixture payloads or keys.
    process.stderr.write('Native browser driver failed; original owners require drainage.\n')
    // Preserve source locations without the exception message or payload.
    const frames = String(cause?.stack ?? '')
      .split('\n')
      .filter(
        line => /^\s+at /.test(line) && (line.includes(__dirname + '/') || /\/program\.js:\d+:\d+\)?$/.test(line))
      )
      .slice(0, 8)
      .map(line =>
        line
          .replaceAll(__dirname + '/', 'native-controller/')
          .replace(/http:\/\/127\.0\.0\.1:\d+\//g, 'native-browser/')
      )
    if (frames.length > 0) process.stderr.write(frames.join('\n') + '\n')
    process.exitCode = 1
  })
}
