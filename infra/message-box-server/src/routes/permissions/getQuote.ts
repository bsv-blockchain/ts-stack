import { Response } from 'express'
import { PublicKey } from '@bsv/sdk'
import { Logger, log } from '../../utils/logger.js'
import { AuthRequest } from '@bsv/auth-express-middleware'
import { getRecipientFee, getServerDeliveryFee } from '../../utils/messagePermissions.js'

export const MAX_QUOTE_RECIPIENTS = 100
export const QUOTE_CONCURRENCY = 10
const MAX_MESSAGE_BOX_BYTES = 128

export interface GetQuoteRequest extends AuthRequest {
  query: {
    recipient: string | string[] // identityKey of recipient or array of recipients
    messageBox?: string // messageBox type
  }
}

type QuoteStatus = 'blocked' | 'always_allow' | 'payment_required'

interface QuoteValidationError {
  statusCode: 400 | 401
  body: {
    status: 'error'
    code: string
    description: string
  }
}

interface ValidatedQuoteInput {
  sender: string
  recipients: string[]
  messageBox: string
}

interface RecipientQuote {
  recipient: string
  messageBox: string
  deliveryFee: number
  recipientFee: number
  status: QuoteStatus
}

function validationError(
  statusCode: 400 | 401,
  code: string,
  description: string
): QuoteValidationError {
  return { statusCode, body: { status: 'error', code, description } }
}

function invalidRecipientIndexes(recipients: string[]): number[] {
  const invalidIndexes: number[] = []
  recipients.forEach((recipient, index) => {
    try {
      PublicKey.fromString(recipient)
    } catch {
      invalidIndexes.push(index)
    }
  })
  return invalidIndexes
}

function validateQuoteInput(req: GetQuoteRequest): ValidatedQuoteInput | QuoteValidationError {
  const sender = req.auth?.identityKey
  if (sender == null) {
    Logger.log('[DEBUG] Authentication required for message quote')
    return validationError(401, 'ERR_AUTHENTICATION_REQUIRED', 'Authentication required.')
  }

  const { recipient, messageBox } = req.query
  if (recipient == null || messageBox == null) {
    Logger.log('[DEBUG] Missing required parameters for message quote')
    return validationError(
      400,
      'ERR_MISSING_PARAMETERS',
      'recipient and messageBox parameters are required.'
    )
  }
  if (
    typeof messageBox !== 'string' ||
    messageBox.trim() === '' ||
    Buffer.byteLength(messageBox, 'utf8') > MAX_MESSAGE_BOX_BYTES
  ) {
    return validationError(
      400,
      'ERR_INVALID_MESSAGE_BOX',
      `messageBox must be a non-empty string of at most ${MAX_MESSAGE_BOX_BYTES} bytes.`
    )
  }

  const recipients = Array.isArray(recipient) ? recipient : [recipient]
  if (recipients.length === 0) {
    return validationError(400, 'ERR_MISSING_PARAMETERS', 'At least one recipient is required.')
  }
  if (recipients.length > MAX_QUOTE_RECIPIENTS) {
    return validationError(
      400,
      'ERR_TOO_MANY_RECIPIENTS',
      `A quote may include at most ${MAX_QUOTE_RECIPIENTS} recipients.`
    )
  }

  const invalidIndexes = invalidRecipientIndexes(recipients)
  if (invalidIndexes.length > 0) {
    Logger.log('[DEBUG] Invalid recipient public key format in array')
    return validationError(
      400,
      'ERR_INVALID_PUBLIC_KEY',
      `Invalid recipient public key at index(es): ${invalidIndexes.join(', ')}.`
    )
  }

  return { sender, recipients, messageBox }
}

function isQuoteValidationError(
  input: ValidatedQuoteInput | QuoteValidationError
): input is QuoteValidationError {
  return 'statusCode' in input
}

function feeToStatus(fee: number): QuoteStatus {
  if (fee === -1) return 'blocked'
  if (fee === 0) return 'always_allow'
  return 'payment_required'
}

