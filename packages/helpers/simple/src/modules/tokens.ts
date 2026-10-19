import {
  PushDrop,
  SecurityLevel,
  Random,
  LockingScript,
  Transaction,
  Beef,
  completeBoundAction,
  normalizeBRC100ByteArray,
  PublicKey,
  validateWalletArgs,
  stringifyBRC100,
  validateWalletResult,
  snapshotWalletResultRequest,
  type WalletInterface,
  type WalletOutput
} from '@bsv/sdk'
import { toArray, toBase64 } from '@bsv/sdk/primitives/utils'
import {
  parseWalletOutpoint,
  validateSatoshis,
  validateStringLength
} from '@bsv/sdk/wallet/validationHelpers'
import { PeerPayClient } from '@bsv/message-box-client'
import { WalletCore } from '../core/WalletCore'
import {
  TokenOptions,
  TokenResult,
  TokenDetail,
  SendTokenOptions,
  RedeemTokenOptions,
  TransactionResult
} from '../core/types'

const TOKEN_MESSAGE_BOX = 'simple_token_inbox'
const MAX_INCOMING_TOKENS = 1_000
const MAX_TOKEN_TRANSACTION_BYTES = 64 * 1024 * 1024
const MAX_TOKEN_DATA_BYTES = 1024 * 1024
const MAX_TOKEN_OUTPUTS = 10_000
const TOKEN_OUTPUT_PAGE_SIZE = 1_000
const MAX_TOKEN_FIELDS = 256

type PlainRecord = Record<string, unknown>

function dataRecord(value: unknown): PlainRecord | undefined {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return undefined
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    const result = Object.create(null) as PlainRecord
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (typeof key !== 'string' || descriptor == null || !('value' in descriptor))
        return undefined
      result[key] = descriptor.value
    }
    return result
  } catch {
    return undefined
  }
}

function tokenOptions(value: unknown): PlainRecord {
  const options = dataRecord(value)
  if (options == null) throw new TypeError('Token options must be an object')
  return options
}

function tokenBasket(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Token basket is invalid')
  return validateStringLength(value, 'basket', 1, 300)
}

function tokenProtocol(value: unknown): [SecurityLevel, string] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      throw new TypeError('invalid protocol')
    }
    const keys = Reflect.ownKeys(value)
    if (
      keys.length !== 3 ||
      !keys.includes('0') ||
      !keys.includes('1') ||
      !keys.includes('length')
    ) {
      throw new TypeError('invalid protocol')
    }
    const levelDescriptor = Object.getOwnPropertyDescriptor(value, '0')
    const nameDescriptor = Object.getOwnPropertyDescriptor(value, '1')
    if (
      levelDescriptor == null ||
      !('value' in levelDescriptor) ||
      nameDescriptor == null ||
      !('value' in nameDescriptor) ||
      ![0, 1, 2].includes(levelDescriptor.value) ||
      typeof nameDescriptor.value !== 'string'
    ) {
      throw new TypeError('invalid protocol')
    }
    const name = validateStringLength(nameDescriptor.value, 'protocol name', 5, 400)
    return [levelDescriptor.value as SecurityLevel, name]
  } catch {
    throw new TypeError('Token protocol ID is invalid')
  }
}

function canonicalIdentityKey(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:02|03)[0-9a-f]{64}$/.test(value)) {
    throw new TypeError('Incoming token sender is invalid')
  }
  try {
    if (PublicKey.fromString(value).toString() !== value) {
      throw new TypeError('Incoming token sender is invalid')
    }
  } catch {
    throw new TypeError('Incoming token sender is invalid')
  }
  return value
}

function canonicalRecipient(value: unknown): string {
  try {
    return canonicalIdentityKey(value)
  } catch {
    throw new TypeError('Token recipient is invalid')
  }
}

function boundedString(value: unknown, name: string, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    new TextEncoder().encode(value).byteLength > maximum
  ) {
    throw new TypeError(`Incoming token ${name} is invalid`)
  }
  return value
}

