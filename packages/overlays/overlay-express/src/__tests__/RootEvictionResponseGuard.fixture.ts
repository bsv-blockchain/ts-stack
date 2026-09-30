import express from 'express'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { AuthFetch, CompletedProtoWallet, PrivateKey } from '@bsv/sdk'
import { createAuthMiddleware } from '@bsv/auth-express-middleware'
import {
  guardRootAdvertisementResponse,
  type RootAdvertisementSendJournal
} from '../RootEvictionResponseGuard.js'
import {
  fixture,
  selected
} from '../../../../application/output-knowledge/test/root-eviction-fixture.js'

export async function rootResponseFixture() {
  const root = await fixture()
  let target = selected()
  await root.store.assess({
    operationId: 'fixture_http_initial',
    expectedRevision: '0',
    target,
    eligible: true,
    evidenceDigest: '11'.repeat(32),
    reasonCode: 'fixture-local-assessment'
  })
  await root.store.projected((await root.store.projections(1))[0])
  const wallet = new CompletedProtoWallet(new PrivateKey(82)),
    caller = new CompletedProtoWallet(new PrivateKey(81))
  let onSign: (() => void | Promise<void>) | undefined,
    beforeSend: (() => void | Promise<void>) | undefined,
    afterInstall: (() => void) | undefined,
    armed = false,
    dataAccess = true,
    controlAccess = true,
    journal: RootAdvertisementSendJournal = root.store
  const signatures: number[] = [],
    checks: { identity: string; kind: string }[] = [],
    wireHeaders: Headers[] = []
  const sign = wallet.createSignature.bind(wallet)
  wallet.createSignature = async (...args) => {
    const signature = await sign(...args)
    if (armed) {
      signatures.push(signatures.length)
      await onSign?.()
    }
    return signature
  }
  const app = express()
  app.use(express.json())
  app.use(createAuthMiddleware({ wallet, transportLimits: { requestTimeoutMs: 2000 } }))
  app.post('/advertisements', async (_req, res) => {
    try {
      const revision = (await root.store.head()).revision
      guardRootAdvertisementResponse(res, {
        journal,
        revision,
        targets: [target],
        authorize(identity, kind) {
          checks.push({ identity, kind })
          return kind === 'data' ? dataAccess : controlAccess
        },
        controlHeaders: {
          'access-control-allow-origin': 'https://client.example.test',
          'x-bsv-overlay-profile': 'fixture-explicit-selection'
        }
      })
      afterInstall?.()
      await beforeSend?.()
      armed = true
      res
        .status(200)
        .set('x-bsv-private', 'private-candidate-metadata')
        .json({ output: 'original' })
    } catch {
      res.destroy()
    }
  })
  const server = createServer(app)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/advertisements`
  const client = new AuthFetch(caller, undefined, undefined, undefined, {}, async (...args) => {
    const response = await fetch(...args)
    wireHeaders.push(response.headers)
    return response
  })
  return {
    ...root,
    checks,
    signatures,
    wireHeaders,
    client,
    url,
    setTarget(value: typeof target) {
      target = value
    },
    setJournal(value: RootAdvertisementSendJournal) {
      journal = value
    },
    setAccess(data: boolean, control: boolean) {
      dataAccess = data
      controlAccess = control
    },
    onSign(callback: () => void | Promise<void>) {
      onSign = callback
    },
    beforeSend(callback: () => void | Promise<void>) {
      beforeSend = callback
    },
    afterInstall(callback: () => void) {
      afterInstall = callback
    },
    fetch() {
      return client.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      })
    },
    async cleanup() {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve()))
      )
      await root.cleanup()
    }
  }
}
