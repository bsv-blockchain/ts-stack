import type { Server } from 'node:http'
import type OverlayExpress from '@bsv/overlay-express'

interface LegacyReorgAdapter {
  stop?: () => void
  controller?: AbortController
}

interface OverlayRuntime {
  app: OverlayExpress['app']
  close?: () => Promise<void>
  isListening?: boolean
  server?: Server
  knex?: { destroy: () => Promise<void> }
  mongoClient?: { close: () => Promise<void> }
  mongoDb?: unknown
  basmBlockPollTimer?: ReturnType<typeof setInterval>
  unprovenMaintenanceTimer?: ReturnType<typeof setInterval>
  reorgAdapter?: LegacyReorgAdapter
}

export interface OverlayLifecycle {
  close: () => Promise<void>
  capturedServer: () => Server | undefined
}

/**
 * Own the standalone process lifecycle across the published 2.4.2 runtime and
 * the source candidate that adds OverlayExpress.close().
 *
 * The app.listen wrapper changes no arguments or return value; it only retains
 * the HTTP listener that the older package otherwise discards. The explicit
 * compatibility cleanup can be removed once the published dependency baseline
 * provides the package-owned idempotent close operation.
 */
export function createOverlayLifecycle(server: OverlayExpress): OverlayLifecycle {
  const runtime = server as unknown as OverlayRuntime
  const originalListen = runtime.app.listen.bind(runtime.app)
  let capturedServer: Server | undefined
  runtime.app.listen = ((...args: unknown[]) => {
    capturedServer = Reflect.apply(originalListen, runtime.app, args) as Server
    return capturedServer
  }) as typeof runtime.app.listen

  let closePromise: Promise<void> | undefined
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      if (typeof runtime.close === 'function') {
        await runtime.close()
        return
      }

      runtime.isListening = false
      if (runtime.basmBlockPollTimer !== undefined) {
        clearInterval(runtime.basmBlockPollTimer)
        runtime.basmBlockPollTimer = undefined
      }
      if (runtime.unprovenMaintenanceTimer !== undefined) {
        clearInterval(runtime.unprovenMaintenanceTimer)
        runtime.unprovenMaintenanceTimer = undefined
      }
      if (typeof runtime.reorgAdapter?.stop === 'function') {
        runtime.reorgAdapter.stop()
      } else {
        runtime.reorgAdapter?.controller?.abort()
      }
      runtime.reorgAdapter = undefined

      const httpServer = runtime.server ?? capturedServer
      runtime.server = undefined
      if (httpServer?.listening === true) {
        await new Promise<void>((resolve, reject) => {
          httpServer.close(error => (error === undefined ? resolve() : reject(error)))
        })
      }

      await Promise.all([
        runtime.knex?.destroy() ?? Promise.resolve(),
        runtime.mongoClient?.close() ?? Promise.resolve()
      ])
      runtime.knex = undefined
      runtime.mongoClient = undefined
      runtime.mongoDb = undefined
    })()
    return closePromise
  }

  return {
    close,
    capturedServer: () => runtime.server ?? capturedServer
  }
}
