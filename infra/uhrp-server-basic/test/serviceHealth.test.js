const express = require('express')
const { createServiceHealth } = require('../out/src/serviceHealth')

const listen = async app =>
  await new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('Expected TCP address')
      resolve({ origin: `http://127.0.0.1:${address.port}`, server })
    })
  })

const close = async server =>
  await new Promise((resolve, reject) => {
    server.close(error => (error === undefined ? resolve() : reject(error)))
  })

test('reports liveness immediately and readiness only after initialization', async () => {
  const app = express()
  const health = createServiceHealth()
  health.register(app)
  const { origin, server } = await listen(app)

  try {
    const live = await fetch(`${origin}/health`)
    expect(live.status).toBe(200)
    await expect(live.json()).resolves.toEqual({ status: 'ok', live: true })

    const starting = await fetch(`${origin}/ready`)
    expect(starting.status).toBe(503)
    await expect(starting.json()).resolves.toEqual({ status: 'starting', ready: false })

    health.markReady()
    const ready = await fetch(`${origin}/ready`)
    expect(ready.status).toBe(200)
    await expect(ready.json()).resolves.toEqual({ status: 'ready', ready: true })
  } finally {
    await close(server)
  }
})
