/**
 * @file sendMessage.ts
 * @description
 * Route handler to send a message to another identity's messageBox.
 * This route is used for P2P communication in the MessageBox system.
 *
 * It handles:
 * - Validation of message structure
 * - Validation of the recipient public key
 * - MessageBox creation if one doesn't exist
 * - Insertion of the message into the database
 * - Deduplication based on messageId
 *
 */

import { Response } from 'express'
import knexConfig from '../../knexfile.js'
import * as knexLib from 'knex'
import {
  AtomicBEEF,
  Base64String,
  BasketStringUnder300Bytes,
  BooleanDefaultTrue,
  DescriptionString5to50Bytes,
  LabelStringUnder300Bytes,
  OutputTagStringUnder300Bytes,
  PositiveIntegerOrZero,
  PubKeyHex,
  PublicKey,
} from '@bsv/sdk'
import { Logger } from '../utils/logger.js'
import { AuthRequest } from '@bsv/auth-express-middleware'
import { sendFCMNotification } from '../utils/sendFCMNotification.js'
import { getRecipientFee, getServerDeliveryFee, shouldUseFCMDelivery } from '../utils/messagePermissions.js'

// Determine the environment (default to development)
const { NODE_ENV = 'development', SERVER_PRIVATE_KEY } = process.env

/**
 * Knex instance connected based on environment (development, production, or staging).
 */
const knex: knexLib.Knex =
  (knexLib as any).default?.(
    NODE_ENV === 'production' || NODE_ENV === 'staging'
      ? knexConfig.production
      : knexConfig.development
  ) ??
  (knexLib as any)(
    NODE_ENV === 'production' || NODE_ENV === 'staging'
      ? knexConfig.production
      : knexConfig.development
  )

// Type definition for the incoming message format
export interface Message {
  // Back-compat: accept 'recipient' (string or array) AND new 'recipients' (array)
  recipient: PubKeyHex | PubKeyHex[]
  recipients?: PubKeyHex[]
  messageBox: string
  messageId: string | string[] // one per recipient, same order as recipients
  body: string
}

export interface Payment {
  tx: AtomicBEEF
  outputs: Array<{
    outputIndex: PositiveIntegerOrZero
    protocol: 'wallet payment' | 'basket insertion'
    paymentRemittance?: {
      derivationPrefix: Base64String
      derivationSuffix: Base64String
      senderIdentityKey: PubKeyHex
      // NOTE: We intentionally do NOT type this strictly;
      // some clients may include a JSON string here.
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore - custom extension
      customInstructions?: unknown
    }
    insertionRemittance?: {
      basket: BasketStringUnder300Bytes
      customInstructions?: string
      tags?: OutputTagStringUnder300Bytes[]
    }
  }>
  description: DescriptionString5to50Bytes
  labels?: LabelStringUnder300Bytes[]
  seekPermission?: BooleanDefaultTrue
}

export interface SendMessageRequest extends AuthRequest {
  body: {
    message?: Message
    payment?: Payment
  }
}

// Validate critical server-side secret
if (SERVER_PRIVATE_KEY == null || SERVER_PRIVATE_KEY.trim() === '') {
  throw new Error('SERVER_PRIVATE_KEY is not defined in the environment variables.')
}

/**
 * @function calculateMessagePrice
 * @description Determines the price (in satoshis) to send a message, optionally with priority.
 */
export function calculateMessagePrice(message: string, priority: boolean = false): number {
  const basePrice = 2 // Base fee in satoshis
  const sizeFactor = Math.ceil(Buffer.byteLength(message, 'utf8') / 1024) * 3 // Satoshis per KB
  return basePrice + sizeFactor
}

/**
 * @openapi
 * /sendMessage:
 *   post:
 *     summary: Send a message to a recipient’s message box
 *     description: |
 *       Inserts a message into the target recipient’s message box on the server.
 *       The recipient, message box name, and message ID must be provided.
 *     tags:
 *       - Message
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               message:
 *                 type: object
 *                 required:
 *                   - recipient
 *                   - messageBox
 *                   - messageId
 *                   - body
 *                 properties:
 *                   recipient:
 *                     type: string
 *                     description: Identity key of the recipient
 *                   messageBox:
 *                     type: string
 *                     description: The name of the recipient's message box
 *                   messageId:
 *                     type: string
 *                     description: Unique identifier for the message (usually an HMAC)
 *                   body:
 *                     oneOf:
 *                       - type: string
 *                       - type: object
 *                     description: The message content
 *     responses:
 *       200:
 *         description: Message stored successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 messageId:
 *                   type: string
 *                 message:
 *                   type: string
 *       400:
 *         description: Invalid request or duplicate message
 *       500:
 *         description: Internal server error
 */

