import type { Request, Response } from 'express'
import {
  DemoAccountError,
  DemoAccountService,
  isDemoAuthEnabled
} from '../services/DemoAccountService'
import { isRecord } from '../security/requestValidation'
import { log } from '../logger'

export class DemoAccountController {
  static async manage(req: Request, res: Response): Promise<Response> {
    res.setHeader('Cache-Control', 'no-store')
    try {
      if (!isDemoAuthEnabled()) return res.status(404).json({ message: 'Not found.' })
      if (!isRecord(req.body)) throw new DemoAccountError('A JSON object is required.')
      const { action, phoneNumber, label, expiresAtEpochMs, id } = req.body
      if (action === 'list') return res.json({ accounts: await DemoAccountService.list() })
      if (action === 'provision' && typeof phoneNumber === 'string' && typeof label === 'string') {
        const result = await DemoAccountService.provision(phoneNumber, label, expiresAtEpochMs)
        log.info(
          { operation: 'admin.demo.provision', demoId: result.id },
          'Demo access provisioned'
        )
        return res.status(201).json(result)
      }
      if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) {
        throw new DemoAccountError('A supported action and valid demo account id are required.')
      }
      if (action === 'rotate') {
        const result = await DemoAccountService.rotate(id, expiresAtEpochMs)
        log.info({ operation: 'admin.demo.rotate', demoId: id }, 'Demo access code rotated')
        return res.json(result)
      }
      if (action === 'revoke') {
        await DemoAccountService.revoke(id)
        log.info({ operation: 'admin.demo.revoke', demoId: id }, 'Demo access revoked')
        return res.json({ success: true })
      }
      throw new DemoAccountError('Unsupported demo account action.')
    } catch (error) {
      if (error instanceof DemoAccountError)
        return res.status(error.status).json({ message: error.message })
      // Do not serialize SQL errors: database bindings include credential digests.
      log.error(
        { operation: 'admin.demo.manage', outcome: 'error' },
        'Demo account operation failed'
      )
      return res.status(500).json({ message: 'An internal error occurred.' })
    }
  }
}