function normalizeIncomingToken(value: unknown): {
  messageId: string
  sender: string
  transaction: number[]
  protocolID: [SecurityLevel, string]
  keyID: string
  outputIndex: number
  createdAt?: string
} {
  const token = dataRecord(value)
  if (token == null) throw new TypeError('Incoming token is invalid')
  const messageId = boundedString(token.messageId, 'message ID', 1_024)
  const sender = canonicalIdentityKey(token.sender)
  const transaction = normalizeBRC100ByteArray(token.transaction)
  if (
    transaction == null ||
    transaction.length === 0 ||
    transaction.length > MAX_TOKEN_TRANSACTION_BYTES
  ) {
    throw new TypeError('Incoming token transaction is invalid')
  }
  const outputIndex = token.outputIndex ?? 0
  if (
    typeof outputIndex !== 'number' ||
    !Number.isSafeInteger(outputIndex) ||
    outputIndex < 0 ||
    outputIndex > 0xffffffff
  ) {
    throw new TypeError('Incoming token output index is invalid')
  }
  const protocolID = tokenProtocol(token.protocolID)
  validateWalletArgs('decrypt', {
    ciphertext: [0],
    protocolID,
    keyID: token.keyID,
    counterparty: sender
  })
  const keyID = token.keyID as string
  const createdAt =
    token.createdAt == null ? undefined : boundedString(token.createdAt, 'timestamp', 64)
  return {
    messageId,
    sender,
    transaction: Array.from(transaction),
    protocolID: [protocolID[0], protocolID[1]],
    keyID,
    outputIndex,
    ...(createdAt == null ? {} : { createdAt })
  }
}

function tokenFromPeerMessage(value: unknown): ReturnType<typeof normalizeIncomingToken> | null {
  const message = dataRecord(value)
  if (message == null) return null
  let body: unknown = message.body
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body)
    } catch {
      return null
    }
  }
  const bodyRecord = dataRecord(body)
  if (bodyRecord == null || (bodyRecord.sender != null && bodyRecord.sender !== message.sender)) {
    return null
  }
  try {
    return normalizeIncomingToken({
      messageId: message.messageId,
      sender: message.sender,
      transaction: bodyRecord.transaction,
      protocolID: bodyRecord.protocolID,
      keyID: bodyRecord.keyID,
      outputIndex: bodyRecord.outputIndex ?? 0,
      createdAt: message.created_at
    })
  } catch {
    return null
  }
}

async function listBoundedTokenMessages(
  peerPay: PeerPayClient
): Promise<ReturnType<typeof normalizeIncomingToken>[]> {
  const messages = await peerPay.listMessages({
    messageBox: TOKEN_MESSAGE_BOX,
    limit: MAX_INCOMING_TOKENS,
    pageSize: 100,
    maxPages: 10
  })
  if (!Array.isArray(messages) || messages.length > MAX_INCOMING_TOKENS) {
    throw new Error('Incoming token collection exceeds the configured limit')
  }
  return messages.flatMap(message => {
    const token = tokenFromPeerMessage(message)
    return token == null ? [] : [token]
  })
}

