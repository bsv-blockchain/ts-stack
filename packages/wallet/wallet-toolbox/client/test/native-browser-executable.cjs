'use strict'
const assert = require('node:assert/strict')
const { access, realpath, stat } = require('node:fs/promises')

// Fixed host-owned selection, matching the existing browser acceptance entry.
// No archive/remote URL chooses an executable. The outer qualification input
// agreement still pins the actual selected file and its process/resource plan.
async function nativeBrowserExecutable(explicit = process.env.CHROME_BIN) {
  const candidates =
    explicit === undefined
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium']
      : [explicit]
  for (const candidate of candidates) {
    assert.equal(typeof candidate, 'string')
    assert.ok(candidate.length > 0 && candidate.length <= 4096)
    try {
      const selected = await realpath(candidate)
      assert.ok((await stat(selected)).isFile(), 'Native browser executable must be a regular installed file')
      await access(selected)
      return selected
    } catch (cause) {
      if (explicit !== undefined) throw cause
    }
  }
  throw new Error('A real installed Chrome/Chromium or explicit CHROME_BIN is required; native cases cannot be skipped')
}
module.exports = { nativeBrowserExecutable }
