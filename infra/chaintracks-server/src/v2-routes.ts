/**
 * V2 API Routes for ChaintracksService
 *
 * RESTful API with path parameters matching go-chaintracks v2 API
 */

import { Router, Request, Response } from 'express'
import { Chaintracks } from '@bsv/wallet-toolbox'

interface ApiResponse {
  status: 'success' | 'error'
  value?: unknown
  code?: string
  description?: string
}

function success(value: unknown): ApiResponse {
  return { status: 'success', value }
}

function error(code: string, description: string): ApiResponse {
  return { status: 'error', code, description }
}

// Reverse a hex string's byte order (for converting display hash to internal byte order)
function reverseHex(hex: string): Buffer {
  const buf = Buffer.from(hex, 'hex')
  return buf.reverse()
}

// Convert header to 80-byte binary format
// Note: previousHash and merkleRoot are byte-reversed in JSON (display format)
// but need to be in internal byte order for binary serialization
function headerToBytes(header: { version: number; previousHash: string; merkleRoot: string; time: number; bits: number; nonce: number }): Buffer {
  const buf = Buffer.alloc(80)
  buf.writeUInt32LE(header.version, 0)
  reverseHex(header.previousHash).copy(buf, 4)   // Reverse from display to internal
  reverseHex(header.merkleRoot).copy(buf, 36)    // Reverse from display to internal
  buf.writeUInt32LE(header.time, 68)
  buf.writeUInt32LE(header.bits, 72)
  buf.writeUInt32LE(header.nonce, 76)
  return buf
}

