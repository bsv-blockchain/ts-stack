/**
 * UserController
 *
 * Provides endpoints to get the list of linked Auth Methods, unlink an Auth Method,
 * or delete the user's account while retaining detached faucet-abuse evidence.
 */

import { Request, Response } from 'express'
import { UserService } from '../services/UserService'
import {
  isHexIdentifier,
  isPositiveSafeInteger,
  snapshotRequestBody
} from '../security/requestValidation'
import { log } from '../logger'
import { User } from '../types'

type PresentedUser =
  { success: true; user: User } | { success: false; status: 400 | 404; message: string }

async function resolvePresentedUser(body: unknown): Promise<PresentedUser> {
  const snapshot = snapshotRequestBody(body)
  if (snapshot == null || !isHexIdentifier(snapshot.presentationKey)) {
    return {
      success: false,
      status: 400,
      message: 'A 32-byte presentationKey is required.'
    }
  }
  const user = await UserService.getUserByPresentationKey(snapshot.presentationKey)
  return user ? { success: true, user } : { success: false, status: 404, message: 'User not found' }
}

function sendPresentedUserFailure(res: Response, resolution: PresentedUser & { success: false }) {
  return res.status(resolution.status).json({ message: resolution.message })
}

export class UserController {
  /**
   * List the user's linked Auth Methods.
   * Body must include { presentationKey } as proof of authentication.
   */
  public static async listLinkedMethods(req: Request, res: Response) {
    try {
      const resolution = await resolvePresentedUser(req.body)
      if (!resolution.success) {
        return sendPresentedUserFailure(res, resolution)
      }

      const authMethods = await UserService.getAuthMethodsByUserId(resolution.user.id)
      res.json({ success: true, authMethods })
    } catch (error: any) {
      log.error(
        { operation: 'controller.user.list_linked_methods', err: error, outcome: 'error' },
        'listLinkedMethods failed'
      )
      res.status(500).json({ message: 'An internal error occurred.' })
    }
  }

  /**
   * Unlink a single AuthMethod from the user.
   * Body must include { presentationKey, authMethodId }.
   */
  public static async unlinkMethod(req: Request, res: Response) {
    try {
      const body = snapshotRequestBody(req.body)
      if (body == null) {
        return res.status(400).json({ message: 'Request body must be a JSON object.' })
      }
      const { presentationKey, authMethodId } = body
      if (!isHexIdentifier(presentationKey) || !isPositiveSafeInteger(authMethodId)) {
        return res
          .status(400)
          .json({ message: 'A 32-byte presentationKey and positive authMethodId are required.' })
      }

      const user = await UserService.getUserByPresentationKey(presentationKey)
      if (!user) {
        return res.status(404).json({ message: 'User not found' })
      }

      const method = await UserService.getAuthMethodById(authMethodId)
      if (method?.userId !== user.id) {
        return res.status(404).json({ message: 'Auth Method not found or not linked to user' })
      }

      if (!(await UserService.deleteAuthMethodById(method.id, user.id))) {
        return res.status(404).json({ message: 'Auth Method not found or not linked to user' })
      }
      res.json({ success: true, message: 'Auth Method unlinked.' })
    } catch (error: any) {
      log.error(
        { operation: 'controller.user.unlink_method', err: error, outcome: 'error' },
        'unlinkMethod failed'
      )
      res.status(500).json({ message: 'An internal error occurred.' })
    }
  }

  /**
   * Delete the user account while retaining detached abuse-prevention evidence.
   * Body must include { presentationKey }.
   */
  public static async deleteUser(req: Request, res: Response) {
    try {
      const resolution = await resolvePresentedUser(req.body)
      if (!resolution.success) {
        return sendPresentedUserFailure(res, resolution)
      }

      await UserService.deleteUserByPresentationKey(resolution.user.presentationKey)
      res.json({
        success: true,
        message:
          'Account deleted. Detached authentication identity and faucet-payment evidence are retained only to enforce the one-time faucet policy.'
      })
    } catch (error: any) {
      log.error(
        { operation: 'controller.user.delete_user', err: error, outcome: 'error' },
        'deleteUser failed'
      )
      res.status(500).json({ message: 'An internal error occurred.' })
    }
  }
}
