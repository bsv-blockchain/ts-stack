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
  PublicKey
} from '@bsv/sdk'
import { Logger, log } from '../utils/logger.js'
import { AuthRequest } from '@bsv/auth-express-middleware'
import { sendFCMNotification } from '../utils/sendFCMNotification.js'
import {
  getRecipientFee,
  getServerDeliveryFee,
  shouldUseFCMDelivery
} from '../utils/messagePermissions.js'
import { runtimeDeps, getWallet } from '../runtimeDeps.js'

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

export const MAX_MESSAGE_RECIPIENTS = 100
export const MAX_MESSAGE_BOX_BYTES = 128
export const MAX_MESSAGE_ID_BYTES = 256
export const MAX_MESSAGE_BODY_BYTES = 1024 * 1024

interface RouteFailure {
  httpStatus: number
  payload: Record<string, unknown>
}

type RouteResult<T> = { value: T } | RouteFailure

interface ValidatedMessage {
  message: Message
  boxType: string
  recipients: string[]
  messageIds: string[]
  messageIdByRecipient: Map<string, string>
}

interface FeeRow {
  recipient: string
  recipientFee: number
  allowed: boolean
}

type PaymentOutput = Payment['outputs'][number]
type RecipientOutputs = Map<string, PaymentOutput[]>

function routeValue<T>(value: T): RouteResult<T> {
  return { value }
}

function routeFailure(
  httpStatus: number,
  code: string,
  description: string,
  details: Record<string, unknown> = {}
): RouteFailure {
  return {
    httpStatus,
    payload: { status: 'error', code, description, ...details }
  }
}

function isRouteFailure<T>(result: RouteResult<T>): result is RouteFailure {
  return 'httpStatus' in result
}

function validateMessageBox(message: Message): RouteResult<string> {
  if (typeof message.messageBox !== 'string' || message.messageBox.trim() === '') {
    return routeFailure(400, 'ERR_INVALID_MESSAGEBOX', 'Invalid message box.')
  }
  const boxType = message.messageBox.trim()
  if (Buffer.byteLength(boxType, 'utf8') > MAX_MESSAGE_BOX_BYTES) {
    return routeFailure(
      400,
      'ERR_MESSAGEBOX_TOO_LARGE',
      `Message box names must not exceed ${MAX_MESSAGE_BOX_BYTES} bytes.`
    )
  }
  return routeValue(boxType)
}

function validateMessageBody(message: Message): RouteResult<void> {
  if (typeof message.body !== 'string' || message.body.trim() === '') {
    return routeFailure(400, 'ERR_INVALID_MESSAGE_BODY', 'Invalid message body.')
  }
  if (Buffer.byteLength(message.body, 'utf8') > MAX_MESSAGE_BODY_BYTES) {
    return routeFailure(
      413,
      'ERR_MESSAGE_BODY_TOO_LARGE',
      `Message bodies must not exceed ${MAX_MESSAGE_BODY_BYTES} bytes.`
    )
  }
  return routeValue(undefined)
}

function normalizeRecipients(message: Message): RouteResult<string[]> {
  const recipientsRaw: unknown = message.recipients ?? message.recipient
  if (recipientsRaw == null) {
    return routeFailure(
      400,
      'ERR_RECIPIENT_REQUIRED',
      'Missing recipient(s). Provide "recipient" or "recipients".'
    )
  }
  const recipients = Array.isArray(recipientsRaw) ? recipientsRaw : [recipientsRaw]
  if (recipients.length === 0 || recipients.length > MAX_MESSAGE_RECIPIENTS) {
    return routeFailure(
      400,
      'ERR_TOO_MANY_RECIPIENTS',
      `A message may include at most ${MAX_MESSAGE_RECIPIENTS} recipients.`
    )
  }
  return routeValue(recipients.map(recipient => String(recipient).trim()))
}

function normalizeMessageIds(message: Message, recipients: string[]): RouteResult<string[]> {
  const messageIdRaw: unknown = message.messageId
  if (messageIdRaw == null) {
    return routeFailure(400, 'ERR_MESSAGEID_REQUIRED', 'Missing messageId.')
  }
  const messageIds = Array.isArray(messageIdRaw) ? messageIdRaw : [messageIdRaw]
  if (recipients.length > 1 && messageIds.length === 1) {
    return routeFailure(
      400,
      'ERR_MESSAGEID_COUNT_MISMATCH',
      `Provided 1 messageId for ${recipients.length} recipients. Provide one messageId per recipient (same order).`
    )
  }
  if (messageIds.length !== recipients.length) {
    return routeFailure(
      400,
      'ERR_MESSAGEID_COUNT_MISMATCH',
      `Recipients (${recipients.length}) and messageId count (${messageIds.length}) must match.`
    )
  }
  if (
    messageIds.some(
      id =>
        typeof id !== 'string' ||
        id.trim() === '' ||
        Buffer.byteLength(id, 'utf8') > MAX_MESSAGE_ID_BYTES
    )
  ) {
    return routeFailure(400, 'ERR_INVALID_MESSAGEID', 'Each messageId must be a non-empty string.')
  }
  return routeValue(messageIds as string[])
}

