import type { Express, Request, Response } from 'express'

export interface ServiceHealth {
  markReady: () => void
  markNotReady: () => void
  register: (app: Express) => void
}

class CloudServiceHealth implements ServiceHealth {
  private ready = false

  public readonly markReady = (): void => {
    this.ready = true
  }

  public readonly markNotReady = (): void => {
    this.ready = false
  }

  public readonly register = (app: Express): void => {
    app.get('/health', this.reportLiveness)
    app.get('/healthz', this.reportLiveness)
    app.get('/ready', this.reportReadiness)
  }

  private readonly reportLiveness = (_req: Request, res: Response): void => {
    res.status(200).json({ status: 'ok', live: true })
  }

  private readonly reportReadiness = (_req: Request, res: Response): void => {
    const status = this.ready ? 'ready' : 'starting'
    res.status(this.ready ? 200 : 503).json({ status, ready: this.ready })
  }
}

export const createServiceHealth = (): ServiceHealth => new CloudServiceHealth()
