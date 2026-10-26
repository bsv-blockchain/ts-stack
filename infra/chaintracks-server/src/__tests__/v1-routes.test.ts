import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import bodyParser from 'body-parser'
import express from 'express'
import type { Server } from 'node:http'
import { createV1Routes } from '../v1-routes'

const submitted: unknown[] = []
let rejectAtCapacity = false
const chaintracks = {
  addHeader: async (header: unknown) => {
    if (rejectAtCapacity) {
      throw Object.assign(new Error('The submitted block-header queue is at capacity.'), {
        code: 'ERR_CHAINTRACKS_QUEUE_CAPACITY'
      })
    }
    submitted.push(header)
  }
}
let server: Server
let origin: string

before(async () => {
  const app = express()
  app.use(bodyParser.json())
  app.use(createV1Routes({ chaintracks: chaintracks as never, chain: 'main' }))
  server = await new Promise<Server>(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })
  const address = server.address()
  if (address == null || typeof address === 'string') throw new Error('Missing test address')
  origin = `http://127.0.0.1:${address.port}`
})

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close(error => (error == null ? resolve() : reject(error)))
  )
})

test('rejects malformed header submissions before the Chaintracks queue', async () => {
  const response = await fetch(`${origin}/addHeaderHex`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      version: 1,
      previousHash: 'not-a-hash',
      merkleRoot: '11'.repeat(32),
      time: 1,
      bits: 0x1d00ffff,
      nonce: 2
    })
  })
  assert.equal(response.status, 400)
  assert.equal(submitted.length, 0)
})

test('maps queue saturation to a retryable service-capacity response', async () => {
  rejectAtCapacity = true
  const response = await fetch(`${origin}/addHeaderHex`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      version: 1,
      previousHash: '00'.repeat(32),
      merkleRoot: '11'.repeat(32),
      time: 1,
      bits: 0x1d00ffff,
      nonce: 2
    })
  })
  assert.equal(response.status, 503)
  assert.equal(response.headers.get('retry-after'), '1')
  rejectAtCapacity = false
})
