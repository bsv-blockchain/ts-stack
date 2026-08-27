import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse
} from 'node:http'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { WalletInterface } from '@bsv/sdk'
import { createFixtureWallet } from './fixtureWallet.js'
import { ReferenceLCHServer, referenceApiResponse } from './referenceServer.js'

interface WalletSet {
  issuerWallet: WalletInterface
  recordingWallet: WalletInterface
  compositionWallet: WalletInterface
}

interface WalletModule {
  createLCHWallets(): Promise<WalletSet>
}

const port = environmentInteger('PORT', 4173)
const publicBaseUrl = process.env.LCH_PUBLIC_BASE_URL ?? `http://127.0.0.1:${port}`
const staticDirectory =
  process.env.LCH_STATIC_DIR ?? fileURLToPath(new URL('../dist', import.meta.url))
const walletModule = process.env.LCH_WALLET_MODULE
const walletMode = walletModule === undefined ? 'fixture' : 'connected'
const wallets = await loadWallets(walletModule)
const lch = await ReferenceLCHServer.create({
  issuerWallet: wallets.issuerWallet,
  publicBaseUrl,
  payees: [
    {
      wallet: wallets.recordingWallet,
      satoshis: environmentInteger('LCH_RECORDING_SATOSHIS', 7),
      dutyUid: 'urn:lch:duty:recording',
      interest: 'recording',
      label: 'recording controller'
    },
    {
      wallet: wallets.compositionWallet,
      satoshis: environmentInteger('LCH_COMPOSITION_SATOSHIS', 5),
      dutyUid: 'urn:lch:duty:composition',
      interest: 'composition',
      label: 'composition controller'
    }
  ]
})

const server = createHttpServer((request, response) => {
  void route(request, response).catch(error => {
    const message = error instanceof Error ? error.message : 'request failed'
    const status = errorStatus(error)
    if (!response.headersSent) sendJson(response, status, { error: message })
    else response.end()
  })
})

server.listen(port, '0.0.0.0', () => {
  process.stdout.write(
    `LCH reference server listening on ${publicBaseUrl} (${walletMode} wallets)\n`
  )
})

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', publicBaseUrl)
  if (request.method === 'GET' && url.pathname === '/api/health') {
    sendJson(response, 200, {
      status: 'ready',
      walletMode,
      acquisitionEndpoint: lch.acquisitionEndpoint,
      contentAdapter: 'reference-memory'
    })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/assets') {
    await publishAsset(request, response)
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/lch') {
    const body = await requestBytes(request, 16 * 1024 * 1024)
    const fetchRequest = new Request(new URL('/api/lch', publicBaseUrl), {
      method: 'POST',
      headers: requestHeaders(request),
      body: body.slice().buffer
    })
    await sendFetchResponse(response, await lch.http.handle(fetchRequest))
    return
  }
  if (request.method === 'OPTIONS' && url.pathname === '/api/lch') {
    await sendFetchResponse(
      response,
      await lch.http.handle(
        new Request(new URL('/api/lch', publicBaseUrl), {
          method: 'OPTIONS',
          headers: requestHeaders(request)
        })
      )
    )
    return
  }
  if (request.method === 'GET' && url.pathname.startsWith('/content/')) {
    serveContent(response, request.headers.range, url.pathname)
    return
  }
  if (request.method === 'GET' || request.method === 'HEAD') {
    await sendStatic(response, request.method, url.pathname)
    return
  }
  response.writeHead(405, { allow: 'GET, HEAD, POST, OPTIONS' }).end()
}

async function loadWallets(moduleSpecifier: string | undefined): Promise<WalletSet> {
  if (moduleSpecifier === undefined) {
    return {
      issuerWallet: createFixtureWallet(101),
      recordingWallet: createFixtureWallet(102),
      compositionWallet: createFixtureWallet(103)
    }
  }
  const specifier = walletModuleSpecifier(moduleSpecifier)
  const loaded = (await import(/* @vite-ignore */ specifier)) as Partial<WalletModule>
  if (typeof loaded.createLCHWallets !== 'function')
    throw new TypeError('LCH_WALLET_MODULE must export createLCHWallets()')
  return loaded.createLCHWallets()
}

