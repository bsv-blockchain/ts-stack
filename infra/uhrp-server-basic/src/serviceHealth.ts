import type { Express, Request, Response } from 'express'

export interface ServiceHealth {
  markReady: () => void
  markNotReady: () => void
  register: (app: Express) => void
}

export const createServiceHealth = (): ServiceHealth => {
  let ready = false

  return {
    markReady: () => {
      ready = true
    },
    markNotReady: () => {
      ready = false
    },
    register: app => {
      app.get('/health', (_req: Request, res: Response) => {
        res.status(200).json({ status: 'ok', live: true })
      })
      app.get('/healthz', (_req: Request, res: Response) => {
        res.status(200).json({ status: 'ok', live: true })
      })
      app.get('/ready', (_req: Request, res: Response) => {
        res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'starting', ready })
      })
    }
  }
}
