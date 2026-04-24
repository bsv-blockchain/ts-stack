/**
 * WalletRelayService singleton for Next.js.
 *
 * Two-step pattern required because Next.js separates server startup
 * (server.mjs) from API route handlers (app/api/**):
 *
 *   1. server.mjs calls initRelay(server) once, after creating the http.Server.
 *   2. API routes call getRelay() to access the shared instance.
 *
 * The global workaround prevents duplicate instances during Next.js development
 * hot-reloads (module code re-runs; the HTTP server does not).
 */

import type { Server } from 'http'
import { WalletClient } from '@bsv/sdk'
import { WalletRelayService } from '@bsv/wallet-relay'

const g = global as typeof globalThis & { __walletRelay?: WalletRelayService }

export function initRelay(server: Server): WalletRelayService {
  if (g.__walletRelay) return g.__walletRelay

  // TODO: Replace with the BSV wallet your backend should use for
  //       encrypting/decrypting messages with the mobile device.
  //
  // WalletClient('auto') auto-detects a running MetaNet Client on localhost.
  // For a fully server-side setup without a MetaNet Client:
  //
  //   import { ProtoWallet, PrivateKey } from '@bsv/sdk'
  //   const wallet = new ProtoWallet(PrivateKey.fromWif(process.env['WALLET_WIF']!))
  const wallet = new WalletClient('auto')

  // No `app` passed — Next.js handles routing via app/api/ route handlers.
  // `server` is the http.Server from server.mjs; WalletRelayService attaches
  // the WebSocket upgrade handler to it.
  g.__walletRelay = new WalletRelayService({
    server,
    wallet,
    relayUrl: process.env['RELAY_URL'] ?? 'ws://localhost:3000',
    origin:   process.env['ORIGIN']    ?? 'http://localhost:3000',

    // TODO (optional): hook into session lifecycle events
    onSessionConnected:    id => console.log(`[relay] mobile connected    — ${id}`),
    onSessionDisconnected: id => console.log(`[relay] mobile disconnected — ${id}`),
  })

  return g.__walletRelay
}

export function getRelay(): WalletRelayService {
  if (!g.__walletRelay) {
    throw new Error(
      'WalletRelayService not initialized.\n' +
      'Make sure server.mjs calls initRelay(server) before any API routes are hit.'
    )
  }
  return g.__walletRelay
}
