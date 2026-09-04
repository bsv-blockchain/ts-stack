import type { Request, Response } from 'express'
import { getAuthMethodInstance } from '../auth-methods/AuthMethodFactory'
import { log } from '../logger'
import {
  isAuthMethodType,
  isAuthPayload,
  isHexIdentifier,
  isPositiveSafeInteger,
  isRecord,
  isUMPOutpoint
} from '../security/requestValidation'
import { PhoneChangeError, PhoneChangeService } from '../services/PhoneChangeService'
import { UserService } from '../services/UserService'

export class AdminController {
  static async reopenRegistration(req: Request, res: Response): Promise<Response> {
    try {
      if (!isRecord(req.body))
        return res.status(400).json({ message: 'Request body must be a JSON object.' })
      const { presentationKey, methodType, payload } = req.body
      if (req.body.confirmNoUMPToken !== true) {
        return res.status(400).json({
          message: 'confirmNoUMPToken must be true after a healthy verified UMP lookup.'
        })
      }
      let user
      if (isHexIdentifier(presentationKey)) {
        user = await UserService.getUserByPresentationKey(presentationKey)
      } else if (isAuthMethodType(methodType) && isAuthPayload(payload)) {
        const config = getAuthMethodInstance(methodType).buildConfigFromPayload(payload)
        user = await UserService.findUserByConfig(methodType, config)
      } else {
        return res.status(400).json({
          message: 'Identify the user with presentationKey or methodType and payload.'
        })
      }
      if (!user) return res.status(404).json({ message: 'User was not found.' })

      await UserService.reopenRegistration(user.id)
      log.warn(
        { operation: 'admin.registration.reopen', userId: user.id },
        'Registration reopened by support'
      )
      return res.json({ success: true, registrationStatus: 'pending' })
    } catch (error) {
      log.error({ operation: 'admin.registration.reopen', err: error }, 'Registration reopen failed')
      return res.status(500).json({ message: 'An internal error occurred.' })
    }
  }

  static async setUMPTokenPin(req: Request, res: Response): Promise<Response> {
    try {
      if (!isRecord(req.body))
        return res.status(400).json({ message: 'Request body must be a JSON object.' })
      const { presentationKey, methodType, payload, outpoint } = req.body
      if (outpoint !== null && !isUMPOutpoint(outpoint)) {
        return res.status(400).json({ message: 'outpoint must be a valid UMP outpoint or null.' })
      }

      let user
      if (isHexIdentifier(presentationKey)) {
        user = await UserService.getUserByPresentationKey(presentationKey)
      } else if (isAuthMethodType(methodType) && isAuthPayload(payload)) {
        const config = getAuthMethodInstance(methodType).buildConfigFromPayload(payload)
        user = await UserService.findUserByConfig(methodType, config)
      } else {
        return res.status(400).json({
          message: 'Identify the user with presentationKey or methodType and payload.'
        })
      }
      if (user == null) return res.status(404).json({ message: 'User was not found.' })

      await UserService.setUMPTokenOutpoint(user.id, outpoint)
      log.info(
        { operation: 'admin.ump_pin.set', userId: user.id, pinned: outpoint !== null },
        'UMP token pin updated'
      )
      return res.json({ success: true, pinned: outpoint !== null })
    } catch (error) {
      log.error({ operation: 'admin.ump_pin.set', err: error }, 'UMP token pin update failed')
      return res.status(500).json({ message: 'An internal error occurred.' })
    }
  }

  static async restorePhoneChange(req: Request, res: Response): Promise<Response> {
    try {
      if (!isRecord(req.body) || !isPositiveSafeInteger(req.body.changeId)) {
        return res.status(400).json({ message: 'A positive changeId is required.' })
      }
      await PhoneChangeService.restore(req.body.changeId)
      log.warn(
        { operation: 'admin.phone_change.restore', changeId: req.body.changeId },
        'Phone association restored by support'
      )
      return res.json({ success: true })
    } catch (error) {
      if (error instanceof PhoneChangeError) {
        return res.status(error.status).json({ message: error.message })
      }
      log.error({ operation: 'admin.phone_change.restore', err: error }, 'Phone restore failed')
      return res.status(500).json({ message: 'An internal error occurred.' })
    }
  }
}
