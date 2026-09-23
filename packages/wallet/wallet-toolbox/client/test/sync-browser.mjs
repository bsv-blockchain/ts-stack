import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'

const candidates = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
].filter(Boolean)
let executablePath
for (const candidate of candidates) {
  try {
    await access(candidate)
    executablePath = candidate
    break
  } catch {
    /* try the next installed browser */
  }
}
assert.ok(executablePath, 'Install Chromium/Chrome or set CHROME_BIN; the native IndexedDB gate cannot be skipped.')
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('./sync-browser.ts', import.meta.url))],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'esm',
  target: 'es2022'
})
const server = createServer((req, res) => {
  if (req.url === '/benchmark.js') {
    res.setHeader('Content-Type', 'text/javascript')
    res.end(bundle.outputFiles[0].contents)
  } else {
    res.setHeader('Content-Type', 'text/html')
    res.end('<!doctype html><title>Native sync acceptance</title><script type="module" src="/benchmark.js"></script>')
  }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let browser
try {
  browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--enable-precise-memory-info']
  })
  const page = await browser.newPage()
  page.on('console', message => process.stdout.write(`${message.text()}\n`))
  page.on('pageerror', error => process.stderr.write(`${error}\n`))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.waitForFunction('typeof globalThis.syncBenchmark === "function"', { timeout: 30000 })
  const reports = await page.evaluate(async () => await globalThis.syncBenchmark())
  process.stdout.write(`${JSON.stringify({ nativeSync: reports }, null, 2)}\n`)
} finally {
  if (browser !== undefined) await browser.close()
  await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
}
