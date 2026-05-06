#!/usr/bin/env node
/**
 * wallet-relay init
 *
 * Scaffolds backend and/or frontend template files into your project.
 *
 * Usage:
 *   npx @bsv/wallet-relay init                          — Express backend + React frontend
 *   npx @bsv/wallet-relay init my-app                   — scaffold into ./my-app/
 *   npx @bsv/wallet-relay init --backend                — Express backend only
 *   npx @bsv/wallet-relay init --frontend               — React frontend only
 *   npx @bsv/wallet-relay init --frontend-dir src       — write frontend files into ./src instead of ./frontend
 *   npx @bsv/wallet-relay init --backend-dir server     — write backend files into ./server instead of ./backend
 *   npx @bsv/wallet-relay init --nextjs                 — Next.js (custom server + App Router API routes)
 *
 * Existing files are never overwritten — they are skipped with a warning.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname   = path.dirname(fileURLToPath(import.meta.url))
const templateDir = path.join(__dirname, '..', 'template')

// ── Parse args ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2)

function flagValue(name) {
  const i = args.indexOf(name)
  if (i === -1) return null
  // If next arg exists and isn't another flag, treat it as the value
  const next = args[i + 1]
  return (next && !next.startsWith('--')) ? next : true
}

const isNextjs     = args.includes('--nextjs')
const backendOnly  = args.includes('--backend')
const frontendOnly = args.includes('--frontend')
const positional   = args.filter(a => !a.startsWith('--'))
const targetRoot   = path.resolve(positional[0] ?? '.')

const frontendDirName = flagValue('--frontend-dir') || 'frontend'
const backendDirName  = flagValue('--backend-dir')  || 'backend'

// ── Helpers ──────────────────────────────────────────────────────────────────

function copyDir(src, dest, created) {
  if (!fs.existsSync(src)) return
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath  = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath, created)
    } else {
      if (fs.existsSync(destPath)) {
        console.warn(`  ⚠  skipped (already exists): ${path.relative(targetRoot, destPath)}`)
      } else {
        fs.mkdirSync(path.dirname(destPath), { recursive: true })
        fs.copyFileSync(srcPath, destPath)
        created.push(path.relative(targetRoot, destPath))
      }
    }
  }
}

// ── Copy templates ────────────────────────────────────────────────────────────

const created = []

if (isNextjs) {
  // Next.js template drops files directly at the target root so they land in
  // the right relative positions for App Router (app/api/..., lib/, components/).
  copyDir(path.join(templateDir, 'nextjs'), targetRoot, created)
} else {
  if (!frontendOnly) {
    copyDir(
      path.join(templateDir, 'backend'),
      path.join(targetRoot, backendDirName),
      created,
    )
  }
  if (!backendOnly) {
    copyDir(
      path.join(templateDir, 'frontend'),
      path.join(targetRoot, frontendDirName),
      created,
    )
  }
}

// ── Summary ──────────────────────────────────────────────────────────────────

if (created.length === 0) {
  console.log('\nNothing to do — all template files already exist.\n')
  process.exit(0)
}

console.log('\nCreated:')
for (const f of created) console.log(`  ${f}`)

console.log('\nNext steps:')

if (isNextjs) {
  console.log(`
  Next.js
  ───────
  1. Install deps:
       npm install @bsv/wallet-relay @bsv/sdk ws qrcode
       npm install -D @types/ws @types/node

  2. Replace "dev" and "start" in package.json:
       "dev":   "NODE_ENV=development node server.mjs",
       "start": "node server.mjs"
     The custom server is required for WebSocket support — next dev won't work.

  3. Copy .env.example → .env (or set env vars directly):
       RELAY_URL  ws://localhost:3000    (must be ws:// or wss://)
       ORIGIN     http://localhost:3000  (where your Next.js app is served)
       PORT       3000

  4. Open lib/relay.ts and follow the TODO comment to swap in your BSV wallet.

  5. The components use Tailwind CSS. If your project doesn't have Tailwind:
       npm install -D tailwindcss @tailwindcss/postcss
     Then follow the Tailwind Next.js setup guide.
     Or strip the className strings and apply your own styles.

  6. Add a page that renders <WalletPairingView />:
       // app/wallet/page.tsx
       import { WalletPairingView } from '../../components/WalletPairingView'
       export default function WalletPage() {
         return <WalletPairingView />
       }

  7. Open components/WalletActions.tsx and add the wallet methods your app needs.

  If you use the src/ directory layout:
    - Move app/, components/, hooks/, types/, lib/ into src/
    - Update the relay import in server.mjs:
        import { initRelay } from './src/lib/relay.js'`)
} else {
  if (!frontendOnly) {
    const bdir = backendDirName
    console.log(`
  Backend
  ───────
  1. Install deps:
       npm install express cors ws qrcode @bsv/sdk
       npm install -D typescript @types/express @types/ws @types/node @types/qrcode

  2. Copy ${bdir}/.env.example → ${bdir}/.env and fill in your values.

  3. Open ${bdir}/server.ts — there is a prominent block at the top for
     EXISTING APPS showing how to plug WalletRelayService into your current
     Express app and HTTP server without touching the rest of the file.

  4. For a standalone server:
       npx ts-node ${bdir}/server.ts`)
  }

  if (!backendOnly) {
    const fdir = frontendDirName
    console.log(`
  Frontend (React + Vite)
  ───────────────────────
  1. Install @bsv/wallet-relay as a dependency (if not already):
       npm install @bsv/wallet-relay

  2. The components use Tailwind CSS. If your project doesn't have Tailwind:
       npm install -D tailwindcss @tailwindcss/vite
     Then add to your CSS entry point:
       @import "tailwindcss";
     Or strip the className strings and apply your own styles.

  3. Mount <DesktopView /> somewhere in your app:
       import { DesktopView } from './${fdir}/views/DesktopView'

  4. Open ${fdir}/components/WalletActions.tsx and add the wallet methods
     your app needs (clear TODO block inside).

  5. Make sure your Vite dev server proxies /api and /ws to the backend:
       // vite.config.ts
       server: {
         proxy: {
           '/api': 'http://localhost:3000',
           '/ws':  { target: 'ws://localhost:3000', ws: true },
         }
       }
     If your backend is on a different origin (not proxied), update the
     API constant at the top of ${fdir}/hooks/useWalletSession.ts.`)
  }
}

console.log()
