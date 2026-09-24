import { WalletInterface, SecurityLevel } from '../Wallet.interfaces.js'
import WalletWire, { MAX_WALLET_WIRE_FRAME_BYTES } from './WalletWire.js'
import {
  ReaderUint8Array,
  WriterUint8Array,
  toBase64,
  toHex,
  toUTF8Strict,
  toUint8Array as UtilsToUint8Array
} from '../../primitives/utils.js'
import calls, { CallType } from './WalletWireCalls.js'
import Certificate from '../../auth/certificates/Certificate.js'
import { WalletError, walletErrors } from '../WalletError.js'
import PublicKey from '../../primitives/PublicKey.js'
import {
  MAXIMUM_CERTIFICATE_REVEAL_FIELDS,
  MAXIMUM_DISCOVERY_ATTRIBUTES,
  MAXIMUM_SEND_WITH_TRANSACTIONS,
  validateOriginator
} from '../validationHelpers.js'
import { validateWalletArgs } from '../WalletArgumentValidation.js'
import { snapshotWalletResultRequest, validateWalletResult } from '../WalletResultValidation.js'
import { isUnsafeRecordKey } from '../../primitives/SafeRecord.js'

const MAX_WIRE_ERROR_MESSAGE_BYTES = 4096
const MAX_WIRE_COLLECTION_ITEMS = 100_000

/**
 * Processes incoming wallet calls received over a wallet wire, with a given wallet.
 */
export default class WalletWireProcessor implements WalletWire {
  wallet: WalletInterface

  constructor(wallet: WalletInterface) {
    this.wallet = wallet
  }