function mapMessageIdsToRecipients(
  recipients: string[],
  messageIds: string[]
): RouteResult<Map<string, string>> {
  const messageIdByRecipient = new Map<string, string>()
  for (let index = 0; index < recipients.length; index++) {
    const recipient = recipients[index]
    try {
      PublicKey.fromString(recipient)
    } catch {
      return routeFailure(400, 'ERR_INVALID_RECIPIENT_KEY', `Invalid recipient key: ${recipient}`)
    }
    messageIdByRecipient.set(recipient, messageIds[index])
  }
  return routeValue(messageIdByRecipient)
}

function validateMessage(message: Message | undefined): RouteResult<ValidatedMessage> {
  if (message == null) {
    Logger.error('[ERROR] No message provided in request body!')
    return routeFailure(400, 'ERR_MESSAGE_REQUIRED', 'Please provide a valid message to send!')
  }
  const box = validateMessageBox(message)
  if (isRouteFailure(box)) return box
  const body = validateMessageBody(message)
  if (isRouteFailure(body)) return body
  const recipients = normalizeRecipients(message)
  if (isRouteFailure(recipients)) return recipients
  const messageIds = normalizeMessageIds(message, recipients.value)
  if (isRouteFailure(messageIds)) return messageIds
  const messageIdByRecipient = mapMessageIdsToRecipients(recipients.value, messageIds.value)
  if (isRouteFailure(messageIdByRecipient)) return messageIdByRecipient
  return routeValue({
    message,
    boxType: box.value,
    recipients: recipients.value,
    messageIds: messageIds.value,
    messageIdByRecipient: messageIdByRecipient.value
  })
}

async function ensureMessageBoxes(recipients: string[], boxType: string): Promise<void> {
  for (const recipient of recipients) {
    const existing = await runtimeDeps
      .knex('messageBox')
      .where({ identityKey: recipient, type: boxType })
      .first()
    if (existing == null) {
      await runtimeDeps.knex('messageBox').insert({
        identityKey: recipient,
        type: boxType,
        created_at: new Date(),
        updated_at: new Date()
      })
    }
  }
}

async function evaluateRecipientFees(
  recipients: string[],
  senderKey: string,
  boxType: string
): Promise<FeeRow[]> {
  const feeRows: FeeRow[] = []
  for (const recipient of recipients) {
    const recipientFee = await getRecipientFee(recipient, senderKey, boxType)
    feeRows.push({
      recipient,
      recipientFee,
      allowed: recipientFee !== -1
    })
  }
  return feeRows
}

function blockedRecipientFailure(feeRows: FeeRow[]): RouteFailure | undefined {
  const blocked = feeRows.filter(fee => !fee.allowed).map(fee => fee.recipient)
  if (blocked.length === 0) return undefined
  return routeFailure(403, 'ERR_DELIVERY_BLOCKED', `Blocked recipients: ${blocked.join(', ')}`, {
    blockedRecipients: blocked
  })
}

async function internalizeDeliveryFee(
  payment: Payment,
  deliveryFee: number
): Promise<RouteFailure | undefined> {
  if (deliveryFee <= 0) return undefined
  if (payment.outputs.length === 0) {
    return routeFailure(
      400,
      'ERR_MISSING_DELIVERY_OUTPUT',
      'Delivery fee required but no outputs were provided.'
    )
  }
  try {
    const wallet = await getWallet()
    const internalizeResult = await wallet.internalizeAction({
      tx: payment.tx,
      outputs: [payment.outputs[0]],
      description: payment.description ?? 'MessageBox delivery payment (batch)'
    })
    if (!internalizeResult.accepted) {
      return routeFailure(
        400,
        'ERR_INSUFFICIENT_PAYMENT',
        'Payment was not accepted by the server.'
      )
    }
    Logger.log('[DEBUG] Internalized server delivery output at index 0')
    return undefined
  } catch (error) {
    Logger.error('[ERROR] Failed to internalize delivery fee payment:', error)
    return routeFailure(500, 'ERR_INTERNALIZE_FAILED', 'Failed to internalize payment.')
  }
}

