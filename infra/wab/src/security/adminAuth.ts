import { createHash, timingSafeEqual } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

export function requireWABAdmin(req: Request, res: Response, next: NextFunction): void {
  const configured = process.env.WAB_ADMIN_TOKEN
  if (configured == null || configured.length < 32) {
    res.status(404).json({ message: 'Not found.' })
    return
  }
  const header = req.header('authorization')
  const supplied = header?.startsWith('Bearer ') === true ? header.slice(7) : ''
  if (supplied.length === 0 || !timingSafeEqual(digest(configured), digest(supplied))) {
    res.status(401).json({ message: 'Administrative authorization required.' })
    return
  }
  next()
}