  #readBooleanFlag(reader: ReaderUint8Array, fieldName: string): boolean {
    const flag = reader.readInt8()
    if (flag !== 0 && flag !== 1) {
      throw new Error(`Invalid ${fieldName} flag: expected 0 or 1, received ${flag}`)
    }
    return flag === 1
  }

  #readOptionalBooleanFlag(reader: ReaderUint8Array, fieldName: string): boolean | undefined {
    const flag = reader.readInt8()
    if (flag === -1) return undefined
    if (flag === 0) return false
    if (flag === 1) return true
    throw new Error(`Invalid ${fieldName} flag: expected -1, 0, or 1, received ${flag}`)
  }

  #readOptionalInt8Length(reader: ReaderUint8Array, fieldName: string): number | undefined {
    const length = reader.readInt8()
    if (length === -1) return undefined
    if (length < 0) {
      throw new Error(`Invalid ${fieldName} length: expected -1 or 0–127, received ${length}`)
    }
    return length
  }

  #requireOptionalListLength(
    reader: ReaderUint8Array,
    length: number,
    fieldName: string,
    maximum: number,
    minimumBytesPerItem: number
  ): number | undefined {
    if (length === -1) return undefined
    return this.#requireCollectionLength(reader, length, fieldName, maximum, minimumBytesPerItem)
  }

  #requireBytes(value: unknown, fieldName: string, expectedLength?: number): Uint8Array {
    if (!Array.isArray(value) && !(value instanceof Uint8Array)) {
      throw new Error(`Invalid ${fieldName}: expected an array of bytes`)
    }
    if (expectedLength !== undefined && value.length !== expectedLength) {
      throw new Error(
        `Invalid ${fieldName} length: expected ${expectedLength} bytes, received ${value.length}`
      )
    }
    if (value instanceof Uint8Array) {
      const SharedArrayBufferCtor = (globalThis as any).SharedArrayBuffer
      return SharedArrayBufferCtor != null && value.buffer instanceof SharedArrayBufferCtor
        ? value.slice()
        : value
    }
    const bytes = new Uint8Array(value.length)
    for (let i = 0; i < value.length; i++) {
      const byte = value[i]
      if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
        throw new Error(`Invalid ${fieldName}: expected integers between 0 and 255`)
      }
      bytes[i] = byte
    }
    return bytes
  }

  #stableBytes(value: number[] | Uint8Array): number[] | Uint8Array {
    const SharedArrayBufferCtor = (globalThis as any).SharedArrayBuffer
    return value instanceof Uint8Array &&
      SharedArrayBufferCtor != null &&
      value.buffer instanceof SharedArrayBufferCtor
      ? value.slice()
      : value
  }

  #requireCollectionLength(
    reader: ReaderUint8Array,
    length: number,
    fieldName: string,
    maximum: number = MAX_WIRE_COLLECTION_ITEMS,
    minimumBytesPerItem: number = 1
  ): number {
    if (!Number.isSafeInteger(length) || length < 0 || length > maximum) {
      throw new Error(
        `Invalid ${fieldName} length: expected 0 through ${maximum}, received ${length}`
      )
    }
    if (length > Math.floor(reader.remaining() / minimumBytesPerItem)) {
      throw new Error(`Invalid ${fieldName} length: exceeds the remaining Wallet Wire frame`)
    }
    return length
  }

  #requireFixedHex(value: unknown, fieldName: string, expectedLength: number): Uint8Array {
    if (typeof value !== 'string') throw new Error(`Invalid ${fieldName}: expected a hex string`)
    const bytes = UtilsToUint8Array(value, 'hex')
    if (bytes.length !== expectedLength) {
      throw new Error(
        `Invalid ${fieldName} length: expected ${expectedLength} bytes, received ${bytes.length}`
      )
    }
    return bytes
  }

  #requireInteger(value: unknown, fieldName: string, minimum: number, maximum: number): number {
    if (
      !Number.isSafeInteger(value) ||
      (value as number) < minimum ||
      (value as number) > maximum
    ) {
      throw new Error(
        `Invalid ${fieldName}: expected an integer from ${minimum} to ${maximum}, received ${String(value)}`
      )
    }
    return value as number
  }

  #sendWithStatusCode(status: unknown): number {
    if (status === 'unproven') return 1
    if (status === 'sending') return 2
    if (status === 'failed') return 3
    throw new Error(`Invalid sendWith result status: ${String(status)}`)
  }

  #actionStatusCode(status: unknown): number {
    if (status === 'completed') return 1
    if (status === 'unprocessed') return 2
    if (status === 'sending') return 3
    if (status === 'unproven') return 4
    if (status === 'unsigned') return 5
    if (status === 'nosend') return 6
    if (status === 'nonfinal') return 7
    if (status === 'failed') return 8
    throw new Error(`Invalid action status: ${String(status)}`)
  }

  #requirePageTotal(
    totalValue: unknown,
    records: unknown,
    resultName: string
  ): { total: number; records: any[] } {
    if (!Array.isArray(records)) throw new Error(`Invalid ${resultName}: expected an array`)
    const total = this.#requireInteger(totalValue, `${resultName} total`, 0, 0xffffffff)
    if (records.length > total) {
      throw new Error(
        `Invalid ${resultName}: returned ${records.length} records but declared a total of ${total}`
      )
    }
    return { total, records }
  }

  #recordFromWireEntries<T>(
    entries: ReadonlyMap<string | number, T>,
    recordName: string
  ): Record<string, T> {
    for (const key of entries.keys()) {
      if (typeof key !== 'string') {
        continue
      }
      this.#assertRecordKey(key, recordName)
    }

    return Object.fromEntries(entries)
  }

  #assertRecordKey(key: string, recordName: string): void {
    const keyLength = UtilsToUint8Array(key, 'utf8').length
    if (keyLength < 1 || keyLength > 50) {
      throw new Error(
        `Invalid ${recordName} key length: expected 1–50 bytes, received ${keyLength}`
      )
    }
    if (isUnsafeRecordKey(key)) throw new Error(`Unsafe ${recordName} key: ${key}`)
  }

  #recordEntries(record: unknown, recordName: string): Array<[string, unknown]> {
    if (record == null || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error(`Invalid ${recordName}: expected a record`)
    }
    const entries = Object.entries(record as Record<string, unknown>)
    for (const [key] of entries) this.#assertRecordKey(key, recordName)
    return entries
  }

  #setUniqueWireEntry<K, V>(entries: Map<K, V>, key: K, value: V, recordName: string): void {
    if (entries.has(key)) throw new Error(`Duplicate ${recordName} key: ${String(key)}`)
    entries.set(key, value)
  }

  #decodeOutpoint(reader: ReaderUint8Array): string {
    const txidBytes = reader.read(32)
    const txid = toHex(txidBytes)
    const index = this.#requireInteger(
      reader.readVarIntNumStrict(false),
      'outpoint index',
      0,
      0xffffffff
    )
    return `${txid}.${index}`
  }

  #encodeOutpoint(outpoint: string): Uint8Array {
    const writer = new WriterUint8Array()
    if (typeof outpoint !== 'string') throw new Error('Invalid outpoint: expected a string')
    const parts = outpoint.split('.')
    if (parts.length !== 2 || !/^(?:0|[1-9]\d*)$/.test(parts[1])) {
      throw new Error(`Invalid outpoint: ${outpoint}`)
    }
    const [txid, indexText] = parts
    writer.write(this.#requireFixedHex(txid, 'outpoint txid', 32))
    writer.writeVarIntNum(this.#requireInteger(Number(indexText), 'outpoint index', 0, 0xffffffff))
    return writer.toUint8Array()
  }

  async transmitToWallet(message: number[]): Promise<number[]> {
    if (!Array.isArray(message) || message.length > MAX_WALLET_WIRE_FRAME_BYTES) {
      throw new Error('Wallet Wire request exceeds the maximum permitted size')
    }
    for (let i = 0; i < message.length; i++) {
      if (
        !Object.prototype.hasOwnProperty.call(message, i) ||
        !Number.isInteger(message[i]) ||
        message[i] < 0 ||
        message[i] > 255
      ) {
        throw new Error('Wallet Wire request must be a dense byte array')
      }
    }
    return Array.from(await this.#processMessage(Uint8Array.from(message)))
  }

  async transmitToWalletUint8Array(message: Uint8Array): Promise<Uint8Array> {
    if (!(message instanceof Uint8Array) || message.length > MAX_WALLET_WIRE_FRAME_BYTES) {
      throw new Error('Wallet Wire request exceeds the maximum permitted size')
    }
    return await this.#processMessage(message)
  }

  async #processMessage(message: Uint8Array): Promise<Uint8Array> {
    const messageReader = new ReaderUint8Array(message)
    try {
      // Read call code
      const callCode = messageReader.readUInt8()

      // Map call code to call name
      const callName = calls[callCode] // calls is enum
      if (callName === undefined || callName === '') {
        // Invalid call code
        throw new Error(`Invalid call code: ${callCode}`)
      }

      // Read originator length
      const originatorLength = messageReader.readUInt8()
      if (originatorLength > 250) {
        throw new Error(
          `Invalid originator length: expected at most 250 bytes, received ${originatorLength}`
        )
      }
      const originatorBytes = messageReader.read(originatorLength)
      const decodedOriginator = toUTF8Strict(originatorBytes)
      const originator = decodedOriginator === '' ? '' : validateOriginator(decodedOriginator)!

      // Read parameters
      const paramsReader = messageReader // Remaining bytes

      switch (callName) {
        case 'createAction':
          return await (async () => {
            // Deserialize parameters from paramsReader
            const args: any = {}

            // Read description
            const descriptionLength = paramsReader.readVarIntNumStrict(false)
            const descriptionBytes = paramsReader.read(descriptionLength)
            args.description = toUTF8Strict(descriptionBytes)

            // tx
            const inputBeefLength = paramsReader.readVarIntNumStrict()
            if (inputBeefLength >= 0) {
              args.inputBEEF = paramsReader.readView(inputBeefLength) // BEEF (Byte[])
            } else {
              args.inputBEEF = undefined
            }

            // Read inputs
            ;(() => {
              const inputsLength = paramsReader.readVarIntNumStrict()
              if (inputsLength >= 0) {
                this.#requireCollectionLength(paramsReader, inputsLength, 'createAction inputs')
                args.inputs = []
                for (let i = 0; i < inputsLength; i++) {
                  const input: any = {}

                  // outpoint
                  input.outpoint = this.#decodeOutpoint(paramsReader)

                  // unlockingScript / unlockingScriptLength
                  const unlockingScriptLength = paramsReader.readVarIntNumStrict()
                  if (unlockingScriptLength >= 0) {
                    const unlockingScriptBytes = paramsReader.read(unlockingScriptLength)
                    input.unlockingScript = toHex(unlockingScriptBytes)
                  } else {
                    input.unlockingScript = undefined
                    const unlockingScriptLengthValue = paramsReader.readVarIntNumStrict(false)
                    input.unlockingScriptLength = unlockingScriptLengthValue
                  }

                  // inputDescription
                  const inputDescriptionLength = paramsReader.readVarIntNumStrict(false)
                  const inputDescriptionBytes = paramsReader.read(inputDescriptionLength)
                  input.inputDescription = toUTF8Strict(inputDescriptionBytes)

                  // sequenceNumber
                  const sequenceNumber = paramsReader.readVarIntNumStrict()
                  if (sequenceNumber >= 0) {
                    input.sequenceNumber = sequenceNumber
                  } else {
                    input.sequenceNumber = undefined
                  }

                  args.inputs.push(input)
                }
              } else {
                args.inputs = undefined
              }
            })()

            // Read outputs
            ;(() => {
              const outputsLength = paramsReader.readVarIntNumStrict()
              if (outputsLength >= 0) {
                this.#requireCollectionLength(paramsReader, outputsLength, 'createAction outputs')
                args.outputs = []
                for (let i = 0; i < outputsLength; i++) {
                  const output: any = {}

                  // lockingScript
                  const lockingScriptLength = paramsReader.readVarIntNumStrict(false)
                  const lockingScriptBytes = paramsReader.read(lockingScriptLength)
                  output.lockingScript = toHex(lockingScriptBytes)

                  // satoshis
                  output.satoshis = paramsReader.readVarIntNumStrict(false)

                  // outputDescription
                  const outputDescriptionLength = paramsReader.readVarIntNumStrict(false)
                  const outputDescriptionBytes = paramsReader.read(outputDescriptionLength)
                  output.outputDescription = toUTF8Strict(outputDescriptionBytes)

                  ;(() => {
                    // basket
                    const basketLength = paramsReader.readVarIntNumStrict()
                    if (basketLength >= 0) {
                      const basketBytes = paramsReader.read(basketLength)
                      output.basket = toUTF8Strict(basketBytes)
                    } else {
                      output.basket = undefined
                    }

                    // customInstructions
                    const customInstructionsLength = paramsReader.readVarIntNumStrict()
                    if (customInstructionsLength >= 0) {
                      const customInstructionsBytes = paramsReader.read(customInstructionsLength)
                      output.customInstructions = toUTF8Strict(customInstructionsBytes)
                    } else {
                      output.customInstructions = undefined
                    }

                    // tags
                    const tagsLength = paramsReader.readVarIntNumStrict()
                    if (tagsLength >= 0) {
                      this.#requireCollectionLength(
                        paramsReader,
                        tagsLength,
                        'createAction output tags'
                      )
                      output.tags = []
                      for (let j = 0; j < tagsLength; j++) {
                        const tagLength = paramsReader.readVarIntNumStrict(false)
                        const tagBytes = paramsReader.read(tagLength)
                        const tag = toUTF8Strict(tagBytes)
                        output.tags.push(tag)
                      }
                    } else {
                      output.tags = undefined
                    }
                  })()

                  args.outputs.push(output)
                }
              } else {
                args.outputs = undefined
              }
            })()

            ;(() => {
              // lockTime
              const lockTime = paramsReader.readVarIntNumStrict()
              if (lockTime >= 0) {
                args.lockTime = lockTime
              } else {
                args.lockTime = undefined
              }

              // version
              const version = paramsReader.readVarIntNumStrict()
              if (version >= 0) {
                args.version = version
              } else {
                args.version = undefined
              }

              // labels
              const labelsLength = paramsReader.readVarIntNumStrict()
              if (labelsLength >= 0) {
                this.#requireCollectionLength(paramsReader, labelsLength, 'createAction labels')
                args.labels = []
                for (let i = 0; i < labelsLength; i++) {
                  const labelLength = paramsReader.readVarIntNumStrict(false)
                  const labelBytes = paramsReader.read(labelLength)
                  const label = toUTF8Strict(labelBytes)
                  args.labels.push(label)
                }
              } else {
                args.labels = undefined
              }
            })()

            // options
            const optionsPresent = this.#readBooleanFlag(paramsReader, 'optionsPresent')
            if (optionsPresent) {
              args.options = {}

              ;(() => {
                // signAndProcess
                args.options.signAndProcess = this.#readOptionalBooleanFlag(
                  paramsReader,
                  'signAndProcess'
                )

                // acceptDelayedBroadcast
                args.options.acceptDelayedBroadcast = this.#readOptionalBooleanFlag(
                  paramsReader,
                  'acceptDelayedBroadcast'
                )

                // trustSelf
                const trustSelfFlag = paramsReader.readInt8()
                if (trustSelfFlag === -1) {
                  args.options.trustSelf = undefined
                } else if (trustSelfFlag === 1) {
                  args.options.trustSelf = 'known'
                } else {
                  throw new Error(
                    `Invalid trustSelf flag: expected -1 or 1, received ${trustSelfFlag}`
                  )
                }
              })()

              // knownTxids
              ;(() => {
                const knownTxidsLength = paramsReader.readVarIntNumStrict()
                if (knownTxidsLength >= 0) {
                  this.#requireCollectionLength(
                    paramsReader,
                    knownTxidsLength,
                    'createAction knownTxids',
                    MAX_WIRE_COLLECTION_ITEMS,
                    32
                  )
                  args.options.knownTxids = []
                  for (let i = 0; i < knownTxidsLength; i++) {
                    const txidBytes = paramsReader.read(32)
                    const txid = toHex(txidBytes)
                    args.options.knownTxids.push(txid)
                  }
                } else {
                  args.options.knownTxids = undefined
                }

                // returnTXIDOnly
                args.options.returnTXIDOnly = this.#readOptionalBooleanFlag(
                  paramsReader,
                  'returnTXIDOnly'
                )

                // noSend
                args.options.noSend = this.#readOptionalBooleanFlag(paramsReader, 'noSend')
              })()

              // noSendChange
              ;(() => {
                const noSendChangeLength = paramsReader.readVarIntNumStrict()
                if (noSendChangeLength >= 0) {
                  this.#requireCollectionLength(
                    paramsReader,
                    noSendChangeLength,
                    'createAction noSendChange',
                    MAX_WIRE_COLLECTION_ITEMS,
                    33
                  )
                  args.options.noSendChange = []
                  for (let i = 0; i < noSendChangeLength; i++) {
                    const outpoint = this.#decodeOutpoint(paramsReader)
                    args.options.noSendChange.push(outpoint)
                  }
                } else {
                  args.options.noSendChange = undefined
                }

                // sendWith
                const sendWithLength = this.#requireOptionalListLength(
                  paramsReader,
                  paramsReader.readVarIntNumStrict(),
                  'sendWith',
                  MAXIMUM_SEND_WITH_TRANSACTIONS,
                  32
                )
                if (sendWithLength !== undefined) {
                  args.options.sendWith = []
                  for (let i = 0; i < sendWithLength; i++) {
                    const txidBytes = paramsReader.read(32)
                    const txid = toHex(txidBytes)
                    args.options.sendWith.push(txid)
                  }
                } else {
                  args.options.sendWith = undefined
                }
              })()

              // randomizeOutputs
              args.options.randomizeOutputs = this.#readOptionalBooleanFlag(
                paramsReader,
                'randomizeOutputs'
              )
            } else {
              args.options = undefined
            }

            // Call the method
            this.#assertRequestConsumed(paramsReader, callName)
            validateWalletArgs(callName, args)
            const createActionResult = await this.#invokeValidatedWallet(
              'createAction',
              args,
              async () => await this.wallet.createAction(args, originator)
            )

            // Serialize the result
            const resultWriter = new WriterUint8Array()
            resultWriter.writeUInt8(0) // errorByte = 0

            ;(() => {
              // txid
              if (createActionResult.txid != null && createActionResult.txid !== '') {
                resultWriter.writeInt8(1)
                resultWriter.write(UtilsToUint8Array(createActionResult.txid, 'hex'))
              } else {
                resultWriter.writeInt8(0)
              }

              // tx
              if (createActionResult.tx == null) {
                resultWriter.writeInt8(0)
              } else {
                const tx = this.#stableBytes(createActionResult.tx)
                resultWriter.writeInt8(1)
                resultWriter.writeVarIntNum(tx.length)
                resultWriter.write(tx)
              }
            })()

            ;(() => {
              // noSendChange
              if (createActionResult.noSendChange == null) {
                resultWriter.writeVarIntNum(-1)
              } else {
                resultWriter.writeVarIntNum(createActionResult.noSendChange.length)
                for (const outpoint of createActionResult.noSendChange) {
                  resultWriter.write(this.#encodeOutpoint(outpoint))
                }
              }

              // sendWithResults
              if (createActionResult.sendWithResults == null) {
                resultWriter.writeVarIntNum(-1)
              } else {
                resultWriter.writeVarIntNum(createActionResult.sendWithResults.length)
                for (const result of createActionResult.sendWithResults) {
                  resultWriter.write(UtilsToUint8Array(result.txid, 'hex'))
                  resultWriter.writeInt8(this.#sendWithStatusCode(result.status))
                }
              }
            })()

            ;(() => {
              // signableTransaction
              if (createActionResult.signableTransaction == null) {
                resultWriter.writeInt8(0)
              } else {
                const tx = this.#stableBytes(createActionResult.signableTransaction.tx)
                resultWriter.writeInt8(1)
                resultWriter.writeVarIntNum(tx.length)
                resultWriter.write(tx)
                const referenceBytes = UtilsToUint8Array(
                  createActionResult.signableTransaction.reference,
                  'base64'
                )
                resultWriter.writeVarIntNum(referenceBytes.length)
                resultWriter.write(referenceBytes)
              }
            })()

            return resultWriter.toUint8ArrayZeroCopy()
          })()
        case 'signAction':
          return await (async () => {
            const args: any = {}

            // Deserialize spends
            ;(() => {
              const spendCount = this.#requireCollectionLength(
                paramsReader,
                paramsReader.readVarIntNumStrict(false),
                'signAction spends'
              )
              const spends = new Map<number, any>()
              for (let i = 0; i < spendCount; i++) {
                const inputIndex = paramsReader.readVarIntNumStrict(false)
                const spend: any = {}

                // unlockingScript
                const unlockingScriptLength = paramsReader.readVarIntNumStrict(false)
                const unlockingScriptBytes = paramsReader.read(unlockingScriptLength)
                spend.unlockingScript = toHex(unlockingScriptBytes)

                // sequenceNumber
                const sequenceNumber = paramsReader.readVarIntNumStrict()
                if (sequenceNumber >= 0) {
                  spend.sequenceNumber = sequenceNumber
                } else {
                  spend.sequenceNumber = undefined
                }

                this.#setUniqueWireEntry(spends, inputIndex, spend, 'signAction spends')
              }
              args.spends = this.#recordFromWireEntries(spends, 'spends')
            })()

            // Deserialize reference
            const referenceLength = paramsReader.readVarIntNumStrict(false)
            const referenceBytes = paramsReader.read(referenceLength)
            args.reference = toBase64(referenceBytes)

            // Deserialize options
            const optionsPresent = this.#readBooleanFlag(paramsReader, 'optionsPresent')
            if (optionsPresent) {
              args.options = {}

              ;(() => {
                // acceptDelayedBroadcast
                args.options.acceptDelayedBroadcast = this.#readOptionalBooleanFlag(
                  paramsReader,
                  'acceptDelayedBroadcast'
                )

                // returnTXIDOnly
                args.options.returnTXIDOnly = this.#readOptionalBooleanFlag(
                  paramsReader,
                  'returnTXIDOnly'
                )

                // noSend
                args.options.noSend = this.#readOptionalBooleanFlag(paramsReader, 'noSend')
              })()

              // sendWith
              ;(() => {
                const sendWithLength = this.#requireOptionalListLength(
                  paramsReader,
                  paramsReader.readVarIntNumStrict(),
                  'sendWith',
                  MAXIMUM_SEND_WITH_TRANSACTIONS,
                  32
                )
                if (sendWithLength !== undefined) {
                  args.options.sendWith = []
                  for (let i = 0; i < sendWithLength; i++) {
                    const txidBytes = paramsReader.read(32)
                    const txid = toHex(txidBytes)
                    args.options.sendWith.push(txid)
                  }
                } else {
                  args.options.sendWith = undefined
                }
              })()
            } else {
              args.options = undefined
            }

            // Call the method
            this.#assertRequestConsumed(paramsReader, callName)
            validateWalletArgs(callName, args)
            const signActionResult = await this.#invokeValidatedWallet(
              'signAction',
              args,
              async () => await this.wallet.signAction(args, originator)
            )

            // Serialize the result
            const resultWriter = new WriterUint8Array()
            resultWriter.writeUInt8(0) // errorByte = 0

            ;(() => {
              // txid
              if (signActionResult.txid != null && signActionResult.txid !== '') {
                resultWriter.writeInt8(1)
                resultWriter.write(UtilsToUint8Array(signActionResult.txid, 'hex'))
              } else {
                resultWriter.writeInt8(0)
              }

              // tx
              if (signActionResult.tx == null) {
                resultWriter.writeInt8(0)
              } else {
                const tx = this.#stableBytes(signActionResult.tx)
                resultWriter.writeInt8(1)
                resultWriter.writeVarIntNum(tx.length)
                resultWriter.write(tx)
              }
            })()

            // sendWithResults
            ;(() => {
              if (signActionResult.sendWithResults == null) {
                resultWriter.writeVarIntNum(-1)
              } else {
                resultWriter.writeVarIntNum(signActionResult.sendWithResults.length)
                for (const result of signActionResult.sendWithResults) {
                  resultWriter.write(UtilsToUint8Array(result.txid, 'hex'))
                  resultWriter.writeInt8(this.#sendWithStatusCode(result.status))
                }
              }
            })()

            return resultWriter.toUint8ArrayZeroCopy()
          })()
        case 'abortAction':
          return await (async () => {
            // Deserialize reference
            const referenceBytes = paramsReader.read()
            const reference = toBase64(referenceBytes)

            // Call the method
            this.#assertRequestConsumed(paramsReader, callName)
            const args = { reference }
            validateWalletArgs(callName, args)
            const result = await this.#invokeValidatedWallet(
              callName,
              args,
              async () => await this.wallet.abortAction(args, originator)
            )
            if (result.aborted !== true) {
              // Older transceivers treated every successful frame as `aborted: true`.
              // An error frame therefore makes refusal fail closed for old clients,
              // while current transceivers translate this code back to `false`.
              throw new WalletError(
                'The wallet refused to abort this action because it has already been broadcast',
                walletErrors.abortRefused
              )
            }

            // Return success code and result
            const responseWriter = new WriterUint8Array()
            responseWriter.writeUInt8(0) // errorByte = 0
            return responseWriter.toUint8Array()
          })()
        case 'listActions':
          return await (async () => {
            const args: any = {}

            ;(() => {
              // Deserialize labels
              const labelsLength = this.#requireCollectionLength(
                paramsReader,
                paramsReader.readVarIntNumStrict(false),
                'listActions labels'
              )
              args.labels = []
              for (let i = 0; i < labelsLength; i++) {
                const labelLength = paramsReader.readVarIntNumStrict(false)
                const labelBytes = paramsReader.read(labelLength)
                args.labels.push(toUTF8Strict(labelBytes))
              }

              // Deserialize labelQueryMode
              const labelQueryModeFlag = paramsReader.readInt8()
              if (labelQueryModeFlag === -1) {
                args.labelQueryMode = undefined
              } else if (labelQueryModeFlag === 1) {
                args.labelQueryMode = 'any'
              } else if (labelQueryModeFlag === 2) {
                args.labelQueryMode = 'all'
              } else {
                throw new Error(
                  `Invalid labelQueryMode flag: expected -1, 1, or 2, received ${labelQueryModeFlag}`
                )
              }

              // Deserialize include options
              const includeOptionsNames = [
                'includeLabels',
                'includeInputs',
                'includeInputSourceLockingScripts',
                'includeInputUnlockingScripts',
                'includeOutputs',
                'includeOutputLockingScripts'
              ]
              for (const optionName of includeOptionsNames) {
                args[optionName] = this.#readOptionalBooleanFlag(paramsReader, optionName)
              }

              // Deserialize limit
              const limit = paramsReader.readVarIntNumStrict()
              if (limit >= 0) {
                args.limit = limit
              } else {
                args.limit = undefined
              }

              // Deserialize offset
              const offset = paramsReader.readVarIntNumStrict()
              if (offset >= 0) {
                args.offset = offset
              } else {
                args.offset = undefined
              }

              // Deserialize seekPermission
              args.seekPermission = this.#readOptionalBooleanFlag(paramsReader, 'seekPermission')
            })()

            // Call the method
            this.#assertRequestConsumed(paramsReader, callName)
            validateWalletArgs(callName, args)
            const listActionsResult = await this.#invokeValidatedWallet(
              callName,
              args,
              async () => await this.wallet.listActions(args, originator)
            )
            const actionsPage = this.#requirePageTotal(
              listActionsResult.totalActions,
              listActionsResult.actions,
              'listActions result'
            )

            // Serialize the result
            const resultWriter = new WriterUint8Array()

            // totalActions
            resultWriter.writeVarIntNum(actionsPage.total)

            // actions
            for (const action of actionsPage.records as typeof listActionsResult.actions) {
              ;(() => {
                // txid
                resultWriter.write(UtilsToUint8Array(action.txid, 'hex'))

                // satoshis
                resultWriter.writeVarIntNum(
                  this.#requireInteger(action.satoshis, 'listActions satoshis', -21e14, 21e14)
                )

                // status
                resultWriter.writeInt8(this.#actionStatusCode(action.status))

                // isOutgoing
                resultWriter.writeInt8(action.isOutgoing ? 1 : 0)

                // description
                const descriptionBytes = UtilsToUint8Array(action.description, 'utf8')
                resultWriter.writeVarIntNum(descriptionBytes.length)
                resultWriter.write(descriptionBytes)
              })()

              ;(() => {
                // labels
                if (action.labels === undefined) {
                  resultWriter.writeVarIntNum(-1)
                } else {
                  resultWriter.writeVarIntNum(action.labels.length)
                  for (const label of action.labels) {
                    const labelBytes = UtilsToUint8Array(label, 'utf8')
                    resultWriter.writeVarIntNum(labelBytes.length)
                    resultWriter.write(labelBytes)
                  }
                }

                // version
                resultWriter.writeVarIntNum(action.version)

                // lockTime
                resultWriter.writeVarIntNum(action.lockTime)
              })()

              ;(() => {
                // inputs
                if (action.inputs === undefined) {
                  resultWriter.writeVarIntNum(-1)
                } else {
                  resultWriter.writeVarIntNum(action.inputs.length)
                  for (const input of action.inputs) {
                    // sourceOutpoint
                    resultWriter.write(this.#encodeOutpoint(input.sourceOutpoint))

                    // sourceSatoshis
                    resultWriter.writeVarIntNum(input.sourceSatoshis)

                    // sourceLockingScript
                    if (input.sourceLockingScript === undefined) {
                      resultWriter.writeVarIntNum(-1)
                    } else {
                      const sourceLockingScriptBytes = UtilsToUint8Array(
                        input.sourceLockingScript,
                        'hex'
                      )
                      resultWriter.writeVarIntNum(sourceLockingScriptBytes.length)
                      resultWriter.write(sourceLockingScriptBytes)
                    }

                    // unlockingScript
                    if (input.unlockingScript === undefined) {
                      resultWriter.writeVarIntNum(-1)
                    } else {
                      const unlockingScriptBytes = UtilsToUint8Array(input.unlockingScript, 'hex')
                      resultWriter.writeVarIntNum(unlockingScriptBytes.length)
                      resultWriter.write(unlockingScriptBytes)
                    }

                    // inputDescription
                    const inputDescriptionBytes = UtilsToUint8Array(input.inputDescription, 'utf8')
                    resultWriter.writeVarIntNum(inputDescriptionBytes.length)
                    resultWriter.write(inputDescriptionBytes)

                    // sequenceNumber
                    resultWriter.writeVarIntNum(input.sequenceNumber)
                  }
                }
              })()

              ;(() => {
                // outputs
                if (action.outputs === undefined) {
                  resultWriter.writeVarIntNum(-1)
                } else {
                  resultWriter.writeVarIntNum(action.outputs.length)
                  for (const output of action.outputs) {
                    // outputIndex
                    resultWriter.writeVarIntNum(output.outputIndex)

                    // satoshis
                    resultWriter.writeVarIntNum(output.satoshis)

                    // lockingScript
                    if (output.lockingScript === undefined) {
                      resultWriter.writeVarIntNum(-1)
                    } else {
                      const lockingScriptBytes = UtilsToUint8Array(output.lockingScript, 'hex')
                      resultWriter.writeVarIntNum(lockingScriptBytes.length)
                      resultWriter.write(lockingScriptBytes)
                    }

                    // spendable
                    resultWriter.writeInt8(output.spendable ? 1 : 0)

                    // outputDescription
                    const outputDescriptionBytes = UtilsToUint8Array(
                      output.outputDescription,
                      'utf8'
                    )
                    resultWriter.writeVarIntNum(outputDescriptionBytes.length)
                    resultWriter.write(outputDescriptionBytes)

                    ;(() => {
                      // basket
                      if (output.basket === undefined) {
                        resultWriter.writeVarIntNum(-1)
                      } else {
                        const basketBytes = UtilsToUint8Array(output.basket, 'utf8')
                        resultWriter.writeVarIntNum(basketBytes.length)
                        resultWriter.write(basketBytes)
                      }

                      // tags
                      if (output.tags === undefined) {
                        resultWriter.writeVarIntNum(-1)
                      } else {
                        resultWriter.writeVarIntNum(output.tags.length)
                        for (const tag of output.tags) {
                          const tagBytes = UtilsToUint8Array(tag, 'utf8')
                          resultWriter.writeVarIntNum(tagBytes.length)
                          resultWriter.write(tagBytes)
                        }
                      }

                      // customInstructions
                      if (output.customInstructions === undefined) {
                        resultWriter.writeVarIntNum(-1)
                      } else {
                        const customInstructionsBytes = UtilsToUint8Array(
                          output.customInstructions,
                          'utf8'
                        )
                        resultWriter.writeVarIntNum(customInstructionsBytes.length)
                        resultWriter.write(customInstructionsBytes)
                      }
                    })()
                  }
                }
              })()
            }

            const responseWriter = new WriterUint8Array()
            responseWriter.writeUInt8(0) // errorByte = 0
            responseWriter.write(resultWriter.toUint8Array())
            return responseWriter.toUint8Array()
          })()
        case 'internalizeAction':
          return await (async () => {
            const args: any = {}

            // Read tx
            const txLength = paramsReader.readVarIntNumStrict(false)
            args.tx = paramsReader.readView(txLength)

            // Read outputs
            ;(() => {
              const outputsLength = this.#requireCollectionLength(
                paramsReader,
                paramsReader.readVarIntNumStrict(false),
                'internalizeAction outputs'
              )
              args.outputs = []
              for (let i = 0; i < outputsLength; i++) {
                const output: any = {}

                // outputIndex
                output.outputIndex = paramsReader.readVarIntNumStrict(false)

                // protocol
                const protocolFlag = paramsReader.readUInt8()
                if (protocolFlag === 1) {
                  output.protocol = 'wallet payment'
                  output.paymentRemittance = {}

                  // senderIdentityKey
                  const senderIdentityKeyBytes = paramsReader.read(33)
                  output.paymentRemittance.senderIdentityKey = toHex(senderIdentityKeyBytes)

                  // derivationPrefix
                  const derivationPrefixLength = paramsReader.readVarIntNumStrict(false)
                  const derivationPrefixBytes = paramsReader.read(derivationPrefixLength)
                  output.paymentRemittance.derivationPrefix = toBase64(derivationPrefixBytes)

                  // derivationSuffix
                  const derivationSuffixLength = paramsReader.readVarIntNumStrict(false)
                  const derivationSuffixBytes = paramsReader.read(derivationSuffixLength)
                  output.paymentRemittance.derivationSuffix = toBase64(derivationSuffixBytes)
                } else if (protocolFlag === 2) {
                  output.protocol = 'basket insertion'
                  output.insertionRemittance = {}

                  // basket
                  const basketLength = paramsReader.readVarIntNumStrict(false)
                  const basketBytes = paramsReader.read(basketLength)
                  output.insertionRemittance.basket = toUTF8Strict(basketBytes)

                  // customInstructions
                  const customInstructionsLength = paramsReader.readVarIntNumStrict()
                  if (customInstructionsLength >= 0) {
                    const customInstructionsBytes = paramsReader.read(customInstructionsLength)
                    output.insertionRemittance.customInstructions =
                      toUTF8Strict(customInstructionsBytes)
                  }

                  // tags
                  const tagsLength = paramsReader.readVarIntNumStrict()
                  if (tagsLength > 0) {
                    this.#requireCollectionLength(
                      paramsReader,
                      tagsLength,
                      'internalizeAction output tags'
                    )
                    output.insertionRemittance.tags = []
                    for (let j = 0; j < tagsLength; j++) {
                      const tagLength = paramsReader.readVarIntNumStrict(false)
                      const tagBytes = paramsReader.read(tagLength)
                      output.insertionRemittance.tags.push(toUTF8Strict(tagBytes))
                    }
                  } else {
                    output.insertionRemittance.tags = []
                  }
                } else {
                  throw new Error(
                    `Invalid internalizeAction protocol flag: expected 1 or 2, received ${protocolFlag}`
                  )
                }

                args.outputs.push(output)
              }
            })()

            const numberOfLabels = paramsReader.readVarIntNumStrict()
            if (numberOfLabels >= 0) {
              this.#requireCollectionLength(
                paramsReader,
                numberOfLabels,
                'internalizeAction labels'
              )
              args.labels = []
              for (let i = 0; i < numberOfLabels; i++) {
                const labelLength = paramsReader.readVarIntNumStrict(false)
                args.labels.push(toUTF8Strict(paramsReader.read(labelLength)))
              }
            }

            const descriptionLength = paramsReader.readVarIntNumStrict(false)
            args.description = toUTF8Strict(paramsReader.read(descriptionLength))

            // Deserialize seekPermission
            args.seekPermission = this.#readOptionalBooleanFlag(paramsReader, 'seekPermission')

            // Call the method
            this.#assertRequestConsumed(paramsReader, callName)
            validateWalletArgs(callName, args)
            const result = await this.#invokeWallet(
              async () => await this.wallet.internalizeAction(args, originator)
            )
            if (result.accepted !== true) throw new Error('The wallet did not accept the action')

            // Return success code and result
            const responseWriter = new WriterUint8Array()
            responseWriter.writeUInt8(0) // errorByte = 0
            return responseWriter.toUint8Array()
          })()

        case 'listOutputs':
          return await (async () => {
            const args: any = {}

            // Deserialize basket
            const basketLength = paramsReader.readVarIntNumStrict(false)
            const basketBytes = paramsReader.read(basketLength)
            args.basket = toUTF8Strict(basketBytes)

            ;(() => {
              // Deserialize tags
              const tagsLength = paramsReader.readVarIntNumStrict()
              if (tagsLength > 0) {
                this.#requireCollectionLength(paramsReader, tagsLength, 'listOutputs tags')
                args.tags = []
                for (let i = 0; i < tagsLength; i++) {
                  const tagLength = paramsReader.readVarIntNumStrict(false)
                  const tagBytes = paramsReader.read(tagLength)
                  args.tags.push(toUTF8Strict(tagBytes))
                }
              } else {
                args.tags = undefined
              }

              // Deserialize tagQueryMode
              const tagQueryModeFlag = paramsReader.readInt8()
              if (tagQueryModeFlag === 1) {
                args.tagQueryMode = 'all'
              } else if (tagQueryModeFlag === 2) {
                args.tagQueryMode = 'any'
              } else if (tagQueryModeFlag === -1) {
                args.tagQueryMode = undefined
              } else {
                throw new Error(
                  `Invalid tagQueryMode flag: expected -1, 1, or 2, received ${tagQueryModeFlag}`
                )
              }

              // Deserialize include
              const includeFlag = paramsReader.readInt8()
              if (includeFlag === 1) {
                args.include = 'locking scripts'
              } else if (includeFlag === 2) {
                args.include = 'entire transactions'
              } else if (includeFlag === -1) {
                args.include = undefined
              } else {
                throw new Error(
                  `Invalid include flag: expected -1, 1, or 2, received ${includeFlag}`
                )
              }
            })()

            ;(() => {
              // Deserialize includeCustomInstructions
              args.includeCustomInstructions = this.#readOptionalBooleanFlag(
                paramsReader,
                'includeCustomInstructions'
              )

              // Deserialize includeTags
              args.includeTags = this.#readOptionalBooleanFlag(paramsReader, 'includeTags')

              // Deserialize includeLabels
              args.includeLabels = this.#readOptionalBooleanFlag(paramsReader, 'includeLabels')

              // Deserialize limit
              const limit = paramsReader.readVarIntNumStrict()
              if (limit >= 0) {
                args.limit = limit
              } else {
                args.limit = undefined
              }

              // Deserialize offset
              const offset = paramsReader.readVarIntNumStrict()
              if (offset >= 0) {
                args.offset = offset
              } else {
                args.offset = undefined
              }

              // Deserialize seekPermission
              args.seekPermission = this.#readOptionalBooleanFlag(paramsReader, 'seekPermission')
            })()

            // Call the method
            this.#assertRequestConsumed(paramsReader, callName)
            validateWalletArgs(callName, args)
            const listOutputsResult = await this.#invokeValidatedWallet(
              callName,
              args,
              async () => await this.wallet.listOutputs(args, originator)
            )
            const outputsPage = this.#requirePageTotal(
              listOutputsResult.totalOutputs,
              listOutputsResult.outputs,
              'listOutputs result'
            )

            // Serialize the result
            const resultWriter = new WriterUint8Array()
            resultWriter.writeUInt8(0) // errorByte = 0

            // totalOutputs
            resultWriter.writeVarIntNum(outputsPage.total)

            // BEEF length and BEEF or -1
            if (listOutputsResult.BEEF == null) {
              resultWriter.writeVarIntNum(-1)
            } else {
              const beef = this.#stableBytes(listOutputsResult.BEEF)
              resultWriter.writeVarIntNum(beef.length)
              resultWriter.write(beef)
            }

            // outputs
            for (const output of outputsPage.records as typeof listOutputsResult.outputs) {
              ;(() => {
                // outpoint
                resultWriter.write(this.#encodeOutpoint(output.outpoint))

                // satoshis
                resultWriter.writeVarIntNum(output.satoshis)

                // lockingScript
                if (output.lockingScript === undefined) {
                  resultWriter.writeVarIntNum(-1)
                } else {
                  const lockingScriptBytes = UtilsToUint8Array(output.lockingScript, 'hex')
                  resultWriter.writeVarIntNum(lockingScriptBytes.length)
                  resultWriter.write(lockingScriptBytes)
                }

                // customInstructions
                if (output.customInstructions === undefined) {
                  resultWriter.writeVarIntNum(-1)
                } else {
                  const customInstructionsBytes = UtilsToUint8Array(
                    output.customInstructions,
                    'utf8'
                  )
                  resultWriter.writeVarIntNum(customInstructionsBytes.length)
                  resultWriter.write(customInstructionsBytes)
                }

                // tags
                if (output.tags === undefined) {
                  resultWriter.writeVarIntNum(-1)
                } else {
                  resultWriter.writeVarIntNum(output.tags.length)
                  for (const tag of output.tags) {
                    const tagBytes = UtilsToUint8Array(tag, 'utf8')
                    resultWriter.writeVarIntNum(tagBytes.length)
                    resultWriter.write(tagBytes)
                  }
                }
              })()

              ;(() => {
                // labels
                if (output.labels === undefined) {
                  resultWriter.writeVarIntNum(-1)
                } else {
                  resultWriter.writeVarIntNum(output.labels.length)
                  for (const label of output.labels) {
                    const labelBytes = UtilsToUint8Array(label, 'utf8')
                    resultWriter.writeVarIntNum(labelBytes.length)
                    resultWriter.write(labelBytes)
                  }
                }
              })()
            }

            return resultWriter.toUint8ArrayZeroCopy()
          })()

        case 'relinquishOutput':
          return await (async () => {
            const args: any = {}

            // Deserialize basket
            const basketLength = paramsReader.readVarIntNumStrict(false)
            const basketBytes = paramsReader.read(basketLength)
            args.basket = toUTF8Strict(basketBytes)

            // Deserialize outpoint
            args.output = this.#decodeOutpoint(paramsReader)

            // Call the method
            this.#assertRequestConsumed(paramsReader, callName)
            validateWalletArgs(callName, args)
            const result = await this.#invokeWallet(
              async () => await this.wallet.relinquishOutput(args, originator)
            )
            if (result.relinquished !== true) {
              throw new Error('The wallet did not relinquish the output')
            }

            // Return success code and result
            const responseWriter = new WriterUint8Array()
            responseWriter.writeUInt8(0) // errorByte = 0
            return responseWriter.toUint8Array()
          })()

        case 'getPublicKey':
          return await (async () => {
            const args: any = {}

            // Deserialize identityKey flag
            args.identityKey = this.#readBooleanFlag(paramsReader, 'identityKey') ? true : undefined

            if (args.identityKey === true) {
              Object.assign(args, this.#decodePrivilegedParams(paramsReader))
            } else {
              Object.assign(args, this.#decodeKeyRelatedParams(paramsReader))

              // Deserialize forSelf
              args.forSelf = this.#readOptionalBooleanFlag(paramsReader, 'forSelf')
            }

            // Deserialize seekPermission
            args.seekPermission = this.#readOptionalBooleanFlag(paramsReader, 'seekPermission')

            // Call the method
            this.#assertRequestConsumed(paramsReader, callName)
            validateWalletArgs(callName, args)
            const getPublicKeyResult = await this.#invokeValidatedWallet(
              callName,
              args,
              async () => await this.wallet.getPublicKey(args, originator)
            )

            // Serialize the result
            const responseWriter = new WriterUint8Array()
            responseWriter.writeUInt8(0) // errorByte = 0
            responseWriter.write(UtilsToUint8Array(getPublicKeyResult.publicKey, 'hex'))
            return responseWriter.toUint8Array()
          })()

        case 'encrypt':
          return await (async () => {
            const args: any = this.#decodeKeyRelatedParams(paramsReader)

            // Deserialize plaintext
            const plaintextLength = paramsReader.readVarIntNumStrict(false)
            args.plaintext = Array.from(paramsReader.read(plaintextLength))

            // Deserialize seekPermission
            args.seekPermission = this.#readOptionalBooleanFlag(paramsReader, 'seekPermission')

            // Call the method
            this.#assertRequestConsumed(paramsReader, callName)
            validateWalletArgs(callName, args)
            const encryptResult = await this.#invokeValidatedWallet(
              callName,
              args,
              async () => await this.wallet.encrypt(args, originator)
            )

            // Serialize the result
            const responseWriter = new WriterUint8Array()
            responseWriter.writeUInt8(0) // errorByte = 0
            responseWriter.write(this.#stableBytes(encryptResult.ciphertext))
            return responseWriter.toUint8Array()
          })()

        case 'decrypt':
          return await (async () => {
            const args: any = this.#decodeKeyRelatedParams(paramsReader)

            // Deserialize ciphertext
            const ciphertextLength = paramsReader.readVarIntNumStrict(false)
            args.ciphertext = Array.from(paramsReader.read(ciphertextLength))

            // Deserialize seekPermission
            args.seekPermission = this.#readOptionalBooleanFlag(paramsReader, 'seekPermission')

            // Call the method
            this.#assertRequestConsumed(paramsReader, callName)
            validateWalletArgs(callName, args)
            const decryptResult = await this.#invokeValidatedWallet(
              callName,
              args,
              async () => await this.wallet.decrypt(args, originator)
            )

            // Serialize the result
            const responseWriter = new WriterUint8Array()
            responseWriter.writeUInt8(0) // errorByte = 0
            responseWriter.write(this.#stableBytes(decryptResult.plaintext))
            return responseWriter.toUint8Array()
          })()

        case 'createHmac':
          return await (async () => {
            const args: any = this.#decodeKeyRelatedParams(paramsReader)

            // Deserialize data
            const dataLength = paramsReader.readVarIntNumStrict(false)
            args.data = Array.from(paramsReader.read(dataLength))

            // Deserialize seekPermission
            args.seekPermission = this.#readOptionalBooleanFlag(paramsReader, 'seekPermission')

            // Call the method
            this.#assertRequestConsumed(paramsReader, callName)
            validateWalletArgs(callName, args)
            const createHmacResult = await this.#invokeWallet(
              async () => await this.wallet.createHmac(args, originator)
            )

            // Serialize the result
            const responseWriter = new WriterUint8Array()
            responseWriter.writeUInt8(0) // errorByte = 0
            responseWriter.write(this.#requireBytes(createHmacResult.hmac, 'createHmac hmac', 32))
            return responseWriter.toUint8Array()
          })()

        case 'verifyHmac':
          return await (async () => {
            const args: any = this.#decodeKeyRelatedParams(paramsReader)

            // Deserialize hmac
            args.hmac = Array.from(paramsReader.read(32))

            // Deserialize data
            const dataLength = paramsReader.readVarIntNumStrict(false)
            args.data = Array.from(paramsReader.read(dataLength))

            // Deserialize seekPermission
            args.seekPermission = this.#readOptionalBooleanFlag(paramsReader, 'seekPermission')

            // Call the method
            this.#assertRequestConsumed(paramsReader, callName)
            validateWalletArgs(callName, args)
            const verifyHmacResult = await this.#invokeWallet(
              async () => await this.wallet.verifyHmac(args, originator)
            )
            if (verifyHmacResult.valid !== true) throw new Error('HMAC is not valid')

            // Serialize the result (no data to return)
            const responseWriter = new WriterUint8Array()
            responseWriter.writeUInt8(0) // errorByte = 0
            return responseWriter.toUint8Array()
          })()

        case 'createSignature':
          return await (async () => {
            const args: any = this.#decodeKeyRelatedParams(paramsReader)

            // Deserialize data or hashToDirectlySign
            const dataTypeFlag = paramsReader.readUInt8()
            if (dataTypeFlag === 1) {
              const dataLength = paramsReader.readVarIntNumStrict(false)
              args.data = Array.from(paramsReader.read(dataLength))
            } else if (dataTypeFlag === 2) {
              args.hashToDirectlySign = Array.from(paramsReader.read(32))
            } else {
              throw new Error(
                `Invalid createSignature data type flag: expected 1 or 2, received ${dataTypeFlag}`
              )
            }

            // Deserialize seekPermission
            args.seekPermission = this.#readOptionalBooleanFlag(paramsReader, 'seekPermission')

            // Call the method
            this.#assertRequestConsumed(paramsReader, callName)
            validateWalletArgs(callName, args)
            const createSignatureResult = await this.#invokeValidatedWallet(
              callName,
              args,
              async () => await this.wallet.createSignature(args, originator)
            )

            // Serialize the result
            const responseWriter = new WriterUint8Array()
            responseWriter.writeUInt8(0) // errorByte = 0
            responseWriter.write(this.#stableBytes(createSignatureResult.signature))
            return responseWriter.toUint8Array()
          })()

        case 'verifySignature':
          return await (async () => {
            const args: any = this.#decodeKeyRelatedParams(paramsReader)

            // Deserialize forSelf
            args.forSelf = this.#readOptionalBooleanFlag(paramsReader, 'forSelf')

            // Deserialize signature
            const signatureLength = paramsReader.readVarIntNumStrict(false)
            args.signature = Array.from(paramsReader.read(signatureLength))

            // Deserialize data or hashToDirectlyVerify
            const dataTypeFlag = paramsReader.readUInt8()
            if (dataTypeFlag === 1) {
              const dataLength = paramsReader.readVarIntNumStrict(false)
              args.data = Array.from(paramsReader.read(dataLength))
            } else if (dataTypeFlag === 2) {
              args.hashToDirectlyVerify = Array.from(paramsReader.read(32))
            } else {
              throw new Error(
                `Invalid verifySignature data type flag: expected 1 or 2, received ${dataTypeFlag}`
              )
            }

            // Deserialize seekPermission
            args.seekPermission = this.#readOptionalBooleanFlag(paramsReader, 'seekPermission')

            // Call the method
            this.#assertRequestConsumed(paramsReader, callName)
            validateWalletArgs(callName, args)
            const verifySignatureResult = await this.#invokeWallet(
              async () => await this.wallet.verifySignature(args, originator)
            )
            if (verifySignatureResult.valid !== true) throw new Error('Signature is not valid')

            // Serialize the result (no data to return)
            const responseWriter = new WriterUint8Array()
            responseWriter.writeUInt8(0) // errorByte = 0
            return responseWriter.toUint8Array()
          })()

        case 'isAuthenticated':
          return await (async () => {
            // No parameters to deserialize

            // Call the method
            this.#assertRequestConsumed(paramsReader, callName)
            validateWalletArgs(callName, {})
            const isAuthenticatedResult = await this.#invokeWallet(
              async () => await this.wallet.isAuthenticated({}, originator)
            )

            // Serialize the result
            const responseWriter = new WriterUint8Array()
            responseWriter.writeUInt8(0) // errorByte = 0
            if (typeof isAuthenticatedResult.authenticated !== 'boolean') {
              throw new Error('Wallet returned an invalid authentication verdict')
            }
            responseWriter.writeUInt8(isAuthenticatedResult.authenticated ? 1 : 0)
            return responseWriter.toUint8Array()
          })()

        case 'waitForAuthentication':
          return await (async () => {
            // No parameters to deserialize

            // Call the method
            this.#assertRequestConsumed(paramsReader, callName)
            validateWalletArgs(callName, {})
            const waitForAuthenticationResult = await this.#invokeWallet(
              async () => await this.wallet.waitForAuthentication({}, originator)
            )
            if (waitForAuthenticationResult.authenticated !== true) {
              throw new Error('Wallet did not affirmatively authenticate')
            }

            // Serialize the result (authenticated is always true)
            const responseWriter = new WriterUint8Array()
            responseWriter.writeUInt8(0) // errorByte = 0
            return responseWriter.toUint8Array()
          })()

        case 'getHeight':
          return await (async () => {
            // No parameters to deserialize

            // Call the method
            this.#assertRequestConsumed(paramsReader, callName)
            validateWalletArgs(callName, {})
            const getHeightResult = await this.#invokeValidatedWallet(
              callName,
              {},
              async () => await this.wallet.getHeight({}, originator)
            )

            // Serialize the result
            const responseWriter = new WriterUint8Array()
            responseWriter.writeUInt8(0) // errorByte = 0
            responseWriter.writeVarIntNum(getHeightResult.height)
            return responseWriter.toUint8Array()
          })()

        case 'getHeaderForHeight':
          return await (async () => {
            const args: any = {}

            // Deserialize height
            args.height = this.#requireInteger(
              paramsReader.readVarIntNumStrict(false),
              'getHeaderForHeight height',
              1,
              0xffffffff
            )

            // Call the method
            this.#assertRequestConsumed(paramsReader, callName)
            validateWalletArgs(callName, args)
            const getHeaderResult = await this.#invokeValidatedWallet(
              callName,
              args,
              async () => await this.wallet.getHeaderForHeight(args, originator)
            )

            // Serialize the result
            const responseWriter = new WriterUint8Array()
            responseWriter.writeUInt8(0) // errorByte = 0
            responseWriter.write(UtilsToUint8Array(getHeaderResult.header, 'hex'))
            return responseWriter.toUint8Array()
          })()

        case 'getNetwork':
          return await (async () => {
            // No parameters to deserialize

            // Call the method
            this.#assertRequestConsumed(paramsReader, callName)
            validateWalletArgs(callName, {})
            const getNetworkResult = await this.#invokeValidatedWallet(
              callName,
              {},
              async () => await this.wallet.getNetwork({}, originator)
            )

            // Serialize the result
            const responseWriter = new WriterUint8Array()
            responseWriter.writeUInt8(0) // errorByte = 0
            responseWriter.writeUInt8(getNetworkResult.network === 'mainnet' ? 0 : 1)
            return responseWriter.toUint8Array()
          })()

        case 'getVersion':
          return await (async () => {
            // No parameters to deserialize

            // Call the method
            this.#assertRequestConsumed(paramsReader, callName)
            validateWalletArgs(callName, {})
            const getVersionResult = await this.#invokeValidatedWallet(
              callName,
              {},
              async () => await this.wallet.getVersion({}, originator)
            )

            // Serialize the result
            const responseWriter = new WriterUint8Array()
            responseWriter.writeUInt8(0) // errorByte = 0
            responseWriter.write(UtilsToUint8Array(getVersionResult.version, 'utf8'))
            return responseWriter.toUint8Array()
          })()

        case 'revealCounterpartyKeyLinkage':
          return await (async () => {
            const args: any = {}

            // Read privileged parameters
            Object.assign(args, this.#decodePrivilegedParams(paramsReader))

            // Read counterparty public key
            const counterpartyBytes = paramsReader.read(33)
            args.counterparty = toHex(counterpartyBytes)

            // Read verifier public key
            const verifierBytes = paramsReader.read(33)
            args.verifier = toHex(verifierBytes)

            // Call the method
            this.#assertRequestConsumed(paramsReader, callName)
            validateWalletArgs(callName, args)
            const revealResult = await this.#invokeValidatedWallet(
              callName,
              args,
              async () => await this.wallet.revealCounterpartyKeyLinkage(args, originator)
            )

            // Serialize the result
            const resultWriter = new WriterUint8Array()

            // Write prover
            resultWriter.write(UtilsToUint8Array(revealResult.prover, 'hex'))

            // Write verifier
            resultWriter.write(UtilsToUint8Array(revealResult.verifier, 'hex'))

            // Write counterparty
            resultWriter.write(UtilsToUint8Array(revealResult.counterparty, 'hex'))

            // Write revelationTime
            const revelationTimeBytes = UtilsToUint8Array(revealResult.revelationTime, 'utf8')
            resultWriter.writeVarIntNum(revelationTimeBytes.length)
            resultWriter.write(revelationTimeBytes)

            // Write encryptedLinkage
            resultWriter.writeVarIntNum(revealResult.encryptedLinkage.length)
            resultWriter.write(revealResult.encryptedLinkage)

            // Write encryptedLinkageProof
            resultWriter.writeVarIntNum(revealResult.encryptedLinkageProof.length)
            resultWriter.write(revealResult.encryptedLinkageProof)

            // Return success code and result
            const responseWriter = new WriterUint8Array()
            responseWriter.writeUInt8(0) // errorByte = 0
            responseWriter.write(resultWriter.toUint8Array())
            return responseWriter.toUint8Array()
          })()

        case 'revealSpecificKeyLinkage':
          return await (async () => {
            // Deserialize key-related parameters and privileged parameters
            const args = this.#decodeKeyRelatedParams(paramsReader)

            // Read verifier public key
            const verifierBytes = paramsReader.read(33)
            args.verifier = toHex(verifierBytes)

            // Call the method
            this.#assertRequestConsumed(paramsReader, callName)
            validateWalletArgs(callName, args)
            const revealResult = await this.#invokeValidatedWallet(
              callName,
              args,
              async () => await this.wallet.revealSpecificKeyLinkage(args, originator)
            )

            // Serialize the result
            const resultWriter = new WriterUint8Array()

            // Write prover
            resultWriter.write(UtilsToUint8Array(revealResult.prover, 'hex'))

            // Write verifier
            resultWriter.write(UtilsToUint8Array(revealResult.verifier, 'hex'))

            // Write counterparty
            resultWriter.write(UtilsToUint8Array(revealResult.counterparty, 'hex'))

            // Write securityLevel
            resultWriter.writeUInt8(revealResult.protocolID[0])

            // Write protocol string
            const protocolBytesOut = UtilsToUint8Array(revealResult.protocolID[1], 'utf8')
            resultWriter.writeVarIntNum(protocolBytesOut.length)
            resultWriter.write(protocolBytesOut)

            // Write keyID
            const keyIDBytesOut = UtilsToUint8Array(revealResult.keyID, 'utf8')
            resultWriter.writeVarIntNum(keyIDBytesOut.length)
            resultWriter.write(keyIDBytesOut)

            // Write encryptedLinkage
            resultWriter.writeVarIntNum(revealResult.encryptedLinkage.length)
            resultWriter.write(revealResult.encryptedLinkage)

            // Write encryptedLinkageProof
            resultWriter.writeVarIntNum(revealResult.encryptedLinkageProof.length)
            resultWriter.write(revealResult.encryptedLinkageProof)

            // Write proofType
            resultWriter.writeUInt8(revealResult.proofType)

            // Return success code and result
            const responseWriter = new WriterUint8Array()
            responseWriter.writeUInt8(0) // errorByte = 0
            responseWriter.write(resultWriter.toUint8Array())
            return responseWriter.toUint8Array()
          })()

        case 'acquireCertificate':
          return await (async () => {
            const args: any = {}

            // Read args.type
            const typeBytes = paramsReader.read(32)
            args.type = toBase64(typeBytes)

            // args.certifier
            const certifierBytes = paramsReader.read(33)
            args.certifier = toHex(certifierBytes)

            // Read fields
            const fieldsLength = this.#requireCollectionLength(
              paramsReader,
              paramsReader.readVarIntNumStrict(false),
              'acquireCertificate fields',
              MAX_WIRE_COLLECTION_ITEMS,
              2
            )
            const fields = new Map<string, string>()
            for (let i = 0; i < fieldsLength; i++) {
              const fieldNameLength = paramsReader.readVarIntNumStrict(false)
              const fieldNameBytes = paramsReader.read(fieldNameLength)
              const fieldName = toUTF8Strict(fieldNameBytes)

              const fieldValueLength = paramsReader.readVarIntNumStrict(false)
              const fieldValueBytes = paramsReader.read(fieldValueLength)
              const fieldValue = toUTF8Strict(fieldValueBytes)

              this.#setUniqueWireEntry(fields, fieldName, fieldValue, 'certificate fields')
            }
            args.fields = this.#recordFromWireEntries(fields, 'certificate fields')

            // Read privileged parameters
            Object.assign(args, this.#decodePrivilegedParams(paramsReader))

            // Read acquisitionProtocol
            const acquisitionProtocolFlag = paramsReader.readUInt8()
            if (acquisitionProtocolFlag === 1) {
              args.acquisitionProtocol = 'direct'
            } else if (acquisitionProtocolFlag === 2) {
              args.acquisitionProtocol = 'issuance'
            } else {
              throw new Error(
                `Invalid acquisitionProtocol flag: expected 1 or 2, received ${acquisitionProtocolFlag}`
              )
            }

            if (args.acquisitionProtocol === 'direct') {
              // args.serialNumber
              const serialNumberBytes = paramsReader.read(32)
              args.serialNumber = toBase64(serialNumberBytes)

              // args.revocationOutpoint
              args.revocationOutpoint = this.#decodeOutpoint(paramsReader)

              // args.signature
              const signatureLength = paramsReader.readVarIntNumStrict(false)
              const signatureBytes = paramsReader.read(signatureLength)
              args.signature = toHex(signatureBytes)

              // args.keyringRevealer
              const keyringRevealerIdentifier = paramsReader.readUInt8()
              if (keyringRevealerIdentifier === 11) {
                args.keyringRevealer = 'certifier'
              } else {
                const keyringRevealerBytes = new Uint8Array(33)
                keyringRevealerBytes[0] = keyringRevealerIdentifier
                keyringRevealerBytes.set(paramsReader.read(32), 1)
                PublicKey.fromDER(Array.from(keyringRevealerBytes))
                args.keyringRevealer = toHex(keyringRevealerBytes)
              }

              // args.keyringForSubject
              const keyringEntriesLength = this.#requireCollectionLength(
                paramsReader,
                paramsReader.readVarIntNumStrict(false),
                'acquireCertificate keyringForSubject',
                MAX_WIRE_COLLECTION_ITEMS,
                2
              )
              const keyringForSubject = new Map<string, string>()
              for (let i = 0; i < keyringEntriesLength; i++) {
                const fieldKeyLength = paramsReader.readVarIntNumStrict(false)
                const fieldKeyBytes = paramsReader.read(fieldKeyLength)
                const fieldKey = toUTF8Strict(fieldKeyBytes)

                const fieldValueLength = paramsReader.readVarIntNumStrict(false)
                const fieldValueBytes = paramsReader.read(fieldValueLength)
                const fieldValue = toBase64(fieldValueBytes)

                this.#setUniqueWireEntry(keyringForSubject, fieldKey, fieldValue, 'subject keyring')
              }
              args.keyringForSubject = this.#recordFromWireEntries(
                keyringForSubject,
                'subject keyring'
              )
            } else {
              // args.certifierUrl
              const certifierUrlLength = paramsReader.readVarIntNumStrict(false)
              const certifierUrlBytes = paramsReader.read(certifierUrlLength)
              args.certifierUrl = toUTF8Strict(certifierUrlBytes)
            }

            // Call the method
            this.#assertRequestConsumed(paramsReader, callName)
            validateWalletArgs(callName, args)
            const acquireResult = await this.#invokeValidatedWallet(
              callName,
              args,
              async () => await this.wallet.acquireCertificate(args, originator)
            )

            // Serialize the certificate (assuming Certificate class is available)
            const cert = new Certificate(
              acquireResult.type,
              acquireResult.serialNumber,
              acquireResult.subject,
              acquireResult.certifier,
              acquireResult.revocationOutpoint,
              acquireResult.fields,
              acquireResult.signature
            )
            const certBin = cert.toBinary()

            // Return success code and certificate binary
            const responseWriter = new WriterUint8Array()
            responseWriter.writeUInt8(0) // errorByte = 0
            responseWriter.write(certBin)
            return responseWriter.toUint8Array()
          })()

        case 'listCertificates':
          return await (async () => {
            const args: any = {}

            ;(() => {
              // Read certifiers
              const certifiersLength = this.#requireCollectionLength(
                paramsReader,
                paramsReader.readVarIntNumStrict(false),
                'listCertificates certifiers',
                MAX_WIRE_COLLECTION_ITEMS,
                33
              )
              args.certifiers = []
              for (let i = 0; i < certifiersLength; i++) {
                const certifierBytes = paramsReader.read(33)
                args.certifiers.push(toHex(certifierBytes))
              }

              // Read types
              const typesLength = this.#requireCollectionLength(
                paramsReader,
                paramsReader.readVarIntNumStrict(false),
                'listCertificates types',
                MAX_WIRE_COLLECTION_ITEMS,
                32
              )
              args.types = []
              for (let i = 0; i < typesLength; i++) {
                const typeBytes = paramsReader.read(32)
                args.types.push(toBase64(typeBytes))
              }

              // Read limit and offset
              const limit = paramsReader.readVarIntNumStrict()
              if (limit >= 0) {
                args.limit = limit
              } else {
                args.limit = undefined
              }

              const offset = paramsReader.readVarIntNumStrict()
              if (offset >= 0) {
                args.offset = offset
              } else {
                args.offset = undefined
              }

              Object.assign(args, this.#decodePrivilegedParams(paramsReader))
            })()

            // Call the method
            this.#assertRequestConsumed(paramsReader, callName)
            validateWalletArgs(callName, args)
            const listResult = await this.#invokeValidatedWallet(
              callName,
              args,
              async () => await this.wallet.listCertificates(args, originator)
            )
            const certificatesPage = this.#requirePageTotal(
              listResult.totalCertificates,
              listResult.certificates,
              'listCertificates result'
            )

            // Serialize the result
            const resultWriter = new WriterUint8Array()

            // totalCertificates
            resultWriter.writeVarIntNum(certificatesPage.total)

            // certificates
            for (const cert of certificatesPage.records as typeof listResult.certificates) {
              ;(() => {
                const certificate = new Certificate(
                  cert.type,
                  cert.serialNumber,
                  cert.subject,
                  cert.certifier,
                  cert.revocationOutpoint,
                  cert.fields,
                  cert.signature
                )
                const certBin = certificate.toBinary()

                // Write certificate binary length and data
                resultWriter.writeVarIntNum(certBin.length)
                resultWriter.write(certBin)

                if (cert.keyring && Object.keys(cert.keyring).length > 0) {
                  resultWriter.writeInt8(1) // Flag indicating keyring is present
                  const keyringEntries = this.#recordEntries(
                    cert.keyring,
                    'listCertificates keyring'
                  )
                  resultWriter.writeVarIntNum(keyringEntries.length)
                  for (const [fieldName, fieldValue] of keyringEntries) {
                    const fieldNameBytes = UtilsToUint8Array(fieldName, 'utf8')
                    resultWriter.writeVarIntNum(fieldNameBytes.length)
                    resultWriter.write(fieldNameBytes)

                    if (typeof fieldValue !== 'string') {
                      throw new Error('Invalid listCertificates keyring value')
                    }
                    const fieldValueBytes = UtilsToUint8Array(fieldValue, 'base64')
                    resultWriter.writeVarIntNum(fieldValueBytes.length)
                    resultWriter.write(fieldValueBytes)
                  }
                } else {
                  resultWriter.writeInt8(0) // Flag indicating no keyring
                }

                if (cert.verifier == null || cert.verifier === '') {
                  resultWriter.writeVarIntNum(0)
                } else {
                  const verifierBytes = UtilsToUint8Array(cert.verifier, 'hex')
                  resultWriter.writeVarIntNum(verifierBytes.length)
                  resultWriter.write(verifierBytes)
                }
              })()
            }

            // Return the response
            const responseWriter = new WriterUint8Array()
            responseWriter.writeUInt8(0) // errorByte = 0
            responseWriter.write(resultWriter.toUint8Array())
            return responseWriter.toUint8Array()
          })()

        case 'proveCertificate':
          return await (async () => {
            const args: any = {}

            // Read certificate
            const cert: any = {}

            // Read type
            const typeBytes = paramsReader.read(32)
            cert.type = toBase64(typeBytes)

            // Read subject
            const subjectBytes = paramsReader.read(33)
            cert.subject = toHex(subjectBytes)

            // Read serialNumber
            const serialNumberBytes = paramsReader.read(32)
            cert.serialNumber = toBase64(serialNumberBytes)

            // Read certifier
            const certifierBytes = paramsReader.read(33)
            cert.certifier = toHex(certifierBytes)

            // Read revocationOutpoint
            cert.revocationOutpoint = this.#decodeOutpoint(paramsReader)

            // Read signature
            const signatureLength = paramsReader.readVarIntNumStrict(false)
            const signatureBytes = paramsReader.read(signatureLength)
            cert.signature = toHex(signatureBytes)

            // Read fields
            const fieldsLength = this.#requireCollectionLength(
              paramsReader,
              paramsReader.readVarIntNumStrict(false),
              'proveCertificate fields',
              MAX_WIRE_COLLECTION_ITEMS,
              2
            )
            const fields = new Map<string, string>()
            for (let i = 0; i < fieldsLength; i++) {
              const fieldNameLength = paramsReader.readVarIntNumStrict(false)
              const fieldNameBytes = paramsReader.read(fieldNameLength)
              const fieldName = toUTF8Strict(fieldNameBytes)

              const fieldValueLength = paramsReader.readVarIntNumStrict(false)
              const fieldValueBytes = paramsReader.read(fieldValueLength)
              const fieldValue = toUTF8Strict(fieldValueBytes)

              this.#setUniqueWireEntry(fields, fieldName, fieldValue, 'certificate fields')
            }
            cert.fields = this.#recordFromWireEntries(fields, 'certificate fields')

            args.certificate = cert

            // Read fields to reveal
            const fieldsToRevealLength = this.#requireCollectionLength(
              paramsReader,
              paramsReader.readVarIntNumStrict(false),
              'proveCertificate fieldsToReveal',
              MAXIMUM_CERTIFICATE_REVEAL_FIELDS
            )
            args.fieldsToReveal = []
            for (let i = 0; i < fieldsToRevealLength; i++) {
              const fieldNameLength = paramsReader.readVarIntNumStrict(false)
              const fieldNameBytes = paramsReader.read(fieldNameLength)
              const fieldName = toUTF8Strict(fieldNameBytes)
              args.fieldsToReveal.push(fieldName)
            }

            // Read verifier
            const verifierBytes = paramsReader.read(33)
            args.verifier = toHex(verifierBytes)

            // Read privileged parameters
            Object.assign(args, this.#decodePrivilegedParams(paramsReader))

            // Call the method
            this.#assertRequestConsumed(paramsReader, callName)
            validateWalletArgs(callName, args)
            const proveResult = await this.#invokeValidatedWallet(
              callName,
              args,
              async () => await this.wallet.proveCertificate(args, originator)
            )

            // Serialize keyringForVerifier
            const resultWriter = new WriterUint8Array()

            const keyringEntries = this.#recordEntries(
              proveResult.keyringForVerifier,
              'proveCertificate keyring'
            )
            resultWriter.writeVarIntNum(keyringEntries.length)
            for (const [fieldName, fieldValue] of keyringEntries) {
              const fieldNameBytes = UtilsToUint8Array(fieldName, 'utf8')
              resultWriter.writeVarIntNum(fieldNameBytes.length)
              resultWriter.write(fieldNameBytes)

              if (typeof fieldValue !== 'string') {
                throw new Error('Invalid proveCertificate keyring value')
              }
              const fieldValueBytes = UtilsToUint8Array(fieldValue, 'base64')
              resultWriter.writeVarIntNum(fieldValueBytes.length)
              resultWriter.write(fieldValueBytes)
            }

            // Return the response
            const responseWriter = new WriterUint8Array()
            responseWriter.writeUInt8(0) // errorByte = 0
            responseWriter.write(resultWriter.toUint8Array())
            return responseWriter.toUint8Array()
          })()

        case 'relinquishCertificate':
          return await (async () => {
            const args: any = {}

            // Read type
            const typeBytes = paramsReader.read(32)
            args.type = toBase64(typeBytes)

            // Read serialNumber
            const serialNumberBytes = paramsReader.read(32)
            args.serialNumber = toBase64(serialNumberBytes)

            // Read certifier
            const certifierBytes = paramsReader.read(33)
            args.certifier = toHex(certifierBytes)

            // Call the method
            this.#assertRequestConsumed(paramsReader, callName)
            validateWalletArgs(callName, args)
            const result = await this.#invokeWallet(
              async () => await this.wallet.relinquishCertificate(args, originator)
            )
            if (result.relinquished !== true) {
              throw new Error('The wallet did not relinquish the certificate')
            }

            // Return success code
            const responseWriter = new WriterUint8Array()
            responseWriter.writeUInt8(0) // errorByte = 0
            return responseWriter.toUint8Array()
          })()

        case 'discoverByIdentityKey':
          return await (async () => {
            const args: any = {}

            // Read identityKey
            const identityKeyBytes = paramsReader.read(33)
            args.identityKey = toHex(identityKeyBytes)

            // Read limit and offset
            const limit = paramsReader.readVarIntNumStrict()
            if (limit >= 0) {
              args.limit = limit
            } else {
              args.limit = undefined
            }

            const offset = paramsReader.readVarIntNumStrict()
            if (offset >= 0) {
              args.offset = offset
            } else {
              args.offset = undefined
            }

            // Deserialize seekPermission
            args.seekPermission = this.#readOptionalBooleanFlag(paramsReader, 'seekPermission')

            // Call the method
            this.#assertRequestConsumed(paramsReader, callName)
            validateWalletArgs(callName, args)
            const discoverResult = await this.#invokeValidatedWallet(
              callName,
              args,
              async () => await this.wallet.discoverByIdentityKey(args, originator)
            )

            // Serialize the result
            const result = this.#serializeDiscoveryResult(discoverResult)

            // Return the response
            const responseWriter = new WriterUint8Array()
            responseWriter.writeUInt8(0) // errorByte = 0
            responseWriter.write(result)
            return responseWriter.toUint8Array()
          })()

        case 'discoverByAttributes':
          return await (async () => {
            const args: any = {}

            // Read attributes
            const attributesLength = this.#requireCollectionLength(
              paramsReader,
              paramsReader.readVarIntNumStrict(false),
              'discoverByAttributes attributes',
              MAXIMUM_DISCOVERY_ATTRIBUTES,
              2
            )
            const attributes = new Map<string, string>()
            for (let i = 0; i < attributesLength; i++) {
              const fieldKeyLength = paramsReader.readVarIntNumStrict(false)
              const fieldKeyBytes = paramsReader.read(fieldKeyLength)
              const fieldKey = toUTF8Strict(fieldKeyBytes)

              const fieldValueLength = paramsReader.readVarIntNumStrict(false)
              const fieldValueBytes = paramsReader.read(fieldValueLength)
              const fieldValue = toUTF8Strict(fieldValueBytes)

              this.#setUniqueWireEntry(attributes, fieldKey, fieldValue, 'attributes')
            }
            args.attributes = this.#recordFromWireEntries(attributes, 'attributes')

            // Read limit and offset
            const limit = paramsReader.readVarIntNumStrict()
            if (limit >= 0) {
              args.limit = limit
            } else {
              args.limit = undefined
            }

            const offset = paramsReader.readVarIntNumStrict()
            if (offset >= 0) {
              args.offset = offset
            } else {
              args.offset = undefined
            }

            // Deserialize seekPermission
            args.seekPermission = this.#readOptionalBooleanFlag(paramsReader, 'seekPermission')

            // Call the method
            this.#assertRequestConsumed(paramsReader, callName)
            validateWalletArgs(callName, args)
            const discoverResult = await this.#invokeValidatedWallet(
              callName,
              args,
              async () => await this.wallet.discoverByAttributes(args, originator)
            )

            // Serialize the result
            const result = this.#serializeDiscoveryResult(discoverResult)

            // Return the response
            const responseWriter = new WriterUint8Array()
            responseWriter.writeUInt8(0) // errorByte = 0
            responseWriter.write(result)
            return responseWriter.toUint8Array()
          })()

        default:
          throw new Error(`Method ${callName} not implemented`)
      }
    } catch (err) {
      const error = err as {
        code?: unknown
        isError?: unknown
        message?: unknown
        name?: unknown
        stack?: unknown
      }
      const responseWriter = new WriterUint8Array()
      const numericCode = Number.isInteger(error.code) ? (error.code as number) : 0
      const errorCode =
        numericCode >= walletErrors.unsupportedAction && numericCode <= walletErrors.abortRefused
          ? numericCode
          : walletErrors.unknownError
      responseWriter.writeUInt8(errorCode)

      // Serialize the error message
      const errorMessage = typeof error.message === 'string' ? error.message : 'Unknown error'
      const errorMessageBytes = UtilsToUint8Array(errorMessage, 'utf8').subarray(
        0,
        MAX_WIRE_ERROR_MESSAGE_BYTES
      )
      responseWriter.writeVarIntNum(errorMessageBytes.length)
      responseWriter.write(errorMessageBytes)

      // Stack traces disclose source paths and implementation details to remote callers.
      responseWriter.writeVarIntNum(0)

      return responseWriter.toUint8Array()
    }
  }

  async #invokeWallet<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (err) {
      const error = err as { code?: unknown; isError?: unknown; name?: unknown }
      const numericCode = Number.isInteger(error.code) ? (error.code as number) : 0
      const isExplicitWalletError =
        err instanceof Error &&
        numericCode >= walletErrors.unsupportedAction &&
        numericCode <= walletErrors.abortRefused &&
        (err instanceof WalletError ||
          (error.isError === true &&
            typeof error.name === 'string' &&
            error.name.startsWith('WERR_')))
      if (isExplicitWalletError) throw err
      throw new WalletError('Wallet operation failed', walletErrors.unknownError)
    }
  }

  async #invokeValidatedWallet<T>(
    call: CallType,
    request: unknown,
    operation: () => Promise<T>
  ): Promise<T> {
    // Snapshot before invoking the wallet. An implementation must not be able
    // to mutate the request while it is pending and then satisfy validation
    // against its own substituted authorization or query context.
    const bindingRequest = snapshotWalletResultRequest(call, request)
    return validateWalletResult(call, await this.#invokeWallet(operation), bindingRequest)
  }

  #assertRequestConsumed(reader: ReaderUint8Array, callName: string): void {
    if (!reader.eof()) {
      throw new Error(`Wallet Wire ${callName} request contains trailing data`)
    }
  }

  #decodeProtocolID(reader: ReaderUint8Array): [SecurityLevel, string] {
    const securityLevel = reader.readUInt8()
    if (securityLevel !== 0 && securityLevel !== 1 && securityLevel !== 2) {
      throw new Error(`Invalid security level: expected 0, 1, or 2, received ${securityLevel}`)
    }
    const protocolLength = reader.readVarIntNumStrict(false)
    const protocolBytes = reader.read(protocolLength)
    const protocolString = toUTF8Strict(protocolBytes)
    return [securityLevel, protocolString]
  }

  #decodeCounterparty(reader: ReaderUint8Array): string | undefined {
    const counterpartyFlag = reader.readUInt8()
    if (counterpartyFlag === 11) {
      return 'self'
    } else if (counterpartyFlag === 12) {
      return 'anyone'
    } else if (counterpartyFlag === 0) {
      return undefined
    } else {
      const counterpartyBytes = Uint8Array.from([counterpartyFlag, ...reader.read(32)])
      PublicKey.fromDER(Array.from(counterpartyBytes))
      return toHex(counterpartyBytes)
    }
  }

  #decodePrivilegedParams(reader: ReaderUint8Array): {
    privileged: boolean | undefined
    privilegedReason: string | undefined
  } {
    const privileged = this.#readOptionalBooleanFlag(reader, 'privileged')
    const privilegedReasonLength = this.#readOptionalInt8Length(reader, 'privilegedReason')
    const privilegedReason =
      privilegedReasonLength === undefined
        ? undefined
        : toUTF8Strict(reader.read(privilegedReasonLength))
    return { privileged, privilegedReason }
  }

  #serializeDiscoveryResult(discoverResult: any): Uint8Array {
    const resultWriter = new WriterUint8Array()
    const certificatesPage = this.#requirePageTotal(
      discoverResult.totalCertificates,
      discoverResult.certificates,
      'discovery result'
    )

    // totalCertificates
    resultWriter.writeVarIntNum(certificatesPage.total)

    // certificates
    for (const cert of certificatesPage.records) {
      // Serialize certificate binary
      const certificate = new Certificate(
        cert.type,
        cert.serialNumber,
        cert.subject,
        cert.certifier,
        cert.revocationOutpoint,
        cert.fields,
        cert.signature
      )
      const certBin = certificate.toBinary()

      // Write certificate binary length and data
      resultWriter.writeVarIntNum(certBin.length)
      resultWriter.write(certBin)

      // Serialize certifierInfo
      const nameBytes = UtilsToUint8Array(cert.certifierInfo.name, 'utf8')
      resultWriter.writeVarIntNum(nameBytes.length)
      resultWriter.write(nameBytes)

      const iconUrlBytes = UtilsToUint8Array(cert.certifierInfo.iconUrl, 'utf8')
      resultWriter.writeVarIntNum(iconUrlBytes.length)
      resultWriter.write(iconUrlBytes)

      const descriptionBytes = UtilsToUint8Array(cert.certifierInfo.description, 'utf8')
      resultWriter.writeVarIntNum(descriptionBytes.length)
      resultWriter.write(descriptionBytes)

      resultWriter.writeUInt8(cert.certifierInfo.trust)

      // Serialize publiclyRevealedKeyring
      const publicKeyringEntries = this.#recordEntries(
        cert.publiclyRevealedKeyring,
        'discovery public keyring'
      )
      resultWriter.writeVarIntNum(publicKeyringEntries.length)
      for (const [fieldName, fieldValue] of publicKeyringEntries) {
        const fieldNameBytes = UtilsToUint8Array(fieldName, 'utf8')
        resultWriter.writeVarIntNum(fieldNameBytes.length)
        resultWriter.write(fieldNameBytes)

        if (typeof fieldValue !== 'string') {
          throw new Error('Invalid discovery public keyring value')
        }
        const fieldValueBytes = UtilsToUint8Array(fieldValue, 'base64')
        resultWriter.writeVarIntNum(fieldValueBytes.length)
        resultWriter.write(fieldValueBytes)
      }

      // Serialize decryptedFields
      const decryptedFieldEntries = this.#recordEntries(
        cert.decryptedFields,
        'discovery decrypted fields'
      )
      resultWriter.writeVarIntNum(decryptedFieldEntries.length)
      for (const [fieldName, fieldValue] of decryptedFieldEntries) {
        const fieldNameBytes = UtilsToUint8Array(fieldName, 'utf8')
        resultWriter.writeVarIntNum(fieldNameBytes.length)
        resultWriter.write(fieldNameBytes)

        if (typeof fieldValue !== 'string') {
          throw new Error('Invalid discovery decrypted field value')
        }
        const fieldValueBytes = UtilsToUint8Array(fieldValue, 'utf8')
        resultWriter.writeVarIntNum(fieldValueBytes.length)
        resultWriter.write(fieldValueBytes)
      }
    }

    return resultWriter.toUint8Array()
  }

  #decodeKeyRelatedParams(paramsReader: ReaderUint8Array): any {
    const args: any = {}

    // Read protocolID
    args.protocolID = this.#decodeProtocolID(paramsReader)

    // Read keyID
    const keyIDLength = paramsReader.readVarIntNumStrict(false)
    const keyIDBytes = paramsReader.read(keyIDLength)
    args.keyID = toUTF8Strict(keyIDBytes)

    // Read counterparty
    args.counterparty = this.#decodeCounterparty(paramsReader)

    // Read privileged parameters
    Object.assign(args, this.#decodePrivilegedParams(paramsReader))

    return args
  }
}