async function publishAsset(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = JSON.parse(
    new TextDecoder().decode(await requestBytes(request, 32 * 1024 * 1024))
  ) as {
    name?: unknown
    mediaType?: unknown
    bytesBase64?: unknown
  }
  if (
    typeof body.name !== 'string' ||
    typeof body.mediaType !== 'string' ||
    typeof body.bytesBase64 !== 'string'
  ) {
    sendJson(response, 400, { error: 'name, mediaType, and bytesBase64 are required' })
    return
  }
  const published = await lch.publish({
    name: body.name,
    mediaType: body.mediaType,
    bytes: Uint8Array.from(Buffer.from(body.bytesBase64, 'base64'))
  })
  await sendFetchResponse(response, referenceApiResponse(published))
}

function serveContent(response: ServerResponse, range: string | undefined, pathname: string): void {
  const key = pathname.slice('/content/'.length)
  if (!/^[0-9a-f]{64}$/u.test(key)) {
    response.writeHead(404).end()
    return
  }
  const bytes = lch.content.get(key)
  if (bytes === undefined) {
    response.writeHead(404).end()
    return
  }
  sendContent(response, range, bytes)
}

function walletModuleSpecifier(value: string): string {
  if (value.startsWith('.')) return pathToFileURL(join(process.cwd(), value)).href
  if (value.startsWith('/')) return pathToFileURL(value).href
  return value
}

function errorStatus(error: unknown): number {
  if (error instanceof SyntaxError) return 400
  if (error instanceof RangeError) return 413
  return 500
}

function requestBytes(request: IncomingMessage, maximum: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = []
    let length = 0
    let failed = false
    request.on('data', (chunk: Buffer) => {
      length += chunk.length
      if (length > maximum && !failed) {
        failed = true
        reject(new RangeError('request body exceeds its limit'))
      } else if (!failed) chunks.push(chunk)
    })
    request.on('end', () => {
      if (!failed) resolve(Uint8Array.from(Buffer.concat(chunks)))
    })
    request.on('error', reject)
  })
}

function requestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value)
  }
  return headers
}

async function sendFetchResponse(output: ServerResponse, input: Response): Promise<void> {
  const headers = Object.fromEntries(input.headers.entries())
  const bytes = input.body === null ? undefined : Buffer.from(await input.arrayBuffer())
  output.writeHead(input.status, headers)
  output.end(bytes)
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value))
  response
    .writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': body.length,
      'cache-control': 'no-store'
    })
    .end(body)
}

function sendContent(response: ServerResponse, range: string | undefined, bytes: Uint8Array): void {
  const parsed = range === undefined ? undefined : /^bytes=(\d+)-(\d*)$/u.exec(range)
  if (parsed === null) {
    response.writeHead(416, { 'content-range': `bytes */${bytes.length}` }).end()
    return
  }
  const start = parsed === undefined ? 0 : Number(parsed[1])
  const end = parsed === undefined || parsed[2] === '' ? bytes.length : Number(parsed[2]) + 1
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start ||
    end > bytes.length
  ) {
    response.writeHead(416, { 'content-range': `bytes */${bytes.length}` }).end()
    return
  }
  const body = bytes.slice(start, end)
  response
    .writeHead(parsed === undefined ? 200 : 206, {
      'content-type': 'application/octet-stream',
      'content-length': body.length,
      'accept-ranges': 'bytes',
      ...(parsed === undefined
        ? {}
        : { 'content-range': `bytes ${start}-${end - 1}/${bytes.length}` })
    })
    .end(body)
}

async function sendStatic(
  response: ServerResponse,
  method: string,
  pathname: string
): Promise<void> {
  const relative = pathname === '/' ? 'index.html' : normalize(pathname).replace(/^[/\\]+/u, '')
  if (relative.startsWith('..')) {
    response.writeHead(404).end()
    return
  }
  let filename = join(staticDirectory, relative)
  let details
  try {
    details = await stat(filename)
    if (!details.isFile()) throw new Error('not a file')
  } catch {
    filename = join(staticDirectory, 'index.html')
    details = await stat(filename)
  }
  response.writeHead(200, {
    'content-type': mediaType(filename),
    'content-length': details.size,
    'cache-control': filename.endsWith('index.html')
      ? 'no-cache'
      : 'public, max-age=31536000, immutable'
  })
  if (method === 'HEAD') response.end()
  else createReadStream(filename).pipe(response)
}

function mediaType(filename: string): string {
  return (
    {
      '.css': 'text/css; charset=utf-8',
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.md': 'text/markdown; charset=utf-8'
    }[extname(filename)] ?? 'application/octet-stream'
  )
}

function environmentInteger(name: string, fallback: number): number {
  const raw = process.env[name]
  const value = raw === undefined ? fallback : Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be positive`)
  return value
}
