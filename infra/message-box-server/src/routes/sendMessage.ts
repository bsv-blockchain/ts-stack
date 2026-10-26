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
import { createHash, randomBytes } from 'node:crypto'
import {
  AtomicBEEF,
  Base64String,
  BasketStringUnder300Bytes,
  BooleanDefaultTrue,
  DescriptionString5to50Bytes,
  LabelStringUnder300Bytes,
  OutputTagStringUnder300Bytes,
  P2PKH,
  PositiveIntegerOrZero,
  ProtoWallet,
  PubKeyHex,
  PublicKey,
  Transaction,
  type ChainTracker
} from '@bsv/sdk'
import { toArray, toBase64 } from '@bsv/sdk/primitives/utils'
import { Logger, log } from '../utils/logger.js'
import { AuthRequest } from '@bsv/auth-express-middleware'
import { sendFCMNotification } from '../utils/sendFCMNotification.js'
import {
  getRecipientFee,
  getServerDeliveryFee,
  shouldUseFCMDelivery
} from '../utils/messagePermissions.js'
import { runtimeDeps, getWallet } from '../runtimeDeps.js'
import {
  messageExpiresAt,
  readMessageBoxResourceConfig,
  type MessageBoxResourceConfig
} from '../config/resources.js'
import { readMessageBoxPricingConfig } from '../config/pricing.js'
import type { Knex } from 'knex'
import { mapWithConcurrency } from '../utils/boundedConcurrency.js'
import {
  isRetryableDatabaseConflict,
  readDatabaseRetryConfig,
  withDatabaseConflictRetry
} from '../utils/databaseRetry.js'
import {
  isCanonicalMessageBox,
  isCanonicalMessageId,
  MAX_MESSAGE_BOX_BYTES as MAX_CANONICAL_MESSAGE_BOX_BYTES,
  MAX_MESSAGE_ID_BYTES as MAX_CANONICAL_MESSAGE_ID_BYTES
} from '../security/messageFields.js'

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
    customInstructions?: unknown
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
export const MAX_MESSAGE_BOX_BYTES = MAX_CANONICAL_MESSAGE_BOX_BYTES
export const MAX_MESSAGE_ID_BYTES = MAX_CANONICAL_MESSAGE_ID_BYTES
export const MAX_MESSAGE_BODY_BYTES = 1024 * 1024
export const MAX_PAYMENT_DERIVATION_BYTES = 128

const MAX_PAYMENT_BEEF_BYTES = 16 * 1024 * 1024
const MAX_PAYMENT_OUTPUTS = 10_000
const MAX_PAYMENT_METADATA_DEPTH = 64
const MAX_PAYMENT_METADATA_NODES = 100_000

const BRC29_PROTOCOL_ID = [2, '3241645161d8'] as const
const anyoneWallet = new ProtoWallet('anyone')
let anyoneIdentityKeyPromise: Promise<string> | undefined

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

interface ParsedPayment {
  transactionId: string
  transaction: Transaction
}

interface PreparedRecipientPayments {
  outputs: RecipientOutputs
  transactionId?: string
}

interface PaymentFinalizationState {
  walletAccepted: boolean
  walletAttempted: boolean
  intent?: PaymentIntentBinding
}

interface PaymentIntentBinding {
  transactionId: string
  requestDigest: string
  attemptToken: string
}

interface PaymentIntentRow {
  transaction_id: string
  request_digest: string
  status: string
  attempt_token: string
}

type PaymentIntentStatus = 'prepared' | 'wallet_accepted' | 'completed'

interface PreparedPaymentIntent {
  binding: PaymentIntentBinding
  status: PaymentIntentStatus
}

const MISSING_OWN_DATA = Symbol('missing own data')

class UnsafeRequestDataError extends Error {}

function ownDataValue(value: unknown, key: PropertyKey): unknown | typeof MISSING_OWN_DATA {
  if (value == null || typeof value !== 'object') return MISSING_OWN_DATA
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (descriptor == null) return MISSING_OWN_DATA
  const valueDescriptor = Object.getOwnPropertyDescriptor(descriptor, 'value')
  if (valueDescriptor == null) throw new UnsafeRequestDataError('Accessor-backed request data')
  return valueDescriptor.value
}

function denseOwnArray(value: unknown, name: string, maximum: number): unknown[] {
  if (!Array.isArray(value)) throw new UnsafeRequestDataError(`${name} must be an array`)
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
  const lengthValue =
    lengthDescriptor == null
      ? undefined
      : Object.getOwnPropertyDescriptor(lengthDescriptor, 'value')?.value
  if (!Number.isSafeInteger(lengthValue) || lengthValue < 0 || lengthValue > maximum) {
    throw new UnsafeRequestDataError(`${name} must be a bounded array`)
  }
  const snapshot: unknown[] = []
  for (let index = 0; index < lengthValue; index++) {
    const entry = ownDataValue(value, String(index))
    if (entry === MISSING_OWN_DATA) throw new UnsafeRequestDataError(`${name} must be dense`)
    snapshot.push(entry)
  }
  return snapshot
}

function snapshotJsonData(
  value: unknown,
  state: { depth: number; nodes: number; ancestors: WeakSet<object> }
): unknown {
  if (++state.nodes > MAX_PAYMENT_METADATA_NODES || state.depth > MAX_PAYMENT_METADATA_DEPTH) {
    throw new UnsafeRequestDataError('Payment metadata is too complex')
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value
  }
  if (value == null || typeof value !== 'object' || state.ancestors.has(value)) {
    throw new UnsafeRequestDataError('Payment metadata must contain JSON data')
  }
  state.ancestors.add(value)
  state.depth += 1
  try {
    if (Array.isArray(value)) {
      return denseOwnArray(value, 'Payment metadata array', MAX_PAYMENT_METADATA_NODES).map(entry =>
        snapshotJsonData(entry, state)
      )
    }
    const snapshot = Object.create(null) as Record<string, unknown>
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') {
        throw new UnsafeRequestDataError('Payment metadata must not contain symbols')
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      const ownValue =
        descriptor == null ? undefined : Object.getOwnPropertyDescriptor(descriptor, 'value')
      if (ownValue == null) throw new UnsafeRequestDataError('Accessor-backed payment metadata')
      if (descriptor?.enumerable === true) snapshot[key] = snapshotJsonData(ownValue.value, state)
    }
    return snapshot
  } finally {
    state.depth -= 1
    state.ancestors.delete(value)
  }
}

