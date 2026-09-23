/**
 * @file MessageBoxClient.ts
 * @description
 * Provides the `MessageBoxClient` class — a secure client library for sending and receiving messages
 * via a Message Box Server over HTTP and WebSocket. Messages are authenticated, optionally encrypted,
 * and routed using identity-based addressing based on BRC-2/BRC-42/BRC-43 protocols.
 *
 * Core Features:
 * - Authenticated message transport using identity keys
 * - Deterministic message ID generation via HMAC (BRC-2)
 * - AES-256-GCM encryption using ECDH shared secrets derived via BRC-42/BRC-43
 * - Support for sending messages to self (`counterparty: 'self'`)
 * - Live message streaming using WebSocket rooms
 * - Optional plaintext messaging with `skipEncryption`
 * - Overlay host discovery and advertisement broadcasting via SHIP
 * - MessageBox-based organization and acknowledgment system
 *
 * See BRC-2 for details on the encryption scheme: https://github.com/bitcoin-sv/BRCs/blob/master/wallet/0002.md
 *
 * @module MessageBoxClient
 * @author BSV Association
 * @license Open BSV License
 */

import { AuthFetch } from '@bsv/sdk/auth/clients/AuthFetch'
import { PublicKey, Random } from '@bsv/sdk/primitives'
import { toArray, toBase64, toHex, toUTF8, toUTF8Strict } from '@bsv/sdk/primitives/utils'
import { LookupResolver, TopicBroadcaster, type LookupNetworkPreset } from '@bsv/sdk/overlay-tools'
import { P2PKH, PushDrop } from '@bsv/sdk/script/templates'
import { decodeCanonicalPushDrop } from '@bsv/sdk/script/templates/PushDropValidation'
import { Beef, Transaction } from '@bsv/sdk/transaction'
import { normalizeBRC100ByteArray, stringifyBRC100 } from '@bsv/sdk/wallet/BRC100ByteEncoding'
import { ProtoWallet, WalletClient } from '@bsv/sdk/wallet'
import type {
  CreateActionOutput,
  InternalizeOutput,
  OriginatorDomainNameStringUnder250Bytes,
  PubKeyHex,
  WalletInterface
} from '@bsv/sdk/wallet/Wallet.interfaces'
import {
  snapshotWalletResultRequest,
  validateWalletResult
} from '@bsv/sdk/wallet/WalletResultValidation'
import { AuthSocketClient } from '@bsv/authsocket-client'
import * as Logger from './Utils/logger.js'
import {
  messageBoxEndpoint,
  normalizeMessageBoxHost,
  normalizeOverlayMessageBoxHost
} from './host.js'
import {
  AcknowledgeMessageParams,
  AdvertisementToken,
  EncryptedMessage,
  ListMessagesParams,
  MessageBoxClientOptions,
  Payment,
  PeerMessage,
  SendMessageParams,
  SendMessageResponse,
  DeviceRegistrationParams,
  DeviceRegistrationResponse,
  RegisteredDevice
} from './types.js'
import {
  SetMessageBoxPermissionParams,
  GetMessageBoxPermissionParams,
  MessageBoxPermission,
  MessageBoxMultiQuote,
  MessageBoxQuote,
  ListPermissionsParams,
  GetQuoteParams,
  SendListParams,
  SendListResult
} from './types/permissions.js'

const DEFAULT_MAINNET_HOST = 'https://message-box-us-1.bsvb.tech'
const DEFAULT_TESTNET_HOST = DEFAULT_MAINNET_HOST
const MAX_SERVER_IDENTITY_PINS = 32
const MAX_ADVERTISEMENT_OUTPUTS = 256
const MAX_ADVERTISEMENT_BEEF_BYTES = 32 * 1024 * 1024
const MAX_MESSAGE_BOX_BYTES = 128
const MAX_MESSAGE_ID_BYTES = 256
const MAX_MESSAGE_BODY_BYTES = 4 * 1024 * 1024
const MAX_MESSAGE_CIPHERTEXT_BYTES = MAX_MESSAGE_BODY_BYTES + 256
const MAX_MESSAGE_RECIPIENTS = 100
const MAX_ACKNOWLEDGMENT_IDS = 1_000
const MAX_MESSAGE_FEE = 2_147_483_647
const MAX_PAYMENT_BEEF_BYTES = 32 * 1024 * 1024
const MAX_PAYMENT_OUTPUTS = MAX_MESSAGE_RECIPIENTS + 1
const unsafeRecordKeys = new Set(['__proto__', 'constructor', 'prototype'])

type OwnDataRecord = Record<string, unknown>
const MAX_SAFE_DATA_NODES = 1_000_000

interface OutgoingMessageSnapshot {
  recipient: PubKeyHex
  messageBox: string
  bodyForHmac: string
  bodyForWire: string
  messageId?: string
  skipEncryption: boolean
  checkPermissions: boolean
  maximumPayment?: number
}

interface BatchSendSnapshot {
  recipients: PubKeyHex[]
  messageBox: string
  bodyForHmac: string
  bodyForWire: string
  maximumPayment?: number
}

function isPlainObjectPrototype(prototype: object | null): boolean {
  return prototype === null || Object.getPrototypeOf(prototype) === null
}

function isPlainArrayPrototype(prototype: object | null): boolean {
  if (prototype === null) return false
  const parent = Object.getPrototypeOf(prototype)
  return parent != null && Object.getPrototypeOf(parent) === null
}

function assertSafeDataGraph(value: unknown, name: string): void {
  const pending: unknown[] = [value]
  const seen = new WeakSet<object>()
  let nodes = 0
  try {
    while (pending.length > 0) {
      const candidate = pending.pop()
      if (candidate == null || typeof candidate !== 'object') continue
      if (candidate instanceof Uint8Array) {
        nodes += candidate.byteLength
        if (nodes > MAX_SAFE_DATA_NODES) throw new TypeError(`${name} is too large.`)
        continue
      }
      if (seen.has(candidate)) continue
      seen.add(candidate)
      nodes++
      if (nodes > MAX_SAFE_DATA_NODES) throw new TypeError(`${name} is too large.`)
      const keys = Reflect.ownKeys(candidate)
      nodes += keys.length
      if (nodes > MAX_SAFE_DATA_NODES) throw new TypeError(`${name} is too large.`)
      if (Array.isArray(candidate)) {
        if (!isPlainArrayPrototype(Object.getPrototypeOf(candidate))) {
          throw new TypeError(`${name} contains a non-plain array.`)
        }
        if (keys.length !== candidate.length + 1) {
          throw new TypeError(`${name} contains a sparse or extended array.`)
        }
      } else if (!isPlainObjectPrototype(Object.getPrototypeOf(candidate))) {
        throw new TypeError(`${name} contains a non-plain object.`)
      }
      for (const key of keys) {
        if (typeof key !== 'string' || unsafeRecordKeys.has(key)) {
          throw new TypeError(`${name} contains an unsafe property.`)
        }
        if (Array.isArray(candidate) && key !== 'length') {
          const index = Number(key)
          if (
            !Number.isSafeInteger(index) ||
            index < 0 ||
            index >= candidate.length ||
            String(index) !== key
          ) {
            throw new TypeError(`${name} contains an invalid array property.`)
          }
        }
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key)
        if (descriptor == null || !('value' in descriptor)) {
          throw new TypeError(`${name} must contain only own data properties.`)
        }
        pending.push(descriptor.value)
      }
    }
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith(name)) throw error
    throw new TypeError(`${name} must contain only bounded plain own data.`)
  }
}

function ownDataRecord(value: unknown, name: string): OwnDataRecord {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be a plain own-data record.`)
  }
  try {
    const prototype = Object.getPrototypeOf(value)
    const keys = Reflect.ownKeys(value)
    if (!isPlainObjectPrototype(prototype)) {
      throw new TypeError(`${name} must use a plain object prototype.`)
    }
    const snapshot: OwnDataRecord = Object.create(null)
    for (const key of keys) {
      if (typeof key !== 'string' || unsafeRecordKeys.has(key)) {
        throw new TypeError(`${name} contains an unsafe property.`)
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor == null || !('value' in descriptor)) {
        throw new TypeError(`${name} must contain only own data properties.`)
      }
      snapshot[key] = descriptor.value
    }
    return snapshot
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith(name)) throw error
    throw new TypeError(`${name} must be a plain own-data record.`)
  }
}

function ownDataArray(value: unknown, name: string, maximumLength: number): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array.`)
  try {
    const prototype = Object.getPrototypeOf(value)
    const keys = Reflect.ownKeys(value)
    if (
      !isPlainArrayPrototype(prototype) ||
      value.length > maximumLength ||
      keys.length !== value.length + 1
    ) {
      throw new TypeError(`${name} must be a bounded dense ordinary array.`)
    }
    const snapshot = Array.from<unknown>({ length: value.length })
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (descriptor == null || descriptor.enumerable !== true || !('value' in descriptor)) {
        throw new TypeError(`${name} must contain only enumerable own data properties.`)
      }
      snapshot[index] = descriptor.value
    }
    return snapshot
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith(name)) throw error
    throw new TypeError(`${name} must be a bounded dense ordinary array.`)
  }
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return true
  }
  return false
}

function exactBoundedText(
  value: unknown,
  name: string,
  maximumBytes: number,
  options: { forbidControls?: boolean } = {}
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    utf8Length(value) > maximumBytes ||
    (options.forbidControls === true && containsControlCharacter(value))
  ) {
    throw new TypeError(
      `${name} must be an exact non-empty string of at most ${maximumBytes} UTF-8 bytes.`
    )
  }
  return value
}

