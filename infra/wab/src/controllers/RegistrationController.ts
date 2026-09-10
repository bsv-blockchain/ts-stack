import type { Request, Response } from 'express'
import { log } from '../logger'
import { isHexIdentifier, isRecord } from '../security/requestValidation'
import { UserService } from '../services/UserService'

export class RegistrationController {
  static async finalize(req: Request, res: Response): Promise<Response> {
    try {
      if (!isRecord(req.body) || !isHexIdentifier(req.body.presentationKey)) {
        return res.status(400).json({ message: 'A valid 32-byte presentationKey is required.' })
      }
      const user = await UserService.finalizeRegistration(req.body.presentationKey)
      if (!user) return res.status(404).json({ message: 'Registration was not found.' })

      log.info(
        { operation: 'auth.registration.finalize', userId: user.id, outcome: 'success' },
        'Registration finalized'
      )
      return res.json({ success: true, registrationStatus: user.registrationStatus })
    } catch (error) {
      log.error(
        { operation: 'auth.registration.finalize', err: error, outcome: 'error' },
        'Registration finalize failed'
      )
      return res.status(500).json({ message: 'An internal error occurred.' })
    }
  }
}