function optionalJsonData(value: unknown | typeof MISSING_OWN_DATA): unknown {
  if (value === MISSING_OWN_DATA || value === undefined) return undefined
  return snapshotJsonData(value, { depth: 0, nodes: 0, ancestors: new WeakSet<object>() })
}

function snapshotScalarData(
  value: unknown | typeof MISSING_OWN_DATA,
  name: string
): unknown | typeof MISSING_OWN_DATA {
  if (value === MISSING_OWN_DATA || value === undefined) return value
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value
  }
  throw new UnsafeRequestDataError(`${name} must be scalar JSON data`)
}

function snapshotStringArray(
  value: unknown | typeof MISSING_OWN_DATA,
  name: string
): string[] | undefined {
  if (value === MISSING_OWN_DATA || value === undefined) return undefined
  return denseOwnArray(value, name, MAX_PAYMENT_OUTPUTS).map(entry => {
    if (typeof entry !== 'string') throw new UnsafeRequestDataError(`${name} must contain strings`)
    return entry
  })
}

function snapshotRemittance(
  value: unknown | typeof MISSING_OWN_DATA
): Record<string, unknown> | undefined {
  if (value === MISSING_OWN_DATA || value === undefined) return undefined
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new UnsafeRequestDataError('Payment remittance must be an object')
  }
  const snapshot = Object.create(null) as Record<string, unknown>
  for (const key of [
    'derivationPrefix',
    'derivationSuffix',
    'senderIdentityKey',
    'basket'
  ] as const) {
    const field = snapshotScalarData(ownDataValue(value, key), `Payment remittance ${key}`)
    if (field !== MISSING_OWN_DATA) snapshot[key] = field
  }
  const instructions = ownDataValue(value, 'customInstructions')
  if (instructions !== MISSING_OWN_DATA)
    snapshot.customInstructions = optionalJsonData(instructions)
  const tags = snapshotStringArray(ownDataValue(value, 'tags'), 'Payment insertion tags')
  if (tags != null) snapshot.tags = tags
  return snapshot
}

function snapshotPayment(value: unknown | typeof MISSING_OWN_DATA): Payment | undefined {
  if (value === MISSING_OWN_DATA || value === undefined) return undefined
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new UnsafeRequestDataError('Payment must be an object')
  }
  const tx = denseOwnArray(ownDataValue(value, 'tx'), 'Payment Atomic BEEF', MAX_PAYMENT_BEEF_BYTES)
  const txBytes = tx.map(byte => {
    if (!Number.isInteger(byte) || (byte as number) < 0 || (byte as number) > 255) {
      throw new UnsafeRequestDataError('Payment Atomic BEEF must contain bytes')
    }
    return byte as number
  })
  const outputs = denseOwnArray(
    ownDataValue(value, 'outputs'),
    'Payment outputs',
    MAX_PAYMENT_OUTPUTS
  ).map(rawOutput => {
    if (rawOutput == null || typeof rawOutput !== 'object' || Array.isArray(rawOutput)) {
      throw new UnsafeRequestDataError('Payment output must be an object')
    }
    const output = Object.create(null) as Record<string, unknown>
    for (const key of ['outputIndex', 'protocol'] as const) {
      const field = snapshotScalarData(ownDataValue(rawOutput, key), `Payment output ${key}`)
      if (field !== MISSING_OWN_DATA) output[key] = field
    }
    const paymentRemittance = snapshotRemittance(ownDataValue(rawOutput, 'paymentRemittance'))
    if (paymentRemittance != null) output.paymentRemittance = paymentRemittance
    const insertionRemittance = snapshotRemittance(ownDataValue(rawOutput, 'insertionRemittance'))
    if (insertionRemittance != null) output.insertionRemittance = insertionRemittance
    const instructions = ownDataValue(rawOutput, 'customInstructions')
    if (instructions !== MISSING_OWN_DATA) {
      output.customInstructions = optionalJsonData(instructions)
    }
    return output as PaymentOutput
  })
  const description = snapshotScalarData(ownDataValue(value, 'description'), 'Payment description')
  const labels = snapshotStringArray(ownDataValue(value, 'labels'), 'Payment labels')
  const seekPermission = snapshotScalarData(
    ownDataValue(value, 'seekPermission'),
    'Payment seekPermission'
  )
  return {
    tx: txBytes,
    outputs,
    description:
      description === MISSING_OWN_DATA
        ? (undefined as unknown as DescriptionString5to50Bytes)
        : (description as DescriptionString5to50Bytes),
    ...(labels == null ? {} : { labels }),
    ...(seekPermission === MISSING_OWN_DATA
      ? {}
      : { seekPermission: seekPermission as BooleanDefaultTrue })
  }
}

function snapshotMessage(value: unknown | typeof MISSING_OWN_DATA): Message | undefined {
  if (value === MISSING_OWN_DATA || value === undefined) return undefined
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    // Preserve the route's established validation/error identities for malformed
    // message values. Only record-like values need an own-data snapshot.
    return value as unknown as Message
  }
  const copyStringOrArray = (field: string): unknown => {
    const raw = ownDataValue(value, field)
    if (raw === MISSING_OWN_DATA) return undefined
    return Array.isArray(raw)
      ? denseOwnArray(raw, `Message ${field}`, MAX_MESSAGE_RECIPIENTS + 1).map(entry => entry)
      : raw
  }
  return {
    recipient: copyStringOrArray('recipient') as Message['recipient'],
    recipients: copyStringOrArray('recipients') as Message['recipients'],
    messageBox: copyStringOrArray('messageBox') as string,
    messageId: copyStringOrArray('messageId') as Message['messageId'],
    body: copyStringOrArray('body') as string
  }
}

function snapshotSendBody(value: unknown): RouteResult<{ message?: Message; payment?: Payment }> {
  try {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
      throw new UnsafeRequestDataError('Request body must be an object')
    }
    return routeValue({
      message: snapshotMessage(ownDataValue(value, 'message')),
      payment: snapshotPayment(ownDataValue(value, 'payment'))
    })
  } catch {
    return routeFailure(400, 'ERR_INVALID_REQUEST_DATA', 'Request fields must be own JSON data.')
  }
}

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
  if (Buffer.byteLength(message.messageBox, 'utf8') > MAX_MESSAGE_BOX_BYTES) {
    return routeFailure(
      400,
      'ERR_MESSAGEBOX_TOO_LARGE',
      `Message box names must not exceed ${MAX_MESSAGE_BOX_BYTES} bytes.`
    )
  }
  if (!isCanonicalMessageBox(message.messageBox)) {
    return routeFailure(
      400,
      'ERR_INVALID_MESSAGEBOX',
      'Message box names must be exact and control-free.'
    )
  }
  return routeValue(message.messageBox)
}

