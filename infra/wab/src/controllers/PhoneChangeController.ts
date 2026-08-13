import type { Request, Response } from 'express'
import { getAuthMethodInstance } from '../auth-methods/AuthMethodFactory'
import { log } from '../logger'
import { isAuthPayload, isHexIdentifier, isRecord } from '../security/requestValidation'
import { PhoneChangeError, PhoneChangeService } from '../services/PhoneChangeService'
import { UserService } from '../services/UserService'

const METHOD_TYPE = 'TwilioPhone'

function phonePayload(
  body: Record<string, unknown>,
  includeOtp: boolean
): Record<string, unknown> | undefined {
  if (typeof body.phoneNumber !== 'string') return undefined
  if (includeOtp && typeof body.otp !== 'string') return undefined
  return {
    phoneNumber: body.phoneNumber,
    ...(includeOtp ? { otp: body.otp } : {})
  }
}

export class PhoneChangeController {
  static async start(req: Request, res: Response): Promise<Response> {
    try {
      if (!isRecord(req.body) || !isHexIdentifier(req.body.presentationKey)) {
        return res
          .status(400)
          .json({ message: 'A current presentationKey and phoneNumber are required.' })
      }
      const payload = phonePayload(req.body, false)
      if (!isAuthPayload(payload)) {
        return res
          .status(400)
          .json({ message: 'A current presentationKey and phoneNumber are required.' })
      }
      const user = await UserService.getUserByPresentationKey(req.body.presentationKey)
      if (user == null)
        return res
          .status(401)
          .json({ message: 'The current wallet account could not be verified.' })

      const result = await getAuthMethodInstance(METHOD_TYPE).startAuth(
        req.body.presentationKey,
        payload
      )
      return res.json(result)
    } catch (error) {
      log.error(
        { operation: 'controller.phone_change.start', err: error },
        'Phone change start failed'
      )
      return res.status(500).json({ message: 'An internal error occurred.' })
    }
  }

  static async complete(req: Request, res: Response): Promise<Response> {
    try {
      if (!isRecord(req.body) || !isHexIdentifier(req.body.presentationKey)) {
        return res
          .status(400)
          .json({ message: 'A current presentationKey, phoneNumber, and otp are required.' })
      }
      const payload = phonePayload(req.body, true)
      if (!isAuthPayload(payload)) {
        return res
          .status(400)
          .json({ message: 'A current presentationKey, phoneNumber, and otp are required.' })
      }
      const user = await UserService.getUserByPresentationKey(req.body.presentationKey)
      if (user == null)
        return res
          .status(401)
          .json({ message: 'The current wallet account could not be verified.' })

      const authMethod = getAuthMethodInstance(METHOD_TYPE)
      const result = await authMethod.completeAuth(req.body.presentationKey, payload)
      if (!result.success) return res.json(result)
      const config = authMethod.buildConfigFromPayload(payload)
      const changeToken = await PhoneChangeService.createAuthorization(user.id, METHOD_TYPE, config)
      return res.json({ success: true, message: result.message, changeToken })
    } catch (error) {
      log.error(
        { operation: 'controller.phone_change.complete', err: error },
        'Phone change completion failed'
      )
      return res.status(500).json({ message: 'An internal error occurred.' })
    }
  }

  static async commit(req: Request, res: Response): Promise<Response> {
    try {
      if (
        !isRecord(req.body) ||
        typeof req.body.changeToken !== 'string' ||
        !/^[0-9a-fA-F]{64}$/.test(req.body.changeToken) ||
        !isHexIdentifier(req.body.presentationKey) ||
        !isHexIdentifier(req.body.newPresentationKey)
      ) {
        return res.status(400).json({
          message: 'A valid changeToken, presentationKey, and newPresentationKey are required.'
        })
      }
      const changeId = await PhoneChangeService.commit(
        req.body.changeToken,
        req.body.presentationKey,
        req.body.newPresentationKey
      )
      return res.json({ success: true, changeId })
    } catch (error) {
      if (error instanceof PhoneChangeError) {
        return res.status(error.status).json({ success: false, message: error.message })
      }
      log.error(
        { operation: 'controller.phone_change.commit', err: error },
        'Phone change commit failed'
      )
      return res.status(500).json({ message: 'An internal error occurred.' })
    }
  }
}
