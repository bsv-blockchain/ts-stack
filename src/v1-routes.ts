/**
 * V1 API Routes for ChaintracksService
 *
 * RPC-style API matching the original ChaintracksService endpoints
 */

import { Router, Request, Response } from 'express'
import { Chaintracks, Services } from '@bsv/wallet-toolbox'

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

export interface V1RoutesOptions {
  chaintracks: Chaintracks
  services?: Services
  chain: string
}

export function createV1Routes(options: V1RoutesOptions): Router {
  const { chaintracks, services, chain } = options
  const router = Router()

  // GET /getChain - Get blockchain network name
  router.get('/getChain', async (_req: Request, res: Response) => {
    try {
      res.json(success(chain))
    } catch (err) {
      res.status(500).json(error('ERR_INTERNAL', 'Failed to get chain'))
    }
  })

  // GET /getInfo - Get detailed service info
  router.get('/getInfo', async (_req: Request, res: Response) => {
    try {
      res.set('Cache-Control', 'no-cache')
      const info = await chaintracks.getInfo()
      res.json(success(info))
    } catch (err) {
      res.status(500).json(error('ERR_INTERNAL', 'Failed to get info'))
    }
  })

  // GET /getPresentHeight - Get current external blockchain height
  router.get('/getPresentHeight', async (_req: Request, res: Response) => {
    try {
      res.set('Cache-Control', 'no-cache')
      const height = await chaintracks.getPresentHeight()
      res.json(success(height))
    } catch (err) {
      res.status(500).json(error('ERR_INTERNAL', 'Failed to get present height'))
    }
  })

  // GET /findChainTipHashHex - Get chain tip hash as hex
  router.get('/findChainTipHashHex', async (_req: Request, res: Response) => {
    try {
      res.set('Cache-Control', 'no-cache')
      const hash = await chaintracks.findChainTipHash()
      if (!hash) {
        return res.status(404).json(error('ERR_NO_TIP', 'Chain tip not found'))
      }
      res.json(success(hash))
    } catch (err) {
      res.status(500).json(error('ERR_INTERNAL', 'Failed to get chain tip hash'))
    }
  })

  // GET /findChainTipHeaderHex - Get chain tip header
  router.get('/findChainTipHeaderHex', async (_req: Request, res: Response) => {
    try {
      res.set('Cache-Control', 'no-cache')
      const header = await chaintracks.findChainTipHeader()
      if (!header) {
        return res.status(404).json(error('ERR_NO_TIP', 'Chain tip not found'))
      }
      res.json(success(header))
    } catch (err) {
      res.status(500).json(error('ERR_INTERNAL', 'Failed to get chain tip header'))
    }
  })

  // GET /findHeaderHexForHeight - Get header by height (query param)
  router.get('/findHeaderHexForHeight', async (req: Request, res: Response) => {
    try {
      const height = parseInt(req.query.height as string, 10)
      if (isNaN(height) || height < 0) {
        return res.status(400).json(error('ERR_INVALID_PARAMS', 'Invalid or missing height parameter'))
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

  // GET /findHeaderHexForBlockHash - Get header by hash (query param)
  router.get('/findHeaderHexForBlockHash', async (req: Request, res: Response) => {
    try {
      const hash = req.query.hash as string
      if (!hash || !/^[a-fA-F0-9]{64}$/.test(hash)) {
        return res.status(400).json(error('ERR_INVALID_PARAMS', 'Invalid or missing hash parameter'))
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

  // GET /getHeaders - Get multiple headers as hex string
  router.get('/getHeaders', async (req: Request, res: Response) => {
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

      // Collect headers as hex string (160 hex chars = 80 bytes each)
      let hexString = ''
      for (let i = 0; i < count; i++) {
        const header = await chaintracks.findHeaderForHeight(height + i)
        if (!header) break
        // Convert to hex - version (8) + prevHash (64) + merkleRoot (64) + time (8) + bits (8) + nonce (8) = 160
        const versionHex = header.version.toString(16).padStart(8, '0')
        const timeHex = header.time.toString(16).padStart(8, '0')
        const bitsHex = header.bits.toString(16).padStart(8, '0')
        const nonceHex = header.nonce.toString(16).padStart(8, '0')
        // Little-endian conversion for numeric fields
        const versionLE = versionHex.match(/.{2}/g)!.reverse().join('')
        const timeLE = timeHex.match(/.{2}/g)!.reverse().join('')
        const bitsLE = bitsHex.match(/.{2}/g)!.reverse().join('')
        const nonceLE = nonceHex.match(/.{2}/g)!.reverse().join('')
        hexString += versionLE + header.previousHash + header.merkleRoot + timeLE + bitsLE + nonceLE
      }

      res.json(success(hexString))
    } catch (err) {
      res.status(500).json(error('ERR_INTERNAL', 'Failed to get headers'))
    }
  })

  // POST /addHeaderHex - Submit new block header
  router.post('/addHeaderHex', async (req: Request, res: Response) => {
    try {
      const { version, previousHash, merkleRoot, time, bits, nonce } = req.body

      if (version === undefined || !previousHash || !merkleRoot || time === undefined || bits === undefined || nonce === undefined) {
        return res.status(400).json(error('ERR_INVALID_PARAMS', 'Missing required header fields'))
      }

      await chaintracks.addHeader({
        version,
        previousHash,
        merkleRoot,
        time,
        bits,
        nonce
      })

      res.json(success(true))
    } catch (err) {
      res.status(500).json(error('ERR_INTERNAL', 'Failed to add header'))
    }
  })

  // GET /getFiatExchangeRates - Get BSV exchange rates (requires services)
  router.get('/getFiatExchangeRates', async (_req: Request, res: Response) => {
    try {
      if (!services) {
        return res.status(501).json(error('ERR_NOT_IMPLEMENTED', 'Services not configured'))
      }
      const rates = await services.getFiatExchangeRate('USD')
      res.json(success(rates))
    } catch (err) {
      res.status(500).json(error('ERR_INTERNAL', 'Failed to get exchange rates'))
    }
  })

  return router
}
