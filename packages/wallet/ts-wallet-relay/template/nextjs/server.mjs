/**
 * Custom Next.js server — required for WebSocket support.
 *
 * Next.js API route handlers are HTTP-only, so the WebSocket relay cannot
 * attach to the built-in Next.js server. This file creates a plain Node.js
 * http.Server, hands all HTTP traffic to Next.js, and lets WalletRelayService
 * mount its WebSocket upgrade handler on the same port.
 *
 * Run instead of `next start` / `next dev`:
 *   node server.mjs              (production)
 *   NODE_ENV=development node server.mjs   (development, enables Next.js HMR)
 *
 * Update package.json scripts:
 *   "dev":   "NODE_ENV=development node server.mjs",
 *   "start": "node server.mjs"
 *
 * If you use the src/ directory layout, update the relay import to:
 *   import { initRelay } from './src/lib/relay.js'
 */

import { createServer } from 'node:http'
import { parse } from 'node:url'
import next from 'next'
import { initRelay } from './lib/relay.js'

const dev  = process.env.NODE_ENV !== 'production'
const port = Number.parseInt(process.env.PORT ?? '3000', 10)

const app    = next({ dev })
const handle = app.getRequestHandler()

await app.prepare()

const server = createServer((req, res) => {
  // Let Next.js handle all HTTP requests (pages, API routes, assets)
  handle(req, parse(req.url ?? '/', true), res)
})

// Attach the WebSocket relay to this server before .listen()
// This is what makes ws://host/ws available on the same port.
initRelay(server)

server.listen(port, '0.0.0.0', () => {
  console.log(`Ready on http://0.0.0.0:${port}`)
})