function taggedRecipient(output: PaymentOutput): string | undefined {
  const extendedOutput = output as PaymentOutput & { customInstructions?: unknown }
  const raw =
    output.insertionRemittance?.customInstructions ??
    output.paymentRemittance?.customInstructions ??
    extendedOutput.customInstructions
  if (raw == null || raw === '') return undefined
  try {
    const instructions: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (
      instructions != null &&
      typeof instructions === 'object' &&
      'recipientIdentityKey' in instructions &&
      typeof instructions.recipientIdentityKey === 'string' &&
      instructions.recipientIdentityKey.trim() !== ''
    )
      return instructions.recipientIdentityKey
  } catch {
    // Unparseable custom instructions are intentionally ignored.
  }
  return undefined
}

function positionalRecipientOutputs(
  outputs: PaymentOutput[],
  feeRecipients: string[]
): RouteResult<RecipientOutputs> {
  if (outputs.length < feeRecipients.length) {
    return routeFailure(
      400,
      'ERR_INSUFFICIENT_OUTPUTS',
      `Expected at least ${feeRecipients.length} recipient output(s) but received ${outputs.length}`
    )
  }
  const allocated: RecipientOutputs = new Map()
  feeRecipients.forEach((recipient, index) => {
    allocated.set(recipient, [outputs[index]])
  })
  return routeValue(allocated)
}

function allocateTaggedRecipientOutputs(
  outputs: PaymentOutput[],
  feeRecipients: string[]
): RouteResult<RecipientOutputs> {
  const tagged = new Map<string, PaymentOutput[]>()
  const usedIndexes = new Set<number>()
  for (const output of outputs) {
    const recipient = taggedRecipient(output)
    if (recipient == null) continue
    const recipientOutputs = tagged.get(recipient) ?? []
    recipientOutputs.push(output)
    tagged.set(recipient, recipientOutputs)
    if (typeof output.outputIndex === 'number') usedIndexes.add(output.outputIndex)
  }
  if (tagged.size === 0) return positionalRecipientOutputs(outputs, feeRecipients)

  const allocated: RecipientOutputs = new Map()
  for (const recipient of feeRecipients) {
    const recipientOutputs = tagged.get(recipient)
    if (recipientOutputs != null && recipientOutputs.length > 0) {
      allocated.set(recipient, recipientOutputs)
    }
  }
  const unmapped = feeRecipients.filter(recipient => !allocated.has(recipient))
  const remaining = outputs.filter(output => !usedIndexes.has(output.outputIndex))
  if (remaining.length < unmapped.length) {
    return routeFailure(
      400,
      'ERR_INSUFFICIENT_OUTPUTS',
      `Expected at least ${unmapped.length} additional recipient output(s) but only ${remaining.length} remain`
    )
  }
  unmapped.forEach((recipient, index) => {
    allocated.set(recipient, [remaining[index]])
  })
  const missing = feeRecipients.find(recipient => (allocated.get(recipient)?.length ?? 0) === 0)
  if (missing != null) {
    return routeFailure(
      400,
      'ERR_MISSING_RECIPIENT_OUTPUTS',
      `Recipient fee required but no outputs were provided for ${missing}`
    )
  }
  return routeValue(allocated)
}

async function prepareRecipientPayments(
  payment: Payment | undefined,
  deliveryFee: number,
  feeRows: FeeRow[]
): Promise<RouteResult<RecipientOutputs>> {
  const feeRecipients = feeRows.filter(fee => fee.recipientFee > 0).map(fee => fee.recipient)
  if (deliveryFee <= 0 && feeRecipients.length === 0) {
    return routeValue(new Map())
  }
  if (payment?.tx == null || !Array.isArray(payment.outputs)) {
    return routeFailure(
      400,
      'ERR_MISSING_PAYMENT_TX',
      'Payment transaction data is required for payable delivery.'
    )
  }
  const internalizationFailure = await internalizeDeliveryFee(payment, deliveryFee)
  if (internalizationFailure != null) return internalizationFailure

  const outputs = payment.outputs.slice(deliveryFee > 0 ? 1 : 0)
  log.info(
    {
      operation: 'message.send',
      recipient_output_count: outputs.length,
      total_output_count: payment.outputs.length
    },
    'Payment outputs'
  )
  return allocateTaggedRecipientOutputs(outputs, feeRecipients)
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error != null && typeof error === 'object' && 'code' in error && error.code === code
}