function validateMessageBody(
  message: Message,
  resourceConfig: MessageBoxResourceConfig
): RouteResult<void> {
  if (typeof message.body !== 'string' || message.body.trim() === '') {
    return routeFailure(400, 'ERR_INVALID_MESSAGE_BODY', 'Invalid message body.')
  }
  if (
    resourceConfig.maxMessageBodyBytes !== -1 &&
    Buffer.byteLength(message.body, 'utf8') > resourceConfig.maxMessageBodyBytes
  ) {
    return routeFailure(
      413,
      'ERR_MESSAGE_BODY_TOO_LARGE',
      `Message bodies must not exceed ${resourceConfig.maxMessageBodyBytes} bytes.`
    )
  }
  return routeValue(undefined)
}

function normalizeRecipients(
  message: Message,
  resourceConfig: MessageBoxResourceConfig
): RouteResult<string[]> {
  const recipientsRaw: unknown = message.recipients ?? message.recipient
  if (recipientsRaw == null) {
    return routeFailure(
      400,
      'ERR_RECIPIENT_REQUIRED',
      'Missing recipient(s). Provide "recipient" or "recipients".'
    )
  }
  const recipients = Array.isArray(recipientsRaw) ? recipientsRaw : [recipientsRaw]
  if (
    recipients.length === 0 ||
    (resourceConfig.maxRecipients !== -1 && recipients.length > resourceConfig.maxRecipients)
  ) {
    return routeFailure(
      400,
      'ERR_TOO_MANY_RECIPIENTS',
      resourceConfig.maxRecipients === -1
        ? 'A message must include at least one recipient.'
        : `A message may include at most ${resourceConfig.maxRecipients} recipients.`
    )
  }
  if (recipients.some(recipient => typeof recipient !== 'string')) {
    return routeFailure(400, 'ERR_INVALID_RECIPIENT_KEY', 'Invalid recipient key.')
  }
  return routeValue((recipients as string[]).map(recipient => recipient.trim()))
}

function canonicalizeRecipients(recipients: string[]): RouteResult<string[]> {
  const canonical: string[] = []
  for (const recipient of recipients) {
    try {
      canonical.push(PublicKey.fromString(recipient).toString())
    } catch {
      return routeFailure(400, 'ERR_INVALID_RECIPIENT_KEY', 'Invalid recipient key.')
    }
  }
  if (new Set(canonical).size !== canonical.length) {
    return routeFailure(
      400,
      'ERR_DUPLICATE_RECIPIENT',
      'Each recipient may appear only once in a batch.'
    )
  }
  return routeValue(canonical)
}