/**
 * @exports
 * Express-compatible route definition for `/sendMessage`, used to send messages to other users.
 * Contains metadata for auto-generation of route documentation and Swagger/OpenAPI integration.
 */
export default {
  type: 'post',
  path: '/sendMessage',
  knex,
  summary: "Use this route to send a message to a recipient's message box.",
  parameters: {
    message: {
      recipient: '028d37b941208cd6b8a4c28288eda5f2f16c2b3ab0fcb6d13c18b47fe37b971fc1',
      messageBox: 'payment_inbox',
      messageId: 'xyz123',
      body: '{}'
    }
  },
  exampleResponse: { status: 'success' },

  func: async (req: SendMessageRequest, res: Response): Promise<Response> => {
    Logger.log('[DEBUG] Processing /sendMessage request...')
    Logger.log('[DEBUG] Request Headers:', JSON.stringify(req.headers, null, 2))

    const senderKey = req.auth?.identityKey
    if (senderKey == null) {
      return res.status(401).json({
        status: 'error',
        code: 'ERR_AUTH_REQUIRED',
        description: 'Authentication required'
      })
    }

    try {
      const { message, payment } = req.body
      console.log('Received message send request from:', message, payment)

      if (message == null) {
        Logger.error('[ERROR] No message provided in request body!')
        return res.status(400).json({
          status: 'error',
          code: 'ERR_MESSAGE_REQUIRED',
          description: 'Please provide a valid message to send!'
        })
      }

      if (typeof message.messageBox !== 'string' || message.messageBox.trim() === '') {
        return res.status(400).json({ status: 'error', code: 'ERR_INVALID_MESSAGEBOX', description: 'Invalid message box.' })
      }

      if (
        (typeof message.body !== 'string' && (typeof message.body !== 'object' || message.body === null)) ||
        (typeof message.body === 'string' && message.body.trim() === '')
      ) {
        return res.status(400).json({ status: 'error', code: 'ERR_INVALID_MESSAGE_BODY', description: 'Invalid message body.' })
      }

      // ---------- Back-compat normalization ----------
      // Accept message.recipients (array) or message.recipient (string|array)
      const recipientsRaw = (message as any).recipients ?? (message as any).recipient
      if (recipientsRaw == null) {
        return res.status(400).json({
          status: 'error',
          code: 'ERR_RECIPIENT_REQUIRED',
          description: 'Missing recipient(s). Provide "recipient" or "recipients".'
        })
      }
      const recipients: string[] = Array.isArray(recipientsRaw)
        ? recipientsRaw
        : [recipientsRaw]

      const messageIdRaw = message.messageId
      if (messageIdRaw == null) {
        return res.status(400).json({
          status: 'error',
          code: 'ERR_MESSAGEID_REQUIRED',
          description: 'Missing messageId.'
        })
      }
      const messageIds: string[] = Array.isArray(messageIdRaw)
        ? messageIdRaw
        : [messageIdRaw]

      // If multiple recipients but only one messageId provided, fail clearly (avoid accidental reuse)
      if (recipients.length > 1 && messageIds.length === 1) {
        return res.status(400).json({
          status: 'error',
          code: 'ERR_MESSAGEID_COUNT_MISMATCH',
          description: `Provided 1 messageId for ${recipients.length} recipients. Provide one messageId per recipient (same order).`
        })
      }
      if (messageIds.length !== recipients.length) {
        return res.status(400).json({
          status: 'error',
          code: 'ERR_MESSAGEID_COUNT_MISMATCH',
          description: `Recipients (${recipients.length}) and messageId count (${messageIds.length}) must match.`
        })
      }

      // Validate each messageId
      for (const id of messageIds) {
        if (typeof id !== 'string' || id.trim() === '') {
          return res.status(400).json({ status: 'error', code: 'ERR_INVALID_MESSAGEID', description: 'Each messageId must be a non-empty string.' })
        }
      }

      // Validate recipient keys & build map(recipient -> messageId)
      const recipientsTrimmed = recipients.map(r => String(r).trim())
      const msgIdByRecipient = new Map<string, string>()

      for (let i = 0; i < recipientsTrimmed.length; i++) {
        const r = recipientsTrimmed[i]
        try {
          PublicKey.fromString(r)
        } catch {
          return res.status(400).json({
            status: 'error',
            code: 'ERR_INVALID_RECIPIENT_KEY',
            description: `Invalid recipient key: ${r}`
          })
        }
        msgIdByRecipient.set(r, messageIds[i])
      }

      // Ensure messageBox exists for each recipient
      const boxType = message.messageBox.trim()
      for (const r of recipientsTrimmed) {
        const existing = await knex('messageBox').where({ identityKey: r, type: boxType }).first()
        if (!existing) {
          await knex('messageBox').insert({
            identityKey: r, type: boxType, created_at: new Date(), updated_at: new Date()
          })
        }
      }

      // ---------- Fee evaluation ----------
      const deliveryFeeOnce = await getServerDeliveryFee(boxType)

      type FeeRow = { recipient: string; recipientFee: number; allowed: boolean; blockedReason?: string }
      const feeRows: FeeRow[] = []
      for (const r of recipientsTrimmed) {
        const rf = await getRecipientFee(r, senderKey, boxType) // -1 = blocked; 0 = allow; >0 = sats required
        if (rf === -1) feeRows.push({ recipient: r, recipientFee: rf, allowed: false, blockedReason: `Messages to ${r} are blocked` })
        else feeRows.push({ recipient: r, recipientFee: rf, allowed: true })
      }

      // Blocked recipients short-circuit
      const blocked = feeRows.filter(f => !f.allowed).map(f => f.recipient)
      if (blocked.length) {
        return res.status(403).json({
          status: 'error',
          code: 'ERR_DELIVERY_BLOCKED',
          description: `Blocked recipients: ${blocked.join(', ')}`,
          blockedRecipients: blocked
        })
      }

      const anyRecipientFee = feeRows.some(f => f.recipientFee > 0)
      const requiresPayment = (deliveryFeeOnce > 0) || anyRecipientFee

      // ---------- Payment internalization (batch) ----------
      const perRecipientOutputs = new Map<string, any[]>()

      if (requiresPayment) {
        if (!payment?.tx || !Array.isArray(payment.outputs)) {
          return res.status(400).json({
            status: 'error',
            code: 'ERR_MISSING_PAYMENT_TX',
            description: 'Payment transaction data is required for payable delivery.'
          })
        }

        // Enforce: index 0 is server delivery output (when needed)
        if (deliveryFeeOnce > 0) {
          if (payment.outputs.length === 0) {
            return res.status(400).json({
              status: 'error',
              code: 'ERR_MISSING_DELIVERY_OUTPUT',
              description: 'Delivery fee required but no outputs were provided.'
            })
          }
          const serverDeliveryOutput = payment.outputs[0]
          try {
            const { getWallet } = await import('../app.js')
            const wallet = await getWallet()
            const internalizeResult = await wallet.internalizeAction({
              tx: payment.tx,
              outputs: [serverDeliveryOutput],
              description: payment.description ?? 'MessageBox delivery payment (batch)'
            })
            if (!internalizeResult.accepted) {
              return res.status(400).json({
                status: 'error',
                code: 'ERR_INSUFFICIENT_PAYMENT',
                description: 'Payment was not accepted by the server.'
              })
            }
            Logger.log('[DEBUG] Internalized server delivery output at index 0')
          } catch (error) {
            Logger.error('[ERROR] Failed to internalize delivery fee payment:', error)
            return res.status(500).json({
              status: 'error',
              code: 'ERR_INTERNALIZE_FAILED',
              description: `Failed to internalize payment: ${error instanceof Error ? error.message : 'Unknown error'}`
            })
          }
        }

        // ---------- Build per-recipient outputs ----------
        const recipientSideOutputs = payment.outputs.slice(deliveryFeeOnce > 0 ? 1 : 0)
        console.log('Recipient side outputs:', recipientSideOutputs)
        console.log('All outputs: ', payment.outputs)

        const feeRecipients = feeRows.filter(f => f.recipientFee > 0).map(f => f.recipient)

        // Try explicit mapping via customInstructions (in insertionRemittance OR paymentRemittance)
        const outputsByRecipientKey = new Map<string, any[]>()
        const usedIndexes = new Set<number>()

        for (const out of recipientSideOutputs) {
          const raw =
            (out as any)?.insertionRemittance?.customInstructions ??
            (out as any)?.paymentRemittance?.customInstructions ??
            (out as any)?.customInstructions

          if (!raw) continue

          try {
            const instr = typeof raw === 'string' ? JSON.parse(raw) : raw
            const key = instr?.recipientIdentityKey
            if (typeof key === 'string' && key.trim() !== '') {
              if (!outputsByRecipientKey.has(key)) outputsByRecipientKey.set(key, [])
              outputsByRecipientKey.get(key)!.push(out)
              if (typeof (out as any)?.outputIndex === 'number') {
                usedIndexes.add((out as any).outputIndex)
              }
            }
          } catch {
            // ignore unparsable instructions
          }
        }

        if (outputsByRecipientKey.size === 0) {
          // No explicit tags: fallback to positional mapping for recipients that require a fee
          if (recipientSideOutputs.length < feeRecipients.length) {
            return res.status(400).json({
              status: 'error',
              code: 'ERR_INSUFFICIENT_OUTPUTS',
              description: `Expected at least ${feeRecipients.length} recipient output(s) but received ${recipientSideOutputs.length}`
            })
          }

          feeRecipients.forEach((r, idx) => {
            const out = recipientSideOutputs[idx]
            if (!perRecipientOutputs.has(r)) perRecipientOutputs.set(r, [])
            perRecipientOutputs.get(r)!.push(out)
          })
        } else {
          // Use tagged outputs where present
          for (const r of feeRecipients) {
            const tagged = outputsByRecipientKey.get(r) ?? []
            if (tagged.length > 0) {
              perRecipientOutputs.set(r, tagged)
            }
          }

          // For any remaining fee recipients without tags, allocate unused outputs (positional)
          const unmapped = feeRecipients.filter(r => !perRecipientOutputs.has(r))
          if (unmapped.length > 0) {
            const remaining = recipientSideOutputs.filter(o => {
              const idx = (o as any)?.outputIndex
              return typeof idx === 'number' ? !usedIndexes.has(idx) : true
            })

            if (remaining.length < unmapped.length) {
              return res.status(400).json({
                status: 'error',
                code: 'ERR_INSUFFICIENT_OUTPUTS',
                description: `Expected at least ${unmapped.length} additional recipient output(s) but only ${remaining.length} remain`
              })
            }

            unmapped.forEach((r, i) => {
              const out = remaining[i]
              if (!perRecipientOutputs.has(r)) perRecipientOutputs.set(r, [])
              perRecipientOutputs.get(r)!.push(out)
            })
          }

          // Final safety check
          for (const r of feeRecipients) {
            if (!perRecipientOutputs.has(r) || perRecipientOutputs.get(r)!.length === 0) {
              return res.status(400).json({
                status: 'error',
                code: 'ERR_MISSING_RECIPIENT_OUTPUTS',
                description: `Recipient fee required but no outputs were provided for ${r}`
              })
            }
          }
        }
      }

      // ---------- Store messages (one per recipient) ----------
      const results: Array<{ recipient: string; messageId: string }> = []
      for (const { recipient: r } of feeRows) {
        const mb = await knex('messageBox')
          .where({ identityKey: r, type: boxType })
          .select('messageBoxId')
          .first()

        const perRecipientMessageId = msgIdByRecipient.get(r)!
        if (!perRecipientMessageId) {
          return res.status(400).json({
            status: 'error',
            code: 'ERR_INVALID_MESSAGEID',
            description: `Missing messageId for recipient ${r}`
          })
        }

        const perRecipientPayment =
          perRecipientOutputs.has(r) && req.body.payment
            ? { ...req.body.payment, outputs: perRecipientOutputs.get(r)! }
            : undefined

        const storedBody = {
          message: message.body,
          ...(perRecipientPayment && { payment: perRecipientPayment })
        }

        try {
          await knex('messages')
            .insert({
              messageId: perRecipientMessageId,
              messageBoxId: mb?.messageBoxId ?? null,
              sender: senderKey,
              recipient: r,
              body: JSON.stringify(storedBody),
              created_at: new Date(),
              updated_at: new Date()
            })
            .onConflict('messageId')
            .ignore()

          results.push({ recipient: r, messageId: perRecipientMessageId })
        } catch (error: any) {
          if (error?.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({
              status: 'error',
              code: 'ERR_DUPLICATE_MESSAGE',
              description: 'Duplicate message.'
            })
          }
          throw error
        }

        try {
          if (shouldUseFCMDelivery(boxType)) {
            await sendFCMNotification(r, { title: 'New Message', messageId: perRecipientMessageId })
          }
        } catch (deliveryError) {
          Logger.error('[ERROR] Error processing FCM delivery:', deliveryError)
        }
      }

      return res.status(200).json({
        status: 'success',
        message: `Your message has been sent to ${results.length} recipient(s).`,
        results
      })
    } catch (error) {
      Logger.error('[ERROR] Internal Server Error:', error)
      return res.status(500).json({
        status: 'error',
        code: 'ERR_INTERNAL',
        description: 'An internal error has occurred.'
      })
    }
  }
}