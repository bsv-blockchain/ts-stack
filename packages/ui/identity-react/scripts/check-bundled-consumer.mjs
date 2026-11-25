import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
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
  const bundle = await rolldown({
    input: join(temporary, 'package/dist/index.js'),
    platform: 'browser',
    // Retain every warning without source-frame expansion for thousands of MUI icons.
    onLog(level, log, handler) {
      if (level === 'warn') console.warn(`[${log.code}] ${log.message}`)
      else handler(level, log)
    },
    moduleTypes: { '.css': 'empty' },
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
  console.log(
    `Packed ${packed.name}@${packed.version} browser component renders with React18 and MUI5`
  )
} finally {
  dom?.window.close()
  await rm(temporary, { recursive: true, force: true })
}