export function createV2Routes(chaintracks: Chaintracks): Router {
  const router = Router()

  // GET /v2/network - Get blockchain network name
  router.get('/network', async (_req: Request, res: Response) => {
    try {
      const network = chaintracks.chain
      res.json(success(network))
    } catch (err) {
      res.status(500).json(error('ERR_INTERNAL', 'Failed to get network'))
    }
  })

  // GET /v2/tip - Get chain tip header
  router.get('/tip', async (_req: Request, res: Response) => {
    try {
      res.set('Cache-Control', 'no-cache')
      const header = await chaintracks.findChainTipHeader()
      if (!header) {
        return res.status(404).json(error('ERR_NO_TIP', 'Chain tip not found'))
      }
      res.json(success(header))
    } catch (err) {
      res.status(500).json(error('ERR_INTERNAL', 'Failed to get chain tip'))
    }
  })

  // GET /v2/header/height/:height - Get header by height
  router.get('/header/height/:height', async (req: Request, res: Response) => {
    try {
      const height = parseInt(req.params.height, 10)
      if (isNaN(height) || height < 0) {
        return res.status(400).json(error('ERR_INVALID_PARAMS', 'Invalid height parameter'))
      }

      const currentHeight = await chaintracks.currentHeight()
      if (height < currentHeight - 100) {
        res.set('Cache-Control', 'public, max-age=3600')
      } else {
        res.set('Cache-Control', 'no-cache')
      }

      const header = await chaintracks.findHeaderForHeight(height)
      if (!header) {
        return res.status(404).json(error('ERR_NOT_FOUND', `Header not found at height ${height}`))
      }
      res.json(success(header))
    } catch (err) {
      res.status(500).json(error('ERR_INTERNAL', 'Failed to get header'))
    }
  })

  // GET /v2/header/hash/:hash - Get header by hash
  router.get('/header/hash/:hash', async (req: Request, res: Response) => {
    try {
      const hash = req.params.hash
      if (!hash || !/^[a-fA-F0-9]{64}$/.test(hash)) {
        return res.status(400).json(error('ERR_INVALID_PARAMS', 'Invalid hash parameter'))
      }

      const header = await chaintracks.findHeaderForBlockHash(hash)
      if (!header) {
        return res.status(404).json(error('ERR_NOT_FOUND', `Header not found for hash ${hash}`))
      }

      const currentHeight = await chaintracks.currentHeight()
      if (header.height < currentHeight - 100) {
        res.set('Cache-Control', 'public, max-age=3600')
      } else {
        res.set('Cache-Control', 'no-cache')
      }

      res.json(success(header))
    } catch (err) {
      res.status(500).json(error('ERR_INTERNAL', 'Failed to get header'))
    }
  })

  // GET /v2/headers?height=N&count=M - Get multiple headers as binary
  router.get('/headers', async (req: Request, res: Response) => {
    try {
      const height = parseInt(req.query.height as string, 10)
      const count = parseInt(req.query.count as string, 10)

      if (isNaN(height) || height < 0) {
        return res.status(400).json(error('ERR_INVALID_PARAMS', 'Invalid or missing height parameter'))
      }
      if (isNaN(count) || count <= 0) {
        return res.status(400).json(error('ERR_INVALID_PARAMS', 'Invalid or missing count parameter'))
      }

      const currentHeight = await chaintracks.currentHeight()
      if (height < currentHeight - 100) {
        res.set('Cache-Control', 'public, max-age=3600')
      } else {
        res.set('Cache-Control', 'no-cache')
      }

      // Collect headers as binary (80 bytes each)
      const buffers: Buffer[] = []
      for (let i = 0; i < count; i++) {
        const header = await chaintracks.findHeaderForHeight(height + i)
        if (!header) break
        buffers.push(headerToBytes(header))
      }

      res.set('Content-Type', 'application/octet-stream')
      res.send(Buffer.concat(buffers))
    } catch (err) {
      res.status(500).json(error('ERR_INTERNAL', 'Failed to get headers'))
    }
  })

  // Binary routes (80 bytes per header, height returned in X-Block-Height header)

  // GET /v2/tip.bin - Get chain tip as 80-byte binary
  router.get('/tip.bin', async (_req: Request, res: Response) => {
    try {
      res.set('Cache-Control', 'no-cache')
      const header = await chaintracks.findChainTipHeader()
      if (!header) {
        return res.status(404).json(error('ERR_NO_TIP', 'Chain tip not found'))
      }
      res.set('Content-Type', 'application/octet-stream')
      res.set('X-Block-Height', String(header.height))
      res.send(headerToBytes(header))
    } catch (err) {
      res.status(500).json(error('ERR_INTERNAL', 'Failed to get chain tip'))
    }
  })

  // GET /v2/header/height/:height.bin - Get header by height as 80-byte binary
  router.get('/header/height/:height.bin', async (req: Request, res: Response) => {
    try {
      const heightStr = req.params.height.replace('.bin', '')
      const height = parseInt(heightStr, 10)
      if (isNaN(height) || height < 0) {
        return res.status(400).json(error('ERR_INVALID_PARAMS', 'Invalid height parameter'))
      }

      const currentHeight = await chaintracks.currentHeight()
      if (height < currentHeight - 100) {
        res.set('Cache-Control', 'public, max-age=3600')
      } else {
        res.set('Cache-Control', 'no-cache')
      }

      const header = await chaintracks.findHeaderForHeight(height)
      if (!header) {
        return res.status(404).json(error('ERR_NOT_FOUND', `Header not found at height ${height}`))
      }
      res.set('Content-Type', 'application/octet-stream')
      res.set('X-Block-Height', String(header.height))
      res.send(headerToBytes(header))
    } catch (err) {
      res.status(500).json(error('ERR_INTERNAL', 'Failed to get header'))
    }
  })

  // GET /v2/header/hash/:hash.bin - Get header by hash as 80-byte binary
  router.get('/header/hash/:hash.bin', async (req: Request, res: Response) => {
    try {
      const hash = req.params.hash.replace('.bin', '')
      if (!hash || !/^[a-fA-F0-9]{64}$/.test(hash)) {
        return res.status(400).json(error('ERR_INVALID_PARAMS', 'Invalid hash parameter'))
      }

      const header = await chaintracks.findHeaderForBlockHash(hash)
      if (!header) {
        return res.status(404).json(error('ERR_NOT_FOUND', `Header not found for hash ${hash}`))
      }

      const currentHeight = await chaintracks.currentHeight()
      if (header.height < currentHeight - 100) {
        res.set('Cache-Control', 'public, max-age=3600')
      } else {
        res.set('Cache-Control', 'no-cache')
      }

      res.set('Content-Type', 'application/octet-stream')
      res.set('X-Block-Height', String(header.height))
      res.send(headerToBytes(header))
    } catch (err) {
      res.status(500).json(error('ERR_INTERNAL', 'Failed to get header'))
    }
  })

  // GET /v2/headers.bin?height=N&count=M - Get multiple headers as binary (80 bytes each)
  router.get('/headers.bin', async (req: Request, res: Response) => {
    try {
      const height = parseInt(req.query.height as string, 10)
      const count = parseInt(req.query.count as string, 10)

      if (isNaN(height) || height < 0) {
        return res.status(400).json(error('ERR_INVALID_PARAMS', 'Invalid or missing height parameter'))
      }
      if (isNaN(count) || count <= 0) {
        return res.status(400).json(error('ERR_INVALID_PARAMS', 'Invalid or missing count parameter'))
      }

      const currentHeight = await chaintracks.currentHeight()
      if (height < currentHeight - 100) {
        res.set('Cache-Control', 'public, max-age=3600')
      } else {
        res.set('Cache-Control', 'no-cache')
      }

      // Collect headers as binary (80 bytes each)
      const buffers: Buffer[] = []
      let headerCount = 0
      for (let i = 0; i < count; i++) {
        const header = await chaintracks.findHeaderForHeight(height + i)
        if (!header) break
        buffers.push(headerToBytes(header))
        headerCount++
      }

      res.set('Content-Type', 'application/octet-stream')
      res.set('X-Start-Height', String(height))
      res.set('X-Header-Count', String(headerCount))
      res.send(Buffer.concat(buffers))
    } catch (err) {
      res.status(500).json(error('ERR_INTERNAL', 'Failed to get headers'))
    }
  })

  return router
}
