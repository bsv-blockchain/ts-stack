import type { Request, Response } from 'express'
import { runtimeDeps } from '../runtimeDeps.js'

const NO_STORE = 'no-store'

export const healthRoute = {
  type: 'get',
  path: '/health',
  func: (_req: Request, res: Response): Response => {
    res.setHeader('Cache-Control', NO_STORE)
    return res.status(200).json({ status: 'ok' })
  }
}

export const readinessRoute = {
  type: 'get',
  path: '/ready',
  func: async (_req: Request, res: Response): Promise<Response> => {
    res.setHeader('Cache-Control', NO_STORE)
    try {
      if (runtimeDeps.knex == null) throw new Error('Database is not configured')
      await runtimeDeps.knex.raw('select 1')
      return res.status(200).json({ status: 'ready' })
    } catch {
      return res.status(503).json({
        status: 'error',
        code: 'ERR_NOT_READY',
        description: 'Message Box dependencies are not ready.'
      })
    }
  }
}