function canonicalizeAuthenticatedSender(sender: string): RouteResult<string> {
  try {
    return routeValue(PublicKey.fromString(sender).toString())
  } catch {
    return routeFailure(
      401,
      'ERR_INVALID_AUTH_IDENTITY',
      'The authenticated sender identity is invalid.'
    )
  }
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
  if (messageIds.some(id => !isCanonicalMessageId(id))) {
    return routeFailure(
      400,
      'ERR_INVALID_MESSAGEID',
      `Each messageId must be an exact, control-free string of at most ${MAX_MESSAGE_ID_BYTES} bytes.`
    )
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
  const resourceConfig = readMessageBoxResourceConfig()
  const body = validateMessageBody(message, resourceConfig)
  if (isRouteFailure(body)) return body
  const recipients = normalizeRecipients(message, resourceConfig)
  if (isRouteFailure(recipients)) return recipients
  const canonicalRecipients = canonicalizeRecipients(recipients.value)
  if (isRouteFailure(canonicalRecipients)) return canonicalRecipients
  const messageIds = normalizeMessageIds(message, canonicalRecipients.value)
  if (isRouteFailure(messageIds)) return messageIds
  const messageIdByRecipient = mapMessageIdsToRecipients(
    canonicalRecipients.value,
    messageIds.value
  )
  if (isRouteFailure(messageIdByRecipient)) return messageIdByRecipient
  return routeValue({
    message,
    boxType: box.value,
    recipients: canonicalRecipients.value,
    messageIds: messageIds.value,
    messageIdByRecipient: messageIdByRecipient.value
  })
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

type WalletInternalizationVerdict = 'accepted' | 'rejected'

function walletInternalizationVerdict(result: unknown): WalletInternalizationVerdict {
  if (result == null || typeof result !== 'object' || Array.isArray(result)) return 'rejected'
  const accepted = Object.getOwnPropertyDescriptor(result, 'accepted')
  if (accepted == null || !Object.hasOwn(accepted, 'value') || accepted.value !== true) {
    return 'rejected'
  }
  const isMerge = Object.getOwnPropertyDescriptor(result, 'isMerge')
  if (isMerge == null) return 'accepted'
  if (!Object.hasOwn(isMerge, 'value')) return 'rejected'
  return isMerge.value === false ? 'accepted' : 'rejected'
}

async function internalizeDeliveryFee(
  payment: Payment,
  deliveryFee: number,
  authenticatedSender: string
): Promise<RouteFailure | undefined> {
  if (deliveryFee <= 0) return undefined
  if (!hasCanonicalDeliveryRemittance(payment, authenticatedSender)) {
    return routeFailure(
      400,
      'ERR_INVALID_PAYMENT',
      'The delivery payment remittance is invalid for the authenticated sender.'
    )
  }
  try {
    const wallet = await getWallet()
    const internalizeResult: unknown = await wallet.internalizeAction({
      tx: payment.tx,
      outputs: [payment.outputs[0]],
      description: payment.description ?? 'MessageBox delivery payment (batch)'
    })
    if (walletInternalizationVerdict(internalizeResult) !== 'accepted') {
      return routeFailure(
        409,
        'ERR_PAYMENT_REPLAYED',
        'Payment was not newly accepted by the server.'
      )
    }
    Logger.log(
      `[DEBUG] Internalized server delivery output at index ${payment.outputs[0].outputIndex}`
    )
    return undefined
  } catch {
    Logger.error('[ERROR] Failed to internalize delivery fee payment.')
    return routeFailure(500, 'ERR_INTERNALIZE_FAILED', 'Failed to internalize payment.')
  }
}

export function paymentOutputCoversDeliveryFee(payment: Payment, deliveryFee: number): boolean {
  const parsed = parsePayment(payment)
  return parsed != null && deliveryOutputCoversFee(parsed, payment.outputs[0], deliveryFee)
}

function parsePayment(payment: Payment): ParsedPayment | null {
  try {
    const transaction = Transaction.fromAtomicBEEFView(Uint8Array.from(payment.tx))
    return { transactionId: transaction.id('hex'), transaction }
  } catch {
    return null
  }
}

function deliveryOutputCoversFee(
  parsed: ParsedPayment,
  remittance: PaymentOutput | undefined,
  deliveryFee: number
): boolean {
  if (!Number.isSafeInteger(deliveryFee) || deliveryFee < 1) return false
  if (
    remittance?.protocol !== 'wallet payment' ||
    !Number.isSafeInteger(remittance.outputIndex) ||
    remittance.outputIndex < 0
  ) {
    return false
  }
  const satoshis = parsed.transaction.outputs[remittance.outputIndex]?.satoshis
  return typeof satoshis === 'number' && Number.isSafeInteger(satoshis) && satoshis >= deliveryFee
}

function aggregateDeliveryFee(deliveryFee: number, recipientCount: number): number {
  const total = deliveryFee * recipientCount
  if (
    !Number.isSafeInteger(deliveryFee) ||
    deliveryFee < 0 ||
    !Number.isSafeInteger(recipientCount) ||
    recipientCount < 1 ||
    !Number.isSafeInteger(total)
  ) {
    throw new TypeError('Invalid aggregate delivery fee.')
  }
  return total
}

async function claimPayment(
  transactionId: string,
  transaction: Knex.Transaction
): Promise<RouteFailure | undefined> {
  const replayStore = runtimeDeps.paymentReplayStore
  if (replayStore == null || typeof replayStore.claimInTransaction !== 'function') {
    return routeFailure(503, 'ERR_PAYMENT_UNAVAILABLE', 'Payment replay protection is unavailable.')
  }
  try {
    const claimed: unknown = await replayStore.claimInTransaction(transactionId, transaction)
    if (typeof claimed !== 'boolean') {
      throw new TypeError('The payment replay store returned an invalid result.')
    }
    if (!claimed) {
      return routeFailure(409, 'ERR_PAYMENT_REPLAYED', 'This payment was already used.')
    }
  } catch (error) {
    if (isRetryableDatabaseConflict(error)) throw error
    Logger.error('[ERROR] Failed to claim message payment.')
    return routeFailure(503, 'ERR_PAYMENT_UNAVAILABLE', 'Unable to claim payment.')
  }
  return undefined
}

function validDerivationToken(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > MAX_PAYMENT_DERIVATION_BYTES ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return false
  }
  try {
    return toBase64(toArray(value, 'base64')) === value
  } catch {
    return false
  }
}

function hasCanonicalDeliveryRemittance(payment: Payment, authenticatedSender: string): boolean {
  const output = payment.outputs[0]
  const remittance = output?.paymentRemittance
  if (
    output?.protocol !== 'wallet payment' ||
    !Number.isSafeInteger(output.outputIndex) ||
    output.outputIndex < 0 ||
    remittance == null ||
    !validDerivationToken(remittance.derivationPrefix) ||
    !validDerivationToken(remittance.derivationSuffix) ||
    typeof remittance.senderIdentityKey !== 'string'
  ) {
    return false
  }
  try {
    const canonicalSender = PublicKey.fromString(remittance.senderIdentityKey).toString()
    return (
      canonicalSender === authenticatedSender && remittance.senderIdentityKey === canonicalSender
    )
  } catch {
    return false
  }
}

async function anyoneIdentityKey(): Promise<string> {
  anyoneIdentityKeyPromise ??= anyoneWallet
    .getPublicKey({ identityKey: true })
    .then(result => result.publicKey)
  return await anyoneIdentityKeyPromise
}

async function resolvePaymentChainTracker(): Promise<ChainTracker | undefined> {
  const wallet = await getWallet()
  const walletWithServices = wallet as unknown as {
    getServices?: () => { getChainTracker?: () => Promise<ChainTracker> }
  }
  const services = walletWithServices.getServices?.()
  return await services?.getChainTracker?.()
}

async function verifyRecipientPaymentTransaction(
  payment: Payment,
  parsed: ParsedPayment
): Promise<RouteFailure | undefined> {
  try {
    const verifier = runtimeDeps.paymentTransactionVerifier
    const valid: unknown =
      verifier != null
        ? await verifier(payment.tx)
        : await (async () => {
            const chainTracker = await resolvePaymentChainTracker()
            if (chainTracker == null) {
              throw new Error('No payment chain tracker is available.')
            }
            return await parsed.transaction.verify(chainTracker)
          })()
    if (valid !== true) {
      return routeFailure(
        400,
        'ERR_INVALID_RECIPIENT_PAYMENT',
        'The recipient payment transaction is not valid.'
      )
    }
    return undefined
  } catch {
    Logger.error('[ERROR] Failed to validate recipient payment transaction.')
    return routeFailure(
      503,
      'ERR_PAYMENT_VALIDATION_UNAVAILABLE',
      'Unable to validate the recipient payment transaction.'
    )
  }
}

async function validateRecipientOutputs(
  payment: Payment,
  parsed: ParsedPayment,
  allocated: RecipientOutputs,
  feeRows: FeeRow[],
  deliveryFee: number
): Promise<RouteFailure | undefined> {
  const usedOutputIndexes = new Set<number>()
  if (deliveryFee > 0) usedOutputIndexes.add(payment.outputs[0].outputIndex)
  const expectedSenderIdentityKey = await anyoneIdentityKey()

  for (const fee of feeRows) {
    if (fee.recipientFee <= 0) continue
    const outputs = allocated.get(fee.recipient)
    if (outputs == null || outputs.length === 0) {
      return routeFailure(
        400,
        'ERR_MISSING_RECIPIENT_OUTPUTS',
        `Recipient fee required but no outputs were provided for ${fee.recipient}`
      )
    }

    let paid = 0
    for (const output of outputs) {
      const remittance = output.paymentRemittance
      if (
        output.protocol !== 'wallet payment' ||
        remittance == null ||
        !Number.isSafeInteger(output.outputIndex) ||
        output.outputIndex < 0 ||
        usedOutputIndexes.has(output.outputIndex) ||
        !validDerivationToken(remittance.derivationPrefix) ||
        !validDerivationToken(remittance.derivationSuffix) ||
        remittance.senderIdentityKey !== expectedSenderIdentityKey
      ) {
        return routeFailure(
          400,
          'ERR_INVALID_RECIPIENT_PAYMENT',
          `Invalid recipient payment metadata for ${fee.recipient}`
        )
      }
      usedOutputIndexes.add(output.outputIndex)

      const transactionOutput = parsed.transaction.outputs[output.outputIndex]
      const outputSatoshis = transactionOutput?.satoshis
      if (
        transactionOutput == null ||
        typeof outputSatoshis !== 'number' ||
        !Number.isSafeInteger(outputSatoshis)
      ) {
        return routeFailure(
          400,
          'ERR_INVALID_RECIPIENT_PAYMENT',
          `Recipient payment output is missing for ${fee.recipient}`
        )
      }
      try {
        const { publicKey } = await anyoneWallet.getPublicKey({
          protocolID: [...BRC29_PROTOCOL_ID],
          keyID: `${remittance.derivationPrefix} ${remittance.derivationSuffix}`,
          counterparty: fee.recipient
        })
        const expectedScript = new P2PKH().lock(PublicKey.fromString(publicKey).toAddress()).toHex()
        if (transactionOutput.lockingScript.toHex() !== expectedScript) {
          return routeFailure(
            400,
            'ERR_INVALID_RECIPIENT_PAYMENT',
            `Recipient payment output is not locked to ${fee.recipient}`
          )
        }
      } catch {
        return routeFailure(
          400,
          'ERR_INVALID_RECIPIENT_PAYMENT',
          `Recipient payment key derivation is invalid for ${fee.recipient}`
        )
      }
      paid += outputSatoshis
      if (!Number.isSafeInteger(paid)) {
        return routeFailure(
          400,
          'ERR_INVALID_RECIPIENT_PAYMENT',
          `Recipient payment amount is invalid for ${fee.recipient}`
        )
      }
    }
    if (paid < fee.recipientFee) {
      return routeFailure(
        400,
        'ERR_INSUFFICIENT_RECIPIENT_PAYMENT',
        `The recipient output does not pay the required amount for ${fee.recipient}`
      )
    }
  }

  return await verifyRecipientPaymentTransaction(payment, parsed)
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
    if (instructions != null && typeof instructions === 'object' && !Array.isArray(instructions)) {
      const recipient = Object.getOwnPropertyDescriptor(instructions, 'recipientIdentityKey')
      if (
        recipient != null &&
        Object.hasOwn(recipient, 'value') &&
        typeof recipient.value === 'string' &&
        recipient.value.trim() !== ''
      ) {
        return recipient.value
      }
    }
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
  feeRows: FeeRow[],
  authenticatedSender: string
): Promise<RouteResult<PreparedRecipientPayments>> {
  const feeRecipients = feeRows.filter(fee => fee.recipientFee > 0).map(fee => fee.recipient)
  if (deliveryFee <= 0 && feeRecipients.length === 0) {
    return routeValue({ outputs: new Map() })
  }
  if (payment?.tx == null || !Array.isArray(payment.outputs)) {
    return routeFailure(
      400,
      'ERR_MISSING_PAYMENT_TX',
      'Payment transaction data is required for payable delivery.'
    )
  }
  if (deliveryFee > 0 && payment.outputs.length === 0) {
    return routeFailure(
      400,
      'ERR_MISSING_DELIVERY_OUTPUT',
      'Delivery fee required but no outputs were provided.'
    )
  }
  const parsed = parsePayment(payment)
  if (parsed == null) {
    return routeFailure(400, 'ERR_INVALID_PAYMENT', 'Payment must contain a valid Atomic BEEF.')
  }
  if (deliveryFee > 0 && !hasCanonicalDeliveryRemittance(payment, authenticatedSender)) {
    return routeFailure(
      400,
      'ERR_INVALID_PAYMENT',
      'The delivery payment remittance is invalid for the authenticated sender.'
    )
  }
  if (deliveryFee > 0 && !deliveryOutputCoversFee(parsed, payment.outputs[0], deliveryFee)) {
    return routeFailure(
      400,
      'ERR_INSUFFICIENT_PAYMENT',
      'The server delivery output does not pay the required amount.'
    )
  }

  const outputs = payment.outputs.slice(deliveryFee > 0 ? 1 : 0)
  log.info(
    {
      operation: 'message.send',
      recipient_output_count: outputs.length,
      total_output_count: payment.outputs.length
    },
    'Payment outputs'
  )
  const allocated = allocateTaggedRecipientOutputs(outputs, feeRecipients)
  if (isRouteFailure(allocated)) return allocated
  if (feeRecipients.length > 0) {
    const validationFailure = await validateRecipientOutputs(
      payment,
      parsed,
      allocated.value,
      feeRows,
      deliveryFee
    )
    if (validationFailure != null) return validationFailure
  }
  return routeValue({ outputs: allocated.value, transactionId: parsed.transactionId })
}

function paymentIntentDigest(
  validated: ValidatedMessage,
  authenticatedSender: string,
  payment: Payment,
  transactionId: string
): string {
  const request = JSON.stringify({
    version: 1,
    sender: authenticatedSender,
    message: {
      boxType: validated.boxType,
      recipients: validated.recipients,
      messageIds: validated.messageIds,
      body: validated.message.body
    },
    payment: {
      transactionId,
      atomicBEEF: Buffer.from(payment.tx).toString('base64'),
      outputs: payment.outputs,
      description: payment.description,
      labels: payment.labels,
      seekPermission: payment.seekPermission
    }
  })
  return createHash('sha256').update(request, 'utf8').digest('hex')
}

async function preparePaymentIntent(
  binding: PaymentIntentBinding
): Promise<RouteResult<PreparedPaymentIntent>> {
  try {
    const now = new Date()
    await runtimeDeps
      .knex('message_payment_intents')
      .insert({
        transaction_id: binding.transactionId,
        request_digest: binding.requestDigest,
        status: 'prepared',
        attempt_token: binding.attemptToken,
        created_at: now,
        updated_at: now
      })
      .onConflict('transaction_id')
      .ignore()
    const row = await runtimeDeps
      .knex<PaymentIntentRow>('message_payment_intents')
      .where({ transaction_id: binding.transactionId })
      .first('request_digest', 'status', 'attempt_token')
    if (row == null) throw new Error('Payment intent was not persisted.')
    if (row.request_digest !== binding.requestDigest) {
      return routeFailure(
        409,
        'ERR_PAYMENT_REPLAYED',
        'This payment is already bound to a different message request.'
      )
    }
    if (
      row.status !== 'prepared' &&
      row.status !== 'wallet_accepted' &&
      row.status !== 'completed'
    ) {
      throw new Error('Payment intent has an invalid state.')
    }
    if (row.status === 'prepared' && row.attempt_token !== binding.attemptToken) {
      return routeFailure(
        409,
        'ERR_PAYMENT_IN_PROGRESS',
        'An identical payment request is already being processed.'
      )
    }
    return routeValue({
      status: row.status,
      binding: {
        transactionId: binding.transactionId,
        requestDigest: binding.requestDigest,
        attemptToken: row.attempt_token
      }
    })
  } catch {
    Logger.error('[ERROR] Failed to prepare durable message payment intent.')
    return routeFailure(
      503,
      'ERR_PAYMENT_UNAVAILABLE',
      'Unable to prepare durable payment recovery.'
    )
  }
}

async function updatePaymentIntent(
  binding: PaymentIntentBinding,
  status: 'wallet_accepted' | 'completed'
): Promise<boolean> {
  try {
    const updated = await runtimeDeps
      .knex('message_payment_intents')
      .where({
        transaction_id: binding.transactionId,
        request_digest: binding.requestDigest,
        attempt_token: binding.attemptToken
      })
      .whereIn(
        'status',
        status === 'completed'
          ? ['prepared', 'wallet_accepted', 'completed']
          : ['prepared', 'wallet_accepted']
      )
      .update({ status, updated_at: new Date() })
    if (updated === 1) return true
    const existing = await runtimeDeps
      .knex<PaymentIntentRow>('message_payment_intents')
      .where({
        transaction_id: binding.transactionId,
        request_digest: binding.requestDigest,
        attempt_token: binding.attemptToken
      })
      .first('status')
    return status === 'wallet_accepted' && existing?.status === 'completed'
  } catch {
    return false
  }
}

async function releaseUnusedPaymentIntent(binding: PaymentIntentBinding): Promise<void> {
  try {
    await runtimeDeps
      .knex('message_payment_intents')
      .where({
        transaction_id: binding.transactionId,
        request_digest: binding.requestDigest,
        attempt_token: binding.attemptToken,
        status: 'prepared'
      })
      .delete()
  } catch {
    Logger.error('[ERROR] Failed to release an unused message payment intent.')
  }
}

async function preserveAcceptedPaymentIntent(state: PaymentFinalizationState): Promise<boolean> {
  if (state.intent == null || !state.walletAccepted) return true
  const persisted = await updatePaymentIntent(state.intent, 'wallet_accepted')
  if (!persisted) {
    Logger.error('[ERROR] Failed to preserve accepted message payment intent.')
  }
  return persisted
}

async function finalizePayment(
  payment: Payment,
  deliveryFee: number,
  transactionId: string,
  authenticatedSender: string,
  transaction: Knex.Transaction,
  state: PaymentFinalizationState
): Promise<RouteFailure | undefined> {
  if (!state.walletAccepted) {
    // Wallet acceptance validates the server-owned output. Cache a successful
    // verdict only for this handler so a database-conflict retry does not
    // internalize it twice. A fresh request must receive a newly accepted
    // verdict; wallet merge results fail closed before a replay claim is made.
    state.walletAttempted = deliveryFee > 0
    const internalizationFailure = await internalizeDeliveryFee(
      payment,
      deliveryFee,
      authenticatedSender
    )
    if (internalizationFailure != null) return internalizationFailure
    state.walletAccepted = true
  }
  return await claimPayment(transactionId, transaction)
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error != null && typeof error === 'object' && 'code' in error && error.code === code
}

function isDuplicateDatabaseError(error: unknown): boolean {
  return (
    hasErrorCode(error, 'ER_DUP_ENTRY') ||
    hasErrorCode(error, 'SQLITE_CONSTRAINT_PRIMARYKEY') ||
    hasErrorCode(error, 'SQLITE_CONSTRAINT_UNIQUE')
  )
}

class RouteFailureError extends Error {
  constructor(readonly failure: RouteFailure) {
    const detail = failure.payload.description ?? failure.payload.code
    super(typeof detail === 'string' ? detail : 'Route failure')
  }
}

interface StoredMessageRow {
  messageId: string
  messageBoxId: number
  sender: string
  recipient: string
  body: string
  bodyBytes: number
  created_at: Date
  updated_at: Date
  expires_at: Date | null
}

interface ResourceUsage {
  messageCount: number
  bodyBytes: number
}

function numericAggregate(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  return 0
}

function activeMessages(query: Knex.QueryBuilder, now: Date): Knex.QueryBuilder {
  return query.where(builder => {
    builder.whereNull('expires_at').orWhere('expires_at', '>', now)
  })
}

async function resourceUsage(
  transaction: Knex.Transaction,
  column: 'sender' | 'recipient',
  identityKey: string,
  now: Date
): Promise<ResourceUsage> {
  const byteFunction = transaction.client.config.client.includes('sqlite')
    ? 'LENGTH(??)'
    : 'OCTET_LENGTH(??)'
  const result = await activeMessages(transaction('messages').where(column, identityKey), now)
    .count<{ message_count: string | number }[]>({ message_count: '*' })
    .select(transaction.raw(`COALESCE(SUM(${byteFunction}), 0) AS ??`, ['body', 'body_bytes']))
    .first()
  return {
    messageCount: numericAggregate(result?.message_count),
    bodyBytes: numericAggregate((result as Record<string, unknown> | undefined)?.body_bytes)
  }
}

function enforceQuota(
  usage: ResourceUsage,
  additions: ResourceUsage,
  maxMessages: number,
  maxBytes: number,
  code: string,
  description: string
): void {
  if (maxMessages !== -1 && usage.messageCount + additions.messageCount > maxMessages) {
    throw new RouteFailureError(
      routeFailure(429, code, description, {
        resource: 'messages',
        limit: maxMessages
      })
    )
  }
  if (maxBytes !== -1 && usage.bodyBytes + additions.bodyBytes > maxBytes) {
    throw new RouteFailureError(
      routeFailure(429, code, description, {
        resource: 'bytes',
        limit: maxBytes
      })
    )
  }
}

function resourceLockKeys(identities: string[]): string[] {
  return [...new Set(identities)].sort((left, right) => left.localeCompare(right))
}

async function ensureResourceLockRows(knex: Knex, keys: string[], now: Date): Promise<void> {
  await knex('message_resource_locks')
    .insert(keys.map(identity_key => ({ identity_key, updated_at: now })))
    .onConflict('identity_key')
    .ignore()
}

async function acquireResourceLocks(transaction: Knex.Transaction, keys: string[]): Promise<void> {
  // The short autocommit ensure operation runs before this transaction. That
  // prevents concurrent INSERT IGNORE shared locks from being upgraded to
  // FOR UPDATE locks inside long-lived quota transactions on MySQL/PXC.
  await transaction('message_resource_locks')
    .whereIn('identity_key', keys)
    .orderBy('identity_key', 'asc')
    .select('identity_key')
    .forUpdate()
}

function buildStoredBody(
  validated: ValidatedMessage,
  recipient: string,
  payment: Payment | undefined,
  recipientOutputs: RecipientOutputs
): string {
  const recipientPayment =
    recipientOutputs.has(recipient) && payment != null
      ? { ...payment, outputs: recipientOutputs.get(recipient)! }
      : undefined
  return JSON.stringify({
    message: validated.message.body,
    ...(recipientPayment != null ? { payment: recipientPayment } : {})
  })
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
  } catch {
    Logger.error('[ERROR] Error processing FCM delivery.')
  }
}