function parseTokenData(plaintext: number[]): any {
  const text = new TextDecoder().decode(new Uint8Array(plaintext))
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function tokenInstructions(
  output: Pick<WalletOutput, 'customInstructions'>,
  defaults: {
    protocolID: [SecurityLevel, string]
    keyID: string
    counterparty: string
  }
): { protocolID: [SecurityLevel, string]; keyID: string; counterparty: string } {
  if (output.customInstructions == null) {
    validateWalletArgs('decrypt', { ciphertext: [0], ...defaults })
    return {
      protocolID: [...defaults.protocolID],
      keyID: defaults.keyID,
      counterparty: defaults.counterparty
    }
  }
  if (
    typeof output.customInstructions !== 'string' ||
    new TextEncoder().encode(output.customInstructions).byteLength > 4096
  ) {
    throw new TypeError('Token custom instructions are invalid')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(output.customInstructions)
  } catch {
    throw new TypeError('Token custom instructions are invalid')
  }
  const instructions = dataRecord(parsed)
  if (instructions == null) throw new TypeError('Token custom instructions are invalid')
  const protocolID = tokenProtocol(instructions.protocolID ?? defaults.protocolID)
  const keyID = (instructions.keyID ?? defaults.keyID) as string
  const counterparty = (instructions.counterparty ?? defaults.counterparty) as string
  validateWalletArgs('decrypt', { ciphertext: [0], protocolID, keyID, counterparty })
  return { protocolID: [protocolID[0], protocolID[1]], keyID, counterparty }
}

async function validatedListOutputs(
  client: WalletInterface,
  args: Parameters<WalletInterface['listOutputs']>[0]
): Promise<Awaited<ReturnType<WalletInterface['listOutputs']>> & { totalOutputs: number }> {
  validateWalletArgs('listOutputs', args)
  const bindingRequest = snapshotWalletResultRequest('listOutputs', args)
  const result = validateWalletResult('listOutputs', await client.listOutputs(args), bindingRequest)
  const { totalOutputs } = result
  if (typeof totalOutputs !== 'number') {
    throw new TypeError('Wallet returned a module balance where an output count was expected')
  }
  return { ...result, totalOutputs }
}

async function validatedCreateAction(
  client: WalletInterface,
  args: Parameters<WalletInterface['createAction']>[0]
): Promise<Awaited<ReturnType<WalletInterface['createAction']>>> {
  validateWalletArgs('createAction', args)
  const bindingRequest = snapshotWalletResultRequest('createAction', args)
  return validateWalletResult('createAction', await client.createAction(args), bindingRequest)
}

interface OwnedTokenOutput {
  output: WalletOutput
  beef?: number[]
}

async function listTokenOutputs(
  client: WalletInterface,
  basket: string,
  include: 'locking scripts' | 'entire transactions'
): Promise<OwnedTokenOutput[]> {
  const entries: OwnedTokenOutput[] = []
  const seen = new Set<string>()
  let expectedTotal: number | undefined
  let offset = 0

  while (expectedTotal === undefined || offset < expectedTotal) {
    const result = await validatedListOutputs(client, {
      basket,
      include,
      includeCustomInstructions: true,
      limit: TOKEN_OUTPUT_PAGE_SIZE,
      offset
    })
    if (expectedTotal === undefined) {
      expectedTotal = result.totalOutputs
      if (expectedTotal > MAX_TOKEN_OUTPUTS) {
        throw new Error(`Token basket exceeds the ${MAX_TOKEN_OUTPUTS}-output safety limit`)
      }
    } else if (result.totalOutputs !== expectedTotal) {
      throw new Error('Token basket changed while it was being read')
    }
    if (result.outputs.length === 0 && offset < expectedTotal) {
      throw new Error('Wallet returned an incomplete token page')
    }
    if (offset + result.outputs.length > expectedTotal) {
      throw new Error('Wallet returned more token outputs than declared')
    }

    const beef = result.BEEF == null ? undefined : Array.from(result.BEEF)
    for (const output of result.outputs) {
      const outpoint = output.outpoint.toLowerCase()
      if (seen.has(outpoint)) throw new Error('Wallet returned a duplicate token output')
      seen.add(outpoint)
      entries.push({
        output: {
          outpoint: output.outpoint,
          satoshis: output.satoshis,
          spendable: output.spendable,
          ...(output.lockingScript == null ? {} : { lockingScript: output.lockingScript }),
          ...(output.customInstructions == null
            ? {}
            : { customInstructions: output.customInstructions }),
          ...(output.tags == null ? {} : { tags: [...output.tags] }),
          ...(output.labels == null ? {} : { labels: [...output.labels] })
        },
        ...(beef == null ? {} : { beef })
      })
    }
    offset += result.outputs.length
  }
  return entries
}

function tokenDataString(data: unknown): string {
  if (data === undefined) throw new TypeError('Token data is required')
  let serialized: string
  try {
    serialized = typeof data === 'string' ? data : stringifyBRC100(data)
  } catch {
    throw new TypeError('Token data must be JSON serializable')
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_TOKEN_DATA_BYTES) {
    throw new RangeError('Token data exceeds the 1 MiB safety limit')
  }
  return serialized
}

function tokenFields(decoded: ReturnType<typeof PushDrop.decode>): number[][] {
  if (decoded.fields.length === 0 || decoded.fields.length > MAX_TOKEN_FIELDS) {
    throw new TypeError('Token field count is invalid')
  }
  let totalBytes = 0
  return decoded.fields.map((field, index) => {
    const bytes = normalizeBRC100ByteArray(field)
    if (bytes == null || (index === 0 && bytes.length === 0)) {
      throw new TypeError('Token field bytes are invalid')
    }
    totalBytes += bytes.length
    if (totalBytes > MAX_TOKEN_DATA_BYTES) {
      throw new RangeError('Token fields exceed the 1 MiB safety limit')
    }
    return Array.from(bytes)
  })
}

function canonicalOutpoint(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Token outpoint is invalid')
  const parsed = parseWalletOutpoint(value)
  return `${parsed.txid.toLowerCase()}.${parsed.vout}`
}

async function decryptTokenData(
  client: WalletInterface,
  ciphertext: number[],
  protocolID: [SecurityLevel, string],
  keyID: string,
  counterparty: string
): Promise<any> {
  try {
    const args = {
      ciphertext,
      protocolID,
      keyID,
      counterparty
    }
    validateWalletArgs('decrypt', args)
    const result = validateWalletResult('decrypt', await client.decrypt(args), args)
    if (result.plaintext.length > MAX_TOKEN_DATA_BYTES) {
      throw new RangeError('Decrypted token data exceeds the 1 MiB safety limit')
    }
    return parseTokenData(Array.from(result.plaintext))
  } catch {
    if (counterparty !== 'self') return null
  }

  try {
    const args = {
      ciphertext,
      protocolID,
      keyID,
      counterparty: 'anyone'
    } as const
    validateWalletArgs('decrypt', args)
    const result = validateWalletResult('decrypt', await client.decrypt(args), args)
    if (result.plaintext.length > MAX_TOKEN_DATA_BYTES) {
      throw new RangeError('Decrypted token data exceeds the 1 MiB safety limit')
    }
    return parseTokenData(Array.from(result.plaintext))
  } catch {
    return null
  }
}

export function createTokenMethods(core: WalletCore): {
  createToken: (options: TokenOptions) => Promise<TokenResult>
  listTokenDetails: (basket?: string) => Promise<TokenDetail[]>
  sendToken: (options: SendTokenOptions) => Promise<TransactionResult>
  redeemToken: (options: RedeemTokenOptions) => Promise<TransactionResult>
  sendTokenViaMessageBox: (options: SendTokenOptions) => Promise<TransactionResult>
  listIncomingTokens: () => Promise<any[]>
  acceptIncomingToken: (token: any, basket?: string) => Promise<any>
} {
  return {
    async createToken(options: TokenOptions): Promise<TokenResult> {
      try {
        const ownedOptions = tokenOptions(options)
        const client = core.getClient()
        const basket = tokenBasket(ownedOptions.basket ?? core.defaults.tokenBasket)
        const protocolID = tokenProtocol(ownedOptions.protocolID ?? core.defaults.tokenProtocolID)
        const keyID = (ownedOptions.keyID ?? core.defaults.tokenKeyID) as string
        const satoshis = validateSatoshis((ownedOptions.satoshis ?? 1) as number, 'satoshis', 1)
        const localIdentity = canonicalRecipient(core.getIdentityKey())
        const recipient =
          ownedOptions.to == null ? localIdentity : canonicalRecipient(ownedOptions.to)
        const isSelf = recipient === localIdentity
        const counterparty = isSelf ? 'self' : recipient

        const dataString = tokenDataString(ownedOptions.data)

        const plaintext = Array.from(toArray(dataString, 'utf8'))
        const encryptArgs = {
          plaintext,
          protocolID,
          keyID,
          counterparty
        }
        validateWalletArgs('encrypt', encryptArgs)
        const encryptResult = validateWalletResult(
          'encrypt',
          await client.encrypt(encryptArgs),
          encryptArgs
        )

        const ciphertext = Array.from(encryptResult.ciphertext)

        const pushdrop = new PushDrop(client)
        const lockingScript = await pushdrop.lock(
          [ciphertext],
          protocolID,
          keyID,
          counterparty,
          isSelf,
          false
        )

        const result = await validatedCreateAction(client, {
          description: `Create token in ${basket} basket`,
          outputs: [
            {
              lockingScript: lockingScript.toHex(),
              satoshis,
              basket,
              customInstructions: stringifyBRC100({ protocolID, keyID, counterparty }),
              tags: ['token'],
              outputDescription: `Token (${basket})`
            }
          ],
          options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
        })

        return {
          txid: result.txid ?? '',
          tx: result.tx,
          basket,
          encrypted: true,
          outputs: [{ index: 0, satoshis, lockingScript: lockingScript.toHex() }]
        }
      } catch (error) {
        throw new Error(`Token creation failed: ${(error as Error).message}`)
      }
    },

    async listTokenDetails(basket?: string): Promise<TokenDetail[]> {
      const effectiveBasket = basket ?? core.defaults.tokenBasket
      const client = core.getClient()
      const entries = await listTokenOutputs(client, effectiveBasket, 'locking scripts')
      const details: TokenDetail[] = []

      const defaultProtocolID = [...core.defaults.tokenProtocolID] as [SecurityLevel, string]
      const defaultKeyID = core.defaults.tokenKeyID
      const defaultCounterparty = 'self'

      for (const { output } of entries) {
        try {
          const lockScript = LockingScript.fromHex(output.lockingScript as string)
          const decoded = PushDrop.decode(lockScript)
          const ciphertext = tokenFields(decoded)[0]
          const { protocolID, keyID, counterparty } = tokenInstructions(output, {
            protocolID: defaultProtocolID,
            keyID: defaultKeyID,
            counterparty: defaultCounterparty
          })

          const data = await decryptTokenData(client, ciphertext, protocolID, keyID, counterparty)

          details.push({
            outpoint: output.outpoint,
            satoshis: output.satoshis,
            data,
            protocolID,
            keyID,
            counterparty
          })
        } catch {
          // Skip non-PushDrop outputs
        }
      }

      return details
    },

    async sendToken(options: SendTokenOptions): Promise<TransactionResult> {
      try {
        const ownedOptions = tokenOptions(options)
        const client = core.getClient()
        const basket = tokenBasket(ownedOptions.basket)
        const outpoint = canonicalOutpoint(ownedOptions.outpoint)

        const defaultProtocolID: [number, string] = core.defaults.tokenProtocolID
        const defaultKeyID = core.defaults.tokenKeyID
        const defaultCounterparty = 'self'

        const recipient = canonicalRecipient(ownedOptions.to)
        const entries = await listTokenOutputs(client, basket, 'entire transactions')
        const matches = entries.filter(entry => entry.output.outpoint.toLowerCase() === outpoint)
        if (matches.length !== 1) throw new Error(`Token not found exactly once: ${outpoint}`)
        const { output: targetOutput, beef: targetBeef } = matches[0]
        if (targetBeef == null) throw new Error('Wallet did not return token transaction evidence')
        if (!targetOutput.spendable) throw new Error('Selected token output is not spendable')

        const { protocolID, keyID, counterparty } = tokenInstructions(targetOutput, {
          protocolID: defaultProtocolID as [SecurityLevel, string],
          keyID: defaultKeyID,
          counterparty: defaultCounterparty
        })

        const beef = new Beef()
        beef.mergeBeef(targetBeef)

        const [txid, voutStr] = outpoint.split('.')
        const vout = Number(voutStr)
        const sourceTx = beef.findAtomicTransaction(txid) as Transaction
        const sourceScript = sourceTx.outputs[vout].lockingScript
        const decoded = PushDrop.decode(sourceScript)
        const fields = tokenFields(decoded)

        const newKeyID = toBase64(Random(8))
        const pushdrop = new PushDrop(client)
        const isSelfSend = recipient === canonicalRecipient(core.getIdentityKey())
        const newLockingScript = await pushdrop.lock(
          fields,
          protocolID as [SecurityLevel, string],
          newKeyID,
          isSelfSend ? 'self' : recipient,
          isSelfSend,
          false
        )

        const newCounterparty = isSelfSend ? 'self' : recipient

        const inputBEEF = beef.toBinary()
        const createArgs = {
          description: `Send token from ${basket}`,
          inputBEEF,
          inputs: [
            {
              outpoint,
              inputDescription: 'Token input',
              unlockingScriptLength: 73
            }
          ],
          outputs: [
            {
              satoshis: targetOutput.satoshis,
              lockingScript: newLockingScript.toHex(),
              outputDescription: 'Token for recipient',
              basket,
              customInstructions: stringifyBRC100({
                protocolID,
                keyID: newKeyID,
                counterparty: newCounterparty
              }),
              tags: ['token', 'sent']
            }
          ],
          options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
        } as any
        const signed = await completeBoundAction(client, createArgs, {
          inputSigners: {
            [outpoint]: async (transaction, inputIndex) =>
              await new PushDrop(client)
                .unlock(protocolID as [SecurityLevel, string], keyID, counterparty)
                .sign(transaction, inputIndex)
          }
        })

        return {
          txid: signed.id('hex'),
          tx: signed.toAtomicBEEF()
        }
      } catch (error) {
        throw new Error(`Token send failed: ${(error as Error).message}`)
      }
    },

    async redeemToken(options: RedeemTokenOptions): Promise<TransactionResult> {
      try {
        const ownedOptions = tokenOptions(options)
        const client = core.getClient()
        const basket = tokenBasket(ownedOptions.basket)
        const outpoint = canonicalOutpoint(ownedOptions.outpoint)

        const defaultProtocolID: [number, string] = core.defaults.tokenProtocolID
        const defaultKeyID = core.defaults.tokenKeyID
        const defaultCounterparty = 'self'

        const entries = await listTokenOutputs(client, basket, 'entire transactions')
        const matches = entries.filter(entry => entry.output.outpoint.toLowerCase() === outpoint)
        if (matches.length !== 1) throw new Error(`Token not found exactly once: ${outpoint}`)
        const { output: targetOutput, beef: targetBeef } = matches[0]
        if (targetBeef == null) throw new Error('Wallet did not return token transaction evidence')
        if (!targetOutput.spendable) throw new Error('Selected token output is not spendable')
        const { protocolID, keyID, counterparty } = tokenInstructions(targetOutput, {
          protocolID: defaultProtocolID as [SecurityLevel, string],
          keyID: defaultKeyID,
          counterparty: defaultCounterparty
        })

        const beef = new Beef()
        beef.mergeBeef(targetBeef)

        const inputBEEF = beef.toBinary()
        const createArgs = {
          description: `Redeem token from ${basket}`,
          inputBEEF,
          inputs: [
            {
              outpoint,
              inputDescription: 'Token to redeem',
              unlockingScriptLength: 73
            }
          ],
          outputs: [],
          options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
        } as any
        const signed = await completeBoundAction(client, createArgs, {
          inputSigners: {
            [outpoint]: async (transaction, inputIndex) =>
              await new PushDrop(client)
                .unlock(protocolID as [SecurityLevel, string], keyID, counterparty)
                .sign(transaction, inputIndex)
          }
        })

        return {
          txid: signed.id('hex'),
          tx: signed.toAtomicBEEF()
        }
      } catch (error) {
        throw new Error(`Token redeem failed: ${(error as Error).message}`)
      }
    },

    async sendTokenViaMessageBox(options: SendTokenOptions): Promise<TransactionResult> {
      try {
        const ownedOptions = tokenOptions(options)
        const client = core.getClient()
        const basket = tokenBasket(ownedOptions.basket)
        const outpoint = canonicalOutpoint(ownedOptions.outpoint)

        const defaultProtocolID: [number, string] = core.defaults.tokenProtocolID
        const defaultKeyID = core.defaults.tokenKeyID
        const defaultCounterparty = 'self'

        const recipient = canonicalRecipient(ownedOptions.to)
        const entries = await listTokenOutputs(client, basket, 'entire transactions')
        const matches = entries.filter(entry => entry.output.outpoint.toLowerCase() === outpoint)
        if (matches.length !== 1) throw new Error(`Token not found exactly once: ${outpoint}`)
        const { output: targetOutput, beef: targetBeef } = matches[0]
        if (targetBeef == null) throw new Error('Wallet did not return token transaction evidence')
        if (!targetOutput.spendable) throw new Error('Selected token output is not spendable')
        const { protocolID, keyID, counterparty } = tokenInstructions(targetOutput, {
          protocolID: defaultProtocolID as [SecurityLevel, string],
          keyID: defaultKeyID,
          counterparty: defaultCounterparty
        })

        const beef = new Beef()
        beef.mergeBeef(targetBeef)

        const [txid, voutStr] = outpoint.split('.')
        const vout = Number(voutStr)
        const sourceTx = beef.findAtomicTransaction(txid) as Transaction
        const sourceScript = sourceTx.outputs[vout].lockingScript
        const decoded = PushDrop.decode(sourceScript)
        const fields = tokenFields(decoded)

        const newKeyID = toBase64(Random(8))
        const pushdrop = new PushDrop(client)
        const newLockingScript = await pushdrop.lock(
          fields,
          protocolID as [SecurityLevel, string],
          newKeyID,
          recipient,
          false,
          false
        )

        const inputBEEF = beef.toBinary()
        const createArgs = {
          description: 'Send token via MessageBox',
          inputBEEF,
          inputs: [
            {
              outpoint,
              inputDescription: 'Token input',
              unlockingScriptLength: 73
            }
          ],
          outputs: [
            {
              satoshis: targetOutput.satoshis,
              lockingScript: newLockingScript.toHex(),
              outputDescription: 'Token for recipient'
            }
          ],
          options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
        } as any
        const signed = await completeBoundAction(client, createArgs, {
          inputSigners: {
            [outpoint]: async (transaction, inputIndex) =>
              await new PushDrop(client)
                .unlock(protocolID as [SecurityLevel, string], keyID, counterparty)
                .sign(transaction, inputIndex)
          }
        })
        const signedBytes = signed.toAtomicBEEF()
        const matchingOutputIndexes = signed.outputs.flatMap((output, index) =>
          output.satoshis === targetOutput.satoshis &&
          output.lockingScript.toHex() === newLockingScript.toHex()
            ? [index]
            : []
        )
        if (matchingOutputIndexes.length !== 1) {
          throw new Error('Signed transaction does not uniquely contain the recipient token')
        }

        // Send via MessageBox
        const peerPay = new PeerPayClient({
          walletClient: client as any,
          messageBoxHost: core.defaults.messageBoxHost,
          enableLogging: false
        })
        try {
          await peerPay.sendMessage({
            recipient,
            messageBox: TOKEN_MESSAGE_BOX,
            body: stringifyBRC100({
              transaction: signedBytes,
              protocolID,
              keyID: newKeyID,
              sender: core.getIdentityKey(),
              outputIndex: matchingOutputIndexes[0]
            })
          })
        } catch {
          throw new Error(
            `Token transaction ${signed.id('hex')} completed but MessageBox delivery failed; do not retry the transfer without reconciling that transaction`
          )
        }

        return {
          txid: signed.id('hex'),
          tx: signedBytes
        }
      } catch (error) {
        throw new Error(`Token MessageBox send failed: ${(error as Error).message}`)
      }
    },

    async listIncomingTokens(): Promise<any[]> {
      try {
        const client = core.getClient()
        const peerPay = new PeerPayClient({
          walletClient: client as any,
          messageBoxHost: core.defaults.messageBoxHost,
          enableLogging: false
        })
        return await listBoundedTokenMessages(peerPay)
      } catch (error) {
        throw new Error(`Failed to list incoming tokens: ${(error as Error).message}`)
      }
    },

    async acceptIncomingToken(token: any, basket?: string): Promise<any> {
      try {
        const client = core.getClient()
        const effectiveBasket = basket ?? core.defaults.tokenBasket
        const requestedToken = dataRecord(token)
        if (requestedToken == null) throw new TypeError('Incoming token is invalid')
        const requestedMessageId = boundedString(requestedToken.messageId, 'message ID', 1_024)
        const peerPay = new PeerPayClient({
          walletClient: client as any,
          messageBoxHost: core.defaults.messageBoxHost,
          enableLogging: false
        })
        const matches = (await listBoundedTokenMessages(peerPay)).filter(
          candidate => candidate.messageId === requestedMessageId
        )
        if (matches.length !== 1) {
          throw new Error('Incoming token is not present exactly once in the authenticated inbox')
        }
        const incoming = matches[0]

        const internalizeResult = dataRecord(
          await client.internalizeAction({
            tx: incoming.transaction,
            outputs: [
              {
                outputIndex: incoming.outputIndex,
                protocol: 'basket insertion',
                insertionRemittance: {
                  basket: effectiveBasket,
                  customInstructions: stringifyBRC100({
                    protocolID: incoming.protocolID,
                    keyID: incoming.keyID,
                    counterparty: incoming.sender
                  }),
                  tags: ['token', 'received']
                }
              }
            ],
            description: `Receive token from ${incoming.sender.substring(0, 20)}...`
          } as any)
        )
        if (internalizeResult?.accepted !== true) {
          throw new Error('Receiving wallet did not accept the token')
        }

        try {
          await peerPay.acknowledgeMessage({ messageIds: [incoming.messageId] })
        } catch {
          // The token is already safe. A later retry can acknowledge the inbox message.
        }

        return { accepted: true, basket: effectiveBasket, sender: incoming.sender }
      } catch (error) {
        throw new Error(`Failed to accept incoming token: ${(error as Error).message}`)
      }
    }
  }
}