async function storeMessage(
  validated: ValidatedMessage,
  recipient: string,
  messageId: string,
  senderKey: string,
  payment: Payment | undefined,
  recipientOutputs: RecipientOutputs
): Promise<RouteFailure | undefined> {
  const messageBox = await runtimeDeps
    .knex('messageBox')
    .where({ identityKey: recipient, type: validated.boxType })
    .select('messageBoxId')
    .first()
  const recipientPayment =
    recipientOutputs.has(recipient) && payment != null
      ? { ...payment, outputs: recipientOutputs.get(recipient)! }
      : undefined
  const storedBody = {
    message: validated.message.body,
    ...(recipientPayment != null ? { payment: recipientPayment } : {})
  }
  try {
    await runtimeDeps
      .knex('messages')
      .insert({
        messageId,
        messageBoxId: messageBox?.messageBoxId ?? null,
        sender: senderKey,
        recipient,
        body: JSON.stringify(storedBody),
        created_at: new Date(),
        updated_at: new Date()
      })
      .onConflict('messageId')
      .ignore()
    return undefined
  } catch (error) {
    if (hasErrorCode(error, 'ER_DUP_ENTRY')) {
      return routeFailure(400, 'ERR_DUPLICATE_MESSAGE', 'Duplicate message.')
    }
    throw error
  }
}

async function notifyRecipient(
  recipient: string,
  messageId: string,
  boxType: string
): Promise<void> {
  try {
    if (shouldUseFCMDelivery(boxType)) {
      await sendFCMNotification(recipient, { title: 'New Message', messageId })
    }
  } catch (deliveryError) {
    Logger.error('[ERROR] Error processing FCM delivery:', deliveryError)
  }
}

async function storeMessages(
  validated: ValidatedMessage,
  senderKey: string,
  payment: Payment | undefined,
  recipientOutputs: RecipientOutputs
): Promise<RouteResult<Array<{ recipient: string; messageId: string }>>> {
  const results: Array<{ recipient: string; messageId: string }> = []
  for (const recipient of validated.recipients) {
    const messageId = validated.messageIdByRecipient.get(recipient)
    if (messageId == null || messageId === '') {
      return routeFailure(
        400,
        'ERR_INVALID_MESSAGEID',
        `Missing messageId for recipient ${recipient}`
      )
    }
    const failure = await storeMessage(
      validated,
      recipient,
      messageId,
      senderKey,
      payment,
      recipientOutputs
    )
    if (failure != null) return failure
    results.push({ recipient, messageId })
    await notifyRecipient(recipient, messageId, validated.boxType)
  }
  return routeValue(results)
}

function sendFailure(res: Response, failure: RouteFailure): Response {
  return res.status(failure.httpStatus).json(failure.payload)
}

/**
 * @function calculateMessagePrice
 * @description Determines the price (in satoshis) to send a message, optionally with priority.
 */
export function calculateMessagePrice(message: string, _priority: boolean = false): number {
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
 *                     oneOf:
 *                       - type: string
 *                       - type: array
 *                         maxItems: 100
 *                         items:
 *                           type: string
 *                     description: Identity key or keys of up to 100 recipients
 *                   messageBox:
 *                     type: string
 *                     maxLength: 128
 *                     description: The name of the recipient's message box
 *                   messageId:
 *                     oneOf:
 *                       - type: string
 *                         maxLength: 256
 *                       - type: array
 *                         maxItems: 100
 *                         items:
 *                           type: string
 *                           maxLength: 256
 *                     description: Unique identifier per recipient (usually an HMAC)
 *                   body:
 *                     type: string
 *                     maxLength: 1048576
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
  get knex() {
    return runtimeDeps.knex
  },
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

    const senderKey = req.auth?.identityKey
    if (senderKey == null) {
      return sendFailure(res, routeFailure(401, 'ERR_AUTH_REQUIRED', 'Authentication required'))
    }

    try {
      const { message, payment } = req.body
      log.info(
        {
          operation: 'message.send',
          message_box: message?.messageBox,
          has_payment: payment != null
        },
        'Received message send request'
      )

      const validated = validateMessage(message)
      if (isRouteFailure(validated)) return sendFailure(res, validated)
      await ensureMessageBoxes(validated.value.recipients, validated.value.boxType)
      const deliveryFee = await getServerDeliveryFee(validated.value.boxType)
      const feeRows = await evaluateRecipientFees(
        validated.value.recipients,
        senderKey,
        validated.value.boxType
      )
      const blocked = blockedRecipientFailure(feeRows)
      if (blocked != null) return sendFailure(res, blocked)
      const recipientPayments = await prepareRecipientPayments(payment, deliveryFee, feeRows)
      if (isRouteFailure(recipientPayments)) {
        return sendFailure(res, recipientPayments)
      }
      const stored = await storeMessages(
        validated.value,
        senderKey,
        payment,
        recipientPayments.value
      )
      if (isRouteFailure(stored)) return sendFailure(res, stored)
      return res.status(200).json({
        status: 'success',
        message: `Your message has been sent to ${stored.value.length} recipient(s).`,
        results: stored.value
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