async function storeMessages(
  validated: ValidatedMessage,
  senderKey: string,
  payment: Payment | undefined,
  recipientOutputs: RecipientOutputs,
  afterInsert?: (transaction: Knex.Transaction) => Promise<RouteFailure | undefined>
): Promise<RouteResult<Array<{ recipient: string; messageId: string }>>> {
  const resourceConfig = readMessageBoxResourceConfig()
  const databaseRetryConfig = readDatabaseRetryConfig()
  const now = new Date()
  const expiresAt = messageExpiresAt(resourceConfig, now)
  const lockKeys = resourceLockKeys([senderKey, ...validated.recipients])

  const onRetry = (error: unknown, retry: number, delayMs: number): void => {
    const candidateCode =
      error != null && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : 'serialization-conflict'
    const reason =
      candidateCode === 'ER_LOCK_DEADLOCK' || candidateCode === 'ER_LOCK_WAIT_TIMEOUT'
        ? candidateCode
        : 'serialization-conflict'
    log.warn(
      {
        operation: 'message.store.retry',
        reason,
        retry,
        max_retries: databaseRetryConfig.maxRetries,
        delay_ms: delayMs
      },
      'Retrying transient database lock conflict'
    )
  }

  try {
    await withDatabaseConflictRetry(
      async () => await ensureResourceLockRows(runtimeDeps.knex, lockKeys, now),
      databaseRetryConfig,
      onRetry
    )
    const rows = await withDatabaseConflictRetry(
      async () =>
        await runtimeDeps.knex.transaction(async transaction => {
          await acquireResourceLocks(transaction, lockKeys)

          await transaction('messageBox')
            .insert(
              validated.recipients.map(identityKey => ({
                identityKey,
                type: validated.boxType,
                created_at: now,
                updated_at: now
              }))
            )
            .onConflict(['type', 'identityKey'])
            .ignore()

          const messageBoxes = await transaction('messageBox')
            .whereIn('identityKey', validated.recipients)
            .where('type', validated.boxType)
            .select('identityKey', 'messageBoxId')
          const messageBoxIds = new Map<string, number>(
            messageBoxes.map(row => [String(row.identityKey), Number(row.messageBoxId)])
          )

          const storedRows: StoredMessageRow[] = validated.recipients.map(recipient => {
            const messageId = validated.messageIdByRecipient.get(recipient)
            const messageBoxId = messageBoxIds.get(recipient)
            if (messageId == null || messageId === '' || messageBoxId == null) {
              throw new RouteFailureError(
                routeFailure(400, 'ERR_INVALID_MESSAGEID', `Missing message data for ${recipient}`)
              )
            }
            const body = buildStoredBody(validated, recipient, payment, recipientOutputs)
            return {
              messageId,
              messageBoxId,
              sender: senderKey,
              recipient,
              body,
              bodyBytes: Buffer.byteLength(body, 'utf8'),
              created_at: now,
              updated_at: now,
              expires_at: expiresAt
            }
          })

          const senderUsage = await resourceUsage(transaction, 'sender', senderKey, now)
          enforceQuota(
            senderUsage,
            {
              messageCount: storedRows.length,
              bodyBytes: storedRows.reduce((total, row) => total + row.bodyBytes, 0)
            },
            resourceConfig.maxSenderMessages,
            resourceConfig.maxSenderBytes,
            'ERR_SENDER_QUOTA_EXCEEDED',
            'The sender storage quota has been reached. Retry after messages expire.'
          )

          for (const recipient of validated.recipients) {
            const recipientRows = storedRows.filter(row => row.recipient === recipient)
            const usage = await resourceUsage(transaction, 'recipient', recipient, now)
            enforceQuota(
              usage,
              {
                messageCount: recipientRows.length,
                bodyBytes: recipientRows.reduce((total, row) => total + row.bodyBytes, 0)
              },
              resourceConfig.maxInboxMessages,
              resourceConfig.maxInboxBytes,
              'ERR_INBOX_QUOTA_EXCEEDED',
              'The recipient inbox storage quota has been reached. Retry after messages are acknowledged or expire.'
            )
          }

          const knownDuplicate = await transaction('messages')
            .whereIn(
              'messageId',
              storedRows.map(row => row.messageId)
            )
            .first('messageId')
          if (knownDuplicate != null) {
            throw new RouteFailureError(
              routeFailure(400, 'ERR_DUPLICATE_MESSAGE', 'Duplicate message.')
            )
          }

          await transaction('messages').insert(
            storedRows.map(({ bodyBytes: _bodyBytes, ...row }) => row)
          )

          // Reserve every globally unique message ID before mutating the wallet.
          // A conflicting insert now fails without accepting payment, while a
          // finalization failure rolls this insert back with the transaction.
          const finalizationFailure = await afterInsert?.(transaction)
          if (finalizationFailure != null) throw new RouteFailureError(finalizationFailure)

          return storedRows
        }),
      databaseRetryConfig,
      onRetry
    )

    const results = rows.map(({ recipient, messageId }) => ({ recipient, messageId }))
    await mapWithConcurrency(
      results,
      resourceConfig.notificationRecipientConcurrency,
      async ({ recipient, messageId }) => {
        await notifyRecipient(recipient, messageId, validated.boxType)
      }
    )
    return routeValue(results)
  } catch (error) {
    if (error instanceof RouteFailureError) return error.failure
    if (isDuplicateDatabaseError(error)) {
      return routeFailure(400, 'ERR_DUPLICATE_MESSAGE', 'Duplicate message.')
    }
    throw error
  }
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
 *                     description: Exact control-free UTF-8 name; surrounding whitespace is not normalized
 *                   messageId:
 *                     oneOf:
 *                       - type: string
 *                         maxLength: 256
 *                       - type: array
 *                         maxItems: 100
 *                         items:
 *                           type: string
 *                           maxLength: 256
 *                     description: Exact control-free UTF-8 identifier per recipient (usually an HMAC); surrounding whitespace is not normalized
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
    const authenticatedSender = canonicalizeAuthenticatedSender(senderKey)
    if (isRouteFailure(authenticatedSender)) return sendFailure(res, authenticatedSender)

    try {
      const safeBody = snapshotSendBody(req.body)
      if (isRouteFailure(safeBody)) return sendFailure(res, safeBody)
      const { message, payment } = safeBody.value
      log.info(
        {
          operation: 'message.send',
          has_payment: payment != null
        },
        'Received message send request'
      )

      const validated = validateMessage(message)
      if (isRouteFailure(validated)) return sendFailure(res, validated)
      // BRC-105 pricing replaces the legacy server-delivery output. Recipient
      // permission fees remain independent and are still honored.
      const deliveryFee = readMessageBoxPricingConfig().enabled
        ? 0
        : await getServerDeliveryFee(validated.value.boxType)
      const requiredDeliveryFee = aggregateDeliveryFee(
        deliveryFee,
        validated.value.recipients.length
      )
      const feeRows = await evaluateRecipientFees(
        validated.value.recipients,
        authenticatedSender.value,
        validated.value.boxType
      )
      const blocked = blockedRecipientFailure(feeRows)
      if (blocked != null) return sendFailure(res, blocked)
      const recipientPayments = await prepareRecipientPayments(
        payment,
        requiredDeliveryFee,
        feeRows,
        authenticatedSender.value
      )
      if (isRouteFailure(recipientPayments)) {
        return sendFailure(res, recipientPayments)
      }
      let intent: PaymentIntentBinding | undefined
      let walletAccepted = false
      if (
        payment != null &&
        recipientPayments.value.transactionId != null &&
        requiredDeliveryFee > 0
      ) {
        const proposedIntent: PaymentIntentBinding = {
          transactionId: recipientPayments.value.transactionId,
          requestDigest: paymentIntentDigest(
            validated.value,
            authenticatedSender.value,
            payment,
            recipientPayments.value.transactionId
          ),
          attemptToken: randomBytes(32).toString('hex')
        }
        const preparedIntent = await preparePaymentIntent(proposedIntent)
        if (isRouteFailure(preparedIntent)) return sendFailure(res, preparedIntent)
        intent = preparedIntent.value.binding
        walletAccepted = preparedIntent.value.status !== 'prepared'
      }
      const paymentFinalizationState: PaymentFinalizationState = {
        walletAccepted,
        walletAttempted: false,
        intent
      }
      let stored: RouteResult<Array<{ recipient: string; messageId: string }>>
      try {
        stored = await storeMessages(
          validated.value,
          authenticatedSender.value,
          payment,
          recipientPayments.value.outputs,
          payment != null && recipientPayments.value.transactionId != null
            ? async transaction =>
                await finalizePayment(
                  payment,
                  requiredDeliveryFee,
                  recipientPayments.value.transactionId!,
                  authenticatedSender.value,
                  transaction,
                  paymentFinalizationState
                )
            : undefined
        )
      } catch (error) {
        if (!(await preserveAcceptedPaymentIntent(paymentFinalizationState))) {
          return sendFailure(
            res,
            routeFailure(
              503,
              'ERR_PAYMENT_RECOVERY_UNAVAILABLE',
              'The accepted payment could not be durably recorded for recovery.'
            )
          )
        }
        if (intent != null && !paymentFinalizationState.walletAttempted) {
          await releaseUnusedPaymentIntent(intent)
        }
        throw error
      }
      if (isRouteFailure(stored)) {
        if (!(await preserveAcceptedPaymentIntent(paymentFinalizationState))) {
          return sendFailure(
            res,
            routeFailure(
              503,
              'ERR_PAYMENT_RECOVERY_UNAVAILABLE',
              'The accepted payment could not be durably recorded for recovery.'
            )
          )
        }
        if (intent != null && !paymentFinalizationState.walletAttempted) {
          await releaseUnusedPaymentIntent(intent)
        }
        return sendFailure(res, stored)
      }
      if (intent != null && !(await updatePaymentIntent(intent, 'completed'))) {
        // Message and replay claim are already committed. A prepared intent is
        // still exact-request-bound and duplicate-message checks remain final.
        Logger.error('[ERROR] Failed to mark message payment intent completed.')
      }
      return res.status(200).json({
        status: 'success',
        message: `Your message has been sent to ${stored.value.length} recipient(s).`,
        results: stored.value
      })
    } catch {
      Logger.error('[ERROR] Message send failed.')
      return res.status(500).json({
        status: 'error',
        code: 'ERR_INTERNAL',
        description: 'An internal error has occurred.'
      })
    }
  }
}
