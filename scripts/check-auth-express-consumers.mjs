#!/usr/bin/env node

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { createCommandRunner } from './lib/command-runner.mjs'

const run = createCommandRunner({
  timeoutMs: 180_000,
  maxBufferBytes: 20 * 1024 * 1024
})

const profiles = [
  { label: 'Express 4', express: '4.22.1', types: '4.17.23' },
  { label: 'Express 5', express: '5.2.1', types: '5.0.6' }
]

const sources = {
  '@bsv/paymail': `import express, { type Router } from 'express'
import { PaymailRouter } from '@bsv/paymail'

const app = express()
const router: Router = new PaymailRouter({
  baseUrl: 'https://paymail.example.com',
  routes: []
}).getRouter()

app.use(router)
`,
  '@bsv/auth-express-middleware': `import express, { type RequestHandler } from 'express'
import type { WalletInterface } from '@bsv/sdk'
import { createAuthMiddleware, type AuthRequest } from '@bsv/auth-express-middleware'

declare const wallet: WalletInterface
const app = express()
const authentication: RequestHandler = createAuthMiddleware({ wallet })

app.use(authentication)
app.get('/private', (req: AuthRequest, res) => {
  res.json({ identityKey: req.auth?.identityKey })
})
`,
  '@bsv/payment-express-middleware': `import express, { type RequestHandler } from 'express'
import type { WalletInterface } from '@bsv/sdk'
import {
  createPaymentMiddleware,
  type PaymentRequest
} from '@bsv/payment-express-middleware'

declare const wallet: WalletInterface
const app = express()
const payment: RequestHandler = createPaymentMiddleware({ wallet })

app.use(payment)
app.get('/paid', (req: PaymentRequest, res) => {
  res.json({ satoshisPaid: req.payment?.satoshisPaid })
})
`,
  '@bsv/wallet-relay': `import express from 'express'
import { createServer } from 'node:http'
import {
  WalletRelayService,
  type WalletRelayServiceOptions
} from '@bsv/wallet-relay'

declare const wallet: WalletRelayServiceOptions['wallet']
const app = express()
const server = createServer(app)

new WalletRelayService({ app, server, wallet })
`
}

const tsconfig = {
  compilerOptions: {
    esModuleInterop: true,
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    noEmit: true,
    skipLibCheck: false,
    strict: true,
    target: 'ES2022'
  },
  include: ['consumer.mts']
}

async function pack(packageDirectory, temporaryDirectory) {
  const { stdout } = await run(
    'pnpm',
    ['pack', '--json', '--pack-destination', temporaryDirectory],
    {
      cwd: packageDirectory,
      env: { ...process.env, npm_config_ignore_scripts: 'true' }
    }
  )
  return path.resolve(JSON.parse(stdout).filename)
}

async function verifyProfile(packageName, source, tarball, profile, temporaryDirectory) {
  const consumerDirectory = path.join(
    temporaryDirectory,
    `express-${profile.express.split('.')[0]}-consumer`
  )
  await fs.mkdir(consumerDirectory)
  await Promise.all([
    fs.writeFile(
      path.join(consumerDirectory, 'package.json'),
      `${JSON.stringify({ private: true, type: 'module' }, null, 2)}\n`
    ),
    fs.writeFile(path.join(consumerDirectory, 'consumer.mts'), source),
    fs.writeFile(
      path.join(consumerDirectory, 'tsconfig.json'),
      `${JSON.stringify(tsconfig, null, 2)}\n`
    )
  ])
  await run(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      tarball,
      '@bsv/sdk@^2.1.6',
      `express@${profile.express}`,
      `@types/express@${profile.types}`,
      'typescript@5.9.3'
    ],
    { cwd: consumerDirectory }
  )
  await run(path.join(consumerDirectory, 'node_modules', '.bin', 'tsc'), ['--pretty', 'false'], {
    cwd: consumerDirectory
  })
  await run('npm', ['ls', '--all', 'express', '@types/express'], { cwd: consumerDirectory })
  const installedManifest = JSON.parse(
    await fs.readFile(
      path.join(consumerDirectory, 'node_modules', ...packageName.split('/'), 'package.json'),
      'utf8'
    )
  )
  if (
    installedManifest.dependencies?.express ||
    installedManifest.dependencies?.['@types/express']
  ) {
    throw new Error(
      `${packageName} ${profile.label} consumer received a nested Express runtime or type graph`
    )
  }
}

const packageDirectory = path.resolve(process.argv[2] ?? '.')
const packageManifest = JSON.parse(
  await fs.readFile(path.join(packageDirectory, 'package.json'), 'utf8')
)
const source = sources[packageManifest.name]
if (source === undefined) {
  throw new Error(`Unsupported Express middleware package: ${packageManifest.name}`)
}
const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'auth-express-consumers-'))
try {
  const tarball = await pack(packageDirectory, temporaryDirectory)
  for (const profile of profiles) {
    await verifyProfile(packageManifest.name, source, tarball, profile, temporaryDirectory)
  }
  console.log(`Verified ${packageManifest.name} clean TypeScript consumers on Express 4 and 5.`)
} finally {
  await fs.rm(temporaryDirectory, { recursive: true, force: true })
}