function optionalMaximumPayment(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer.`)
  }
  return value as number
}

function serializeOutgoingBody(value: unknown): { bodyForHmac: string; bodyForWire: string } {
  if (value == null || (typeof value !== 'string' && typeof value !== 'object')) {
    throw new TypeError('Message body must be a non-empty string or plain data object.')
  }
  if (typeof value === 'object') assertSafeDataGraph(value, 'Message Box message body')
  let bodyForHmac: string
  try {
    bodyForHmac = stringifyBRC100(value)
  } catch {
    throw new TypeError('Message body must be serializable BRC-100 JSON data.')
  }
  const bodyForWire = typeof value === 'string' ? value : bodyForHmac
  if (bodyForWire.trim() === '' || utf8Length(bodyForWire) > MAX_MESSAGE_BODY_BYTES) {
    throw new TypeError(
      `Message body must be non-empty and at most ${MAX_MESSAGE_BODY_BYTES} UTF-8 bytes.`
    )
  }
  return { bodyForHmac, bodyForWire }
}

function snapshotSendMessageParams(value: unknown): OutgoingMessageSnapshot {
  const record = ownDataRecord(value, 'SendMessageParams')
  if (typeof record.recipient !== 'string' || record.recipient.trim() === '') {
    throw new Error('You must provide a message recipient!')
  }
  if (typeof record.messageBox !== 'string' || record.messageBox.trim() === '') {
    throw new Error('You must provide a messageBox to send this message into!')
  }
  if (record.body == null || (typeof record.body === 'string' && record.body.trim() === '')) {
    throw new Error('Every message must have a body!')
  }
  const recipient = canonicalIdentityKey(record.recipient, 'Message recipient')
  const messageBox = exactBoundedText(record.messageBox, 'Message box', MAX_MESSAGE_BOX_BYTES, {
    forbidControls: true
  })
  const body = serializeOutgoingBody(record.body)
  const messageId =
    record.messageId === undefined
      ? undefined
      : exactBoundedText(record.messageId, 'Message ID', MAX_MESSAGE_ID_BYTES, {
          forbidControls: true
        })
  if (record.skipEncryption !== undefined && typeof record.skipEncryption !== 'boolean') {
    throw new TypeError('skipEncryption must be a boolean when provided.')
  }
  if (record.checkPermissions !== undefined && typeof record.checkPermissions !== 'boolean') {
    throw new TypeError('checkPermissions must be a boolean when provided.')
  }
  return {
    recipient,
    messageBox,
    ...body,
    messageId,
    skipEncryption: record.skipEncryption === true,
    checkPermissions: record.checkPermissions === true,
    maximumPayment: optionalMaximumPayment(record.maximumPayment, 'maximumPayment')
  }
}

function snapshotBatchSendParams(value: unknown): BatchSendSnapshot {
  const record = ownDataRecord(value, 'SendListParams')
  assertSafeDataGraph(record.recipients, 'Message Box batch recipients')
  if (!Array.isArray(record.recipients) || record.recipients.length === 0) {
    throw new Error('You must provide at least one recipient!')
  }
  if (record.recipients.length > MAX_MESSAGE_RECIPIENTS) {
    throw new Error(`A batch may include at most ${MAX_MESSAGE_RECIPIENTS} recipients.`)
  }
  if (record.skipEncryption !== true) {
    throw new TypeError(
      'A shared multi-recipient batch cannot be encrypted per recipient. Set skipEncryption: true explicitly or send encrypted messages individually.'
    )
  }
  const recipients = record.recipients.map((recipient, index) =>
    canonicalIdentityKey(recipient, `Batch recipient ${index}`)
  )
  if (new Set(recipients).size !== recipients.length) {
    throw new TypeError('Batch recipients must be unique.')
  }
  if (typeof record.messageBox !== 'string' || record.messageBox.trim() === '') {
    throw new Error('You must provide a messageBox to send this message into!')
  }
  if (record.body == null || (typeof record.body === 'string' && record.body.trim() === '')) {
    throw new Error('Every message must have a body!')
  }
  return {
    recipients,
    messageBox: exactBoundedText(record.messageBox, 'Message box', MAX_MESSAGE_BOX_BYTES, {
      forbidControls: true
    }),
    ...serializeOutgoingBody(record.body),
    maximumPayment: optionalMaximumPayment(record.maximumPayment, 'maximumPayment')
  }
}

function snapshotQuoteParams(value: unknown): {
  recipient: PubKeyHex | PubKeyHex[]
  messageBox: string
} {
  const record = ownDataRecord(value, 'GetQuoteParams')
  const messageBox = exactBoundedText(record.messageBox, 'Message box', MAX_MESSAGE_BOX_BYTES, {
    forbidControls: true
  })
  if (!Array.isArray(record.recipient)) {
    return {
      recipient: canonicalIdentityKey(record.recipient, 'Quote recipient'),
      messageBox
    }
  }
  assertSafeDataGraph(record.recipient, 'Message Box quote recipients')
  if (record.recipient.length === 0) throw new Error('At least one recipient is required.')
  if (record.recipient.length > MAX_MESSAGE_RECIPIENTS) {
    throw new TypeError(`A quote may include at most ${MAX_MESSAGE_RECIPIENTS} recipients.`)
  }
  const recipients = record.recipient.map((recipient, index) =>
    canonicalIdentityKey(recipient, `Quote recipient ${index}`)
  )
  if (new Set(recipients).size !== recipients.length) {
    throw new TypeError('Quote recipients must be unique.')
  }
  return { recipient: recipients, messageBox }
}

function messageFee(value: unknown, name: string, allowBlocked = false): number {
  const minimum = allowBlocked ? -1 : 0
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > MAX_MESSAGE_FEE
  ) {
    throw new TypeError(`${name} must be an integer from ${minimum} to ${MAX_MESSAGE_FEE}.`)
  }
  return value as number
}

function isoTimestamp(value: unknown, name: string): string {
  const timestamp = exactBoundedText(value, name, 64, { forbidControls: true })
  if (!Number.isFinite(Date.parse(timestamp))) throw new TypeError(`${name} must be a timestamp.`)
  return timestamp
}

function validatePermissionRecord(value: unknown): MessageBoxPermission {
  try {
    const record = ownDataRecord(value, 'Message Box permission')
    const rawSender = record.sender
    const sender =
      rawSender === null ? null : canonicalIdentityKey(rawSender, 'Permission sender identity')
    const messageBox = exactBoundedText(
      record.messageBox ?? record.message_box,
      'Permission message box',
      MAX_MESSAGE_BOX_BYTES,
      { forbidControls: true }
    )
    const recipientFee = messageFee(
      record.recipientFee ?? record.recipient_fee,
      'Permission recipient fee',
      true
    )
    return {
      sender,
      messageBox,
      recipientFee,
      status:
        recipientFee === -1 ? 'blocked' : recipientFee === 0 ? 'always_allow' : 'payment_required',
      createdAt: isoTimestamp(record.createdAt ?? record.created_at, 'Permission creation time'),
      updatedAt: isoTimestamp(record.updatedAt ?? record.updated_at, 'Permission update time')
    }
  } catch {
    throw new TypeError('Failed to list permissions: server returned an invalid permission record')
  }
}

function validateRegisteredDevice(value: unknown): RegisteredDevice {
  const record = ownDataRecord(value, 'Registered device')
  if (!Number.isSafeInteger(record.id) || (record.id as number) < 1) {
    throw new TypeError('Registered device ID must be a positive safe integer.')
  }
  const deviceId =
    record.deviceId === null
      ? null
      : exactBoundedText(record.deviceId, 'Registered device identifier', 255, {
          forbidControls: true
        })
  const platform = record.platform
  if (platform !== null && platform !== 'ios' && platform !== 'android' && platform !== 'web') {
    throw new TypeError('Registered device platform is invalid.')
  }
  if (typeof record.active !== 'boolean') {
    throw new TypeError('Registered device active flag is invalid.')
  }
  return {
    id: record.id as number,
    deviceId,
    platform,
    fcmToken: exactBoundedText(record.fcmToken, 'Masked FCM token', 64, {
      forbidControls: true
    }),
    active: record.active,
    createdAt: isoTimestamp(record.createdAt, 'Device creation time'),
    updatedAt: isoTimestamp(record.updatedAt, 'Device update time'),
    lastUsed: isoTimestamp(record.lastUsed, 'Device last-used time')
  }
}

function checkedFeeSum(values: readonly number[], name: string): number {
  let total = 0
  for (const value of values) {
    total += value
    if (!Number.isSafeInteger(total)) throw new TypeError(`${name} exceeds the safe integer range.`)
  }
  return total
}

function boundedByteArray(
  value: unknown,
  name: string,
  maximumLength: number,
  exactLength?: number
): number[] {
  let bytes: readonly unknown[] | Uint8Array | undefined
  try {
    if (Array.isArray(value)) {
      bytes = ownDataArray(value, name, maximumLength)
    } else if (value != null && typeof value === 'object' && ArrayBuffer.isView(value)) {
      const normalized = normalizeBRC100ByteArray(value)
      if (
        normalized != null &&
        !Array.isArray(normalized) &&
        normalized.length <= maximumLength &&
        (exactLength === undefined || normalized.length === exactLength)
      ) {
        bytes = Uint8Array.prototype.slice.call(normalized)
      }
    } else if (value != null && typeof value === 'object') {
      const prototype = Object.getPrototypeOf(value)
      const keys = Reflect.ownKeys(value)
      if (
        isPlainObjectPrototype(prototype) &&
        keys.length > 0 &&
        keys.length <= maximumLength &&
        (exactLength === undefined || keys.length === exactLength)
      ) {
        const historical = Array.from<unknown>({ length: keys.length })
        for (let index = 0; index < keys.length; index++) {
          const key = keys[index]
          const descriptor = Object.getOwnPropertyDescriptor(value, key)
          if (
            key !== String(index) ||
            descriptor == null ||
            descriptor.enumerable !== true ||
            !('value' in descriptor)
          ) {
            historical.length = 0
            break
          }
          historical[index] = descriptor.value
        }
        if (historical.length > 0) bytes = historical
      }
    }
  } catch {
    bytes = undefined
  }
  if (
    bytes == null ||
    bytes.length > maximumLength ||
    (exactLength !== undefined && bytes.length !== exactLength) ||
    !Array.prototype.every.call(
      bytes,
      (byte: unknown) => Number.isInteger(byte) && (byte as number) >= 0 && (byte as number) <= 255
    )
  ) {
    throw new TypeError(`${name} must be ${exactLength ?? `at most ${maximumLength}`} bytes.`)
  }
  return Array.from(bytes as ArrayLike<number>)
}

function safeResponseRecord(value: unknown, name: string): OwnDataRecord {
  assertSafeDataGraph(value, name)
  return ownDataRecord(value, name)
}

function snapshotIncomingPayment(
  value: unknown,
  name: string
): Parameters<WalletInterface['internalizeAction']>[0] {
  const payment = ownDataRecord(value, name)
  const tx = boundedByteArray(payment.tx, `${name} transaction`, MAX_PAYMENT_BEEF_BYTES)
  if (tx.length === 0) {
    throw new TypeError(`${name} transaction must not be empty.`)
  }
  const paymentOutputs = ownDataArray(payment.outputs, `${name} outputs`, MAX_PAYMENT_OUTPUTS)
  const outputs = paymentOutputs.flatMap((value, index) => {
    const output = safeResponseRecord(value, `${name} output ${index}`)
    if (output.protocol !== 'wallet payment') return []
    if (!Number.isSafeInteger(output.outputIndex) || (output.outputIndex as number) < 0) {
      throw new TypeError(`${name} output ${index} index must be a non-negative safe integer.`)
    }
    const snapshot: Record<string, unknown> = {
      outputIndex: output.outputIndex,
      protocol: output.protocol
    }
    if (output.paymentRemittance !== undefined) {
      const remittance = safeResponseRecord(
        output.paymentRemittance,
        `${name} output ${index} remittance`
      )
      snapshot.paymentRemittance = {
        derivationPrefix: remittance.derivationPrefix,
        derivationSuffix: remittance.derivationSuffix,
        senderIdentityKey: remittance.senderIdentityKey
      }
    }
    return [snapshot as unknown as InternalizeOutput]
  })
  const description =
    payment.description == null
      ? 'MessageBox recipient payment'
      : exactBoundedText(payment.description, `${name} description`, 50, {
          forbidControls: true
        })
  return {
    tx: tx as Parameters<WalletInterface['internalizeAction']>[0]['tx'],
    outputs,
    description
  }
}

function expectedQuoteStatus(recipientFee: number): MessageBoxQuoteStatus {
  if (recipientFee === -1) return 'blocked'
  return recipientFee === 0 ? 'always_allow' : 'payment_required'
}

function validateSingleQuoteResult(value: unknown): MessageBoxQuote {
  const record = safeResponseRecord(value, 'Message Box quote')
  return {
    deliveryFee: messageFee(record.deliveryFee, 'Quote deliveryFee'),
    recipientFee: messageFee(record.recipientFee, 'Quote recipientFee', true),
    deliveryAgentIdentityKey: canonicalIdentityKey(
      record.deliveryAgentIdentityKey,
      'Quote delivery-agent identity'
    )
  }
}

function validateQuoteRow(
  value: unknown,
  requestedRecipients: ReadonlySet<PubKeyHex>,
  messageBox: string,
  seen: Set<PubKeyHex>
): MessageBoxRecipientQuote {
  const record = safeResponseRecord(value, 'Message Box recipient quote')
  const recipient = canonicalIdentityKey(record.recipient, 'Quoted recipient')
  if (!requestedRecipients.has(recipient) || seen.has(recipient)) {
    throw new TypeError('Quote recipients must match the requested recipients exactly once.')
  }
  seen.add(recipient)
  if (record.messageBox !== messageBox) {
    throw new TypeError('Quoted messageBox does not match the requested messageBox.')
  }
  const deliveryFee = messageFee(record.deliveryFee, 'Quote deliveryFee')
  const recipientFee = messageFee(record.recipientFee, 'Quote recipientFee', true)
  const status = expectedQuoteStatus(recipientFee)
  if (record.status !== status) {
    throw new TypeError('Quoted status does not match the quoted recipient fee.')
  }
  return { recipient, messageBox, deliveryFee, recipientFee, status }
}

function normalizeDeliveryIdentityMap(value: unknown): Record<string, PubKeyHex> {
  const record = safeResponseRecord(value, 'Delivery-agent identity map')
  const entries = Object.entries(record)
  if (entries.length === 0 || entries.length > MAX_MESSAGE_RECIPIENTS) {
    throw new TypeError('Delivery-agent identity map must contain 1–100 hosts.')
  }
  const result: Record<string, PubKeyHex> = Object.create(null)
  for (const [host, identity] of entries) {
    const normalizedHost = normalizeMessageBoxHost(host)
    const key = canonicalIdentityKey(identity, `Delivery-agent identity for ${normalizedHost}`)
    const existing = result[normalizedHost]
    if (existing != null && existing !== key) {
      throw new TypeError(`Conflicting delivery-agent identities for ${normalizedHost}.`)
    }
    result[normalizedHost] = key
  }
  return result
}

function validateMultiQuoteResult(
  value: unknown,
  recipients: readonly PubKeyHex[],
  messageBox: string
): MessageBoxMultiQuote {
  const record = safeResponseRecord(value, 'Message Box multi-quote')
  if (!Array.isArray(record.quotesByRecipient)) {
    throw new TypeError('Multi-quote must contain quotesByRecipient.')
  }
  if (record.quotesByRecipient.length !== recipients.length) {
    throw new TypeError('Multi-quote must contain exactly one quote per requested recipient.')
  }
  const requested = new Set(recipients)
  const seen = new Set<PubKeyHex>()
  const quotesByRecipient = record.quotesByRecipient.map(quote =>
    validateQuoteRow(quote, requested, messageBox, seen)
  )
  const derivedBlocked = quotesByRecipient
    .filter(quote => quote.recipientFee === -1)
    .map(quote => quote.recipient)
  const rawBlocked = record.blockedRecipients ?? derivedBlocked
  if (!Array.isArray(rawBlocked)) {
    throw new TypeError('Multi-quote blockedRecipients must be an array when provided.')
  }
  const blockedRecipients = rawBlocked.map((recipient, index) =>
    canonicalIdentityKey(recipient, `Blocked quote recipient ${index}`)
  )
  if (
    new Set(blockedRecipients).size !== blockedRecipients.length ||
    blockedRecipients.length !== derivedBlocked.length ||
    blockedRecipients.some(recipient => !derivedBlocked.includes(recipient))
  ) {
    throw new TypeError('blockedRecipients must exactly match blocked quote rows.')
  }
  const deliveryFees = checkedFeeSum(
    quotesByRecipient.map(quote => quote.deliveryFee),
    'Quote delivery-fee total'
  )
  const recipientFees = checkedFeeSum(
    quotesByRecipient.filter(quote => quote.recipientFee > 0).map(quote => quote.recipientFee),
    'Quote recipient-fee total'
  )
  return {
    quotesByRecipient,
    totals: {
      deliveryFees,
      recipientFees,
      totalForPayableRecipients: checkedFeeSum([deliveryFees, recipientFees], 'Quote payment total')
    },
    blockedRecipients,
    deliveryAgentIdentityKeyByHost: normalizeDeliveryIdentityMap(
      record.deliveryAgentIdentityKeyByHost
    )
  }
}

function validateSendResponse(
  value: unknown,
  recipient: PubKeyHex,
  messageId: string
): SendMessageResponse {
  const record = safeResponseRecord(value, 'Message Box send response')
  if (record.status !== 'success') throw new Error('Message Box server rejected the message.')
  if (record.results !== undefined) {
    assertSafeDataGraph(record.results, 'Message Box send results')
    if (!Array.isArray(record.results) || record.results.length !== 1) {
      throw new TypeError('Message Box send response must describe exactly one result.')
    }
    const result = safeResponseRecord(record.results[0], 'Message Box send result')
    if (result.recipient !== recipient || result.messageId !== messageId) {
      throw new TypeError('Message Box send result does not match the submitted message.')
    }
  }
  const response: SendMessageResponse = { status: 'success', messageId }
  if (record.message !== undefined) {
    response.message = exactBoundedText(record.message, 'Message Box response message', 512)
  }
  return response
}

function validateBatchSendResults(
  value: unknown,
  recipients: readonly PubKeyHex[],
  messageIds: readonly string[]
): Array<{ recipient: PubKeyHex; messageId: string }> {
  assertSafeDataGraph(value, 'Message Box batch results')
  if (!Array.isArray(value) || value.length > recipients.length) {
    throw new TypeError('Message Box batch results exceed the submitted recipient set.')
  }
  const expected = new Map(recipients.map((recipient, index) => [recipient, messageIds[index]]))
  const seen = new Set<PubKeyHex>()
  return value.map(item => {
    const record = safeResponseRecord(item, 'Message Box batch result')
    const recipient = canonicalIdentityKey(record.recipient, 'Batch result recipient')
    if (seen.has(recipient) || expected.get(recipient) !== record.messageId) {
      throw new TypeError('Message Box batch result does not match the submitted message.')
    }
    seen.add(recipient)
    return { recipient, messageId: record.messageId as string }
  })
}

function canonicalIdentityKey(value: unknown, name: string): PubKeyHex {
  if (typeof value !== 'string' || !/^(?:02|03)[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(`${name} must be a canonical compressed public key.`)
  }
  try {
    if (PublicKey.fromString(value).toString() !== value) throw new Error('non-canonical key')
  } catch {
    throw new TypeError(`${name} must be a valid compressed public key.`)
  }
  return value as PubKeyHex
}

function normalizeServerIdentityPins(value: unknown): ReadonlyMap<string, PubKeyHex> {
  if (value === undefined) return new Map()
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('serverIdentityKeysByHost must be a plain own-data record.')
  }
  const prototype = Object.getPrototypeOf(value)
  const names = Object.getOwnPropertyNames(value)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    names.length > MAX_SERVER_IDENTITY_PINS ||
    names.some(name => descriptors[name]?.get != null || descriptors[name]?.set != null)
  ) {
    throw new TypeError('serverIdentityKeysByHost must be a bounded plain own-data record.')
  }

  const pins = new Map<string, PubKeyHex>()
  for (const host of names) {
    const origin = new URL(normalizeMessageBoxHost(host)).origin
    const identityKey = canonicalIdentityKey(
      descriptors[host]?.value,
      `Server identity pin for ${origin}`
    )
    const existing = pins.get(origin)
    if (existing != null && existing !== identityKey) {
      throw new TypeError(`Conflicting Message Box server identity pins for ${origin}.`)
    }
    pins.set(origin, identityKey)
  }
  return pins
}

/** Build status + description for a batch send result. */
function buildBatchSendResult(
  sentCount: number,
  allowedCount: number,
  blockedCount: number
): { status: SendListResult['status']; description: string } {
  if (sentCount === allowedCount) {
    return { status: 'success', description: `Sent to ${sentCount} recipients.` }
  }
  if (sentCount > 0) {
    return {
      status: 'partial',
      description: `Sent to ${sentCount} recipients; ${allowedCount - sentCount} failed; ${blockedCount} blocked.`
    }
  }
  return {
    status: 'error',
    description: `Failed to send to ${allowedCount} allowed recipients. ${blockedCount} blocked.`
  }
}

function buildRecipientQuoteMap(
  quotes: MessageBoxMultiQuote['quotesByRecipient']
): Map<string, { recipientFee: number; deliveryFee: number }> {
  return new Map(
    quotes.map(quote => [
      quote.recipient,
      {
        recipientFee: quote.recipientFee,
        deliveryFee: quote.deliveryFee
      }
    ])
  )
}

function selectDeliveryAgentIdentityKey(
  identityKeysByHost: Record<string, string> | undefined,
  finalHost: string,
  hasOverrideHost: boolean
): string {
  const entries = Object.entries(identityKeysByHost ?? {})
  if (entries.length === 0) {
    throw new Error('Missing delivery agent identity keys in quote response.')
  }
  if (entries.length > 1 && !hasOverrideHost) {
    throw new Error(
      'Recipients resolve to multiple hosts. Use overrideHost to force a single server or split by host.'
    )
  }

  const identityKey = identityKeysByHost?.[finalHost]
  if (!identityKey) {
    throw new Error(`Missing delivery agent identity key for ${finalHost}.`)
  }
  return identityKey
}

type MessageBoxRecipientQuote = MessageBoxMultiQuote['quotesByRecipient'][number]
type MessageBoxQuoteStatus = MessageBoxRecipientQuote['status']

interface MessageBoxMultiQuoteAccumulator {
  quotesByRecipient: MessageBoxRecipientQuote[]
  blockedRecipients: Set<PubKeyHex>
  deliveryAgentIdentityKeyByHost: Record<string, string>
  deliveryFees: number
  recipientFees: number
}

/**
 * @class MessageBoxClient
 * @description
 * A secure client for sending and receiving authenticated, encrypted messages
 * through a MessageBox server over HTTP and WebSocket.
 *
 * Core Features:
 * - Identity-authenticated message transport (BRC-2)
 * - AES-256-GCM end-to-end encryption with BRC-42/BRC-43 key derivation
 * - HMAC-based message ID generation for deduplication
 * - Live WebSocket messaging with room-based subscription management
 * - Overlay network discovery and host advertisement broadcasting (SHIP protocol)
 * - Fallback to HTTP messaging when WebSocket is unavailable
 *
 * **Important:**
 * The MessageBoxClient automatically calls `await init()` if needed.
 * Manual initialization is optional but still supported.
 *
 * You may call `await init()` manually for explicit control, but you can also use methods
 * like `sendMessage()` or `listenForLiveMessages()` directly — the client will initialize itself
 * automatically if not yet ready.
 *
 * @example
 * const client = new MessageBoxClient({ walletClient, enableLogging: true })
 * await client.init() // <- Required before using the client
 * await client.sendMessage({ recipient, messageBox: 'payment_inbox', body: 'Hello world' })
 */
export class MessageBoxClient {
  private host: string
  public readonly authFetch: AuthFetch
  private readonly walletClient: WalletInterface
  private socket?: ReturnType<typeof AuthSocketClient>
  private myIdentityKey?: string
  private readonly joinedRooms: Set<string> = new Set()
  private readonly lookupResolver: LookupResolver
  private readonly networkPreset: LookupNetworkPreset
  private initialized = false
  private socketAuthenticated = false
  private connectionInitPromise?: Promise<void>
  protected originator?: OriginatorDomainNameStringUnder250Bytes
  private readonly socketOptions: MessageBoxClientOptions['socketOptions']
  private readonly expectedServerIdentityByOrigin: ReadonlyMap<string, PubKeyHex>
  private readonly authenticatedServerIdentityByOrigin = new Map<string, PubKeyHex>()
  /**
   * @constructor
   * @param {Object} options - Initialization options for the MessageBoxClient.
   * @param {string} [options.host] - The base URL of the MessageBox server. Required for TerraTestNet until a dedicated TTN deployment is available.
   * @param {WalletInterface} options.walletClient - Wallet instance used for authentication, signing, and encryption.
   * @param {boolean} [options.enableLogging=false] - Whether to enable detailed debug logging to the console.
   * @param {'local' | 'mainnet' | 'testnet' | 'teratestnet'} [options.networkPreset='mainnet'] - Overlay network preset used for routing and advertisement lookup.
   * @param {MessageBoxSocketOptions} [options.socketOptions] - Options forwarded to the underlying AuthSocketClient, e.g. `{ managerOptions: { transports: ['websocket'] } }`. The client's own wallet and originator always win; deferred connection and Socket.IO message retries are unsupported.
   *
   * @description
   * Constructs a new MessageBoxClient.
   *
   * **Note:**
   * Passing a `host` during construction sets the default server.
   * If you do not manually call `await init()`, the client will automatically initialize itself on first use.
   *
   * @example
   * const client = new MessageBoxClient({
   *   host: 'https://messagebox.example',
   *   walletClient,
   *   enableLogging: true,
   *   networkPreset: 'testnet'
   * })
   * await client.init()
   */
  constructor(options: MessageBoxClientOptions = {}) {
    const {
      host,
      walletClient,
      enableLogging = false,
      networkPreset = 'mainnet',
      originator = undefined,
      socketOptions = undefined,
      serverIdentityKeysByHost = undefined
    } = options

    if (networkPreset === 'teratestnet' && host == null) {
      throw new Error(
        'MessageBoxClient requires an explicit host for TerraTestNet until a dedicated TTN Message Box deployment is available.'
      )
    }

    let defaultHost = DEFAULT_MAINNET_HOST
    if (networkPreset === 'testnet') {
      defaultHost = DEFAULT_TESTNET_HOST
    }

    this.host = normalizeMessageBoxHost(host ?? defaultHost)
    this.originator = originator
    // These options are excluded from the forwarded type; validate JavaScript
    // callers as well so unsupported socket settings fail before authentication.
    const forwardedManagerOptions = socketOptions?.managerOptions as
      { autoConnect?: boolean; retries?: number } | undefined
    if (forwardedManagerOptions?.autoConnect === false) {
      throw new Error(
        '[MB CLIENT ERROR] socketOptions.managerOptions.autoConnect must not be false: deferred connection is unsupported.'
      )
    }
    if ((forwardedManagerOptions?.retries ?? 0) !== 0) {
      throw new Error(
        '[MB CLIENT ERROR] socketOptions.managerOptions.retries must be zero or omitted: AuthSocket does not send Socket.IO acknowledgements.'
      )
    }
    this.socketOptions = socketOptions
    this.expectedServerIdentityByOrigin = normalizeServerIdentityPins(serverIdentityKeysByHost)
    this.walletClient = walletClient ?? new WalletClient('auto', originator)
    this.authFetch = new AuthFetch(this.walletClient, undefined, undefined, originator)
    this.networkPreset = networkPreset

    this.lookupResolver = new LookupResolver({
      networkPreset
    })

    if (enableLogging) {
      Logger.enable()
    }
  }

  /**
   * @method init
   * @async
   * @param {string} [targetHost] - Optional host to set or override the default host.
   * @returns {Promise<void>}
   *
   * @description
   * Initializes the MessageBoxClient by verifying wallet connectivity and setting the active host.
   *
   * - If the client was constructed with a host, it uses that unless a different targetHost is provided.
   * - After calling init(), the client becomes ready to send, receive, and acknowledge messages.
   * - To advertise your host on the overlay network, call `anointHost()` explicitly.
   *
   * This method can be called manually for explicit control,
   * but will be automatically invoked if omitted.
   * @throws {Error} If no valid host is provided, or wallet is unreachable.
   *
   * @example
   * const client = new MessageBoxClient({ host: 'https://mybox.example', walletClient })
   * await client.init()
   * // Optionally advertise your host on the overlay:
   * await client.anointHost('https://mybox.example')
   * await client.sendMessage({ recipient, messageBox: 'inbox', body: 'Hello' })
   */
  async init(targetHost: string = this.host): Promise<void> {
    let normalizedHost: string
    try {
      normalizedHost = normalizeMessageBoxHost(targetHost)
    } catch (error) {
      throw new Error(
        `Cannot initialize: ${error instanceof Error ? error.message : 'No valid host provided'}`
      )
    }

    // Check if this is an override host
    if (normalizedHost !== this.host) {
      this.initialized = false
      this.host = normalizedHost
    }

    if (this.initialized) return

    // Verify wallet is reachable
    await this.getIdentityKey()
    this.initialized = true
  }

  /**
   * @method assertInitialized
   * @private
   * @description
   * Ensures that the MessageBoxClient has completed initialization before performing sensitive operations
   * like sending, receiving, or acknowledging messages.
   *
   * If the client is not yet initialized, it will automatically call `await init()` to complete setup.
   *
   * Used automatically by all public methods that require initialization.
   */
  private async assertInitialized(): Promise<void> {
    if (!this.initialized || this.host == null || this.host.trim() === '') {
      await this.init()
    }
  }

  /**
   * @method getJoinedRooms
   * @returns {Set<string>} A set of currently joined WebSocket room IDs
   * @description
   * Returns a live list of WebSocket rooms the client is subscribed to.
   * Useful for inspecting state or ensuring no duplicates are joined.
   */
  public getJoinedRooms(): Set<string> {
    return this.joinedRooms
  }

  /**
   * @method getIdentityKey
   * @param {string} [originator] - Optional originator to use for identity key lookup
   * @returns {Promise<string>} The identity public key of the user
   * @description
   * Returns the client's identity key, used for signing, encryption, and addressing.
   * If not already loaded, it will fetch and cache it.
   */
  public async getIdentityKey(): Promise<string> {
    if (this.myIdentityKey != null) {
      return this.myIdentityKey
    }

    Logger.log('[MB CLIENT] Fetching identity key...')
    try {
      const request: Parameters<WalletInterface['getPublicKey']>[0] = { identityKey: true }
      const keyResult = validateWalletResult(
        'getPublicKey',
        await this.walletClient.getPublicKey(request, this.originator),
        request
      )
      this.myIdentityKey = canonicalIdentityKey(keyResult.publicKey, 'Wallet identity key')
      Logger.log('[MB CLIENT] Identity key fetched.')
      return this.myIdentityKey
    } catch {
      Logger.error('[MB CLIENT ERROR] Failed to fetch identity key')
      throw new Error('Identity key retrieval failed')
    }
  }

  /** Require a mutually authenticated response and pin its server identity per origin. */
  private async authenticatedFetch(
    url: string,
    config: Parameters<AuthFetch['fetch']>[1]
  ): Promise<Response> {
    const origin = new URL(url).origin
    const response = await this.authFetch.fetch(url, config)
    const responseIdentityKey = response.headers?.get('x-bsv-auth-identity-key')
    if (responseIdentityKey == null) {
      throw new Error(
        `Message Box server ${origin} did not return a mutually authenticated response.`
      )
    }
    const identityKey = canonicalIdentityKey(
      responseIdentityKey,
      `Authenticated Message Box server identity for ${origin}`
    )
    this.pinAuthenticatedServerIdentity(origin, identityKey)
    return response
  }

  private pinAuthenticatedServerIdentity(origin: string, identityKey: PubKeyHex): void {
    const expected = this.expectedServerIdentityByOrigin.get(origin)
    if (expected != null && identityKey !== expected) {
      throw new Error(
        `Authenticated Message Box server identity does not match the pin for ${origin}.`
      )
    }
    const established = this.authenticatedServerIdentityByOrigin.get(origin)
    if (established != null && identityKey !== established) {
      throw new Error(`Authenticated Message Box server identity changed for ${origin}.`)
    }
    this.authenticatedServerIdentityByOrigin.set(origin, identityKey)
  }

  private expectedServerIdentity(origin: string): PubKeyHex | undefined {
    const configured = this.expectedServerIdentityByOrigin.get(origin)
    const established = this.authenticatedServerIdentityByOrigin.get(origin)
    if (configured != null && established != null && configured !== established) {
      throw new Error(`Conflicting Message Box server identity state for ${origin}.`)
    }
    return configured ?? established
  }

  /**
   * @property testSocket
   * @readonly
   * @returns {AuthSocketClient | undefined} The internal WebSocket client (or undefined if not connected).
   * @description
   * Exposes the underlying Authenticated WebSocket client used for live messaging.
   * This is primarily intended for debugging, test frameworks, or direct inspection.
   *
   * Note: Do not interact with the socket directly unless necessary.
   * Use the provided `sendLiveMessage`, `listenForLiveMessages`, and related methods.
   */
  public get testSocket(): ReturnType<typeof AuthSocketClient> | undefined {
    return this.socket
  }

  /**
   * @method initializeConnection
   * @param {string} [originator] - Optional originator to use for authentication.
   * @async
   * @returns {Promise<void>}
   * @description
   * Establishes an authenticated WebSocket connection to the configured MessageBox server.
   * Enables live message streaming via room-based channels tied to identity keys.
   *
   * This method:
   * 1. Retrieves the user’s identity key if not already set
   * 2. Initializes a secure AuthSocketClient WebSocket connection
   * 3. Authenticates the connection using the identity key
   * 4. Waits up to 5 seconds for authentication confirmation
   *
   * If authentication fails or times out, the connection is rejected.
   *
   * @throws {Error} If the identity key is unavailable or authentication fails
   *
   * @example
   * const mb = new MessageBoxClient({ walletClient })
   * await mb.initializeConnection()
   * // WebSocket is now ready for use
   */
  async initializeConnection(overrideHost?: string): Promise<void> {
    Logger.log('[MB CLIENT] initializeConnection() STARTED')

    if (this.myIdentityKey == null || this.myIdentityKey.trim() === '') {
      await this.getIdentityKey()
    }

    if (this.myIdentityKey == null || this.myIdentityKey.trim() === '') {
      Logger.error('[MB CLIENT ERROR] Identity key is still missing after retrieval!')
      throw new Error('Identity key is missing')
    }

    Logger.log('[MB CLIENT] Setting up WebSocket connection...')

    if (this.socketAuthenticated && this.socket != null) {
      return
    }

    if (this.connectionInitPromise != null) {
      await this.connectionInitPromise
      return
    }

    if (this.socket == null) {
      const targetHost = normalizeMessageBoxHost(overrideHost ?? this.host)
      const targetOrigin = new URL(targetHost).origin
      const socketConfiguredIdentity = this.socketOptions?.expectedServerIdentityKey
      const sharedExpectedIdentity = this.expectedServerIdentity(targetOrigin)
      if (
        socketConfiguredIdentity != null &&
        sharedExpectedIdentity != null &&
        socketConfiguredIdentity !== sharedExpectedIdentity
      ) {
        throw new Error(`Conflicting Message Box WebSocket identity pin for ${targetOrigin}.`)
      }
      const expectedServerIdentityKey = socketConfiguredIdentity ?? sharedExpectedIdentity
      this.socket = AuthSocketClient(targetHost, {
        ...this.socketOptions,
        wallet: this.walletClient,
        originator: this.originator,
        ...(expectedServerIdentityKey === undefined ? {} : { expectedServerIdentityKey })
      })

      this.socket.on('connect', () => {
        Logger.log('[MB CLIENT] Connected to WebSocket.')

        Logger.log('[MB CLIENT] Sending WebSocket authentication data')
        if (this.myIdentityKey == null || this.myIdentityKey.trim() === '') {
          Logger.error('[MB CLIENT ERROR] Cannot send authentication: Identity key is missing!')
        } else {
          this.socket?.emit('authenticated', { identityKey: this.myIdentityKey })
        }
      })

      // Listen for authentication success from the server
      this.socket.on('authenticationSuccess', () => {
        const serverIdentityKey = canonicalIdentityKey(
          this.socket?.serverIdentityKey,
          `Authenticated Message Box WebSocket identity for ${targetOrigin}`
        )
        this.pinAuthenticatedServerIdentity(targetOrigin, serverIdentityKey)
        Logger.log('[MB CLIENT] WebSocket authentication successful')
        this.socketAuthenticated = true
      })

      // Handle authentication failures
      this.socket.on('authenticationFailed', () => {
        Logger.error('[MB CLIENT ERROR] WebSocket authentication failed')
        this.socketAuthenticated = false
      })

      this.socket.on('disconnect', () => {
        Logger.log('[MB CLIENT] Disconnected from MessageBox server')
        this.socket = undefined
        this.socketAuthenticated = false
      })

      this.socket.on('error', () => {
        Logger.error('[MB CLIENT ERROR] WebSocket error')
      })
    }

    if (this.socket?.connected && !this.socketAuthenticated) {
      this.socket.emit('authenticated', { identityKey: this.myIdentityKey })
    }

    this.connectionInitPromise = new Promise<void>((resolve, reject) => {
      const socketAny = this.socket as any
      let settled = false
      let timeoutId: ReturnType<typeof setTimeout> | undefined

      const finalizeResolve = (): void => {
        if (settled) return
        settled = true
        if (timeoutId != null) {
          clearTimeout(timeoutId)
          timeoutId = undefined
        }
        if (typeof socketAny?.off === 'function') {
          socketAny.off('authenticationSuccess', onSuccess)
          socketAny.off('authenticationFailed', onFailed)
          socketAny.off('disconnect', onDisconnectBeforeAuth)
        }
        this.connectionInitPromise = undefined
        Logger.log('[MB CLIENT] WebSocket fully authenticated and ready!')
        resolve()
      }

      const finalizeReject = (error: Error): void => {
        if (settled) return
        settled = true
        if (timeoutId != null) {
          clearTimeout(timeoutId)
          timeoutId = undefined
        }
        if (typeof socketAny?.off === 'function') {
          socketAny.off('authenticationSuccess', onSuccess)
          socketAny.off('authenticationFailed', onFailed)
          socketAny.off('disconnect', onDisconnectBeforeAuth)
        }
        this.connectionInitPromise = undefined
        reject(error)
      }

      const onSuccess = (): void => {
        this.socketAuthenticated = true
        finalizeResolve()
      }

      const onFailed = (): void => {
        this.socketAuthenticated = false
        finalizeReject(new Error('[MB CLIENT ERROR] WebSocket authentication failed!'))
      }

      const onDisconnectBeforeAuth = (): void => {
        this.socketAuthenticated = false
      }

      if (this.socketAuthenticated) {
        finalizeResolve()
        return
      }

      socketAny?.on('authenticationSuccess', onSuccess)
      socketAny?.on('authenticationFailed', onFailed)
      socketAny?.on('disconnect', onDisconnectBeforeAuth)

      timeoutId = setTimeout(() => {
        if (this.socketAuthenticated) {
          finalizeResolve()
        } else {
          finalizeReject(new Error('[MB CLIENT ERROR] WebSocket authentication timed out!'))
        }
      }, 5000)
    })

    await this.connectionInitPromise
  }

  /**
   * @method resolveHostForRecipient
   * @async
   * @param {string} identityKey - The public identity key of the intended recipient.
   * @param {string} [originator] - The originator to use for the WalletClient.
   * @returns {Promise<string>} - A fully qualified host URL for the recipient's MessageBox server.
   *
   * @description
   * Attempts to resolve the most recently anointed MessageBox host for the given identity key
   * using the BSV overlay network and the `ls_messagebox` LookupResolver.
   *
   * If no advertisements are found, or if resolution fails, the client will fall back
   * to its own configured `host`. This allows seamless operation in both overlay and non-overlay environments.
   *
   * This method guarantees a non-null return value and should be used directly when routing messages.
   *
   * @example
   * const host = await resolveHostForRecipient('028d...') // → returns either overlay host or this.host
   */
  async resolveHostForRecipient(identityKey: string): Promise<string> {
    const advertisementTokens = await this.queryAdvertisements(identityKey)
    if (advertisementTokens.length === 0) {
      Logger.warn('[MB CLIENT] No valid advertisement; using the configured host')
      return this.host
    }
    // Return the first host found
    return advertisementTokens[0].host
  }

  /**
   * Core lookup: ask the LookupResolver (optionally filtered by host),
   * decode every PushDrop output, and collect all the host URLs you find.
   *
   * @param identityKey  the recipient’s public key
   * @param host?        if passed, only look for adverts anointed at that host
   * @returns            0-length array if nothing valid was found
   */
  async queryAdvertisements(identityKey?: string, host?: string): Promise<AdvertisementToken[]> {
    const hosts: AdvertisementToken[] = []
    const requestedIdentityKey = canonicalIdentityKey(
      identityKey ?? (await this.getIdentityKey()),
      'Message Box advertisement identity key'
    )
    try {
      const query: Record<string, string> = {
        identityKey: requestedIdentityKey
      }
      if (host != null) {
        const normalizedFilterHost = normalizeOverlayMessageBoxHost(host)
        if (normalizedFilterHost == null) {
          throw new TypeError('Message Box advertisement host filter must be a public HTTPS URL.')
        }
        query.host = normalizedFilterHost
      }

      const result = await this.lookupResolver.query({
        service: 'ls_messagebox',
        query
      })
      if (result == null || typeof result !== 'object' || Array.isArray(result)) {
        throw new Error('Message Box advertisement lookup returned an invalid result.')
      }
      const resultDescriptors = Object.getOwnPropertyDescriptors(result)
      if (
        Object.getOwnPropertySymbols(result).length !== 0 ||
        Object.values(resultDescriptors).some(
          property => property.get != null || property.set != null
        ) ||
        resultDescriptors.type?.value !== 'output-list' ||
        !Array.isArray(resultDescriptors.outputs?.value)
      ) {
        throw new Error('Message Box advertisement lookup returned an invalid output list.')
      }
      const outputs = resultDescriptors.outputs.value as unknown[]
      if (outputs.length > MAX_ADVERTISEMENT_OUTPUTS) {
        throw new Error('Message Box advertisement lookup returned too many outputs.')
      }

      const anyoneWallet = new ProtoWallet('anyone')
      let totalBeefBytes = 0

      for (let i = 0; i < outputs.length; i++) {
        try {
          if (!Object.prototype.hasOwnProperty.call(outputs, i))
            throw new Error('Sparse output list')
          const output = outputs[i]
          if (output == null || typeof output !== 'object' || Array.isArray(output)) {
            throw new Error('Invalid advertisement output')
          }
          const outputDescriptors = Object.getOwnPropertyDescriptors(output)
          if (
            Object.getOwnPropertySymbols(output).length !== 0 ||
            Object.values(outputDescriptors).some(
              property => property.get != null || property.set != null
            )
          ) {
            throw new Error('Invalid advertisement output')
          }
          const outputIndex = outputDescriptors.outputIndex?.value
          if (!Number.isSafeInteger(outputIndex) || outputIndex < 0 || outputIndex > 0xffffffff) {
            throw new Error('Invalid advertisement output index')
          }
          const normalizedBeef = normalizeBRC100ByteArray(outputDescriptors.beef?.value)
          if (normalizedBeef == null || normalizedBeef.length === 0) {
            throw new Error('Invalid advertisement BEEF')
          }
          totalBeefBytes += normalizedBeef.length
          if (totalBeefBytes > MAX_ADVERTISEMENT_BEEF_BYTES) {
            return []
          }
          const beef = Array.from(normalizedBeef)
          const tx = Transaction.fromBEEF(beef)
          const script = tx.outputs[outputIndex]?.lockingScript
          if (script == null) throw new Error('Advertisement output index is out of range')
          const token = decodeCanonicalPushDrop(script, {
            fieldCount: 3,
            maximumFieldBytes: 2048,
            maximumPayloadBytes: 2161
          })
          const [identityKeyBuf, hostBuf, signature] = token.fields
          if (
            identityKeyBuf.length !== 33 ||
            toHex(identityKeyBuf) !== requestedIdentityKey ||
            hostBuf.length === 0 ||
            hostBuf.length > 2048 ||
            signature.length === 0 ||
            signature.length > 80
          ) {
            throw new Error('Advertisement fields are invalid')
          }
          const advertisedHost = toUTF8Strict(hostBuf)
          const verified = await anyoneWallet.verifySignature({
            data: [...identityKeyBuf, ...hostBuf],
            signature,
            counterparty: requestedIdentityKey,
            protocolID: [1, 'messagebox advertisement'],
            keyID: '1'
          })
          if (verified.valid !== true) throw new Error('Advertisement signature is invalid')

          hosts.push({
            host: advertisedHost,
            txid: tx.id('hex'),
            outputIndex,
            lockingScript: script,
            beef
          })
        } catch {
          // skip any malformed / non-PushDrop outputs
        }
      }
    } catch {
      Logger.error('[MB CLIENT ERROR] Advertisement lookup failed')
    }
    return hosts.flatMap(item => {
      const normalizedHost = normalizeOverlayMessageBoxHost(item.host)
      return normalizedHost == null ? [] : [{ ...item, host: normalizedHost }]
    })
  }

  /**
   * @method joinRoom
   * @async
   * @param {string} messageBox - The name of the WebSocket room to join (e.g., "payment_inbox").
   * @returns {Promise<void>}
   *
   * @description
   * Joins a WebSocket room that corresponds to the user’s identity key and the specified message box.
   * This is required to receive real-time messages via WebSocket for a specific type of communication.
   *
   * If the WebSocket connection is not already established, this method will first initialize the connection.
   * It also ensures the room is only joined once, and tracks all joined rooms in an internal set.
   *
   * Room ID format: `${identityKey}-${messageBox}`
   *
   * @example
   * await client.joinRoom('payment_inbox')
   * // Now listening for real-time messages in room '028d...-payment_inbox'
   */
  async joinRoom(messageBox: string, overrideHost?: string): Promise<void> {
    Logger.log('[MB CLIENT] Attempting to join a WebSocket room')
    const canonicalMessageBox = exactBoundedText(messageBox, 'Message box', MAX_MESSAGE_BOX_BYTES, {
      forbidControls: true
    })

    // Ensure WebSocket connection is established first
    if (this.socket == null) {
      Logger.log('[MB CLIENT] No WebSocket connection. Initializing...')
      await this.initializeConnection(overrideHost)
    }

    if (this.myIdentityKey == null || this.myIdentityKey.trim() === '') {
      throw new Error('[MB CLIENT ERROR] Identity key is not defined')
    }

    const roomId = `${this.myIdentityKey ?? ''}-${canonicalMessageBox}`

    if (this.joinedRooms.has(roomId)) {
      Logger.log('[MB CLIENT] WebSocket room already joined')
      return
    }

    try {
      Logger.log('[MB CLIENT] Joining WebSocket room')
      this.socket?.emit('joinRoom', roomId)
      this.joinedRooms.add(roomId)
      Logger.log('[MB CLIENT] WebSocket room joined')
    } catch {
      Logger.error('[MB CLIENT ERROR] Failed to join WebSocket room')
    }
  }

  /**
   * @method listenForLiveMessages
   * @async
   * @param {Object} params - Configuration for the live message listener.
   * @param {function} params.onMessage - A callback function that will be triggered when a new message arrives.
   * @param {string} params.messageBox - The messageBox name (e.g., `payment_inbox`) to listen for.
   * @returns {Promise<void>}
   *
   * @description
   * Subscribes the client to live messages over WebSocket for a specific messageBox.
   *
   * This method:
   * - Ensures the WebSocket connection is initialized and authenticated.
   * - Joins the correct room formatted as `${identityKey}-${messageBox}`.
   * - Listens for messages broadcast to the room.
   * - Automatically attempts to parse and decrypt message bodies.
   * - Emits the final message (as a `PeerMessage`) to the supplied `onMessage` handler.
   *
   * If the incoming message is encrypted, the client decrypts it using AES-256-GCM via
   * ECDH shared secrets derived from identity keys as defined in [BRC-2](https://github.com/bitcoin-sv/BRCs/blob/master/wallet/0002.md).
   * Messages sent by the client to itself are decrypted using `counterparty = 'self'`.
   *
   * @example
   * await client.listenForLiveMessages({
   *   messageBox: 'payment_inbox',
   *   onMessage: (msg) => console.log('Received live message:', msg)
   * })
   */
  async listenForLiveMessages({
    onMessage,
    messageBox,
    overrideHost
  }: {
    onMessage: (message: PeerMessage) => void
    messageBox: string
    overrideHost?: string
  }): Promise<void> {
    Logger.log('[MB CLIENT] Setting up a WebSocket room listener')

    // Ensure WebSocket connection is established first
    if (this.socket == null) {
      Logger.log('[MB CLIENT] No WebSocket connection. Initializing...')
      await this.initializeConnection(overrideHost)
    }

    // Join the room
    await this.joinRoom(messageBox, overrideHost)

    // Ensure identity key is available before creating roomId
    if (this.myIdentityKey == null || this.myIdentityKey.trim() === '') {
      throw new Error('[MB CLIENT ERROR] Identity key is missing. Cannot construct room ID.')
    }

    const roomId = `${this.myIdentityKey}-${messageBox}`

    Logger.log('[MB CLIENT] Listening for WebSocket room messages')

    this.socket?.on(`sendMessage-${roomId}`, (message: PeerMessage) => {
      void (async () => {
        Logger.log('[MB CLIENT] Received a WebSocket room message')

        try {
          let parsedBody: unknown = message.body

          if (typeof parsedBody === 'string') {
            try {
              parsedBody = JSON.parse(parsedBody)
            } catch {
              // Leave it as-is (plain text)
            }
          }

          if (
            parsedBody != null &&
            typeof parsedBody === 'object' &&
            !Array.isArray(parsedBody) &&
            Object.hasOwn(parsedBody, 'encryptedMessage')
          ) {
            const body = ownDataRecord(parsedBody, 'Live Message Box message body')
            if (typeof body.encryptedMessage !== 'string') {
              throw new TypeError('Live Message Box ciphertext must be a string')
            }
            Logger.log('[MB CLIENT] Decrypting a WebSocket message')
            const request: Parameters<WalletInterface['decrypt']>[0] = {
              protocolID: [1, 'messagebox'],
              keyID: '1',
              counterparty: message.sender,
              ciphertext: toArray(body.encryptedMessage, 'base64')
            }
            const decrypted = validateWalletResult(
              'decrypt',
              await this.walletClient.decrypt(request, this.originator),
              request
            )

            message.body = toUTF8(decrypted.plaintext)
          } else {
            Logger.log('[MB CLIENT] Message is not encrypted.')
            message.body =
              typeof parsedBody === 'string'
                ? parsedBody
                : (() => {
                    try {
                      return stringifyBRC100(parsedBody)
                    } catch {
                      return '[Error: Unstringifiable message]'
                    }
                  })()
          }
        } catch {
          Logger.error('[MB CLIENT ERROR] Failed to parse or decrypt live message')
          message.body = '[Error: Failed to decrypt or parse message]'
        }

        onMessage(message)
      })()
    })
  }

  /**
   * @method sendLiveMessage
   * @async
   * @param {SendMessageParams} param0 - The message parameters including recipient, box name, body, and options.
   * @returns {Promise<SendMessageResponse>} A success response with the generated messageId.
   *
   * @description
   * Sends a message in real time using WebSocket with authenticated delivery and overlay fallback.
   *
   * This method:
   * - Ensures the WebSocket connection is open and joins the correct room.
   * - Derives a unique message ID using an HMAC of the message body and counterparty identity key.
   * - Encrypts the message body using AES-256-GCM based on the ECDH shared secret between derived keys, per [BRC-2](https://github.com/bitcoin-sv/BRCs/blob/master/wallet/0002.md),
   *   unless `skipEncryption` is explicitly set to `true`.
   * - Sends the message to a WebSocket room in the format `${recipient}-${messageBox}`.
   * - Waits for acknowledgment (`sendMessageAck-${roomId}`).
   * - If no acknowledgment is received within 10 seconds, falls back to `sendMessage()` over HTTP.
   *
   * This hybrid delivery strategy ensures reliability in both real-time and offline-capable environments.
   *
   * @throws {Error} If message validation fails, HMAC generation fails, or both WebSocket and HTTP fail to deliver.
   *
   * @example
   * await client.sendLiveMessage({
   *   recipient: '028d...',
   *   messageBox: 'payment_inbox',
   *   body: { amount: 1000 }
   * })
   */
  async sendLiveMessage(
    message: SendMessageParams,
    overrideHost?: string
  ): Promise<SendMessageResponse> {
    if (typeof message?.recipient !== 'string' || message.recipient.trim() === '') {
      throw new Error('[MB CLIENT ERROR] Recipient identity key is required')
    }
    const snapshot = snapshotSendMessageParams(message)

    // Ensure room is joined before sending
    await this.joinRoom(snapshot.messageBox, overrideHost)

    const fallbackMessage = (finalMessageId?: string): SendMessageParams => ({
      recipient: snapshot.recipient,
      messageBox: snapshot.messageBox,
      body: snapshot.bodyForWire,
      messageId: finalMessageId ?? snapshot.messageId,
      skipEncryption: snapshot.skipEncryption,
      checkPermissions: snapshot.checkPermissions,
      maximumPayment: snapshot.maximumPayment
    })

    // Fallback to HTTP if WebSocket is not connected
    if (!this.socket?.connected) {
      Logger.warn('[MB CLIENT WARNING] WebSocket not connected, falling back to HTTP')
      return await this.sendMessage(fallbackMessage(), overrideHost)
    }

    const finalMessageId = await this.generateMessageId(snapshot)

    const roomId = `${snapshot.recipient}-${snapshot.messageBox}`
    Logger.log('[MB CLIENT] Sending a WebSocket room message')

    const outgoingBody = await this.encodeMessageBody(snapshot)

    return await new Promise((resolve, reject) => {
      const ackEvent = `sendMessageAck-${roomId}`
      let handled = false
      let timeoutId: ReturnType<typeof setTimeout> | undefined

      const ackHandler = (response?: SendMessageResponse): void => {
        if (handled) return
        handled = true
        if (timeoutId != null) {
          clearTimeout(timeoutId)
          timeoutId = undefined
        }

        const socketAny = this.socket as any
        if (typeof socketAny?.off === 'function') {
          socketAny.off(ackEvent, ackHandler)
        }

        Logger.log('[MB CLIENT] Received a WebSocket acknowledgment')

        if (response?.status !== 'success') {
          Logger.warn(
            '[MB CLIENT] WebSocket message failed or returned unexpected response. Falling back to HTTP.'
          )
          this.sendMessage(fallbackMessage(finalMessageId), overrideHost)
            .then(resolve)
            .catch(reject)
        } else {
          Logger.log('[MB CLIENT] Message sent successfully via WebSocket')
          resolve(response)
        }
      }

      // Attach acknowledgment listener
      this.socket?.on(ackEvent, ackHandler)

      // Emit message to room
      this.socket?.emit('sendMessage', {
        roomId,
        message: {
          messageId: finalMessageId,
          recipient: snapshot.recipient,
          body: outgoingBody
        }
      })

      // Timeout: Fallback to HTTP if no acknowledgment received
      timeoutId = setTimeout(() => {
        if (!handled) {
          handled = true
          timeoutId = undefined
          const socketAny = this.socket as any
          if (typeof socketAny?.off === 'function') {
            socketAny.off(ackEvent, ackHandler)
          }
          Logger.warn('[CLIENT] WebSocket acknowledgment timed out, falling back to HTTP')
          this.sendMessage(fallbackMessage(finalMessageId), overrideHost)
            .then(resolve)
            .catch(reject)
        }
      }, 10000)
    })
  }

  /**
   * @method leaveRoom
   * @async
   * @param {string} messageBox - The name of the WebSocket room to leave (e.g., `payment_inbox`).
   * @returns {Promise<void>}
   *
   * @description
   * Leaves a previously joined WebSocket room associated with the authenticated identity key.
   * This helps reduce unnecessary message traffic and memory usage.
   *
   * If the WebSocket is not connected or the identity key is missing, the method exits gracefully.
   *
   * @example
   * await client.leaveRoom('payment_inbox')
   */
  async leaveRoom(messageBox: string): Promise<void> {
    const canonicalMessageBox = exactBoundedText(messageBox, 'Message box', MAX_MESSAGE_BOX_BYTES, {
      forbidControls: true
    })
    await this.assertInitialized()
    if (this.socket == null) {
      Logger.warn('[MB CLIENT] Attempted to leave a room but WebSocket is not connected.')
      return
    }

    if (this.myIdentityKey == null || this.myIdentityKey.trim() === '') {
      throw new Error('[MB CLIENT ERROR] Identity key is not defined')
    }

    const roomId = `${this.myIdentityKey}-${canonicalMessageBox}`
    Logger.log('[MB CLIENT] Leaving WebSocket room')
    this.socket.emit('leaveRoom', roomId)

    // Ensure the room is removed from tracking
    this.joinedRooms.delete(roomId)
  }

  /**
   * @method disconnectWebSocket
   * @async
   * @returns {Promise<void>} Resolves when the WebSocket connection is successfully closed.
   *
   * @description
   * Gracefully disconnects the WebSocket connection to the MessageBox server.
   * This should be called when the client is shutting down, logging out, or no longer
   * needs real-time communication to conserve system resources.
   *
   * @example
   * await client.disconnectWebSocket()
   */
  async disconnectWebSocket(): Promise<void> {
    await this.assertInitialized()
    if (this.socket == null) {
      Logger.log('[MB CLIENT] No active WebSocket connection to close.')
    } else {
      Logger.log('[MB CLIENT] Closing WebSocket connection...')
      this.socket.disconnect()
      this.socket = undefined
    }
  }

  /**
   * @method sendMessage
   * @async
   * @param {SendMessageParams} message - Contains recipient, messageBox name, message body, optional messageId, and skipEncryption flag.
   * @param {string} [overrideHost] - Optional host to override overlay resolution (useful for testing or private routing).
   * @returns {Promise<SendMessageResponse>} - Resolves with `{ status, messageId }` on success.
   *
   * @description
   * Sends a message over HTTP to a recipient's messageBox. This method:
   *
   * - Derives a deterministic `messageId` using an HMAC of the message body and recipient key.
   * - Encrypts the message body using AES-256-GCM, derived from a shared secret using BRC-2-compliant key derivation and ECDH, unless `skipEncryption` is set to true.
   * - Automatically resolves the host via overlay LookupResolver unless an override is provided.
   * - Authenticates the request using the current identity key with `AuthFetch`.
   *
   * This is the fallback mechanism for `sendLiveMessage` when WebSocket delivery fails.
   * It is also used for message types that do not require real-time delivery.
   *
   * @throws {Error} If validation, encryption, HMAC, or network request fails.
   *
   * @example
   * await client.sendMessage({
   *   recipient: '03abc...',
   *   messageBox: 'notifications',
   *   body: { type: 'ping' }
   * })
   */
  async sendMessage(
    message: SendMessageParams,
    overrideHost?: string
  ): Promise<SendMessageResponse> {
    const snapshot = snapshotSendMessageParams(message)
    await this.assertInitialized()

    const paymentData = await this.resolveMessagePayment(snapshot, overrideHost)
    const messageId = await this.generateMessageId(snapshot)
    const finalBody = await this.encodeMessageBody(snapshot)

    const requestBody = {
      message: {
        recipient: snapshot.recipient,
        messageBox: snapshot.messageBox,
        messageId,
        body: finalBody
      },
      ...(paymentData != null && { payment: paymentData })
    }

    try {
      const finalHost = normalizeMessageBoxHost(
        overrideHost ?? (await this.resolveHostForRecipient(snapshot.recipient))
      )

      const sendUrl = messageBoxEndpoint(finalHost, '/sendMessage')
      Logger.log('[MB CLIENT] Sending authenticated HTTP request')
      Logger.log('[MB CLIENT] Sending one authenticated Message Box request.')

      await this.ensureIdentityKey()

      const response = await this.authenticatedFetch(sendUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: stringifyBRC100(requestBody)
      })

      if (response.bodyUsed)
        throw new Error('[MB CLIENT ERROR] Response body has already been used!')

      const parsedResponse = await response.json()

      if (!response.ok) {
        throw new Error(`Message Box send failed with HTTP ${response.status}.`)
      }

      const validatedResponse = validateSendResponse(parsedResponse, snapshot.recipient, messageId)
      Logger.log('[MB CLIENT] Message successfully sent.')
      return validatedResponse
    } catch (error) {
      Logger.error('[MB CLIENT ERROR] Message sending failed.')
      if (error instanceof TypeError) throw error
      throw new Error(
        error instanceof Error && error.message.startsWith('Message Box ')
          ? error.message
          : 'Failed to send message.'
      )
    }
  }

  /** Resolve optional payment data if permission checking is enabled. */
  private async resolveMessagePayment(
    message: OutgoingMessageSnapshot,
    overrideHost?: string
  ): Promise<Payment | undefined> {
    if (!message.checkPermissions) return undefined
    try {
      Logger.log('[MB CLIENT] Checking permissions and fees for message...')
      const quote = validateSingleQuoteResult(
        await this.getMessageBoxQuote(
          {
            recipient: message.recipient,
            messageBox: message.messageBox
          },
          overrideHost
        )
      )

      if (quote.recipientFee === -1) {
        throw new Error('You have been blocked from sending messages to this recipient.')
      }
      if (quote.recipientFee <= 0 && quote.deliveryFee <= 0) return undefined

      const requiredPayment = checkedFeeSum(
        [quote.recipientFee, quote.deliveryFee],
        'Message payment'
      )
      if (requiredPayment <= 0) return undefined
      if (message.maximumPayment !== undefined && requiredPayment > message.maximumPayment) {
        throw new Error('The required Message Box payment exceeds maximumPayment.')
      }

      Logger.log('[MB CLIENT] Creating a message payment')
      const paymentData = await this.createMessagePayment(message.recipient, quote)
      Logger.log('[MB CLIENT] Payment data prepared.')
      return paymentData
    } catch (error) {
      if (error instanceof TypeError) throw error
      if (error instanceof Error && error.message.startsWith('The required Message Box payment')) {
        throw error
      }
      if (error instanceof Error && error.message.startsWith('You have been blocked')) throw error
      throw new Error('Message Box permission check failed.')
    }
  }

  /** Generate the HMAC-based message ID. */
  private async generateMessageId(message: OutgoingMessageSnapshot): Promise<string> {
    if (message.messageId !== undefined) return message.messageId
    try {
      const request = {
        data: Array.from(new TextEncoder().encode(message.bodyForHmac)),
        protocolID: [1, 'messagebox'] as [1, string],
        keyID: '1',
        counterparty: message.recipient
      }
      const hmac = validateWalletResult(
        'createHmac',
        await this.walletClient.createHmac(request, this.originator),
        request
      )
      return boundedByteArray(hmac.hmac, 'Wallet HMAC', 32, 32)
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('')
    } catch {
      Logger.error('[MB CLIENT ERROR] Failed to generate HMAC.')
      throw new Error('Failed to generate message identifier.')
    }
  }

  /** Encode the message body (encrypt unless skipEncryption is set). */
  private async encodeMessageBody(
    message: OutgoingMessageSnapshot
  ): Promise<string | EncryptedMessage> {
    if (message.skipEncryption) return message.bodyForWire
    const request: Parameters<WalletInterface['encrypt']>[0] = {
      protocolID: [1, 'messagebox'],
      keyID: '1',
      counterparty: message.recipient,
      plaintext: toArray(message.bodyForWire, 'utf8')
    }
    const encryptedMessage = validateWalletResult(
      'encrypt',
      await this.walletClient.encrypt(request, this.originator),
      request
    )
    const ciphertext = boundedByteArray(
      encryptedMessage.ciphertext,
      'Wallet ciphertext',
      MAX_MESSAGE_CIPHERTEXT_BYTES
    )
    const encoded = stringifyBRC100({ encryptedMessage: toBase64(ciphertext) })
    if (utf8Length(encoded) > MAX_MESSAGE_BODY_BYTES) {
      throw new TypeError(
        `Encrypted Message Box body must not exceed ${MAX_MESSAGE_BODY_BYTES} UTF-8 bytes.`
      )
    }
    return encoded
  }

  /** Ensure myIdentityKey is populated, fetching it if needed. */
  private async ensureIdentityKey(): Promise<void> {
    await this.getIdentityKey()
  }

  /** Parse a raw PeerMessage into its envelope components (body, payload, payment). */
  private parseMessageEnvelope(message: PeerMessage): {
    message: PeerMessage
    parsedBody: unknown
    messageContent: any
    paymentData: OwnDataRecord | undefined
  } {
    const parsedBody: unknown =
      typeof message.body === 'string' ? this.tryParse(message.body) : message.body
    let messageContent: any = parsedBody
    let paymentData: OwnDataRecord | undefined

    if (
      parsedBody != null &&
      typeof parsedBody === 'object' &&
      !Array.isArray(parsedBody) &&
      Object.hasOwn(parsedBody, 'message')
    ) {
      const envelope = ownDataRecord(parsedBody, 'Message Box stored-message envelope')
      const wrappedMessage = envelope.message
      messageContent =
        typeof wrappedMessage === 'string' ? this.tryParse(wrappedMessage) : wrappedMessage
      if (envelope.payment != null) {
        paymentData = ownDataRecord(envelope.payment, 'Message Box stored-message payment')
      }
    }
    return { message, parsedBody, messageContent, paymentData }
  }

  /** Internalize wallet-payment outputs from a payment-carrying message. */
  private async internalizeRecipientPayment(p: {
    message: PeerMessage
    paymentData?: OwnDataRecord
  }): Promise<void> {
    try {
      Logger.log('[MB CLIENT] Processing a recipient payment')
      const request = snapshotIncomingPayment(p.paymentData, 'Message Box stored-message payment')
      if (request.outputs.length === 0) {
        Logger.log('[MB CLIENT] No wallet payment outputs found in payment data')
        return
      }
      Logger.log('[MB CLIENT] Internalizing recipient payment outputs')
      const bindingRequest = snapshotWalletResultRequest('internalizeAction', request)
      validateWalletResult(
        'internalizeAction',
        await this.walletClient.internalizeAction(request, this.originator),
        bindingRequest
      )
      Logger.log('[MB CLIENT] Successfully internalized recipient payment')
    } catch {
      Logger.error('[MB CLIENT ERROR] Failed to internalize recipient payment')
    }
  }

  /** Decrypt or unwrap an encrypted message in place. */
  private async decryptMessageBody(p: {
    message: PeerMessage
    parsedBody: unknown
    messageContent: any
  }): Promise<void> {
    try {
      if (
        p.messageContent != null &&
        typeof p.messageContent === 'object' &&
        !Array.isArray(p.messageContent) &&
        Object.hasOwn(p.messageContent, 'encryptedMessage')
      ) {
        const body = ownDataRecord(p.messageContent, 'Listed Message Box message body')
        if (typeof body.encryptedMessage !== 'string') {
          throw new TypeError('Listed Message Box ciphertext must be a string')
        }
        Logger.log('[MB CLIENT] Decrypting a listed message')
        const request: Parameters<WalletInterface['decrypt']>[0] = {
          protocolID: [1, 'messagebox'],
          keyID: '1',
          counterparty: p.message.sender,
          ciphertext: toArray(body.encryptedMessage, 'base64')
        }
        const decrypted = validateWalletResult(
          'decrypt',
          await this.walletClient.decrypt(request, this.originator),
          request
        )
        p.message.body = this.tryParse(toUTF8(decrypted.plaintext))
      } else {
        p.message.body = p.messageContent ?? p.parsedBody
      }
    } catch {
      Logger.error('[MB CLIENT ERROR] Failed to parse or decrypt message in list')
      p.message.body = '[Error: Failed to decrypt or parse message]'
    }
  }

  /**
   * @deprecated Use `sendMessageToRecipients`. This misspelled name remains
   * available for source compatibility.
   */
  async sendMesagetoRecepients(
    params: SendListParams,
    overrideHost?: string
  ): Promise<SendListResult> {
    return this.sendMessageToRecipients(params, overrideHost)
  }

  /**
   * Multi-recipient sender. Uses the multi-quote route to:
   *  - identify blocked recipients
   *  - compute per-recipient payment
   * Then sends to the allowed recipients with payment attached.
   */
  async sendMessageToRecipients(
    params: SendListParams,
    overrideHost?: string
  ): Promise<SendListResult> {
    const snapshot = snapshotBatchSendParams(params)
    await this.assertInitialized()
    const { recipients, messageBox, bodyForHmac, bodyForWire, maximumPayment } = snapshot

    // 1) Multi-quote for all recipients
    const quoteResponse = validateMultiQuoteResult(
      await this.getMessageBoxQuote(
        {
          recipient: recipients,
          messageBox
        },
        overrideHost
      ),
      recipients,
      messageBox
    )

    const quotesByRecipient = quoteResponse.quotesByRecipient
    const blocked = quoteResponse.blockedRecipients
    const totals = quoteResponse.totals

    // 2) Filter allowed recipients
    const allowedRecipients = recipients.filter(r => !blocked.includes(r))
    if (allowedRecipients.length === 0) {
      return {
        status: 'error',
        description: `All ${recipients.length} recipients are blocked.`,
        sent: [],
        blocked,
        failed: recipients.map(r => ({ recipient: r, error: 'blocked' })),
        totals
      }
    }

    // 3) Map recipient -> fees
    const perRecipientQuotes = buildRecipientQuoteMap(quotesByRecipient)

    // 4) One delivery agent only (batch goes to one server)
    const { deliveryAgentIdentityKeyByHost } = quoteResponse

    // pick the host to POST to
    const finalHost = normalizeMessageBoxHost(
      overrideHost ?? (await this.resolveHostForRecipient(allowedRecipients[0]))
    )
    const singleDeliveryKey = selectDeliveryAgentIdentityKey(
      deliveryAgentIdentityKeyByHost,
      finalHost,
      overrideHost != null
    )

    // 5) Identity key (sender)
    await this.getIdentityKey()

    // 6) Build per-recipient messageIds (HMAC), same order as allowedRecipients
    const bodyBytes = Array.from(new TextEncoder().encode(bodyForHmac))
    const messageIds: string[] = await this.mapWithConcurrency(allowedRecipients, 8, async r => {
      const request = {
        data: bodyBytes.slice(),
        protocolID: [1, 'messagebox'] as [1, string],
        keyID: '1',
        counterparty: r
      }
      const hmac = validateWalletResult(
        'createHmac',
        await this.walletClient.createHmac(request, this.originator),
        request
      )
      return boundedByteArray(hmac.hmac, 'Wallet HMAC', 32, 32)
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('')
    })

    // 7) Body: for batch route the server expects a single shared body.
    // Per-recipient encryption requires a different server payload shape.
    const finalBody = bodyForWire

    // 8) ONE batch payment with the aggregate per-recipient server fee at index 0
    const deliveryFee = perRecipientQuotes.get(allowedRecipients[0])?.deliveryFee ?? 0
    if (
      allowedRecipients.some(
        recipient => perRecipientQuotes.get(recipient)?.deliveryFee !== deliveryFee
      )
    ) {
      throw new TypeError('All recipients in a batch must have one consistent delivery fee.')
    }
    const actualPayment = checkedFeeSum(
      [
        ...allowedRecipients.map(recipient => perRecipientQuotes.get(recipient)?.deliveryFee ?? 0),
        ...allowedRecipients.map(recipient => perRecipientQuotes.get(recipient)?.recipientFee ?? 0)
      ],
      'Batch Message Box payment'
    )
    if (maximumPayment !== undefined && actualPayment > maximumPayment) {
      throw new Error('The required Message Box payment exceeds maximumPayment.')
    }
    const paymentData = await this.createMessagePaymentBatch(
      allowedRecipients,
      perRecipientQuotes,
      singleDeliveryKey
    )

    // 9) Single POST to /sendMessage with recipients[] + messageId[]
    const requestBody = {
      message: {
        recipients: allowedRecipients,
        messageBox,
        messageId: messageIds, // aligned by index with recipients
        body: finalBody
      },
      ...(paymentData != null && { payment: paymentData })
    }

    const sendUrl = messageBoxEndpoint(finalHost, '/sendMessage')
    Logger.log('[MB CLIENT] Sending authenticated batch HTTP request')
    Logger.log('[MB CLIENT] Sending one authenticated batch request.')

    try {
      const response = await this.authenticatedFetch(sendUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: stringifyBRC100(requestBody)
      })

      const parsed = await response.json().catch(() => undefined)
      if (!response.ok)
        throw new Error(`Message Box batch send failed with HTTP ${response.status}.`)
      const responseRecord = safeResponseRecord(parsed, 'Message Box batch response')
      if (responseRecord.status !== 'success')
        throw new Error('Message Box server rejected the batch.')
      const sent = validateBatchSendResults(
        responseRecord.results ?? [],
        allowedRecipients,
        messageIds
      )
      const failed: Array<{ recipient: string; error: string }> = []
      const { status, description } = buildBatchSendResult(
        sent.length,
        allowedRecipients.length,
        blocked.length
      )
      return { status, description, sent, blocked, failed, totals }
    } catch (err) {
      if (err instanceof TypeError) throw err
      const msg = 'Batch send failed.'
      return {
        status: 'error',
        description: msg,
        sent: [],
        blocked,
        failed: allowedRecipients.map(r => ({ recipient: r, error: msg })),
        totals
      }
    }
  }

  /**
   * @method anointHost
   * @async
   * @param {string} host - The full URL of the server you want to designate as your MessageBox host (e.g., "https://mybox.com").
   * @returns {Promise<{ txid: string }>} - The transaction ID of the advertisement broadcast to the overlay network.
   *
   * @description
   * Broadcasts a signed overlay advertisement using a PushDrop output under the `tm_messagebox` topic.
   * This advertisement announces that the specified `host` is now authorized to receive and route
   * messages for the sender’s identity key.
   *
   * The broadcasted message includes:
   * - The identity key
   * - The chosen host URL
   *
   * This is essential for enabling overlay-based message delivery via SHIP and LookupResolver.
   * The recipient’s host must advertise itself for message routing to succeed in a decentralized manner.
   *
   * @throws {Error} If the URL is invalid, the PushDrop creation fails, or the overlay broadcast does not succeed.
   *
   * @example
   * const { txid } = await client.anointHost('https://my-messagebox.io')
   */
  async anointHost(host: string): Promise<{ txid: string }> {
    Logger.log('[MB CLIENT] Starting anointHost...')
    host = normalizeMessageBoxHost(host)

    const identityKey = await this.getIdentityKey()
    const overlayTokens = await this.queryAdvertisements(identityKey)
    Logger.log('[MB CLIENT] Resolved existing overlay advertisements')

    // Fetch ALL spendable wallet basket outputs and cross-reference with overlay tokens.
    // Only overlay tokens the wallet considers spendable are safe to spend as inputs.
    // This prevents stale overlay tokens (spent externally) from breaking the combined tx.
    const basketResult = await this.walletClient.listOutputs(
      {
        basket: 'overlay advertisements',
        limit: 10000
      },
      this.originator
    )
    const spendableOutpoints = new Set(
      basketResult.outputs.filter(o => o.spendable).map(o => o.outpoint)
    )
    const tokensToSpend = overlayTokens.filter(t =>
      spendableOutpoints.has(`${t.txid}.${t.outputIndex}`)
    )
    const skipped = overlayTokens.length - tokensToSpend.length
    if (skipped > 0) {
      Logger.log('[MB CLIENT] Skipping non-spendable overlay advertisements')
    }
    Logger.log('[MB CLIENT] Preparing spendable overlay advertisements for revocation')

    const fields: number[][] = [toArray(identityKey, 'hex'), toArray(host, 'utf8')]
    const pushdrop = new PushDrop(this.walletClient, this.originator)
    const script = await pushdrop.lock(fields, [1, 'messagebox advertisement'], '1', 'anyone', true)
    Logger.log('[MB CLIENT] Created overlay advertisement script')

    try {
      let inputBEEF: number[] | undefined
      if (tokensToSpend.length > 0) {
        const mergedBeef = Beef.fromBinaryStrict(tokensToSpend[0].beef)
        for (let i = 1; i < tokensToSpend.length; i++) {
          mergedBeef.mergeBeef(Beef.fromBinaryStrict(tokensToSpend[i].beef))
        }
        inputBEEF = mergedBeef.toBinary()
      }

      const { signableTransaction, tx: directTx } = await this.walletClient.createAction(
        {
          description: 'Anoint host for overlay routing',
          ...(inputBEEF !== undefined && {
            inputBEEF,
            inputs: tokensToSpend.map(token => ({
              outpoint: `${token.txid}.${token.outputIndex}`,
              unlockingScriptLength: 73,
              inputDescription: `Revoking advertisement for ${token.host}`
            }))
          }),
          outputs: [
            {
              basket: 'overlay advertisements',
              lockingScript: script.toHex(),
              satoshis: 1,
              outputDescription: 'Overlay advertisement output'
            }
          ],
          options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
        },
        this.originator
      )

      if (signableTransaction === undefined) {
        if (directTx === undefined) throw new Error('Anoint failed: no transaction returned')
        Logger.log('[MB CLIENT] Created direct overlay advertisement transaction')
        const broadcaster = new TopicBroadcaster(['tm_messagebox'], {
          networkPreset: this.networkPreset
        })
        const result = await broadcaster.broadcast(Transaction.fromAtomicBEEF(directTx))
        Logger.log('[MB CLIENT] Overlay advertisement broadcast succeeded')
        if (typeof result.txid !== 'string')
          throw new Error('Anoint failed: broadcast did not return a txid')
        return { txid: result.txid }
      }

      const partialTx = Transaction.fromAtomicBEEF(signableTransaction.tx)
      const spends: Record<number, { unlockingScript: string }> = {}

      for (let i = 0; i < tokensToSpend.length; i++) {
        const token = tokensToSpend[i]
        const sourceTx = Transaction.fromBEEF(token.beef)
        const sourceSatoshis = sourceTx.outputs[token.outputIndex]?.satoshis ?? 1
        const unlocker = pushdrop.unlock(
          [1, 'messagebox advertisement'],
          '1',
          'anyone',
          'all',
          false,
          sourceSatoshis,
          token.lockingScript
        )
        const finalUnlockScript = await unlocker.sign(partialTx, i)
        spends[i] = { unlockingScript: finalUnlockScript.toHex() }
      }

      const { tx: signedTx } = await this.walletClient.signAction(
        {
          reference: signableTransaction.reference,
          spends,
          options: { acceptDelayedBroadcast: false }
        },
        this.originator
      )

      if (signedTx === undefined)
        throw new Error('Anoint failed: signing did not return a transaction')
      Logger.log('[MB CLIENT] Created signed overlay advertisement transaction')

      const broadcaster = new TopicBroadcaster(['tm_messagebox'], {
        networkPreset: this.networkPreset
      })
      const result = await broadcaster.broadcast(Transaction.fromAtomicBEEF(signedTx))
      Logger.log('[MB CLIENT] Overlay advertisement broadcast succeeded')

      if (typeof result.txid !== 'string')
        throw new Error('Anoint failed: broadcast did not return a txid')
      return { txid: result.txid }
    } catch (err) {
      Logger.error('[MB CLIENT ERROR] Host advertisement failed')
      throw err
    }
  }

  /**
   * @method revokeHostAdvertisement
   * @async
   * @param {AdvertisementToken} advertisementToken - The advertisement token containing the messagebox host to revoke.
   * @param {string} [originator] - Optional originator to use with walletClient.
   * @returns {Promise<{ txid: string }>} - The transaction ID of the revocation broadcast to the overlay network.
   *
   * @description
   * Broadcasts a signed revocation transaction indicating the advertisement token should be removed
   * and no longer tracked by lookup services.
   *
   * @example
   * const { txid } = await client.revokeHost('https://my-messagebox.io')
   */
  async revokeHostAdvertisement(advertisementToken: AdvertisementToken): Promise<{ txid: string }> {
    Logger.log('[MB CLIENT] Starting revokeHost...')
    const outpoint = `${advertisementToken.txid}.${advertisementToken.outputIndex}`
    try {
      const { signableTransaction } = await this.walletClient.createAction(
        {
          description: 'Revoke MessageBox host advertisement',
          inputBEEF: advertisementToken.beef,
          inputs: [
            {
              outpoint,
              unlockingScriptLength: 73,
              inputDescription: 'Revoking host advertisement token'
            }
          ]
        },
        this.originator
      )

      if (signableTransaction === undefined) {
        throw new Error('Failed to create signable transaction.')
      }

      const partialTx = Transaction.fromAtomicBEEF(signableTransaction.tx)

      // Get the source satoshis from the BEEF so the sighash preimage is correct
      const sourceTx = Transaction.fromBEEF(advertisementToken.beef)
      const sourceSatoshis = sourceTx.outputs[advertisementToken.outputIndex]?.satoshis ?? 1

      // Prepare the unlocker
      const pushdrop = new PushDrop(this.walletClient, this.originator)
      const unlocker = pushdrop.unlock(
        [1, 'messagebox advertisement'],
        '1',
        'anyone',
        'all',
        false,
        sourceSatoshis,
        advertisementToken.lockingScript
      )

      // Convert to Transaction, apply signature
      const finalUnlockScript = await unlocker.sign(partialTx, 0)

      // Complete signing with the final unlock script
      const { tx: signedTx } = await this.walletClient.signAction(
        {
          reference: signableTransaction.reference,
          spends: {
            0: {
              unlockingScript: finalUnlockScript.toHex()
            }
          },
          options: {
            acceptDelayedBroadcast: false
          }
        },
        this.originator
      )

      if (signedTx === undefined) {
        throw new Error('Failed to finalize the transaction signature.')
      }

      const broadcaster = new TopicBroadcaster(['tm_messagebox'], {
        networkPreset: this.networkPreset
      })

      const result = await broadcaster.broadcast(Transaction.fromAtomicBEEF(signedTx))
      Logger.log('[MB CLIENT] Host-advertisement revocation broadcast succeeded')

      if (typeof result.txid !== 'string') {
        throw new TypeError('Revoke failed: broadcast did not return a txid')
      }

      return { txid: result.txid }
    } catch (err) {
      Logger.error('[MB CLIENT ERROR] Host-advertisement revocation failed')
      throw err
    }
  }

  /**
   * @method listMessages
   * @async
   * @param {ListMessagesParams} params - Contains the name of the messageBox to read from.
   * @returns {Promise<PeerMessage[]>} - Returns an array of decrypted `PeerMessage` objects.
   *
   * @description
   * Retrieves all messages from the specified `messageBox` assigned to the current identity key.
   * Unless a host override is provided, messages are fetched from the resolved overlay host (via LookupResolver) or the default host if no advertisement is found.
   *
   * Each message is:
   * - Parsed and, if encrypted, decrypted using AES-256-GCM via BRC-2-compliant ECDH key derivation and symmetric encryption.
   * - Automatically processed for payments: if the message includes recipient fee payments, they are internalized using `walletClient.internalizeAction()`.
   * - Returned as a normalized `PeerMessage` with readable string body content.
   *
   * Payment Processing:
   * - Detects messages that include payment data (from paid message delivery).
   * - Automatically internalizes recipient payment outputs, allowing you to receive payments without additional API calls.
   * - Only recipient payments are stored with messages - delivery fees are already processed by the server.
   * - Continues processing messages even if payment internalization fails.
   *
   * Decryption automatically derives a shared secret using the sender's identity key and the receiver's child private key.
   * If the sender is the same as the recipient, the `counterparty` is set to `'self'`.
   *
   * @throws {Error} If no messageBox is specified, the request fails, or the server returns an error.
   *
   * @example
   * const messages = await client.listMessages({ messageBox: 'inbox' })
   * messages.forEach(msg => console.log(msg.sender, msg.body))
   * // Payments included with messages are automatically received
   */
  async listMessages({
    messageBox,
    host,
    acceptPayments,
    offset,
    skip,
    limit,
    pageSize,
    maxPages,
    messageId
  }: ListMessagesParams): Promise<PeerMessage[]> {
    const shouldAcceptPayments = acceptPayments !== false
    if (typeof messageBox !== 'string' || messageBox.trim() === '') {
      throw new Error('MessageBox cannot be empty')
    }
    const canonicalMessageBox = exactBoundedText(messageBox, 'Message box', MAX_MESSAGE_BOX_BYTES, {
      forbidControls: true
    })

    const hosts = await this.resolveMessageHosts(host)

    // Query each host in parallel
    const fetchFromHost = async (host: string): Promise<PeerMessage[]> => {
      try {
        Logger.log('[MB CLIENT] Listing messages from a configured host')
        return await this.fetchMessagePages(host, canonicalMessageBox, {
          offset,
          skip,
          limit,
          pageSize,
          maxPages,
          messageId
        })
      } catch (err) {
        Logger.log('[MB CLIENT DEBUG] Message listing failed for a configured host')
        throw err // re-throw to be caught in the settled promise
      }
    }

    const settled = await Promise.allSettled(hosts.map(fetchFromHost))

    // 3. Split successes / failures
    const messagesByHost: PeerMessage[][] = []

    for (const r of settled) {
      if (r.status === 'fulfilled') {
        messagesByHost.push(r.value)
      }
    }

    // 4. If *every* host failed – throw aggregated error
    if (messagesByHost.length === 0) {
      throw new Error('Failed to retrieve messages from any host')
    }

    // 5. Merge & de‑duplicate (first‑seen wins)
    const dedupMap = new Map<string, PeerMessage>()
    for (const messageList of messagesByHost) {
      for (const m of messageList) {
        if (!dedupMap.has(m.messageId)) dedupMap.set(m.messageId, m)
      }
    }

    // 6. Early‑out: no messages but at least one host succeeded → []
    if (dedupMap.size === 0) return []

    const deduplicated = Array.from(dedupMap.values())
    const messages: PeerMessage[] = limit == null ? deduplicated : deduplicated.slice(0, limit)

    const parsed = messages.map(message => this.parseMessageEnvelope(message))

    if (shouldAcceptPayments) {
      const paymentJobs = parsed.filter(
        p => p.paymentData?.tx != null && p.paymentData.outputs != null
      )
      await this.mapWithConcurrency(paymentJobs, 2, async p => {
        await this.internalizeRecipientPayment(p)
        return null
      })
    }

    await this.mapWithConcurrency(parsed, 4, async p => {
      await this.decryptMessageBody(p)
      return null
    })

    // Sort newest‑first for a deterministic order
    messages.sort((a, b) => Number((b as any).timestamp ?? 0) - Number((a as any).timestamp ?? 0))

    return messages
  }

  private async resolveMessageHosts(host?: string): Promise<string[]> {
    if (host != null) return [normalizeMessageBoxHost(host)]
    const advertisedHosts = await this.queryAdvertisements(await this.getIdentityKey())
    return Array.from(
      new Set([this.host, ...advertisedHosts.map(advertisement => advertisement.host)])
    )
  }

  /**
   * @method listMessagesLite
   * @async
   * @param {ListMessagesParams} params - Contains the `messageBox` to read from and the `host` to query.
   * @returns {Promise<PeerMessage[]>} - Returns an array of decrypted `PeerMessage` objects with minimal processing.
   *
   * @description
   * A lightweight variant of {@link listMessages} that fetches and decrypts messages
   * from a specific host without performing:
   * - Overlay host resolution
   * - Payment acceptance or internalization
   * - Cross-host deduplication
   *
   * This method:
   * - Sends a direct POST request to the specified host's `/listMessages` endpoint.
   * - Parses message bodies as JSON when possible.
   * - Decrypts messages if they contain an `encryptedMessage` field, using AES-256-GCM via BRC-2-compliant ECDH key derivation.
   * - Returns messages in the order provided by the host.
   *
   * This is intended for cases where you already know the host and need faster,
   * simpler retrieval without the additional processing overhead of `listMessages`.
   *
   * @throws {Error} If the host returns an error status or decryption fails.
   *
   * @example
   * const messages = await client.listMessagesLite({
   *   messageBox: 'notifications',
   *   host: 'https://message-box-us-1.bsvb.tech'
   * })
   * console.log(messages)
   */
  async listMessagesLite({
    messageBox,
    host,
    offset,
    skip,
    limit,
    pageSize,
    maxPages,
    messageId
  }: ListMessagesParams): Promise<PeerMessage[]> {
    if (typeof messageBox !== 'string' || messageBox.trim() === '') {
      throw new Error('MessageBox cannot be empty')
    }
    const canonicalMessageBox = exactBoundedText(messageBox, 'Message box', MAX_MESSAGE_BOX_BYTES, {
      forbidControls: true
    })
    const finalHost = normalizeMessageBoxHost(host ?? this.host)
    const messages = await this.fetchMessagePages(finalHost, canonicalMessageBox, {
      offset,
      skip,
      limit,
      pageSize,
      maxPages,
      messageId
    })

    await this.mapWithConcurrency(messages, 4, async message => {
      try {
        const parsedBody: unknown =
          typeof message.body === 'string' ? this.tryParse(message.body) : message.body
        let messageContent: any = parsedBody
        if (
          parsedBody != null &&
          typeof parsedBody === 'object' &&
          !Array.isArray(parsedBody) &&
          Object.hasOwn(parsedBody, 'message')
        ) {
          const wrappedMessage = ownDataRecord(
            parsedBody,
            'Message Box stored-message envelope'
          ).message
          messageContent =
            typeof wrappedMessage === 'string' ? this.tryParse(wrappedMessage) : wrappedMessage
        }
        if (
          messageContent != null &&
          typeof messageContent === 'object' &&
          !Array.isArray(messageContent) &&
          Object.hasOwn(messageContent, 'encryptedMessage')
        ) {
          const body = ownDataRecord(messageContent, 'Message Box lite message body')
          if (typeof body.encryptedMessage !== 'string') {
            throw new TypeError('Message Box lite ciphertext must be a string')
          }
          const request: Parameters<WalletInterface['decrypt']>[0] = {
            protocolID: [1, 'messagebox'],
            keyID: '1',
            counterparty: message.sender,
            ciphertext: toArray(body.encryptedMessage, 'base64')
          }
          const decrypted = validateWalletResult(
            'decrypt',
            await this.walletClient.decrypt(request, this.originator),
            request
          )
          const decryptedText = toUTF8(decrypted.plaintext)
          message.body = this.tryParse(decryptedText)
        } else {
          message.body = messageContent ?? parsedBody
        }
      } catch {
        Logger.error('[MB CLIENT ERROR] Failed to parse or decrypt message in list')
        message.body = '[Error: Failed to decrypt or parse message]'
      }
      return null
    })
    return messages
  }

  private async fetchMessagePages(
    host: string,
    messageBox: string,
    options: Pick<
      ListMessagesParams,
      'offset' | 'skip' | 'limit' | 'pageSize' | 'maxPages' | 'messageId'
    > = {}
  ): Promise<PeerMessage[]> {
    const { startingOffset, totalLimit, requestedPageSize, maximumPages } =
      this.normalizeMessagePageOptions(options)
    const messages: PeerMessage[] = []
    let offset = startingOffset
    let page = 0

    while (maximumPages === -1 || page < maximumPages) {
      const remaining = totalLimit == null ? undefined : totalLimit - messages.length
      if (remaining != null && remaining <= 0) return messages
      const pageLimit = this.messagePageLimit(requestedPageSize, remaining)
      const { data, pageMessages } = await this.fetchMessagePage(
        host,
        messageBox,
        offset,
        pageLimit,
        options.messageId
      )
      const accepted = remaining == null ? pageMessages : pageMessages.slice(0, remaining)
      messages.push(...accepted)

      // Legacy Message Box servers returned the complete collection without
      // pagination metadata and may ignore limit/offset. Only continue when a
      // pagination-aware server explicitly advertises another page.
      if (data.hasMore !== true) return messages
      offset = this.nextMessagePageOffset(data, pageMessages.length, offset, requestedPageSize)
      page += 1
    }

    throw new Error(
      `Message Box pagination exceeded ${maximumPages} pages; ` +
        'acknowledge messages, raise maxPages, or set an application-level limit.'
    )
  }

  private normalizeMessagePageOptions(
    options: Pick<ListMessagesParams, 'offset' | 'skip' | 'limit' | 'pageSize' | 'maxPages'>
  ): {
    startingOffset: number
    totalLimit?: number
    requestedPageSize?: number
    maximumPages: number
  } {
    if (options.offset != null && options.skip != null && options.offset !== options.skip) {
      throw new RangeError('offset and skip must match when both are provided')
    }
    const startingOffset = options.offset ?? options.skip ?? 0
    const maximumPages = options.maxPages ?? -1
    this.assertMessagePageOption('offset', startingOffset, 0)
    this.assertMessagePageOption('limit', options.limit, 1)
    this.assertMessagePageOption('pageSize', options.pageSize, 1)
    this.assertMessagePageOption('maxPages', maximumPages, 1, true)
    return {
      startingOffset,
      totalLimit: options.limit,
      requestedPageSize: options.pageSize,
      maximumPages
    }
  }

  private assertMessagePageOption(
    name: string,
    value: number | undefined,
    minimum: number,
    allowUnlimited: boolean = false
  ): void {
    if (value == null) return
    const unlimited = allowUnlimited && value === -1
    if (Number.isSafeInteger(value) && (unlimited || value >= minimum)) return
    const unlimitedPrefix = allowUnlimited ? '-1 or ' : ''
    const sign = minimum === 0 ? 'non-negative' : 'positive'
    throw new RangeError(`${name} must be ${unlimitedPrefix}a ${sign} safe integer`)
  }

  private messagePageLimit(
    requestedPageSize: number | undefined,
    remaining: number | undefined
  ): number | undefined {
    if (requestedPageSize == null) return remaining
    if (remaining == null) return requestedPageSize
    return Math.min(requestedPageSize, remaining)
  }

  private async fetchMessagePage(
    host: string,
    messageBox: string,
    offset: number,
    limit: number | undefined,
    messageId?: string
  ): Promise<{ data: any; pageMessages: PeerMessage[] }> {
    const body: Record<string, unknown> = { messageBox, offset }
    if (limit != null) body.limit = limit
    if (messageId !== undefined) body.messageId = messageId
    const response = await this.authenticatedFetch(messageBoxEndpoint(host, '/listMessages'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: stringifyBRC100(body)
    })
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)

    const data = await response.json()
    if (data.status === 'error') throw new Error(data.description ?? 'Unknown server error')
    if (!Array.isArray(data.messages)) {
      throw new TypeError('Message Box server returned an invalid messages payload')
    }
    return { data, pageMessages: data.messages as PeerMessage[] }
  }

  private nextMessagePageOffset(
    data: any,
    pageMessageCount: number,
    currentOffset: number,
    requestedPageSize: number | undefined
  ): number {
    const nextOffset = Number(data.nextOffset)
    if (Number.isSafeInteger(nextOffset) && nextOffset > currentOffset) return nextOffset
    if (pageMessageCount > 0) return currentOffset + pageMessageCount

    const serverLimit = Number(data.limit)
    if (Number.isSafeInteger(serverLimit) && serverLimit > 0) return currentOffset + serverLimit
    return currentOffset + (requestedPageSize ?? 1_000)
  }

  /**
   * @method tryParse
   * @private
   * @param {string} raw - A raw string value that may contain JSON.
   * @returns {any} - The parsed JavaScript object if valid JSON, or the original string if parsing fails.
   *
   * @description
   * Attempts to parse a string as JSON. If the string is valid JSON, returns the parsed object;
   * otherwise returns the original string unchanged.
   *
   * This method is used throughout the client to safely handle message bodies that may or may not be
   * JSON-encoded without throwing parsing errors.
   *
   * @example
   * tryParse('{"hello":"world"}') // → { hello: "world" }
   * tryParse('plain text')        // → "plain text"
   */
  tryParse(raw: string): any {
    try {
      return JSON.parse(raw)
    } catch {
      return raw
    }
  }

  private async mapWithConcurrency<T, R>(
    items: T[],
    limit: number,
    fn: (item: T, index: number) => Promise<R>
  ): Promise<R[]> {
    if (items.length === 0) return []
    if (!Number.isFinite(limit) || limit >= items.length) {
      return await Promise.all(items.map((item, index) => fn(item, index)))
    }

    const workerCount = Math.max(1, Math.min(limit, items.length))
    const results: R[] = []
    let nextIndex = 0

    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        const currentIndex = nextIndex
        nextIndex++
        if (currentIndex >= items.length) return
        results[currentIndex] = await fn(items[currentIndex], currentIndex)
      }
    })

    await Promise.all(workers)
    return results
  }

  /**
   * @method acknowledgeNotification
   * @async
   * @param {PeerMessage} message - The peer message object to acknowledge.
   * @returns {Promise<boolean>} - Resolves to `true` if the message included a recipient payment and it was successfully internalized, otherwise `false`.
   *
   * @description
   * Acknowledges receipt of a specific notification message and, if applicable, processes any recipient
   * payment contained within it.
   *
   * This method:
   * 1. Checks the original notification body for embedded recipient payment data.
   * 2. Internalizes a present payment and requires `accepted: true` from the wallet.
   * 3. Acknowledges after acceptance, or immediately when no payment is present.
   * Failed, incomplete, or unsupported payments remain queued. The boolean return
   * contract is unchanged; `false` can mean no payment or a retained failed payment.
   *
   * This is a convenience wrapper for acknowledgment and payment handling specifically for messages
   * representing notifications.
   *
   * @example
   * const success = await client.acknowledgeNotification(message)
   * console.log(success ? 'Payment received' : 'No payment or failed')
   */
  async acknowledgeNotification(message: PeerMessage): Promise<boolean> {
    const parsedBody: unknown =
      typeof message.body === 'string' ? this.tryParse(message.body) : message.body

    let paymentData: OwnDataRecord | undefined

    try {
      if (
        parsedBody != null &&
        typeof parsedBody === 'object' &&
        !Array.isArray(parsedBody) &&
        Object.hasOwn(parsedBody, 'message')
      ) {
        const envelope = ownDataRecord(parsedBody, 'Message Box notification envelope')
        if (envelope.payment != null) {
          paymentData = ownDataRecord(envelope.payment, 'Message Box notification payment')
        }
      }
    } catch {
      Logger.error('[MB CLIENT ERROR] Notification payment data is invalid')
      return false
    }

    // Process payment if present - server now only stores recipient payments
    if (paymentData != null) {
      try {
        Logger.log('[MB CLIENT] Processing a notification recipient payment')

        // All outputs in the stored payment data are for the recipient
        // (delivery fees are already processed by the server)
        const request = snapshotIncomingPayment(paymentData, 'Message Box notification payment')
        if (request.outputs.length < 1) {
          Logger.log('[MB CLIENT] No wallet payment outputs found in payment data')
          return false
        }

        Logger.log('[MB CLIENT] Internalizing notification recipient payment outputs')
        const bindingRequest = snapshotWalletResultRequest('internalizeAction', request)
        validateWalletResult(
          'internalizeAction',
          await this.walletClient.internalizeAction(request, this.originator),
          bindingRequest
        )

        Logger.log('[MB CLIENT] Successfully internalized recipient payment')
        await this.acknowledgeMessage({ messageIds: [message.messageId] })
        return true
      } catch {
        Logger.error('[MB CLIENT ERROR] Failed to process or acknowledge recipient payment')
        return false
      }
    }
    if (paymentData == null) {
      await this.acknowledgeMessage({ messageIds: [message.messageId] })
    }
    return false
  }

  /**
   * @method acknowledgeMessage
   * @async
   * @param {AcknowledgeMessageParams} params - An object containing an array of message IDs to acknowledge.
   * @returns {Promise<string>} - A string indicating the result, typically `'success'`.
   *
   * @description
   * Notifies the MessageBox server(s) that one or more messages have been
   * successfully received and processed by the client. Once acknowledged, these messages are removed
   * from the recipient's inbox on the server(s).
   *
   * This operation is essential for proper message lifecycle management and prevents duplicate
   * processing or delivery.
   *
   * Acknowledgment supports providing a host override, or will use overlay routing to find the appropriate server the received the given message.
   *
   * @throws {Error} If the message ID array is missing or empty, or if the request to the server fails.
   *
   * @example
   * await client.acknowledgeMessage({ messageIds: ['msg123', 'msg456'] })
   */
  async acknowledgeMessage({ messageIds, host }: AcknowledgeMessageParams): Promise<string> {
    if (!Array.isArray(messageIds) || messageIds.length === 0) {
      throw new Error('Message IDs array cannot be empty')
    }
    if (messageIds.length > MAX_ACKNOWLEDGMENT_IDS) {
      throw new RangeError(
        `Acknowledge requests may include at most ${MAX_ACKNOWLEDGMENT_IDS} message IDs.`
      )
    }
    const canonicalMessageIds = messageIds.map((messageId, index) =>
      exactBoundedText(messageId, `Message ID ${index}`, MAX_MESSAGE_ID_BYTES, {
        forbidControls: true
      })
    )

    Logger.log('[MB CLIENT] Acknowledging messages')

    let hosts: string[] = host != null ? [normalizeMessageBoxHost(host)] : []
    if (hosts.length === 0) {
      // 1. Determine all hosts (advertised + default)
      const identityKey = await this.getIdentityKey()
      const advertisedHosts = await this.queryAdvertisements(identityKey)
      hosts = Array.from(new Set([this.host, ...advertisedHosts.map(h => h.host)]))
    }

    // 2. Dispatch parallel acknowledge requests
    const ackFromHost = async (host: string): Promise<string | null> => {
      try {
        const res = await this.authenticatedFetch(messageBoxEndpoint(host, '/acknowledgeMessage'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: stringifyBRC100({ messageIds: [...new Set(canonicalMessageIds)] })
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        if (data.status === 'error') throw new Error(data.description)
        Logger.log('[MB CLIENT] Messages acknowledged on a configured host')
        return data.status
      } catch {
        Logger.warn('[MB CLIENT WARN] Message acknowledgement failed for a configured host')
        return null
      }
    }

    const settled = await Promise.allSettled(hosts.map(ackFromHost))

    const successes = settled.filter(
      (r): r is PromiseFulfilledResult<string | null> => r.status === 'fulfilled'
    )

    const firstSuccess = successes.find(s => s.value != null)?.value

    if (firstSuccess != null) {
      return firstSuccess
    }

    // No host accepted the acknowledgement
    const errs: any[] = []
    for (const r of settled) {
      if (r.status === 'rejected') errs.push(r.reason)
    }
    throw new Error(`Failed to acknowledge messages on all hosts: ${errs.map(String).join('; ')}`)
  }

  // ===========================
  // PERMISSION MANAGEMENT METHODS
  // ===========================

  /**
   * @method setMessageBoxPermission
   * @async
   * @param {SetMessageBoxPermissionParams} params - Permission configuration
   * @param {string} [overrideHost] - Optional host override
   * @returns {Promise<void>} Permission status after setting
   *
   * @description
   * Sets permission for receiving messages in a specific messageBox.
   * Can set sender-specific permissions or box-wide defaults.
   *
   * @example
   * // Set box-wide default: allow notifications for 10 sats
   * await client.setMessageBoxPermission({ messageBox: 'notifications', recipientFee: 10 })
   *
   * // Block specific sender
   * await client.setMessageBoxPermission({
   *   messageBox: 'notifications',
   *   sender: '03abc123...',
   *   recipientFee: -1
   * })
   */
  async setMessageBoxPermission(
    params: SetMessageBoxPermissionParams,
    overrideHost?: string
  ): Promise<void> {
    const messageBox = exactBoundedText(params.messageBox, 'Message box', MAX_MESSAGE_BOX_BYTES, {
      forbidControls: true
    })
    const sender =
      params.sender == null ? undefined : canonicalIdentityKey(params.sender, 'Permission sender')
    if (
      !Number.isSafeInteger(params.recipientFee) ||
      params.recipientFee < -1 ||
      params.recipientFee > MAX_MESSAGE_FEE
    ) {
      throw new TypeError(`recipientFee must be an integer from -1 to ${MAX_MESSAGE_FEE}.`)
    }
    const finalHost = normalizeMessageBoxHost(overrideHost ?? this.host)

    Logger.log('[MB CLIENT] Setting messageBox permission...')

    const response = await this.authenticatedFetch(
      messageBoxEndpoint(finalHost, '/permissions/set'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: stringifyBRC100({
          messageBox,
          recipientFee: params.recipientFee,
          ...(sender != null && { sender })
        })
      }
    )

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      throw new Error(
        `Failed to set permission: HTTP ${response.status} - ${String(errorData.description) !== '' ? String(errorData.description) : response.statusText}`
      )
    }

    const { status, description } = await response.json()
    if (status === 'error') {
      throw new Error(description ?? 'Failed to set permission')
    }
  }

  /**
   * @method getMessageBoxPermission
   * @async
   * @param {GetMessageBoxPermissionParams} params - Permission query parameters
   * @param {string} [overrideHost] - Optional host override
   * @returns {Promise<MessageBoxPermission | null>} Permission data (null if not set)
   *
   * @description
   * Gets current permission data for a sender/messageBox combination.
   * Returns null if no permission is set.
   *
   * @example
   * const status = await client.getMessageBoxPermission({
   *   recipient: '03def456...',
   *   messageBox: 'notifications',
   *   sender: '03abc123...'
   * })
   */
  async getMessageBoxPermission(
    params: GetMessageBoxPermissionParams,
    overrideHost?: string
  ): Promise<MessageBoxPermission | null> {
    const recipient = canonicalIdentityKey(params.recipient, 'Permission recipient')
    const messageBox = exactBoundedText(params.messageBox, 'Message box', MAX_MESSAGE_BOX_BYTES, {
      forbidControls: true
    })
    const sender =
      params.sender == null ? undefined : canonicalIdentityKey(params.sender, 'Permission sender')
    const finalHost = normalizeMessageBoxHost(
      overrideHost ?? (await this.resolveHostForRecipient(recipient))
    )
    const queryParams = new URLSearchParams({
      messageBox,
      ...(sender != null && { sender })
    })

    Logger.log('[MB CLIENT] Getting messageBox permission...')

    const response = await this.authenticatedFetch(
      `${messageBoxEndpoint(finalHost, '/permissions/get')}?${queryParams.toString()}`,
      {
        method: 'GET'
      }
    )

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      throw new Error(
        `Failed to get permission: HTTP ${response.status} - ${String(errorData.description) !== '' ? String(errorData.description) : response.statusText}`
      )
    }

    const data = safeResponseRecord(await response.json(), 'Permission response')
    if (data.status === 'error') {
      throw new Error(
        typeof data.description === 'string' ? data.description : 'Failed to get permission'
      )
    }
    if (data.status !== 'success') throw new TypeError('Permission response status is invalid.')
    return data.permission === null ? null : validatePermissionRecord(data.permission)
  }

  /**
   * @method getMessageBoxQuote
   * @async
   * @param {GetQuoteParams} params - Quote request parameters
   * @returns {Promise<MessageBoxQuote>} Fee quote and permission status
   *
   * @description
   * Gets a fee quote for sending a message, including delivery and recipient fees.
   *
   * @example
   * const quote = await client.getMessageBoxQuote({
   *   recipient: '03def456...',
   *   messageBox: 'notifications'
   * })
   */
  async getMessageBoxQuote(
    params: GetQuoteParams,
    overrideHost?: string
  ): Promise<MessageBoxQuote | MessageBoxMultiQuote> {
    const snapshot = snapshotQuoteParams(params)
    if (Array.isArray(snapshot.recipient)) {
      return this.getMultiMessageBoxQuote(snapshot.recipient, snapshot.messageBox, overrideHost)
    }

    return this.getSingleMessageBoxQuote(snapshot.recipient, snapshot.messageBox, overrideHost)
  }

  private async getSingleMessageBoxQuote(
    recipient: string,
    messageBox: string,
    overrideHost?: string
  ): Promise<MessageBoxQuote> {
    const finalHost = normalizeMessageBoxHost(
      overrideHost ?? (await this.resolveHostForRecipient(recipient))
    )
    const queryParams = new URLSearchParams({
      recipient,
      messageBox
    })

    Logger.log('[MB CLIENT] Getting messageBox quote (single)...')
    const quoteUrl = `${messageBoxEndpoint(finalHost, '/permissions/quote')}?${queryParams.toString()}`
    Logger.log('[MB CLIENT] Sending authenticated quote request')
    const response = await this.authenticatedFetch(quoteUrl, { method: 'GET' })
    if (!response.ok) {
      throw new Error(`Message Box quote request failed with HTTP ${response.status}.`)
    }

    const payload = safeResponseRecord(await response.json(), 'Message Box quote response')
    if (payload.status !== 'success')
      throw new Error('Message Box server rejected the quote request.')
    const quote = safeResponseRecord(payload.quote, 'Message Box quote payload')

    const deliveryAgentIdentityKey = response.headers.get('x-bsv-auth-identity-key')
    if (deliveryAgentIdentityKey == null) {
      throw new Error('Failed to get quote: Delivery agent did not provide their identity key')
    }

    return validateSingleQuoteResult({
      recipientFee: quote.recipientFee,
      deliveryFee: quote.deliveryFee,
      deliveryAgentIdentityKey
    })
  }

  private async getMultiMessageBoxQuote(
    recipients: PubKeyHex[],
    messageBox: string,
    overrideHost?: string
  ): Promise<MessageBoxMultiQuote> {
    Logger.log('[MB CLIENT] Getting messageBox quotes (multi)...')
    const hostGroups = await this.groupQuoteRecipientsByHost(recipients, overrideHost)
    const accumulator = this.createMultiQuoteAccumulator()

    await Promise.all(
      Array.from(hostGroups.entries()).map(async ([host, group]) => {
        const payload = await this.fetchQuotePayloadForHost(host, group, messageBox, accumulator)
        if (this.isSingleQuotePayload(payload) && group.length > 1) {
          const individualPayloads = await Promise.all(
            group.map(recipient =>
              this.fetchQuotePayloadForHost(host, [recipient], messageBox, accumulator)
            )
          )
          individualPayloads.forEach((individualPayload, index) =>
            this.mergeQuotePayload(individualPayload, host, [group[index]], messageBox, accumulator)
          )
        } else {
          this.mergeQuotePayload(payload, host, group, messageBox, accumulator)
        }
      })
    )

    const { deliveryFees, recipientFees } = accumulator

    return {
      quotesByRecipient: accumulator.quotesByRecipient,
      totals: {
        deliveryFees,
        recipientFees,
        totalForPayableRecipients: checkedFeeSum(
          [deliveryFees, recipientFees],
          'Quote payment total'
        )
      },
      blockedRecipients: Array.from(accumulator.blockedRecipients),
      deliveryAgentIdentityKeyByHost: accumulator.deliveryAgentIdentityKeyByHost
    }
  }

  private createMultiQuoteAccumulator(): MessageBoxMultiQuoteAccumulator {
    return {
      quotesByRecipient: [],
      blockedRecipients: new Set(),
      deliveryAgentIdentityKeyByHost: {},
      deliveryFees: 0,
      recipientFees: 0
    }
  }

  private async groupQuoteRecipientsByHost(
    recipients: PubKeyHex[],
    overrideHost?: string
  ): Promise<Map<string, PubKeyHex[]>> {
    const resolvedHosts =
      overrideHost != null
        ? recipients.map(() => normalizeMessageBoxHost(overrideHost))
        : await this.mapWithConcurrency(recipients, 8, recipient =>
            this.resolveHostForRecipient(recipient)
          )
    const hostGroups = new Map<string, PubKeyHex[]>()

    for (let i = 0; i < recipients.length; i++) {
      const host = resolvedHosts[i]
      const list = hostGroups.get(host) ?? []
      list.push(recipients[i])
      hostGroups.set(host, list)
    }

    return hostGroups
  }

  private async fetchQuotePayloadForHost(
    host: string,
    groupRecipients: PubKeyHex[],
    messageBox: string,
    accumulator: MessageBoxMultiQuoteAccumulator
  ): Promise<unknown> {
    const qp = new URLSearchParams()
    for (const recipient of groupRecipients) qp.append('recipient', recipient)
    qp.set('messageBox', messageBox)

    const url = `${messageBoxEndpoint(host, '/permissions/quote')}?${qp.toString()}`
    Logger.log('[MB CLIENT] Sending authenticated multi-quote request')

    const response = await this.authenticatedFetch(url, { method: 'GET' })
    if (!response.ok) {
      throw new Error(`Message Box quote request failed with HTTP ${response.status}.`)
    }

    const deliveryAgentKey = response.headers.get('x-bsv-auth-identity-key')
    if (deliveryAgentKey == null) {
      throw new Error(`Failed to get quote (host ${host}): missing delivery agent identity key`)
    }
    accumulator.deliveryAgentIdentityKeyByHost[host] = canonicalIdentityKey(
      deliveryAgentKey,
      `Delivery-agent identity for ${host}`
    )

    const payload = await response.json()
    safeResponseRecord(payload, 'Message Box quote response')
    return payload
  }

  private mergeQuotePayload(
    payload: unknown,
    host: string,
    groupRecipients: PubKeyHex[],
    messageBox: string,
    accumulator: MessageBoxMultiQuoteAccumulator
  ): void {
    const record = safeResponseRecord(payload, 'Message Box quote response')
    if (record.status !== undefined && record.status !== 'success') {
      throw new Error('Message Box server rejected the quote request.')
    }
    if (this.isMultiQuotePayload(payload)) {
      this.mergeRecipientQuotes(payload, groupRecipients, messageBox, accumulator)
      return
    }

    if (this.isSingleQuotePayload(payload)) {
      this.mergeSingleQuotePayload(payload, groupRecipients, messageBox, accumulator)
      return
    }

    throw new Error(`Unexpected quote response shape from host ${host}`)
  }

  private isMultiQuotePayload(payload: unknown): payload is {
    quotesByRecipient: MessageBoxRecipientQuote[]
    blockedRecipients?: PubKeyHex[]
  } {
    if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) return false
    const descriptor = Object.getOwnPropertyDescriptor(payload, 'quotesByRecipient')
    return descriptor != null && 'value' in descriptor && Array.isArray(descriptor.value)
  }

  private isSingleQuotePayload(payload: unknown): payload is {
    quote: Pick<MessageBoxRecipientQuote, 'deliveryFee' | 'recipientFee'>
  } {
    if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) return false
    const descriptor = Object.getOwnPropertyDescriptor(payload, 'quote')
    return descriptor != null && 'value' in descriptor && descriptor.value != null
  }

  private mergeRecipientQuotes(
    payload: { quotesByRecipient: MessageBoxRecipientQuote[]; blockedRecipients?: PubKeyHex[] },
    groupRecipients: PubKeyHex[],
    messageBox: string,
    accumulator: MessageBoxMultiQuoteAccumulator
  ): void {
    if (payload.quotesByRecipient.length !== groupRecipients.length) {
      throw new TypeError('Quote response must contain exactly one row per requested recipient.')
    }
    const requested = new Set(groupRecipients)
    const seen = new Set<PubKeyHex>()
    const quotes = payload.quotesByRecipient.map(quote =>
      validateQuoteRow(quote, requested, messageBox, seen)
    )
    const derivedBlocked = quotes
      .filter(quote => quote.recipientFee === -1)
      .map(quote => quote.recipient)
    const suppliedBlocked = payload.blockedRecipients ?? []
    assertSafeDataGraph(suppliedBlocked, 'Message Box blocked recipients')
    if (!Array.isArray(suppliedBlocked)) {
      throw new TypeError('blockedRecipients must be an array.')
    }
    const blocked = suppliedBlocked.map((recipient, index) =>
      canonicalIdentityKey(recipient, `Blocked quote recipient ${index}`)
    )
    if (
      new Set(blocked).size !== blocked.length ||
      blocked.length !== derivedBlocked.length ||
      blocked.some(recipient => !derivedBlocked.includes(recipient))
    ) {
      throw new TypeError('blockedRecipients must exactly match blocked quote rows.')
    }
    for (const quote of quotes) {
      accumulator.quotesByRecipient.push(quote)
      accumulator.deliveryFees += quote.deliveryFee
      if (!Number.isSafeInteger(accumulator.deliveryFees)) {
        throw new TypeError('Quote delivery-fee total exceeds the safe integer range.')
      }
      this.addRecipientFee(quote.recipient, quote.recipientFee, accumulator)
    }

    for (const recipient of blocked) {
      accumulator.blockedRecipients.add(recipient)
    }
  }

  private mergeSingleQuotePayload(
    payload: { quote: Pick<MessageBoxRecipientQuote, 'deliveryFee' | 'recipientFee'> },
    groupRecipients: PubKeyHex[],
    messageBox: string,
    accumulator: MessageBoxMultiQuoteAccumulator
  ): void {
    if (groupRecipients.length !== 1) {
      throw new TypeError('A single quote response can bind only one requested recipient.')
    }
    const quote = safeResponseRecord(payload.quote, 'Message Box quote payload')
    const deliveryFee = messageFee(quote.deliveryFee, 'Quote deliveryFee')
    const recipientFee = messageFee(quote.recipientFee, 'Quote recipientFee', true)
    const status = this.statusForRecipientFee(recipientFee)

    for (const recipient of groupRecipients) {
      accumulator.quotesByRecipient.push({
        recipient,
        messageBox,
        deliveryFee,
        recipientFee,
        status
      })
      accumulator.deliveryFees += deliveryFee
      if (!Number.isSafeInteger(accumulator.deliveryFees)) {
        throw new TypeError('Quote delivery-fee total exceeds the safe integer range.')
      }
      this.addRecipientFee(recipient, recipientFee, accumulator)
    }
  }

  private addRecipientFee(
    recipient: PubKeyHex,
    recipientFee: number,
    accumulator: MessageBoxMultiQuoteAccumulator
  ): void {
    if (recipientFee === -1) {
      accumulator.blockedRecipients.add(recipient)
      return
    }

    accumulator.recipientFees = checkedFeeSum(
      [accumulator.recipientFees, recipientFee],
      'Quote recipient-fee total'
    )
  }

  private statusForRecipientFee(recipientFee: number): MessageBoxQuoteStatus {
    if (recipientFee === -1) return 'blocked'
    return recipientFee === 0 ? 'always_allow' : 'payment_required'
  }

  /**
   * @method listMessageBoxPermissions
   * @async
   * @param {ListPermissionsParams} [params] - Optional filtering and pagination parameters
   * @returns {Promise<MessageBoxPermission[]>} List of current permissions
   *
   * @description
   * Lists permissions for the authenticated user's messageBoxes with optional pagination.
   *
   * @example
   * // List all permissions
   * const all = await client.listMessageBoxPermissions()
   *
   * // List only notification permissions with pagination
   * const notifications = await client.listMessageBoxPermissions({
   *   messageBox: 'notifications',
   *   limit: 50,
   *   offset: 0
   * })
   */
  async listMessageBoxPermissions(
    params?: ListPermissionsParams,
    overrideHost?: string
  ): Promise<MessageBoxPermission[]> {
    const finalHost = normalizeMessageBoxHost(overrideHost ?? this.host)
    const queryParams = new URLSearchParams()

    if (params?.messageBox != null) {
      queryParams.set(
        'messageBox',
        exactBoundedText(params.messageBox, 'Message box', MAX_MESSAGE_BOX_BYTES, {
          forbidControls: true
        })
      )
    }
    if (params?.limit !== undefined) {
      if (!Number.isSafeInteger(params.limit) || params.limit < 1) {
        throw new RangeError('limit must be a positive safe integer.')
      }
      queryParams.set('limit', params.limit.toString())
    }
    if (params?.offset !== undefined) {
      if (!Number.isSafeInteger(params.offset) || params.offset < 0) {
        throw new RangeError('offset must be a non-negative safe integer.')
      }
      queryParams.set('offset', params.offset.toString())
    }

    Logger.log('[MB CLIENT] Listing Message Box permissions')

    const response = await this.authenticatedFetch(
      `${messageBoxEndpoint(finalHost, '/permissions/list')}?${queryParams.toString()}`,
      {
        method: 'GET'
      }
    )

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      throw new Error(
        `Failed to list permissions: HTTP ${response.status} - ${String(errorData.description) !== '' ? String(errorData.description) : response.statusText}`
      )
    }

    const data = safeResponseRecord(await response.json(), 'Permission-list response')
    if (data.status === 'error') {
      throw new Error(
        typeof data.description === 'string' ? data.description : 'Failed to list permissions'
      )
    }
    if (data.status !== 'success')
      throw new TypeError('Permission-list response status is invalid.')

    if (!Array.isArray(data.permissions)) {
      throw new TypeError(
        'Failed to list permissions: server returned an invalid permissions payload'
      )
    }

    return data.permissions.map(validatePermissionRecord)
  }

  // ===========================
  // NOTIFICATION CONVENIENCE METHODS
  // ===========================

  /**
   * @method allowNotificationsFromPeer
   * @async
   * @param {PubKeyHex} identityKey - Sender's identity key to allow
   * @param {number} [recipientFee=0] - Fee to charge (0 for always allow)
   * @param {string} [overrideHost] - Optional host override
   * @returns {Promise<void>} Permission status after allowing
   *
   * @description
   * Convenience method to allow notifications from a specific peer.
   *
   * @example
   * await client.allowNotificationsFromPeer('03abc123...') // Always allow
   * await client.allowNotificationsFromPeer('03def456...', 5) // Allow for 5 sats
   */
  async allowNotificationsFromPeer(
    identityKey: PubKeyHex,
    recipientFee: number = 0,
    overrideHost?: string
  ): Promise<void> {
    await this.setMessageBoxPermission(
      {
        messageBox: 'notifications',
        sender: identityKey,
        recipientFee
      },
      overrideHost
    )
  }

  /**
   * @method denyNotificationsFromPeer
   * @async
   * @param {PubKeyHex} identityKey - Sender's identity key to block
   * @returns {Promise<void>} Permission status after denying
   *
   * @description
   * Convenience method to block notifications from a specific peer.
   *
   * @example
   * await client.denyNotificationsFromPeer('03spam123...')
   */
  async denyNotificationsFromPeer(identityKey: PubKeyHex, overrideHost?: string): Promise<void> {
    await this.setMessageBoxPermission(
      {
        messageBox: 'notifications',
        sender: identityKey,
        recipientFee: -1
      },
      overrideHost
    )
  }

  /**
   * @method checkPeerNotificationStatus
   * @async
   * @param {PubKeyHex} identityKey - Sender's identity key to check
   * @returns {Promise<MessageBoxPermission>} Current permission status
   *
   * @description
   * Convenience method to check notification permission for a specific peer.
   *
   * @example
   * const status = await client.checkPeerNotificationStatus('03abc123...')
   * console.log(status.allowed) // true/false
   */
  async checkPeerNotificationStatus(
    identityKey: PubKeyHex,
    overrideHost?: string
  ): Promise<MessageBoxPermission | null> {
    const myIdentityKey = await this.getIdentityKey()
    return await this.getMessageBoxPermission(
      {
        recipient: myIdentityKey,
        messageBox: 'notifications',
        sender: identityKey
      },
      overrideHost
    )
  }

  /**
   * @method listPeerNotifications
   * @async
   * @returns {Promise<MessageBoxPermission[]>} List of notification permissions
   *
   * @description
   * Convenience method to list all notification permissions.
   *
   * @example
   * const notifications = await client.listPeerNotifications()
   */
  async listPeerNotifications(overrideHost?: string): Promise<MessageBoxPermission[]> {
    return await this.listMessageBoxPermissions({ messageBox: 'notifications' }, overrideHost)
  }

  /**
   * @method sendNotification
   * @async
   * @param {PubKeyHex} recipient - Recipient's identity key
   * @param {string | object} body - Notification content
   * @param {string} [overrideHost] - Optional host override
   * @returns {Promise<SendMessageResponse>} Send result
   *
   * @description
   * Convenience method to send a notification with automatic quote fetching and payment handling.
   * Automatically determines the required payment amount and creates the payment if needed.
   *
   * @example
   * // Send notification (auto-determines payment needed)
   * await client.sendNotification('03def456...', 'Hello!')
   *
   * // Send with maximum payment limit for safety
   * await client.sendNotification('03def456...', { title: 'Alert', body: 'Important update' }, 50)
   */
  async sendNotification(
    recipient: PubKeyHex | PubKeyHex[],
    body: string | object,
    overrideHost?: string
  ): Promise<SendMessageResponse | SendListResult> {
    await this.assertInitialized()

    // Single recipient → keep original flow
    if (!Array.isArray(recipient)) {
      return await this.sendMessage(
        {
          recipient,
          messageBox: 'notifications',
          body,
          checkPermissions: true
        },
        overrideHost
      )
    }

    // Shared batch payloads cannot be encrypted to multiple counterparties.
    // Preserve encryption-by-default by sending bounded individual requests.
    const outcomes = await this.mapWithConcurrency(recipient, 8, async target => {
      try {
        const response = await this.sendMessage(
          {
            recipient: target,
            messageBox: 'notifications',
            body,
            checkPermissions: true
          },
          overrideHost
        )
        return { recipient: target, messageId: response.messageId }
      } catch (error) {
        return {
          recipient: target,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    })
    const sent = outcomes.filter(
      (outcome): outcome is { recipient: PubKeyHex; messageId: string } => 'messageId' in outcome
    )
    const failed = outcomes.filter(
      (outcome): outcome is { recipient: PubKeyHex; error: string } => 'error' in outcome
    )
    let status: SendListResult['status'] = 'error'
    if (sent.length === recipient.length) {
      status = 'success'
    } else if (sent.length > 0) {
      status = 'partial'
    }

    return {
      status,
      description: `Sent ${sent.length} of ${recipient.length} encrypted notifications.`,
      sent,
      blocked: [],
      failed
    }
  }

  /**
   * Register a device for FCM push notifications.
   *
   * @async
   * @param {DeviceRegistrationParams} params - Device registration parameters
   * @param {string} [overrideHost] - Optional host override
   * @returns {Promise<DeviceRegistrationResponse>} Registration response
   *
   * @description
   * Registers a device with the message box server to receive FCM push notifications.
   * The FCM token is obtained from Firebase SDK on the client side.
   *
   * @example
   * const result = await client.registerDevice({
   *   fcmToken: 'eBo8F...',
   *   platform: 'ios',
   *   deviceId: 'iPhone15Pro'
   * })
   */
  async registerDevice(
    params: DeviceRegistrationParams,
    overrideHost?: string
  ): Promise<DeviceRegistrationResponse> {
    if (typeof params.fcmToken !== 'string' || params.fcmToken.trim() === '') {
      throw new Error('fcmToken is required and must be a non-empty string')
    }
    if (utf8Length(params.fcmToken) > 500) {
      throw new Error('fcmToken must not exceed 500 UTF-8 bytes')
    }
    if (params.deviceId != null && utf8Length(params.deviceId) > 255) {
      throw new Error('deviceId must not exceed 255 UTF-8 bytes')
    }
    const fcmToken = exactBoundedText(params.fcmToken, 'fcmToken', 500, {
      forbidControls: true
    })
    const deviceId =
      params.deviceId == null
        ? undefined
        : exactBoundedText(params.deviceId, 'deviceId', 255, { forbidControls: true })

    // Validate platform if provided
    const validPlatforms = ['ios', 'android', 'web']
    if (params.platform != null && !validPlatforms.includes(params.platform)) {
      throw new Error('platform must be one of: ios, android, web')
    }

    const finalHost = normalizeMessageBoxHost(overrideHost ?? this.host)

    Logger.log('[MB CLIENT] Registering device for FCM notifications...')

    const response = await this.authenticatedFetch(
      messageBoxEndpoint(finalHost, '/registerDevice'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: stringifyBRC100({
          fcmToken,
          deviceId,
          platform: params.platform ?? undefined
        })
      }
    )

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      const description =
        typeof errorData.description === 'string' ? errorData.description : response.statusText
      throw new Error(`Failed to register device: HTTP ${response.status} - ${description}`)
    }

    const data = safeResponseRecord(await response.json(), 'Device-registration response')
    if (data.status === 'error') {
      throw new Error(
        typeof data.description === 'string' ? data.description : 'Failed to register device'
      )
    }
    if (
      data.status !== 'success' ||
      typeof data.message !== 'string' ||
      !Number.isSafeInteger(data.deviceId) ||
      (data.deviceId as number) < 1
    ) {
      throw new TypeError('Device-registration response is invalid.')
    }

    Logger.log('[MB CLIENT] Device registered successfully')
    return {
      status: 'success',
      message: data.message,
      deviceId: data.deviceId as number
    }
  }

  /**
   * List one bounded page of registered devices for push notifications.
   *
   * @async
   * @param {string} [overrideHost] - Optional host override
   * @returns {Promise<RegisteredDevice[]>} Array of registered devices
   *
   * @description
   * Retrieves a bounded page of devices registered by the authenticated user for FCM push
   * notifications.
   * Only shows devices belonging to the current user (authenticated via AuthFetch).
   *
   * @example
   * const devices = await client.listRegisteredDevices()
   * console.log(`Found ${devices.length} registered devices`)
   * devices.forEach(device => {
   *   console.log(`Device: ${device.platform} - ${device.fcmToken}`)
   * })
   */
  async listRegisteredDevices(
    overrideHost?: string,
    pagination: { limit?: number; offset?: number } = {}
  ): Promise<RegisteredDevice[]> {
    if (
      pagination.limit != null &&
      (!Number.isSafeInteger(pagination.limit) || pagination.limit < 1)
    ) {
      throw new RangeError('limit must be a positive safe integer.')
    }
    if (
      pagination.offset != null &&
      (!Number.isSafeInteger(pagination.offset) || pagination.offset < 0)
    ) {
      throw new RangeError('offset must be a non-negative safe integer.')
    }
    const finalHost = normalizeMessageBoxHost(overrideHost ?? this.host)
    const query = new URLSearchParams()
    if (pagination.limit != null) query.set('limit', String(pagination.limit))
    if (pagination.offset != null) query.set('offset', String(pagination.offset))
    const suffix = query.size > 0 ? `?${query.toString()}` : ''

    Logger.log('[MB CLIENT] Listing registered devices...')

    const response = await this.authenticatedFetch(
      `${messageBoxEndpoint(finalHost, '/devices')}${suffix}`,
      { method: 'GET' }
    )

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      const description =
        typeof errorData.description === 'string' ? errorData.description : response.statusText
      throw new Error(`Failed to list devices: HTTP ${response.status} - ${description}`)
    }

    const data = safeResponseRecord(await response.json(), 'Device-list response')
    if (data.status === 'error') {
      throw new Error(
        typeof data.description === 'string' ? data.description : 'Failed to list devices'
      )
    }
    if (data.status !== 'success' || !Array.isArray(data.devices)) {
      throw new TypeError('Device-list response is invalid.')
    }

    Logger.log('[MB CLIENT] Registered devices listed')
    return data.devices.map(validateRegisteredDevice)
  }

  // ===========================
  // PRIVATE HELPER METHODS
  // ===========================

  /**
   * @method createMessagePayment
   * @private
   * @param {string} recipient - Recipient's identity key.
   * @param {MessageBoxQuote} quote - Quote object containing recipient and delivery fees.
   * @param {string} [description='MessageBox delivery payment'] - Description for the payment action.
   * @param {string} [originator] - Optional originator to use for wallet operations.
   * @returns {Promise<Payment>} - Payment data including the transaction and remittance outputs.
   *
   * @description
   * Constructs and signs a payment transaction covering both delivery and recipient fees for
   * message delivery, based on a previously obtained quote.
   *
   * The transaction includes:
   * - An optional delivery fee output for the MessageBox server.
   * - An optional recipient fee output for the message recipient.
   *
   * Payment remittance metadata (derivation prefix/suffix, sender identity) is embedded to allow
   * the payee to derive their private key and spend the output.
   *
   * @throws {Error} If no payment is required, key derivation fails, or the action creation fails.
   *
   * @example
   * const payment = await client.createMessagePayment(recipientKey, quote)
   * await client.sendMessage({ recipient, messageBox, body, payment })
   */
  private async createMessagePayment(recipient: string, quote: MessageBoxQuote): Promise<Payment> {
    recipient = canonicalIdentityKey(recipient, 'Payment recipient')
    quote = validateSingleQuoteResult(quote)
    const description = 'MessageBox delivery payment'
    if (quote.recipientFee <= 0 && quote.deliveryFee <= 0) {
      throw new Error('No payment required')
    }

    Logger.log('[MB CLIENT] Creating a Message Box payment transaction')

    const outputs: InternalizeOutput[] = []
    const createActionOutputs: CreateActionOutput[] = []

    // Get sender identity key for remittance data
    const senderIdentityKey = await this.getIdentityKey()

    // Add server delivery fee output if > 0
    let outputIndex = 0
    if (quote.deliveryFee > 0) {
      const derivationPrefix = toBase64(Random(32))
      const derivationSuffix = toBase64(Random(32))

      // Get host's derived public key
      const keyRequest: Parameters<WalletInterface['getPublicKey']>[0] = {
        protocolID: [2, '3241645161d8'],
        keyID: `${derivationPrefix} ${derivationSuffix}`,
        counterparty: quote.deliveryAgentIdentityKey
      }
      const derivedKeyResult = canonicalIdentityKey(
        validateWalletResult(
          'getPublicKey',
          await this.walletClient.getPublicKey(keyRequest, this.originator),
          keyRequest
        ).publicKey,
        'Wallet-derived delivery-agent payment key'
      )

      // Create locking script using host's public key
      const lockingScript = new P2PKH()
        .lock(PublicKey.fromString(derivedKeyResult).toAddress())
        .toHex()

      // Add to createAction outputs
      createActionOutputs.push({
        satoshis: quote.deliveryFee,
        lockingScript,
        outputDescription: 'MessageBox server delivery fee',
        customInstructions: stringifyBRC100({
          derivationPrefix,
          derivationSuffix,
          recipientIdentityKey: quote.deliveryAgentIdentityKey
        })
      })

      outputs.push({
        outputIndex: outputIndex++,
        protocol: 'wallet payment',
        paymentRemittance: {
          derivationPrefix,
          derivationSuffix,
          senderIdentityKey
        }
      })
    }

    // Add recipient fee output if > 0
    if (quote.recipientFee > 0) {
      const derivationPrefix = toBase64(Random(32))
      const derivationSuffix = toBase64(Random(32))
      // Get a derived public key for the recipient that "anyone" can verify
      const anyoneWallet = new ProtoWallet('anyone')
      const recipientKeyRequest: Parameters<WalletInterface['getPublicKey']>[0] = {
        protocolID: [2, '3241645161d8'],
        keyID: `${derivationPrefix} ${derivationSuffix}`,
        counterparty: recipient
      }
      const derivedKeyResult = canonicalIdentityKey(
        validateWalletResult(
          'getPublicKey',
          await anyoneWallet.getPublicKey(recipientKeyRequest),
          recipientKeyRequest
        ).publicKey,
        'Derived recipient payment key'
      )

      // Create locking script using recipient's public key
      const lockingScript = new P2PKH()
        .lock(PublicKey.fromString(derivedKeyResult).toAddress())
        .toHex()

      // Add to createAction outputs
      createActionOutputs.push({
        satoshis: quote.recipientFee,
        lockingScript,
        outputDescription: 'Recipient message fee',
        customInstructions: stringifyBRC100({
          derivationPrefix,
          derivationSuffix,
          recipientIdentityKey: recipient
        })
      })

      outputs.push({
        outputIndex: outputIndex++,
        protocol: 'wallet payment',
        paymentRemittance: {
          derivationPrefix,
          derivationSuffix,
          senderIdentityKey: canonicalIdentityKey(
            validateWalletResult(
              'getPublicKey',
              await anyoneWallet.getPublicKey({ identityKey: true }),
              { identityKey: true }
            ).publicKey,
            'Anyone-wallet identity key'
          )
        }
      })
    }

    const portableTx = await this.createBoundPaymentAction(
      {
        description,
        outputs: createActionOutputs,
        options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
      },
      createActionOutputs
    )

    return {
      tx: portableTx,
      outputs,
      description
      // labels
    }
  }

  private async createMessagePaymentBatch(
    recipients: string[],
    perRecipientQuotes: Map<string, { recipientFee: number; deliveryFee: number }>,
    // server (delivery agent) identity key to pay the delivery fee to
    serverIdentityKey: string
  ): Promise<Payment | undefined> {
    if (recipients.length === 0 || recipients.length > MAX_MESSAGE_RECIPIENTS) {
      throw new TypeError('Batch payment recipients must contain 1–100 entries.')
    }
    recipients = recipients.map((recipient, index) =>
      canonicalIdentityKey(recipient, `Batch payment recipient ${index}`)
    )
    if (new Set(recipients).size !== recipients.length) {
      throw new TypeError('Batch payment recipients must be unique.')
    }
    serverIdentityKey = canonicalIdentityKey(serverIdentityKey, 'Delivery-agent identity')
    const description = 'MessageBox delivery payment (batch)'
    const outputs: InternalizeOutput[] = []
    const createActionOutputs: CreateActionOutput[] = []

    // Every stored recipient delivery incurs the quoted server fee. The wire
    // still uses one server output, carrying the checked aggregate.
    const deliveryFeePerRecipient =
      recipients.reduce<number | undefined>((acc, r) => {
        const q = perRecipientQuotes.get(r)
        if (q == null) throw new TypeError(`Missing payment quote for recipient ${r}.`)
        const deliveryFee = messageFee(q.deliveryFee, 'Batch quote deliveryFee')
        messageFee(q.recipientFee, 'Batch quote recipientFee')
        if (acc !== undefined && acc !== deliveryFee) {
          throw new TypeError('All recipients in a batch must have one consistent delivery fee.')
        }
        return acc ?? deliveryFee
      }, undefined) ?? 0
    const totalDeliveryFee = checkedFeeSum(
      recipients.map(() => deliveryFeePerRecipient),
      'Batch server delivery fee'
    )

    const senderIdentityKey = await this.getIdentityKey()
    let outputIndex = 0

    // index 0: server delivery fee (if any)
    if (totalDeliveryFee > 0) {
      const derivationPrefix = toBase64(Random(32))
      const derivationSuffix = toBase64(Random(32))

      const keyRequest: Parameters<WalletInterface['getPublicKey']>[0] = {
        protocolID: [2, '3241645161d8'],
        keyID: `${derivationPrefix} ${derivationSuffix}`,
        counterparty: serverIdentityKey
      }
      const agentDerived = canonicalIdentityKey(
        validateWalletResult(
          'getPublicKey',
          await this.walletClient.getPublicKey(keyRequest, this.originator),
          keyRequest
        ).publicKey,
        'Wallet-derived delivery-agent payment key'
      )

      const lockingScript = new P2PKH().lock(PublicKey.fromString(agentDerived).toAddress()).toHex()

      createActionOutputs.push({
        satoshis: totalDeliveryFee,
        lockingScript,
        outputDescription: 'MessageBox server delivery fee (batch)',
        customInstructions: stringifyBRC100({
          derivationPrefix,
          derivationSuffix,
          recipientIdentityKey: serverIdentityKey
        })
      })

      outputs.push({
        outputIndex: outputIndex++,
        protocol: 'wallet payment',
        paymentRemittance: { derivationPrefix, derivationSuffix, senderIdentityKey }
      })
    }

    // recipient outputs start at index 1 (or 0 if no delivery fee)
    const anyoneWallet = new ProtoWallet('anyone')
    const anyoneIdKey = canonicalIdentityKey(
      validateWalletResult('getPublicKey', await anyoneWallet.getPublicKey({ identityKey: true }), {
        identityKey: true
      }).publicKey,
      'Anyone-wallet identity key'
    )

    for (const r of recipients) {
      const q = perRecipientQuotes.get(r)
      if (q == null || q.recipientFee <= 0) continue

      const derivationPrefix = toBase64(Random(32))
      const derivationSuffix = toBase64(Random(32))

      const recipientKeyRequest: Parameters<WalletInterface['getPublicKey']>[0] = {
        protocolID: [2, '3241645161d8'],
        keyID: `${derivationPrefix} ${derivationSuffix}`,
        counterparty: r
      }
      const recipientDerived = canonicalIdentityKey(
        validateWalletResult(
          'getPublicKey',
          await anyoneWallet.getPublicKey(recipientKeyRequest),
          recipientKeyRequest
        ).publicKey,
        'Derived recipient payment key'
      )

      const lockingScript = new P2PKH()
        .lock(PublicKey.fromString(recipientDerived).toAddress())
        .toHex()

      createActionOutputs.push({
        satoshis: q.recipientFee,
        lockingScript,
        outputDescription: `Recipient message fee (${r.slice(0, 8)}…)`,
        customInstructions: stringifyBRC100({
          derivationPrefix,
          derivationSuffix,
          recipientIdentityKey: r
        })
      })

      outputs.push({
        outputIndex: outputIndex++,
        protocol: 'wallet payment',
        paymentRemittance: {
          derivationPrefix,
          derivationSuffix,
          senderIdentityKey: anyoneIdKey
        }
      })
    }

    if (createActionOutputs.length === 0) return undefined

    const portableTx = await this.createBoundPaymentAction(
      {
        description,
        outputs: createActionOutputs,
        options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
      },
      createActionOutputs
    )

    return { tx: portableTx, outputs, description }
  }

  /** Require wallet evidence that preserves every payment output at its remittance index. */
  private async createBoundPaymentAction(
    request: Parameters<WalletInterface['createAction']>[0],
    expectedOutputs: readonly CreateActionOutput[]
  ): Promise<number[]> {
    const bindingRequest = snapshotWalletResultRequest('createAction', request)
    const result = validateWalletResult(
      'createAction',
      await this.walletClient.createAction(request, this.originator),
      bindingRequest
    )
    const portableTx = boundedByteArray(
      result.tx,
      'Payment transaction Atomic BEEF',
      MAX_PAYMENT_BEEF_BYTES
    )
    let transaction: Transaction
    try {
      transaction = Transaction.fromAtomicBEEF(portableTx)
    } catch {
      throw new TypeError('Payment transaction must be valid Atomic BEEF.')
    }
    if (transaction.outputs.length < expectedOutputs.length) {
      throw new TypeError('Payment transaction omitted a requested output.')
    }
    expectedOutputs.forEach((expected, index) => {
      const actual = transaction.outputs[index]
      if (
        actual?.satoshis !== expected.satoshis ||
        actual.lockingScript.toHex().toLowerCase() !== expected.lockingScript.toLowerCase()
      ) {
        throw new TypeError('Payment transaction reordered or changed a requested output.')
      }
    })
    return portableTx
  }
}
