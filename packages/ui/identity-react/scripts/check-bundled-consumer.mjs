import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { readFile, mkdtemp, mkdir, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { rolldown } from 'rolldown'
import { JSDOM } from 'jsdom'
import React from 'react'
import { renderToString } from 'react-dom/server'

const execFile = promisify(execFileCallback)
const cache = resolve('node_modules/.cache')
await mkdir(cache, { recursive: true })
const temporary = await mkdtemp(join(cache, 'identity-react-consumer-'))
let dom
try {
  const packed = JSON.parse(
    (await execFile('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temporary]))
      .stdout
  )[0]
  await execFile('tar', ['-xzf', join(temporary, packed.filename), '-C', temporary])
  const entry = join(temporary, 'package/dist/index.js')
  const nativeExports = await import(pathToFileURL(entry).href)
  assert.equal(typeof nativeExports.IdentitySearchField, 'function')
  assert.equal(typeof nativeExports.useIdentitySearch, 'function')

  const bundle = await rolldown({
    input: entry,
    platform: 'browser',
    // Retain dependency warnings without expanding their source frames.
    onLog(level, log, handler) {
      if (level === 'warn') console.warn(`[${log.code}] ${log.message}`)
      else handler(level, log)
    },
    external: /^(react(?:-dom)?(?:\/|$)|@bsv\/sdk$)/
  })
  const artifact = join(temporary, 'consumer.mjs')
  try {
    await bundle.write({
      file: artifact,
      format: 'esm',
      banner:
        "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"
    })
  } finally {
    await bundle.close()
  }
  dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'https://identity-consumer.test/'
  })
  for (const name of ['window', 'document', 'navigator', 'sessionStorage', 'HTMLElement']) {
    Object.defineProperty(globalThis, name, {
      value: name === 'window' ? dom.window : dom.window[name],
      configurable: true
    })
  }
  const { IdentitySearchField } = await import(pathToFileURL(artifact).href)
  const rendered = renderToString(React.createElement(IdentitySearchField))
  assert.match(rendered, /Search Identity/)
  assert.match(rendered, /role="combobox"/)
  const material = JSON.parse(
    await readFile(new URL(import.meta.resolve('@mui/material/package.json')), 'utf8')
  )
  console.log(
    `Packed ${packed.name}@${packed.version} imports in Node and renders with React ${React.version} and MUI ${material.version}`
  )
} finally {
  dom?.window.close()
  await rm(temporary, { recursive: true, force: true })
}
