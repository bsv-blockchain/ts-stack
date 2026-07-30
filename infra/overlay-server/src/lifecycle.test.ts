import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { createOverlayLifecycle } from './lifecycle.js'

test('uses the package-owned close lifecycle once when available', async () => {
  let closeCalls = 0
  const runtime = {
    app: { listen: () => new EventEmitter() },
    close: async () => {
      closeCalls += 1
    }
  }
  const lifecycle = createOverlayLifecycle(runtime as never)

  await Promise.all([lifecycle.close(), lifecycle.close()])

  assert.equal(closeCalls, 1)
})

test('legacy lifecycle retains HTTP and closes background and database resources', async () => {
  const operations: string[] = []
  const httpServer = Object.assign(new EventEmitter(), {
    listening: true,
    close(callback: (error?: Error) => void) {
      operations.push('http')
      this.listening = false
      callback()
      return this
    }
  })
  const blockTimer = setInterval(() => {}, 60_000)
  const maintenanceTimer = setInterval(() => {}, 60_000)
  blockTimer.unref()
  maintenanceTimer.unref()
  const runtime = {
    app: {
      listen: () => httpServer
    },
    isListening: true,
    basmBlockPollTimer: blockTimer,
    unprovenMaintenanceTimer: maintenanceTimer,
    reorgAdapter: {
      stop: () => operations.push('reorg')
    },
    knex: {
      destroy: async () => {
        operations.push('knex')
      }
    },
    mongoClient: {
      close: async () => {
        operations.push('mongo')
      }
    },
    mongoDb: {}
  }
  const lifecycle = createOverlayLifecycle(runtime as never)

  runtime.app.listen()
  await lifecycle.close()
  await lifecycle.close()

  assert.equal(lifecycle.capturedServer(), httpServer)
  assert.equal(runtime.isListening, false)
  assert.equal(runtime.basmBlockPollTimer, undefined)
  assert.equal(runtime.unprovenMaintenanceTimer, undefined)
  assert.deepEqual(operations, ['reorg', 'http', 'knex', 'mongo'])
})
