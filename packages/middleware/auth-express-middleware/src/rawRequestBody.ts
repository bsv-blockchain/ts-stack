import type { Request, Response } from 'express'

export class RawRequestBodyError extends Error {
  constructor(readonly status: number) {
    super('The raw authentication request could not be read.')
  }
}

/** Optional receiver-first raw collector. No multipart extraction occurs here. */
export class RawRequestBodyReader {
  private bufferedBytes = 0
  private pending = 0
  private readonly captured = new WeakSet<Request>()

  constructor(
    private readonly maxRequestBytes: number,
    private readonly timeoutMs: number,
    private readonly maxPending: number,
    private readonly maxBufferedBytes = 64 * 1024 * 1024
  ) {
    if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1) {
      throw new RangeError('Raw request capture requires a finite positive maxRequestBytes.')
    }
  }

  hasCaptured(req: Request): boolean {
    return this.captured.has(req)
  }

  async capture(req: Request, res: Response): Promise<void> {
    if (req.body !== undefined || req.readableEnded || req.destroyed) {
      throw new RawRequestBodyError(400)
    }
    if (this.pending >= this.maxPending) throw new RawRequestBodyError(503)
    if (
      req.headers['content-encoding'] !== undefined &&
      req.headers['content-encoding'] !== 'identity'
    ) {
      throw new RawRequestBodyError(415)
    }
    const declared = req.headers['content-length']
    if (
      declared !== undefined &&
      (typeof declared !== 'string' ||
        !/^\d+$/.test(declared) ||
        !Number.isSafeInteger(Number(declared)))
    ) {
      throw new RawRequestBodyError(400)
    }
    if (declared !== undefined && Number(declared) > this.maxRequestBytes)
      throw new RawRequestBodyError(413)
    this.pending++
    let length = 0
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      this.pending--
      this.bufferedBytes -= length
      res.off('finish', release)
      res.off('close', release)
    }
    res.once('finish', release)
    res.once('close', release)
    try {
      await new Promise<void>((resolve, reject) => {
        const chunks: Buffer[] = []
        let settled = false
        const cleanup = (): void => {
          clearTimeout(timer)
          req.off('data', data)
          req.off('end', end)
          req.off('error', failed)
          req.off('aborted', failed)
          res.off('close', failed)
        }
        const fail = (status: number): void => {
          if (settled) return
          settled = true
          cleanup()
          req.pause()
          reject(new RawRequestBodyError(status))
        }
        const failed = (): void => fail(400)
        const data = (chunk: Buffer): void => {
          if (!Buffer.isBuffer(chunk)) return fail(400)
          if (length + chunk.length > this.maxRequestBytes) return fail(413)
          if (this.bufferedBytes + chunk.length > this.maxBufferedBytes) return fail(503)
          length += chunk.length
          this.bufferedBytes += chunk.length
          chunks.push(chunk)
        }
        const end = (): void => {
          if (declared !== undefined && Number(declared) !== length) return fail(400)
          settled = true
          cleanup()
          req.body = length === 0 ? undefined : Buffer.concat(chunks, length)
          this.captured.add(req)
          resolve()
        }
        const timer = setTimeout(() => fail(408), this.timeoutMs)
        timer.unref?.()
        req.on('data', data)
        req.once('end', end)
        req.once('error', failed)
        req.once('aborted', failed)
        res.once('close', failed)
      })
    } catch (error) {
      release()
      throw error
    }
  }
}