async function buildMultiRecipientQuote(
  input: ValidatedQuoteInput,
  deliveryFee: number
): Promise<{
  quotesByRecipient: RecipientQuote[]
  blockedRecipients: string[]
  totals: {
    deliveryFees: number
    recipientFees: number
    totalForPayableRecipients: number
  }
}> {
  const quotesByRecipient: RecipientQuote[] = []
  const blockedRecipients: string[] = []
  let totalRecipientFees = 0

  for (let offset = 0; offset < input.recipients.length; offset += QUOTE_CONCURRENCY) {
    const batch = input.recipients.slice(offset, offset + QUOTE_CONCURRENCY)
    const recipientFees = await Promise.all(
      batch.map(async recipient => ({
        recipient,
        recipientFee: await getRecipientFee(recipient, input.sender, input.messageBox)
      }))
    )

    for (const { recipient, recipientFee } of recipientFees) {
      quotesByRecipient.push({
        recipient,
        messageBox: input.messageBox,
        deliveryFee,
        recipientFee,
        status: feeToStatus(recipientFee)
      })
      if (recipientFee === -1) blockedRecipients.push(recipient)
      else totalRecipientFees += recipientFee
    }
  }

  const deliveryFees = deliveryFee * input.recipients.length
  return {
    quotesByRecipient,
    blockedRecipients,
    totals: {
      deliveryFees,
      recipientFees: totalRecipientFees,
      totalForPayableRecipients: deliveryFees + totalRecipientFees
    }
  }
}

/**
 * @swagger
 * /permissions/quote:
 *   get:
 *     summary: Get message delivery quote(s)
 *     description: Get pricing information for sending messages to one or many recipients' message boxes
 *     tags:
 *       - Permissions
 *     parameters:
 *       - in: query
 *         name: recipient
 *         required: true
 *         schema:
 *           oneOf:
 *             - type: string
 *             - type: array
 *               maxItems: 100
 *               items:
 *                 type: string
 *         description: identityKey of the recipient, or multiple recipients by repeating the parameter (?recipient=A&recipient=B)
 *       - in: query
 *         name: messageBox
 *         required: true
 *         schema:
 *           type: string
 *         description: messageBox type
 *     responses:
 *       200:
 *         description: Quote(s) retrieved successfully
 *       400:
 *         description: Invalid request parameters
 *       401:
 *         description: Authentication required
 *       500:
 *         description: Internal server error
 */
export default {
  type: 'get',
  path: '/permissions/quote',
  func: async (req: GetQuoteRequest, res: Response): Promise<Response> => {
    try {
      Logger.log('[DEBUG] Processing message quote request')
      log.debug({ operation: 'permissions.quote' }, 'Processing message quote request')

      const input = validateQuoteInput(req)
      if (isQuoteValidationError(input)) return res.status(input.statusCode).json(input.body)

      // Delivery fee for this messageBox (applies per message/recipient)
      const perMessageDeliveryFee = await getServerDeliveryFee(input.messageBox)

      // Single-recipient path → keep legacy response shape for compatibility
      if (input.recipients.length === 1) {
        const recipientFee = await getRecipientFee(
          input.recipients[0],
          input.sender,
          input.messageBox
        )

        return res.status(200).json({
          status: 'success',
          description: 'Message delivery quote generated.',
          quote: {
            deliveryFee: perMessageDeliveryFee,
            recipientFee
          }
        })
      }

      const quote = await buildMultiRecipientQuote(input, perMessageDeliveryFee)

      return res.status(200).json({
        status: 'success',
        description: `Message delivery quotes generated for ${input.recipients.length} recipients.`,
        ...quote
      })
    } catch (error) {
      Logger.error('[ERROR] Internal Server Error in message quote:', error)
      return res.status(500).json({
        status: 'error',
        code: 'ERR_INTERNAL',
        description: 'An internal error has occurred.'
      })
    }
  }
}
