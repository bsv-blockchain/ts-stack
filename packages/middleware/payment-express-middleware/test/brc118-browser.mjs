import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { access, readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import express from 'express'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'
import { Beef, PrivateKey, ProtoWallet, PublicKey, P2PKH } from '@bsv/sdk'
import { createAuthMiddleware } from '@bsv/auth-express-middleware'
import { createPaymentMiddleware } from '../dist/mod.mjs'

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
    /* next installed browser */
  }
}
assert.ok(
  executablePath,
  'Chrome/Chromium or CHROME_BIN is required; the BRC-118 browser gate cannot be skipped.'
)
const bundleOptions = {
  entryPoints: [fileURLToPath(new URL('./brc118-client.mjs', import.meta.url))],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'esm',
  target: 'es2022'
}
const bundle = await build(bundleOptions)
let legacyBundle
const servers = []
async function listen(server) {
  servers.push(server)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${server.address().port}`
}
async function receiver({ multipart = true, exposeTransport = true } = {}) {
  const app = express()
  const wallet = new ProtoWallet(new PrivateKey(23))
  let accepted = 0
  let handled = 0
  let preflights = 0
  wallet.internalizeAction = async args => {
    const beef = Beef.fromBinaryStrict(args.tx)
    const remittance = args.outputs[0].paymentRemittance
    const key = await wallet.getPublicKey({
      protocolID: [2, '3241645161d8'],
      keyID: `${remittance.derivationPrefix} ${remittance.derivationSuffix}`,
      counterparty: remittance.senderIdentityKey,
      forSelf: true
    })
    const output = beef.findTxid(beef.atomicTxid).tx.outputs[0]
    assert.equal(
      output.lockingScript.toHex(),
      new P2PKH().lock(PublicKey.fromString(key.publicKey).toAddress()).toHex()
    )
    assert.equal(output.satoshis, 10)
    accepted++
    return { accepted: true, isMerge: false }
  }
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader(
      'Access-Control-Allow-Headers',
      req.headers['access-control-request-headers'] ?? '*'
    )
    res.setHeader(
      'Access-Control-Expose-Headers',
      exposeTransport
        ? '*'
        : 'x-bsv-auth-version, x-bsv-auth-identity-key, x-bsv-auth-nonce, x-bsv-auth-your-nonce, x-bsv-auth-signature, x-bsv-auth-request-id, x-bsv-payment-version, x-bsv-payment-satoshis-required, x-bsv-payment-derivation-prefix'
    )
    if (req.method === 'OPTIONS') {
      preflights++
      res.sendStatus(204)
      return
    }
    next()
  })
  app.use(createAuthMiddleware({ wallet, captureRawBody: true }))
  app.use(
    createPaymentMiddleware({ wallet, enableMultipart: multipart, calculateRequestPrice: () => 10 })
  )
  app.use((req, res) => {
    handled++
    res.json({
      raw: Array.from(req.rawBody ?? []),
      mediaType: req.headers['content-type'],
      paid: req.payment.accepted
    })
  })
  return {
    origin: await listen(createServer(app)),
    counts: () => ({ accepted, handled, preflights })
  }
}
let browser
try {
  const pageOrigin = await listen(
    createServer((req, res) => {
      res.setHeader('Content-Type', req.url?.endsWith('.js') ? 'text/javascript' : 'text/html')
      res.end(
        req.url === '/legacy.js'
          ? legacyBundle?.outputFiles[0].contents
          : req.url === '/client.js'
            ? bundle.outputFiles[0].contents
            : '<!doctype html><title>BRC-118 cross-origin acceptance</title><script type="module" src="/client.js"></script>'
      )
    })
  )
  browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] })
  const page = await browser.newPage()
  page.on('pageerror', error => process.stderr.write(`${error}\n`))
  await page.goto(pageOrigin)
  await page.waitForFunction('typeof globalThis.pay === "function"')
  const cases = [
    { contentType: 'application/octet-stream', body: [0, 255, 128, 13, 10], ancestorBytes: 12000 },
    {
      contentType: 'application/json; charset=utf-8',
      body: Array.from(Buffer.from('{ "snow": "雪" }\n')),
      ancestorBytes: 12000
    },
    { contentType: 'text/plain', body: [], ancestorBytes: 0, multipart: false }
  ]
  for (const item of cases) {
    const target = await receiver(item)
    const result = await page.evaluate(async args => await globalThis.pay(args), {
      ...item,
      origin: target.origin
    })
    assert.equal(result.status, 200, JSON.stringify(result))
    assert.deepEqual(result.result.raw, item.body)
    assert.equal(result.result.mediaType, item.contentType)
    assert.equal(result.result.paid, true)
    assert.deepEqual([result.prepared, result.submitted, result.aborted], [1, 1, 0])
    assert.ok(result.challenges.includes(item.multipart === false ? 'header' : 'header,multipart'))
    assert.equal(target.counts().accepted, 1)
    assert.equal(target.counts().handled, 1)
    assert.ok(target.counts().preflights > 0, 'Browser did not exercise cross-origin preflight')
    console.log(
      JSON.stringify({
        browserPayment: item.contentType,
        ancestorBytes: item.ancestorBytes,
        ...target.counts()
      })
    )
  }
  const hidden = await receiver({ exposeTransport: false })
  const refusal = await page.evaluate(async args => await globalThis.pay(args), {
    origin: hidden.origin,
    ancestorBytes: 12000,
    contentType: 'text/plain',
    body: []
  })
  // Negotiation is signed: hiding it invalidates authentication before any wallet spend.
  assert.equal(refusal.code, 'ERR_INVALID_SIGNATURE', JSON.stringify(refusal))
  assert.deepEqual([refusal.prepared, refusal.submitted, refusal.aborted], [0, 0, 0])
  assert.equal(hidden.counts().accepted, 0)
  assert.equal(hidden.counts().handled, 0)
  console.log(
    'BRC-118 native browser: binary, exact JSON, header-only compatibility and hidden-capability refusal passed.'
  )
  // Optional compatibility probe is additive: the complete current-client gate above always runs.
  const legacyModule = process.env.BRC118_LEGACY_SDK_MODULE
  if (legacyModule !== undefined) {
    const manifest = JSON.parse(
      await readFile(new URL('../../package.json', pathToFileURL(legacyModule)), 'utf8')
    )
    assert.equal(manifest.name, '@bsv/sdk')
    assert.equal(manifest.version, '2.8.0')
    legacyBundle = await build({ ...bundleOptions, alias: { '@bsv/sdk': legacyModule } })
    await page.addScriptTag({ url: `${pageOrigin}/legacy.js`, type: 'module' })
    for (const multipart of [true, false]) {
      const target = await receiver({ multipart })
      const item = {
        origin: target.origin,
        ancestorBytes: 0,
        contentType: 'text/plain',
        body: [108, 101, 103, 97, 99, 121],
        legacy: true
      }
      const result = await page.evaluate(async args => await globalThis.pay(args), item)
      assert.equal(result.status, 200, JSON.stringify(result))
      assert.deepEqual(result.result.raw, item.body)
      assert.deepEqual([result.prepared, result.submitted, result.aborted], [0, 1, 0])
      assert.equal(target.counts().accepted, 1)
      assert.equal(target.counts().handled, 1)
      console.log(
        JSON.stringify({
          publishedClient: '2.8.0',
          receiverMultipart: multipart,
          ...target.counts()
        })
      )
    }
  }
} finally {
  if (browser !== undefined) await browser.close()
  await Promise.all(
    servers.map(async server => {
      server.closeAllConnections()
      await new Promise((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve()))
      )
    })
  )
}
