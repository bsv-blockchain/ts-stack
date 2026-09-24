import {
  AcquireCertificateArgs,
  AcquireCertificateResult,
  SecurityLevel,
  SecurityLevels,
  Base64String,
  BasketStringUnder300Bytes,
  BooleanDefaultFalse,
  BooleanDefaultTrue,
  Byte,
  CertificateFieldNameUnder50Bytes,
  CertificateResult,
  CreateActionArgs,
  CreateActionResult,
  DescriptionString5to50Bytes,
  DiscoverCertificatesResult,
  EntityIconURLStringMax500Bytes,
  EntityNameStringMax100Bytes,
  HexString,
  InternalizeActionArgs,
  ISOTimestampString,
  KeyIDStringUnder800Bytes,
  LabelStringUnder300Bytes,
  ListActionsArgs,
  ListActionsResult,
  ListCertificatesResult,
  ListOutputsArgs,
  ListOutputsResult,
  OriginatorDomainNameStringUnder250Bytes,
  OutpointString,
  OutputTagStringUnder300Bytes,
  PositiveInteger,
  PositiveIntegerDefault10Max10000,
  PositiveIntegerMax10,
  PositiveIntegerOrZero,
  ProtocolString5To400Bytes,
  ProveCertificateArgs,
  ProveCertificateResult,
  PubKeyHex,
  SatoshiValue,
  SignActionArgs,
  SignActionResult,
  TXIDHexString,
  VersionString7To30Bytes,
  WalletInterface,
  ActionStatus,
  SendWithResultStatus
} from '../Wallet.interfaces.js'
import WalletWire, { MAX_WALLET_WIRE_FRAME_BYTES } from './WalletWire.js'
import Certificate from '../../auth/certificates/Certificate.js'
import {
  ReaderUint8Array,
  WriterUint8Array,
  toBase64,
  toHex,
  toUTF8Strict,
  toUint8Array as UtilsToUint8Array
} from '../../primitives/utils.js'
import calls, { CallType } from './WalletWireCalls.js'
import { WalletError, walletErrors } from '../WalletError.js'
import PublicKey from '../../primitives/PublicKey.js'
import { validateOriginator } from '../validationHelpers.js'
import { validateWalletArgs } from '../WalletArgumentValidation.js'
import { snapshotWalletResultRequest, validateWalletResult } from '../WalletResultValidation.js'
import { isUnsafeRecordKey } from '../../primitives/SafeRecord.js'

const MAX_WIRE_RESPONSE_COLLECTION_ITEMS = 100_000

const ACTION_STATUS_MAP: Record<number, ActionStatus> = {
  1: 'completed',
  2: 'unprocessed',
  3: 'sending',
  4: 'unproven',
  5: 'unsigned',
  6: 'nosend',
  7: 'nonfinal',
  8: 'failed'
}

/**
 * A way to make remote calls to a wallet over a wallet wire.
 */
export default class WalletWireTransceiver implements WalletInterface {
  wire: WalletWire

  constructor(wire: WalletWire) {
    this.wire = wire
  }

  async #transmit(
    call: CallType,
    originator: OriginatorDomainNameStringUnder250Bytes = '',
    params: readonly number[] | Uint8Array = []
  ): Promise<Uint8Array> {
    const normalizedOriginator = originator === '' ? '' : validateOriginator(originator)!
    const originatorArray = UtilsToUint8Array(normalizedOriginator, 'utf8')
    const frameWriter = new WriterUint8Array(undefined, 2 + originatorArray.length + params.length)
    frameWriter.writeUInt8(calls[call])
    frameWriter.writeUInt8(originatorArray.length)
    frameWriter.write(originatorArray)
    if (params.length > 0) {
      frameWriter.write(params)
    }
    const frame = frameWriter.toUint8ArrayZeroCopy()
    if (frame.length > MAX_WALLET_WIRE_FRAME_BYTES) {
      throw new Error('Wallet Wire request exceeds the maximum permitted size')
    }
    let result: Uint8Array
    if (this.wire.transmitToWalletUint8Array === undefined) {
      const legacyResult: unknown = await this.wire.transmitToWallet(Array.from(frame))
      if (!Array.isArray(legacyResult) || legacyResult.length > MAX_WALLET_WIRE_FRAME_BYTES) {
        throw new Error('Wallet Wire response exceeds the maximum permitted size')
      }
      for (let i = 0; i < legacyResult.length; i++) {
        if (
          !Object.prototype.hasOwnProperty.call(legacyResult, i) ||
          !Number.isInteger(legacyResult[i]) ||
          legacyResult[i] < 0 ||
          legacyResult[i] > 255
        ) {
          throw new Error('Wallet Wire response must be a dense byte array')
        }
      }
      result = Uint8Array.from(legacyResult)
    } else {
      const compactResult: unknown = await this.wire.transmitToWalletUint8Array(frame)
      if (
        !(compactResult instanceof Uint8Array) ||
        compactResult.length > MAX_WALLET_WIRE_FRAME_BYTES
      ) {
        throw new Error('Wallet Wire response exceeds the maximum permitted size')
      }
      result = compactResult
    }
    const resultReader = new ReaderUint8Array(result)
    const errorByte = resultReader.readUInt8()
    if (errorByte === 0) {
      const resultFrame = resultReader.readView()
      return resultFrame
    } else {
      // Deserialize the error message length
      const errorMessageLength = resultReader.readVarIntNumStrict(false)
      const errorMessageBytes = resultReader.read(errorMessageLength)
      const errorMessage = toUTF8Strict(errorMessageBytes)

      // Deserialize the stack trace length
      const stackTraceLength = resultReader.readVarIntNumStrict(false)
      const stackTraceBytes = resultReader.read(stackTraceLength)
      const stackTrace = toUTF8Strict(stackTraceBytes)
      this.#assertResponseConsumed(resultReader, call)

      // Construct a custom wallet error
      const e = new WalletError(errorMessage, errorByte, stackTrace)
      throw e
    }
  }

  async createAction(
    args: CreateActionArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<CreateActionResult> {
    validateWalletArgs('createAction', args)
    const bindingRequest = snapshotWalletResultRequest('createAction', args)
    const paramWriter = new WriterUint8Array(
      undefined,
      Math.max(
        256,
        Math.ceil(
          (args.inputBEEF?.length ?? 0) +
            (args.inputs ?? []).reduce(
              (sum, input) => sum + (input.unlockingScript?.length ?? 0) / 2,
              0
            ) +
            (args.outputs ?? []).reduce((sum, output) => sum + output.lockingScript.length / 2, 0) +
            4096
        )
      )
    )

    // Serialize description
    this.#writeUTF8(paramWriter, args.description)

    // input BEEF
    if (args.inputBEEF == null) {
      paramWriter.writeVarIntNum(-1)
    } else {
      paramWriter.writeVarIntNum(args.inputBEEF.length)
      paramWriter.write(args.inputBEEF)
    }

    // Serialize inputs
    if (args.inputs == null) {
      paramWriter.writeVarIntNum(-1)
    } else {
      paramWriter.writeVarIntNum(args.inputs.length)
      for (const input of args.inputs) {
        this.#serializeCreateActionInput(paramWriter, input)
      }
    }

    // Serialize outputs
    if (args.outputs == null) {
      paramWriter.writeVarIntNum(-1)
    } else {
      paramWriter.writeVarIntNum(args.outputs.length)
      for (const output of args.outputs) {
        this.#serializeCreateActionOutput(paramWriter, output)
      }
    }

    // Serialize lockTime, version
    this.#writeOptionalVarInt(paramWriter, args.lockTime)
    this.#writeOptionalVarInt(paramWriter, args.version)

    // Serialize labels
    this.#writeUTF8Array(paramWriter, args.labels)

    // Serialize options
    this.#serializeCreateActionOptions(paramWriter, args.options)

    // Transmit and parse response
    const result = await this.#transmit(
      'createAction',
      originator,
      paramWriter.toUint8ArrayZeroCopy()
    )
    return validateWalletResult(
      'createAction',
      this.#parseCreateActionResult(result),
      bindingRequest
    )
  }

  #parseCreateActionResult(result: Uint8Array): CreateActionResult {
    const resultReader = new ReaderUint8Array(result)
    const response: CreateActionResult = {}

    if (this.#readBooleanFlag(resultReader, 'createAction txid present')) {
      response.txid = toHex(resultReader.read(32))
    }

    if (this.#readBooleanFlag(resultReader, 'createAction tx present')) {
      response.tx = resultReader.readView(resultReader.readVarIntNumStrict(false))
    }

    const noSendChangeLength = resultReader.readVarIntNumStrict()
    if (noSendChangeLength >= 0) {
      this.#requireResponseCollectionLength(
        resultReader,
        noSendChangeLength,
        'createAction noSendChange',
        33
      )
      response.noSendChange = []
      for (let i = 0; i < noSendChangeLength; i++) {
        response.noSendChange.push(this.#readOutpoint(resultReader))
      }
    }

    const sendWithResults = this.#readSendWithResults(resultReader)
    if (sendWithResults != null) response.sendWithResults = sendWithResults

    if (this.#readBooleanFlag(resultReader, 'createAction signableTransaction present')) {
      const tx = resultReader.readView(resultReader.readVarIntNumStrict(false))
      const referenceBytes = resultReader.read(resultReader.readVarIntNumStrict(false))
      response.signableTransaction = { tx, reference: toBase64(referenceBytes) }
    }

    this.#assertResponseConsumed(resultReader, 'createAction')
    return response
  }

  async signAction(
    args: SignActionArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<SignActionResult> {
    validateWalletArgs('signAction', args)
    const bindingRequest = snapshotWalletResultRequest('signAction', args)
    const paramWriter = new WriterUint8Array()

    // Serialize spends
    const spendIndexes = Object.keys(args.spends)
    paramWriter.writeVarIntNum(spendIndexes.length)
    for (const index of spendIndexes) {
      paramWriter.writeVarIntNum(Number(index))
      const spend = args.spends[Number(index)]
      const unlockingScriptBytes = UtilsToUint8Array(spend.unlockingScript, 'hex')
      paramWriter.writeVarIntNum(unlockingScriptBytes.length)
      paramWriter.write(unlockingScriptBytes)
      this.#writeOptionalVarInt(paramWriter, spend.sequenceNumber)
    }

    // Serialize reference
    const referenceBytes = UtilsToUint8Array(args.reference, 'base64')
    paramWriter.writeVarIntNum(referenceBytes.length)
    paramWriter.write(referenceBytes)

    // Serialize options
    this.#serializeSignActionOptions(paramWriter, args.options)

    // Transmit and parse response
    const result = await this.#transmit(
      'signAction',
      originator,
      paramWriter.toUint8ArrayZeroCopy()
    )
    const resultReader = new ReaderUint8Array(result)

    const response: SignActionResult = {}
    if (this.#readBooleanFlag(resultReader, 'signAction txid present')) {
      response.txid = toHex(resultReader.read(32))
    }
    if (this.#readBooleanFlag(resultReader, 'signAction tx present')) {
      response.tx = resultReader.readView(resultReader.readVarIntNumStrict(false))
    }
    const sendWithResults = this.#readSendWithResults(resultReader)
    if (sendWithResults != null) response.sendWithResults = sendWithResults

    this.#assertResponseConsumed(resultReader, 'signAction')
    return validateWalletResult('signAction', response, bindingRequest)
  }

  async abortAction(
    args: { reference: Base64String },
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<{ aborted: boolean }> {
    validateWalletArgs('abortAction', args)
    try {
      const result = await this.#transmit(
        'abortAction',
        originator,
        UtilsToUint8Array(args.reference, 'base64')
      )
      this.#requireEmptyResponse(result, 'abortAction')
      return { aborted: true }
    } catch (error) {
      if (error instanceof WalletError && error.code === walletErrors.abortRefused) {
        return { aborted: false }
      }
      throw error
    }
  }

  async listActions(
    args: ListActionsArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<ListActionsResult> {
    validateWalletArgs('listActions', args)
    const paramWriter = new WriterUint8Array()

    // Serialize labels (always-present array, no -1 sentinel)
    paramWriter.writeVarIntNum(args.labels.length)
    for (const label of args.labels) {
      this.#writeUTF8(paramWriter, label)
    }

    // Serialize labelQueryMode
    if (args.labelQueryMode === 'any') paramWriter.writeInt8(1)
    else if (args.labelQueryMode === 'all') paramWriter.writeInt8(2)
    else paramWriter.writeInt8(-1)

    // Serialize include options
    for (const option of [
      args.includeLabels,
      args.includeInputs,
      args.includeInputSourceLockingScripts,
      args.includeInputUnlockingScripts,
      args.includeOutputs,
      args.includeOutputLockingScripts
    ]) {
      this.#writeOptionalBool(paramWriter, option)
    }

    this.#writeOptionalVarInt(paramWriter, args.limit)
    this.#writeOptionalVarInt(paramWriter, args.offset)
    this.#writeOptionalBool(paramWriter, args.seekPermission)

    const result = await this.#transmit('listActions', originator, paramWriter.toUint8Array())
    const resultReader = new ReaderUint8Array(result)
    const totalActions = this.#requireInteger(
      resultReader.readVarIntNumStrict(false),
      'listActions totalActions',
      0,
      0xffffffff
    )
    const actions: ListActionsResult['actions'] = []
    while (!resultReader.eof()) {
      this.#requirePageCapacity(actions.length, args.limit, 'listActions')
      actions.push(this.#parseAction(resultReader))
    }
    this.#assertPageCount(actions.length, totalActions, 'listActions')
    return { totalActions, actions }
  }

  #parseActionStatus(code: number): ActionStatus {
    const status = ACTION_STATUS_MAP[code]
    if (status == null) throw new Error(`Unknown status code: ${code}`)
    return status
  }

  #readActionSatoshis(reader: ReaderUint8Array): number {
    // Action history is a signed net amount. Legacy wallet wire encodes negative
    // values as 0xff followed by signed little-endian int64. This exception is
    // field-specific: counts, lengths and individual output values stay unsigned.
    let value: number
    if (
      reader.remaining() >= 9 &&
      reader.bin[reader.pos] === 0xff &&
      reader.bin[reader.pos + 8] >= 0x80
    ) {
      reader.skip(1)
      value = reader.readInt64LEBn().toNumber()
    } else {
      value = reader.readVarIntNumStrict(false)
    }
    return this.#requireInteger(value, 'listActions satoshis', -21e14, 21e14)
  }

  #parseAction(reader: ReaderUint8Array): ListActionsResult['actions'][number] {
    const txid = toHex(reader.read(32))
    const satoshis = this.#readActionSatoshis(reader)
    const status = this.#parseActionStatus(reader.readInt8())
    const isOutgoing = this.#readBooleanFlag(reader, 'listActions isOutgoing')
    const description = toUTF8Strict(reader.read(reader.readVarIntNumStrict(false)))

    const action: any = { txid, satoshis, status, isOutgoing, description, version: 0, lockTime: 0 }

    const labelsLen = reader.readVarIntNumStrict()
    if (labelsLen >= 0) {
      this.#requireResponseCollectionLength(reader, labelsLen, 'listActions labels')
      action.labels = []
      for (let j = 0; j < labelsLen; j++) {
        action.labels.push(toUTF8Strict(reader.read(reader.readVarIntNumStrict(false))))
      }
    }

    action.version = this.#requireInteger(
      reader.readVarIntNumStrict(false),
      'listActions version',
      0,
      0xffffffff
    )
    action.lockTime = this.#requireInteger(
      reader.readVarIntNumStrict(false),
      'listActions lockTime',
      0,
      0xffffffff
    )

    const inputsLen = reader.readVarIntNumStrict()
    if (inputsLen >= 0) {
      this.#requireResponseCollectionLength(reader, inputsLen, 'listActions inputs')
      action.inputs = []
      for (let k = 0; k < inputsLen; k++) {
        action.inputs.push(this.#parseActionInput(reader))
      }
    }

    const outputsLen = reader.readVarIntNumStrict()
    if (outputsLen >= 0) {
      this.#requireResponseCollectionLength(reader, outputsLen, 'listActions outputs')
      action.outputs = []
      for (let l = 0; l < outputsLen; l++) {
        action.outputs.push(this.#parseActionOutput(reader))
      }
    }

    return action
  }

  #parseActionInput(reader: ReaderUint8Array): {
    sourceOutpoint: OutpointString
    sourceSatoshis: SatoshiValue
    sourceLockingScript?: HexString
    unlockingScript?: HexString
    inputDescription: DescriptionString5to50Bytes
    sequenceNumber: PositiveIntegerOrZero
  } {
    const sourceOutpoint = this.#readOutpoint(reader)
    const sourceSatoshis = this.#requireInteger(
      reader.readVarIntNumStrict(false),
      'listActions input sourceSatoshis',
      0,
      21e14
    )
    const srcLockLen = reader.readVarIntNumStrict()
    const sourceLockingScript = srcLockLen >= 0 ? toHex(reader.read(srcLockLen)) : undefined
    const unlockLen = reader.readVarIntNumStrict()
    const unlockingScript = unlockLen >= 0 ? toHex(reader.read(unlockLen)) : undefined
    const inputDescription = toUTF8Strict(reader.read(reader.readVarIntNumStrict(false)))
    const sequenceNumber = this.#requireInteger(
      reader.readVarIntNumStrict(false),
      'listActions input sequenceNumber',
      0,
      0xffffffff
    )
    return {
      sourceOutpoint,
      sourceSatoshis,
      sourceLockingScript,
      unlockingScript,
      inputDescription,
      sequenceNumber
    }
  }

  #parseActionOutput(reader: ReaderUint8Array): {
    outputIndex: PositiveIntegerOrZero
    satoshis: SatoshiValue
    lockingScript?: HexString
    spendable: boolean
    outputDescription: DescriptionString5to50Bytes
    basket: BasketStringUnder300Bytes
    tags: OutputTagStringUnder300Bytes[]
    customInstructions?: string
  } {
    const outputIndex = this.#requireInteger(
      reader.readVarIntNumStrict(false),
      'listActions output outputIndex',
      0,
      0xffffffff
    )
    const satoshis = this.#requireInteger(
      reader.readVarIntNumStrict(false),
      'listActions output satoshis',
      0,
      21e14
    )
    const lockLen = reader.readVarIntNumStrict()
    const lockingScript = lockLen >= 0 ? toHex(reader.read(lockLen)) : undefined
    const spendable = this.#readBooleanFlag(reader, 'listOutputs spendable')
    const outputDescription = toUTF8Strict(reader.read(reader.readVarIntNumStrict(false)))
    const basketLen = reader.readVarIntNumStrict()
    const basket = basketLen >= 0 ? toUTF8Strict(reader.read(basketLen)) : undefined
    const tagsLen = reader.readVarIntNumStrict()
    const tags: string[] = []
    if (tagsLen >= 0) {
      this.#requireResponseCollectionLength(reader, tagsLen, 'listActions output tags')
      for (let m = 0; m < tagsLen; m++) {
        tags.push(toUTF8Strict(reader.read(reader.readVarIntNumStrict(false))))
      }
    }
    const custLen = reader.readVarIntNumStrict()
    const customInstructions = custLen >= 0 ? toUTF8Strict(reader.read(custLen)) : undefined
    return {
      outputIndex,
      satoshis,
      lockingScript,
      spendable,
      outputDescription,
      basket: basket as BasketStringUnder300Bytes,
      tags,
      customInstructions
    }
  }

  async internalizeAction(
    args: InternalizeActionArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<{ accepted: true }> {
    validateWalletArgs('internalizeAction', args)
    const paramWriter = new WriterUint8Array(undefined, Math.max(256, args.tx.length + 4096))
    paramWriter.writeVarIntNum(args.tx.length)
    paramWriter.write(args.tx)
    paramWriter.writeVarIntNum(args.outputs.length)
    for (const out of args.outputs) {
      this.#serializeInternalizeOutput(paramWriter, out)
    }
    this.#writeUTF8Array(paramWriter, typeof args.labels === 'object' ? args.labels : undefined)
    const descriptionAsArray = UtilsToUint8Array(args.description)
    paramWriter.writeVarIntNum(descriptionAsArray.length)
    paramWriter.write(descriptionAsArray)
    this.#writeOptionalBool(paramWriter, args.seekPermission)
    const result = await this.#transmit(
      'internalizeAction',
      originator,
      paramWriter.toUint8ArrayZeroCopy()
    )
    this.#requireEmptyResponse(result, 'internalizeAction')
    return { accepted: true }
  }

  #serializeInternalizeOutput(
    writer: WriterUint8Array,
    out: InternalizeActionArgs['outputs'][number]
  ): void {
    writer.writeVarIntNum(out.outputIndex)
    if (out.protocol === 'wallet payment') {
      if (out.paymentRemittance == null) {
        throw new Error('Payment remittance is required for wallet payment')
      }
      writer.writeUInt8(1)
      writer.write(UtilsToUint8Array(out.paymentRemittance.senderIdentityKey, 'hex'))
      const prefix = UtilsToUint8Array(out.paymentRemittance.derivationPrefix, 'base64')
      writer.writeVarIntNum(prefix.length)
      writer.write(prefix)
      const suffix = UtilsToUint8Array(out.paymentRemittance.derivationSuffix, 'base64')
      writer.writeVarIntNum(suffix.length)
      writer.write(suffix)
    } else {
      writer.writeUInt8(2)
      const basket = UtilsToUint8Array(out.insertionRemittance?.basket, 'utf8')
      writer.writeVarIntNum(basket.length)
      writer.write(basket)
      this.#writeOptionalUTF8(writer, out.insertionRemittance?.customInstructions)
      const tags = out.insertionRemittance?.tags
      if (typeof tags === 'object') {
        writer.writeVarIntNum(tags.length)
        for (const tag of tags) {
          const t = UtilsToUint8Array(tag, 'utf8')
          writer.writeVarIntNum(t.length)
          writer.write(t)
        }
      } else {
        writer.writeVarIntNum(0)
      }
    }
  }

  async listOutputs(
    args: ListOutputsArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<ListOutputsResult> {
    validateWalletArgs('listOutputs', args)
    const bindingRequest = snapshotWalletResultRequest('listOutputs', args)
    const paramWriter = new WriterUint8Array()
    this.#writeUTF8(paramWriter, args.basket)
    if (typeof args.tags === 'object') {
      paramWriter.writeVarIntNum(args.tags.length)
      for (const tag of args.tags) {
        this.#writeUTF8(paramWriter, tag)
      }
    } else {
      paramWriter.writeVarIntNum(0)
    }
    if (args.tagQueryMode === 'all') paramWriter.writeInt8(1)
    else if (args.tagQueryMode === 'any') paramWriter.writeInt8(2)
    else paramWriter.writeInt8(-1)
    if (args.include === 'locking scripts') paramWriter.writeInt8(1)
    else if (args.include === 'entire transactions') paramWriter.writeInt8(2)
    else paramWriter.writeInt8(-1)
    this.#writeOptionalBool(paramWriter, args.includeCustomInstructions)
    this.#writeOptionalBool(paramWriter, args.includeTags)
    this.#writeOptionalBool(paramWriter, args.includeLabels)
    this.#writeOptionalVarInt(paramWriter, args.limit)
    this.#writeOptionalVarInt(paramWriter, args.offset)
    this.#writeOptionalBool(paramWriter, args.seekPermission)

    const result = await this.#transmit('listOutputs', originator, paramWriter.toUint8Array())
    const resultReader = new ReaderUint8Array(result)
    const totalOutputs = this.#requireInteger(
      resultReader.readVarIntNumStrict(false),
      'listOutputs totalOutputs',
      0,
      0xffffffff
    )
    const beefLength = resultReader.readVarIntNumStrict()
    const BEEF = beefLength >= 0 ? resultReader.readView(beefLength) : undefined
    const outputs: ListOutputsResult['outputs'] = []
    while (!resultReader.eof()) {
      this.#requirePageCapacity(outputs.length, args.limit, 'listOutputs')
      outputs.push(this.#parseListOutputEntry(resultReader))
    }
    this.#assertPageCount(outputs.length, totalOutputs, 'listOutputs')
    return validateWalletResult('listOutputs', { totalOutputs, BEEF, outputs }, bindingRequest)
  }

  #parseListOutputEntry(reader: ReaderUint8Array): ListOutputsResult['outputs'][number] {
    const outpoint = this.#readOutpoint(reader)
    const satoshis = this.#requireInteger(
      reader.readVarIntNumStrict(false),
      'listOutputs satoshis',
      0,
      21e14
    )
    const output: ListOutputsResult['outputs'][number] = { spendable: true, outpoint, satoshis }
    const scriptLen = reader.readVarIntNumStrict()
    if (scriptLen >= 0) output.lockingScript = toHex(reader.read(scriptLen))
    const custLen = reader.readVarIntNumStrict()
    if (custLen >= 0) output.customInstructions = toUTF8Strict(reader.read(custLen))
    const tagsLen = reader.readVarIntNumStrict()
    if (tagsLen !== -1) {
      this.#requireResponseCollectionLength(reader, tagsLen, 'listOutputs tags')
      const tags: OutputTagStringUnder300Bytes[] = []
      for (let i = 0; i < tagsLen; i++) {
        tags.push(toUTF8Strict(reader.read(reader.readVarIntNumStrict(false))))
      }
      output.tags = tags
    }
    const labelsLen = reader.readVarIntNumStrict()
    if (labelsLen !== -1) {
      this.#requireResponseCollectionLength(reader, labelsLen, 'listOutputs labels')
      const labels: LabelStringUnder300Bytes[] = []
      for (let i = 0; i < labelsLen; i++) {
        labels.push(toUTF8Strict(reader.read(reader.readVarIntNumStrict(false))))
      }
      output.labels = labels
    }
    return output
  }

  async relinquishOutput(
    args: { basket: BasketStringUnder300Bytes; output: OutpointString },
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<{ relinquished: true }> {
    validateWalletArgs('relinquishOutput', args)
    const paramWriter = new WriterUint8Array()
    const basketAsArray = UtilsToUint8Array(args.basket, 'utf8')
    paramWriter.writeVarIntNum(basketAsArray.length)
    paramWriter.write(basketAsArray)
    paramWriter.write(this.#encodeOutpoint(args.output))
    const result = await this.#transmit('relinquishOutput', originator, paramWriter.toUint8Array())
    this.#requireEmptyResponse(result, 'relinquishOutput')
    return { relinquished: true }
  }

  #encodeOutpoint(outpoint: OutpointString): Uint8Array {
    const writer = new WriterUint8Array()
    if (typeof outpoint !== 'string') throw new Error('Invalid outpoint: expected a string')
    const parts = outpoint.split('.')
    if (parts.length !== 2 || !/^(?:0|[1-9]\d*)$/.test(parts[1])) {
      throw new Error(`Invalid outpoint: ${outpoint}`)
    }
    const txid = UtilsToUint8Array(parts[0], 'hex')
    if (txid.length !== 32) throw new Error('Invalid outpoint txid length')
    writer.write(txid)
    writer.writeVarIntNum(this.#requireInteger(Number(parts[1]), 'outpoint index', 0, 0xffffffff))
    return writer.toUint8Array()
  }

  #readOutpoint(reader: ReaderUint8Array): OutpointString {
    const txid = toHex(reader.read(32))
    const index = this.#requireInteger(
      reader.readVarIntNumStrict(false),
      'outpoint index',
      0,
      0xffffffff
    )
    return `${txid}.${index}`
  }

  async getPublicKey(
    args: {
      seekPermission?: BooleanDefaultTrue
      identityKey?: true
      protocolID?: [SecurityLevel, ProtocolString5To400Bytes]
      keyID?: KeyIDStringUnder800Bytes
      privileged?: BooleanDefaultFalse
      privilegedReason?: DescriptionString5to50Bytes
      counterparty?: PubKeyHex
      forSelf?: BooleanDefaultFalse
    },
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<{ publicKey: PubKeyHex }> {
    validateWalletArgs('getPublicKey', args)
    const paramWriter = new WriterUint8Array()
    paramWriter.writeUInt8(args.identityKey ? 1 : 0)
    if (args.identityKey) {
      paramWriter.write(this.#encodePrivilegedParams(args.privileged, args.privilegedReason))
    } else {
      args.protocolID ??= [SecurityLevels.Silent, 'default']
      args.keyID ??= ''
      paramWriter.write(
        this.#encodeKeyRelatedParams(
          args.protocolID,
          args.keyID,
          args.counterparty,
          args.privileged,
          args.privilegedReason
        )
      )
      if (typeof args.forSelf === 'boolean') {
        paramWriter.writeInt8(args.forSelf ? 1 : 0)
      } else {
        paramWriter.writeInt8(-1)
      }
    }

    // Serialize seekPermission
    this.#writeOptionalBool(paramWriter, args.seekPermission)

    const result = await this.#transmit('getPublicKey', originator, paramWriter.toUint8Array())
    this.#requireResponseLength(result, 33, 'getPublicKey')
    PublicKey.fromDER(Array.from(result))
    return {
      publicKey: toHex(result)
    }
  }

  async revealCounterpartyKeyLinkage(
    args: {
      counterparty: PubKeyHex
      verifier: PubKeyHex
      privilegedReason?: DescriptionString5to50Bytes
      privileged?: BooleanDefaultFalse
    },
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<{
    prover: PubKeyHex
    verifier: PubKeyHex
    counterparty: PubKeyHex
    revelationTime: ISOTimestampString
    encryptedLinkage: Byte[]
    encryptedLinkageProof: number[]
  }> {
    validateWalletArgs('revealCounterpartyKeyLinkage', args)
    const bindingRequest = snapshotWalletResultRequest('revealCounterpartyKeyLinkage', args)
    const paramWriter = new WriterUint8Array()
    paramWriter.write(this.#encodePrivilegedParams(args.privileged, args.privilegedReason))
    paramWriter.write(UtilsToUint8Array(args.counterparty, 'hex'))
    paramWriter.write(UtilsToUint8Array(args.verifier, 'hex'))
    const result = await this.#transmit(
      'revealCounterpartyKeyLinkage',
      originator,
      paramWriter.toUint8Array()
    )
    const resultReader = new ReaderUint8Array(result)
    const prover = this.#readCompressedPublicKey(
      resultReader,
      'revealCounterpartyKeyLinkage prover'
    )
    const verifier = this.#readCompressedPublicKey(
      resultReader,
      'revealCounterpartyKeyLinkage verifier'
    )
    const counterparty = this.#readCompressedPublicKey(
      resultReader,
      'revealCounterpartyKeyLinkage counterparty'
    )
    const revelationTimeLength = resultReader.readVarIntNumStrict(false)
    const revelationTime = toUTF8Strict(resultReader.read(revelationTimeLength))
    const encryptedLinkageLength = resultReader.readVarIntNumStrict(false)
    const encryptedLinkage = resultReader.read(encryptedLinkageLength)
    const encryptedLinkageProofLength = resultReader.readVarIntNumStrict(false)
    const encryptedLinkageProof = resultReader.read(encryptedLinkageProofLength)
    this.#assertResponseConsumed(resultReader, 'revealCounterpartyKeyLinkage')
    return validateWalletResult(
      'revealCounterpartyKeyLinkage',
      {
        prover,
        verifier,
        counterparty,
        revelationTime,
        encryptedLinkage: Array.from(encryptedLinkage),
        encryptedLinkageProof: Array.from(encryptedLinkageProof)
      },
      bindingRequest
    )
  }

  async revealSpecificKeyLinkage(
    args: {
      counterparty: PubKeyHex
      verifier: PubKeyHex
      protocolID: [SecurityLevel, ProtocolString5To400Bytes]
      keyID: KeyIDStringUnder800Bytes
      privilegedReason?: DescriptionString5to50Bytes
      privileged?: BooleanDefaultFalse
    },
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<{
    prover: PubKeyHex
    verifier: PubKeyHex
    counterparty: PubKeyHex
    protocolID: [SecurityLevel, ProtocolString5To400Bytes]
    keyID: KeyIDStringUnder800Bytes
    encryptedLinkage: Byte[]
    encryptedLinkageProof: Byte[]
    proofType: Byte
  }> {
    validateWalletArgs('revealSpecificKeyLinkage', args)
    const bindingRequest = snapshotWalletResultRequest('revealSpecificKeyLinkage', args)
    const paramWriter = new WriterUint8Array()
    paramWriter.write(
      this.#encodeKeyRelatedParams(
        args.protocolID,
        args.keyID,
        args.counterparty,
        args.privileged,
        args.privilegedReason
      )
    )
    paramWriter.write(UtilsToUint8Array(args.verifier, 'hex'))
    const result = await this.#transmit(
      'revealSpecificKeyLinkage',
      originator,
      paramWriter.toUint8Array()
    )
    const resultReader = new ReaderUint8Array(result)
    const prover = this.#readCompressedPublicKey(resultReader, 'revealSpecificKeyLinkage prover')
    const verifier = this.#readCompressedPublicKey(
      resultReader,
      'revealSpecificKeyLinkage verifier'
    )
    const counterparty = this.#readCompressedPublicKey(
      resultReader,
      'revealSpecificKeyLinkage counterparty'
    )
    const securityLevel = this.#readSecurityLevel(resultReader, 'revealSpecificKeyLinkage')
    const protocolLength = resultReader.readVarIntNumStrict(false)
    const protocol = toUTF8Strict(resultReader.read(protocolLength))
    const keyIDLength = resultReader.readVarIntNumStrict(false)
    const keyID = toUTF8Strict(resultReader.read(keyIDLength))
    const encryptedLinkageLength = resultReader.readVarIntNumStrict(false)
    const encryptedLinkage = resultReader.read(encryptedLinkageLength)
    const encryptedLinkageProofLength = resultReader.readVarIntNumStrict(false)
    const encryptedLinkageProof = resultReader.read(encryptedLinkageProofLength)
    const proofType = resultReader.readUInt8()
    this.#assertResponseConsumed(resultReader, 'revealSpecificKeyLinkage')
    return validateWalletResult(
      'revealSpecificKeyLinkage',
      {
        prover,
        verifier,
        counterparty,
        protocolID: [securityLevel, protocol],
        keyID,
        encryptedLinkage: Array.from(encryptedLinkage),
        encryptedLinkageProof: Array.from(encryptedLinkageProof),
        proofType
      },
      bindingRequest
    )
  }

  async encrypt(
    args: {
      seekPermission?: BooleanDefaultTrue
      plaintext: Byte[]
      protocolID: [SecurityLevel, ProtocolString5To400Bytes]
      keyID: KeyIDStringUnder800Bytes
      privilegedReason?: DescriptionString5to50Bytes
      counterparty?: PubKeyHex
      privileged?: BooleanDefaultFalse
    },
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<{ ciphertext: Byte[] }> {
    validateWalletArgs('encrypt', args)
    const paramWriter = new WriterUint8Array()
    paramWriter.write(
      this.#encodeKeyRelatedParams(
        args.protocolID,
        args.keyID,
        args.counterparty,
        args.privileged,
        args.privilegedReason
      )
    )
    paramWriter.writeVarIntNum(args.plaintext.length)
    paramWriter.write(args.plaintext)
    // Serialize seekPermission
    this.#writeOptionalBool(paramWriter, args.seekPermission)
    return {
      ciphertext: Array.from(
        await this.#transmit('encrypt', originator, paramWriter.toUint8Array())
      )
    }
  }

  async decrypt(
    args: {
      seekPermission?: BooleanDefaultTrue
      ciphertext: Byte[]
      protocolID: [SecurityLevel, ProtocolString5To400Bytes]
      keyID: KeyIDStringUnder800Bytes
      privilegedReason?: DescriptionString5to50Bytes
      counterparty?: PubKeyHex
      privileged?: BooleanDefaultFalse
    },
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<{ plaintext: Byte[] }> {
    validateWalletArgs('decrypt', args)
    const paramWriter = new WriterUint8Array()
    paramWriter.write(
      this.#encodeKeyRelatedParams(
        args.protocolID,
        args.keyID,
        args.counterparty,
        args.privileged,
        args.privilegedReason
      )
    )
    paramWriter.writeVarIntNum(args.ciphertext.length)
    paramWriter.write(args.ciphertext)
    // Serialize seekPermission
    this.#writeOptionalBool(paramWriter, args.seekPermission)
    return {
      plaintext: Array.from(await this.#transmit('decrypt', originator, paramWriter.toUint8Array()))
    }
  }

  async createHmac(
    args: {
      seekPermission?: BooleanDefaultTrue
      data: Byte[]
      protocolID: [SecurityLevel, ProtocolString5To400Bytes]
      keyID: KeyIDStringUnder800Bytes
      privilegedReason?: DescriptionString5to50Bytes
      counterparty?: PubKeyHex
      privileged?: BooleanDefaultFalse
    },
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<{ hmac: Byte[] }> {
    validateWalletArgs('createHmac', args)
    const paramWriter = new WriterUint8Array()
    paramWriter.write(
      this.#encodeKeyRelatedParams(
        args.protocolID,
        args.keyID,
        args.counterparty,
        args.privileged,
        args.privilegedReason
      )
    )
    paramWriter.writeVarIntNum(args.data.length)
    paramWriter.write(args.data)
    // Serialize seekPermission
    this.#writeOptionalBool(paramWriter, args.seekPermission)
    const hmac = await this.#transmit('createHmac', originator, paramWriter.toUint8Array())
    this.#requireResponseLength(hmac, 32, 'createHmac')
    return { hmac: Array.from(hmac) }
  }

  async verifyHmac(
    args: {
      seekPermission?: BooleanDefaultTrue
      data: Byte[]
      hmac: Byte[]
      protocolID: [SecurityLevel, ProtocolString5To400Bytes]
      keyID: KeyIDStringUnder800Bytes
      privilegedReason?: DescriptionString5to50Bytes
      counterparty?: PubKeyHex
      privileged?: BooleanDefaultFalse
    },
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<{ valid: true }> {
    validateWalletArgs('verifyHmac', args)
    const paramWriter = new WriterUint8Array()
    paramWriter.write(
      this.#encodeKeyRelatedParams(
        args.protocolID,
        args.keyID,
        args.counterparty,
        args.privileged,
        args.privilegedReason
      )
    )
    paramWriter.write(args.hmac)
    paramWriter.writeVarIntNum(args.data.length)
    paramWriter.write(args.data)
    // Serialize seekPermission
    this.#writeOptionalBool(paramWriter, args.seekPermission)
    const result = await this.#transmit('verifyHmac', originator, paramWriter.toUint8Array())
    this.#requireEmptyResponse(result, 'verifyHmac')
    return { valid: true }
  }

  async createSignature(
    args: {
      seekPermission?: BooleanDefaultTrue
      data?: Byte[]
      hashToDirectlySign?: Byte[]
      protocolID: [SecurityLevel, ProtocolString5To400Bytes]
      keyID: KeyIDStringUnder800Bytes
      privilegedReason?: DescriptionString5to50Bytes
      counterparty?: PubKeyHex
      privileged?: BooleanDefaultFalse
    },
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<{ signature: Byte[] }> {
    validateWalletArgs('createSignature', args)
    const paramWriter = new WriterUint8Array()
    paramWriter.write(
      this.#encodeKeyRelatedParams(
        args.protocolID,
        args.keyID,
        args.counterparty,
        args.privileged,
        args.privilegedReason
      )
    )
    if (typeof args.data === 'object') {
      paramWriter.writeUInt8(1)
      paramWriter.writeVarIntNum(args.data.length)
      paramWriter.write(args.data)
    } else {
      args.hashToDirectlySign ??= []
      paramWriter.writeUInt8(2)
      paramWriter.write(args.hashToDirectlySign)
    }
    // Serialize seekPermission
    this.#writeOptionalBool(paramWriter, args.seekPermission)
    return validateWalletResult(
      'createSignature',
      {
        signature: Array.from(
          await this.#transmit('createSignature', originator, paramWriter.toUint8Array())
        )
      },
      args
    )
  }

  async verifySignature(
    args: {
      seekPermission?: BooleanDefaultTrue
      data?: Byte[]
      hashToDirectlyVerify?: Byte[]
      signature: Byte[]
      protocolID: [SecurityLevel, ProtocolString5To400Bytes]
      keyID: KeyIDStringUnder800Bytes
      privilegedReason?: DescriptionString5to50Bytes
      counterparty?: PubKeyHex
      forSelf?: BooleanDefaultFalse
      privileged?: BooleanDefaultFalse
    },
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<{ valid: true }> {
    validateWalletArgs('verifySignature', args)
    const paramWriter = new WriterUint8Array()
    paramWriter.write(
      this.#encodeKeyRelatedParams(
        args.protocolID,
        args.keyID,
        args.counterparty,
        args.privileged,
        args.privilegedReason
      )
    )
    if (typeof args.forSelf === 'boolean') {
      paramWriter.writeInt8(args.forSelf ? 1 : 0)
    } else {
      paramWriter.writeInt8(-1)
    }
    paramWriter.writeVarIntNum(args.signature.length)
    paramWriter.write(args.signature)
    if (typeof args.data === 'object') {
      paramWriter.writeUInt8(1)
      paramWriter.writeVarIntNum(args.data.length)
      paramWriter.write(args.data)
    } else {
      paramWriter.writeUInt8(2)
      paramWriter.write(args.hashToDirectlyVerify ?? [])
    }
    // Serialize seekPermission
    this.#writeOptionalBool(paramWriter, args.seekPermission)
    const result = await this.#transmit('verifySignature', originator, paramWriter.toUint8Array())
    this.#requireEmptyResponse(result, 'verifySignature')
    return { valid: true }
  }

  private static readonly OPTIONAL_BOOLEAN_WIRE_VALUES = new Map<boolean | undefined, number>([
    [true, 1],
    [false, 0],
    [undefined, -1]
  ])

  /** Writes an optional boolean as Int8: 1/0 if present, -1 if absent. */
  #writeOptionalBool(writer: WriterUint8Array, val: boolean | undefined): void {
    writer.writeInt8(WalletWireTransceiver.OPTIONAL_BOOLEAN_WIRE_VALUES.get(val)!)
  }

  /** Writes an optional number as VarInt: the value if present, -1 if absent. */
  #writeOptionalVarInt(writer: WriterUint8Array, val: number | undefined): void {
    if (typeof val === 'number') {
      writer.writeVarIntNum(val)
    } else {
      writer.writeVarIntNum(-1)
    }
  }

  /** Writes a UTF-8 string as (VarInt length, bytes). */
  #writeUTF8(writer: WriterUint8Array, val: string | undefined): void {
    const bytes = UtilsToUint8Array(val ?? '', 'utf8')
    writer.writeVarIntNum(bytes.length)
    writer.write(bytes)
  }

  /** Writes an optional UTF-8 string: (VarInt length, bytes) if non-empty, -1 if absent/empty. */
  #writeOptionalUTF8(writer: WriterUint8Array, val: string | undefined): void {
    if (val != null && val !== '') {
      const bytes = UtilsToUint8Array(val, 'utf8')
      writer.writeVarIntNum(bytes.length)
      writer.write(bytes)
    } else {
      writer.writeVarIntNum(-1)
    }
  }

  /** Writes an array of UTF-8 strings as (VarInt count, ...items). -1 if null. */
  #writeUTF8Array(writer: WriterUint8Array, arr: string[] | undefined): void {
    if (arr == null) {
      writer.writeVarIntNum(-1)
    } else {
      writer.writeVarIntNum(arr.length)
      for (const item of arr) {
        const bytes = UtilsToUint8Array(item, 'utf8')
        writer.writeVarIntNum(bytes.length)
        writer.write(bytes)
      }
    }
  }

  /** Writes an array of hex-encoded txids (each 32 bytes) as (VarInt count, ...items). -1 if null. */
  #writeTxidArray(writer: WriterUint8Array, arr: string[] | undefined): void {
    if (arr == null) {
      writer.writeVarIntNum(-1)
    } else {
      writer.writeVarIntNum(arr.length)
      for (const txid of arr) {
        writer.write(UtilsToUint8Array(txid, 'hex'))
      }
    }
  }

  /** Reads a list of SendWithResults entries from a binary reader. */
  #readSendWithResults(
    reader: ReaderUint8Array
  ): Array<{ txid: TXIDHexString; status: SendWithResultStatus }> | undefined {
    const len = reader.readVarIntNumStrict()
    if (len < 0) return undefined
    this.#requireResponseCollectionLength(reader, len, 'sendWithResults', 33, 1001)
    const results: Array<{ txid: TXIDHexString; status: SendWithResultStatus }> = []
    for (let i = 0; i < len; i++) {
      const txid = toHex(reader.read(32))
      const code = reader.readInt8()
      let status: SendWithResultStatus = 'unproven'
      if (code === 2) {
        status = 'sending'
      } else if (code === 3) {
        status = 'failed'
      } else if (code !== 1) {
        throw new Error(`Unknown sendWith result status code: ${code}`)
      }
      results.push({ txid, status })
    }
    return results
  }

  /** Serializes a single createAction input to the writer. */
  #serializeCreateActionInput(
    writer: WriterUint8Array,
    input: {
      outpoint: OutpointString
      unlockingScript?: string
      unlockingScriptLength?: number
      inputDescription: string
      sequenceNumber?: number
    }
  ): void {
    writer.write(this.#encodeOutpoint(input.outpoint))

    if (input.unlockingScript != null && input.unlockingScript !== '') {
      const bytes = UtilsToUint8Array(input.unlockingScript, 'hex')
      writer.writeVarIntNum(bytes.length)
      writer.write(bytes)
    } else {
      writer.writeVarIntNum(-1)
      writer.writeVarIntNum(input.unlockingScriptLength ?? 0)
    }

    this.#writeUTF8(writer, input.inputDescription)
    this.#writeOptionalVarInt(writer, input.sequenceNumber)
  }

  /** Serializes a single createAction output to the writer. */
  #serializeCreateActionOutput(
    writer: WriterUint8Array,
    output: {
      lockingScript: string
      satoshis: number
      outputDescription: string
      basket?: string
      customInstructions?: string
      tags?: string[]
    }
  ): void {
    const lockingBytes = UtilsToUint8Array(output.lockingScript, 'hex')
    writer.writeVarIntNum(lockingBytes.length)
    writer.write(lockingBytes)
    writer.writeVarIntNum(output.satoshis)
    this.#writeUTF8(writer, output.outputDescription)
    this.#writeOptionalUTF8(writer, output.basket)
    this.#writeOptionalUTF8(writer, output.customInstructions)
    this.#writeUTF8Array(writer, output.tags)
  }

  /** Serializes createAction options to the writer (Int8 presence byte + fields). */
  #serializeCreateActionOptions(
    writer: WriterUint8Array,
    options:
      | {
          signAndProcess?: boolean
          acceptDelayedBroadcast?: boolean
          trustSelf?: string
          knownTxids?: string[]
          returnTXIDOnly?: boolean
          noSend?: boolean
          noSendChange?: OutpointString[]
          sendWith?: string[]
          randomizeOutputs?: boolean
        }
      | undefined
  ): void {
    if (options == null) {
      writer.writeInt8(0)
      return
    }
    writer.writeInt8(1)
    this.#writeOptionalBool(writer, options.signAndProcess)
    this.#writeOptionalBool(writer, options.acceptDelayedBroadcast)
    writer.writeInt8(options.trustSelf === 'known' ? 1 : -1)
    this.#writeTxidArray(writer, options.knownTxids)
    this.#writeOptionalBool(writer, options.returnTXIDOnly)
    this.#writeOptionalBool(writer, options.noSend)
    if (options.noSendChange == null) {
      writer.writeVarIntNum(-1)
    } else {
      writer.writeVarIntNum(options.noSendChange.length)
      for (const outpoint of options.noSendChange) {
        writer.write(this.#encodeOutpoint(outpoint))
      }
    }
    this.#writeTxidArray(writer, options.sendWith)
    this.#writeOptionalBool(writer, options.randomizeOutputs)
  }

  /** Serializes signAction options to the writer (Int8 presence byte + fields). */
  #serializeSignActionOptions(
    writer: WriterUint8Array,
    options:
      | {
          acceptDelayedBroadcast?: boolean
          returnTXIDOnly?: boolean
          noSend?: boolean
          sendWith?: string[]
        }
      | undefined
  ): void {
    if (options == null) {
      writer.writeInt8(0)
      return
    }
    writer.writeInt8(1)
    this.#writeOptionalBool(writer, options.acceptDelayedBroadcast)
    this.#writeOptionalBool(writer, options.returnTXIDOnly)
    this.#writeOptionalBool(writer, options.noSend)
    this.#writeTxidArray(writer, options.sendWith)
  }

  #encodeKeyRelatedParams(
    protocolID: [SecurityLevel, ProtocolString5To400Bytes],
    keyID: KeyIDStringUnder800Bytes,
    counterparty?: PubKeyHex,
    privileged?: boolean,
    privilegedReason?: string
  ): Uint8Array {
    const paramWriter = new WriterUint8Array()
    paramWriter.writeUInt8(protocolID[0])
    const protocolAsArray = UtilsToUint8Array(protocolID[1], 'utf8')
    paramWriter.writeVarIntNum(protocolAsArray.length)
    paramWriter.write(protocolAsArray)
    const keyIDAsArray = UtilsToUint8Array(keyID, 'utf8')
    paramWriter.writeVarIntNum(keyIDAsArray.length)
    paramWriter.write(keyIDAsArray)
    if (typeof counterparty !== 'string') {
      paramWriter.writeUInt8(0)
    } else if (counterparty === 'self') {
      paramWriter.writeUInt8(11)
    } else if (counterparty === 'anyone') {
      paramWriter.writeUInt8(12)
    } else {
      paramWriter.write(UtilsToUint8Array(counterparty, 'hex'))
    }
    paramWriter.write(this.#encodePrivilegedParams(privileged, privilegedReason))
    return paramWriter.toUint8Array()
  }

  async acquireCertificate(
    args: AcquireCertificateArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<AcquireCertificateResult> {
    validateWalletArgs('acquireCertificate', args)
    const bindingRequest = snapshotWalletResultRequest('acquireCertificate', args)
    const paramWriter = new WriterUint8Array()
    paramWriter.write(UtilsToUint8Array(args.type, 'base64'))
    paramWriter.write(UtilsToUint8Array(args.certifier, 'hex'))

    const fieldEntries = Object.entries(args.fields)
    paramWriter.writeVarIntNum(fieldEntries.length)
    for (const [key, value] of fieldEntries) {
      const keyAsArray = UtilsToUint8Array(key, 'utf8')
      const valueAsArray = UtilsToUint8Array(value, 'utf8')

      paramWriter.writeVarIntNum(keyAsArray.length)
      paramWriter.write(keyAsArray)

      paramWriter.writeVarIntNum(valueAsArray.length)
      paramWriter.write(valueAsArray)
    }

    paramWriter.write(this.#encodePrivilegedParams(args.privileged, args.privilegedReason))
    paramWriter.writeUInt8(args.acquisitionProtocol === 'direct' ? 1 : 2)

    if (args.acquisitionProtocol === 'direct') {
      paramWriter.write(UtilsToUint8Array(args.serialNumber, 'base64'))
      paramWriter.write(this.#encodeOutpoint(args.revocationOutpoint ?? ''))
      const signatureAsArray = UtilsToUint8Array(args.signature, 'hex')
      paramWriter.writeVarIntNum(signatureAsArray.length)
      paramWriter.write(signatureAsArray)

      const keyringRevealerAsArray =
        args.keyringRevealer === 'certifier' ? [11] : UtilsToUint8Array(args.keyringRevealer, 'hex')
      paramWriter.write(keyringRevealerAsArray)

      const keyringKeys = Object.keys(args.keyringForSubject ?? {})
      paramWriter.writeVarIntNum(keyringKeys.length)
      for (const key of keyringKeys) {
        const keyringKeysAsArray = UtilsToUint8Array(key, 'utf8')
        paramWriter.writeVarIntNum(keyringKeysAsArray.length)
        paramWriter.write(keyringKeysAsArray)
        const keyringForSubjectAsArray = UtilsToUint8Array(args.keyringForSubject?.[key], 'base64')
        paramWriter.writeVarIntNum(keyringForSubjectAsArray.length)
        paramWriter.write(keyringForSubjectAsArray)
      }
    } else {
      const certifierUrlAsArray = UtilsToUint8Array(args.certifierUrl, 'utf8')
      paramWriter.writeVarIntNum(certifierUrlAsArray.length)
      paramWriter.write(certifierUrlAsArray)
    }

    const result = await this.#transmit(
      'acquireCertificate',
      originator,
      paramWriter.toUint8Array()
    )
    const cert = Certificate.fromBinary(result)
    return validateWalletResult(
      'acquireCertificate',
      {
        ...cert,
        signature: cert.signature as string
      },
      bindingRequest
    )
  }

  #encodePrivilegedParams(privileged?: boolean, privilegedReason?: string): Uint8Array {
    const paramWriter = new WriterUint8Array()
    if (typeof privileged === 'boolean') {
      paramWriter.writeInt8(privileged ? 1 : 0)
    } else {
      paramWriter.writeInt8(-1)
    }
    if (typeof privilegedReason === 'string') {
      const privilegedReasonAsArray = UtilsToUint8Array(privilegedReason, 'utf8')
      paramWriter.writeInt8(privilegedReasonAsArray.length)
      paramWriter.write(privilegedReasonAsArray)
    } else {
      paramWriter.writeInt8(-1)
    }
    return paramWriter.toUint8Array()
  }

  async listCertificates(
    args: {
      certifiers: PubKeyHex[]
      types: Base64String[]
      limit?: PositiveIntegerDefault10Max10000
      offset?: PositiveIntegerOrZero
      privileged?: BooleanDefaultFalse
      privilegedReason?: DescriptionString5to50Bytes
    },
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<ListCertificatesResult> {
    validateWalletArgs('listCertificates', args)
    const bindingRequest = snapshotWalletResultRequest('listCertificates', args)
    const paramWriter = new WriterUint8Array()
    paramWriter.writeVarIntNum(args.certifiers.length)
    for (const certifier of args.certifiers) {
      paramWriter.write(UtilsToUint8Array(certifier, 'hex'))
    }

    paramWriter.writeVarIntNum(args.types.length)
    for (const type of args.types) {
      paramWriter.write(UtilsToUint8Array(type, 'base64'))
    }
    if (typeof args.limit === 'number') {
      paramWriter.writeVarIntNum(args.limit)
    } else {
      paramWriter.writeVarIntNum(-1)
    }
    if (typeof args.offset === 'number') {
      paramWriter.writeVarIntNum(args.offset)
    } else {
      paramWriter.writeVarIntNum(-1)
    }
    paramWriter.write(this.#encodePrivilegedParams(args.privileged, args.privilegedReason))
    const result = await this.#transmit('listCertificates', originator, paramWriter.toUint8Array())
    const resultReader = new ReaderUint8Array(result)
    const totalCertificates = this.#requireInteger(
      resultReader.readVarIntNumStrict(false),
      'listCertificates totalCertificates',
      0,
      0xffffffff
    )
    const certificates: CertificateResult[] = []
    while (!resultReader.eof()) {
      this.#requirePageCapacity(certificates.length, args.limit, 'listCertificates')
      const certificateLength = resultReader.readVarIntNumStrict(false)
      const certificateBin = resultReader.read(certificateLength)
      const cert = Certificate.fromBinary(certificateBin)
      const keyringForVerifier: Record<string, string> = {}
      if (this.#readBooleanFlag(resultReader, 'listCertificates keyring present')) {
        const numFields = resultReader.readVarIntNumStrict(false)
        this.#requireResponseCollectionLength(resultReader, numFields, 'listCertificates keyring')
        for (let i = 0; i < numFields; i++) {
          const fieldKeyLength = resultReader.readVarIntNumStrict(false)
          const fieldKey = this.#readRecordKey(
            resultReader,
            fieldKeyLength,
            'listCertificates keyring'
          )
          const fieldValueLength = resultReader.readVarIntNumStrict(false)
          this.#setUniqueWireRecordEntry(
            keyringForVerifier,
            fieldKey,
            toBase64(resultReader.read(fieldValueLength)),
            'listCertificates keyring'
          )
        }
      }
      const verifierLength = resultReader.readVarIntNumStrict(false)
      let verifier: string | undefined
      if (verifierLength > 0) {
        if (verifierLength !== 33) {
          throw new Error(
            `Invalid listCertificates verifier length: expected 33 bytes, received ${verifierLength}`
          )
        }
        verifier = this.#readCompressedPublicKey(resultReader, 'listCertificates verifier')
      }
      certificates.push({
        ...cert,
        signature: cert.signature as string,
        keyring: keyringForVerifier,
        verifier
      })
    }
    this.#assertPageCount(certificates.length, totalCertificates, 'listCertificates')
    return validateWalletResult(
      'listCertificates',
      {
        totalCertificates,
        certificates
      },
      bindingRequest
    )
  }

  async proveCertificate(
    args: ProveCertificateArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<ProveCertificateResult> {
    validateWalletArgs('proveCertificate', args)
    const bindingRequest = snapshotWalletResultRequest('proveCertificate', args)
    const paramWriter = new WriterUint8Array()
    const typeAsArray = UtilsToUint8Array(args.certificate.type, 'base64')
    paramWriter.write(typeAsArray)
    const subjectAsArray = UtilsToUint8Array(args.certificate.subject, 'hex')
    paramWriter.write(subjectAsArray)
    const serialNumberAsArray = UtilsToUint8Array(args.certificate.serialNumber, 'base64')
    paramWriter.write(serialNumberAsArray)
    const certifierAsArray = UtilsToUint8Array(args.certificate.certifier, 'hex')
    paramWriter.write(certifierAsArray)
    const revocationOutpointAsArray = this.#encodeOutpoint(
      args.certificate.revocationOutpoint ?? ''
    )
    paramWriter.write(revocationOutpointAsArray)
    const signatureAsArray = UtilsToUint8Array(args.certificate.signature, 'hex')
    paramWriter.writeVarIntNum(signatureAsArray.length)
    paramWriter.write(signatureAsArray)
    const fieldEntries = Object.entries(args.certificate.fields ?? {})
    paramWriter.writeVarIntNum(fieldEntries.length)
    for (const [key, value] of fieldEntries) {
      const keyAsArray = UtilsToUint8Array(key, 'utf8')
      const valueAsArray = UtilsToUint8Array(value, 'utf8')
      paramWriter.writeVarIntNum(keyAsArray.length)
      paramWriter.write(keyAsArray)
      paramWriter.writeVarIntNum(valueAsArray.length)
      paramWriter.write(valueAsArray)
    }
    paramWriter.writeVarIntNum(args.fieldsToReveal.length)
    for (const field of args.fieldsToReveal) {
      const fieldAsArray = UtilsToUint8Array(field, 'utf8')
      paramWriter.writeVarIntNum(fieldAsArray.length)
      paramWriter.write(fieldAsArray)
    }
    paramWriter.write(UtilsToUint8Array(args.verifier, 'hex'))
    paramWriter.write(this.#encodePrivilegedParams(args.privileged, args.privilegedReason))
    const result = await this.#transmit('proveCertificate', originator, paramWriter.toUint8Array())
    const resultReader = new ReaderUint8Array(result)
    const numFields = resultReader.readVarIntNumStrict(false)
    this.#requireResponseCollectionLength(resultReader, numFields, 'proveCertificate keyring')
    const keyringForVerifier: Record<string, string> = {}
    for (let i = 0; i < numFields; i++) {
      const fieldKeyLength = resultReader.readVarIntNumStrict(false)
      const fieldKey = this.#readRecordKey(resultReader, fieldKeyLength, 'proveCertificate keyring')
      const fieldValueLength = resultReader.readVarIntNumStrict(false)
      this.#setUniqueWireRecordEntry(
        keyringForVerifier,
        fieldKey,
        toBase64(resultReader.read(fieldValueLength)),
        'proveCertificate keyring'
      )
    }
    this.#assertResponseConsumed(resultReader, 'proveCertificate')
    return validateWalletResult(
      'proveCertificate',
      {
        keyringForVerifier
      },
      bindingRequest
    )
  }

  async relinquishCertificate(
    args: {
      type: Base64String
      serialNumber: Base64String
      certifier: PubKeyHex
    },
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<{ relinquished: true }> {
    validateWalletArgs('relinquishCertificate', args)
    const paramWriter = new WriterUint8Array()
    const typeAsArray = UtilsToUint8Array(args.type, 'base64')
    paramWriter.write(typeAsArray)
    const serialNumberAsArray = UtilsToUint8Array(args.serialNumber, 'base64')
    paramWriter.write(serialNumberAsArray)
    const certifierAsArray = UtilsToUint8Array(args.certifier, 'hex')
    paramWriter.write(certifierAsArray)
    const result = await this.#transmit(
      'relinquishCertificate',
      originator,
      paramWriter.toUint8Array()
    )
    this.#requireEmptyResponse(result, 'relinquishCertificate')
    return { relinquished: true }
  }

  #parseDiscoveryResult(
    result: Uint8Array,
    requestedLimit: number | undefined
  ): {
    totalCertificates: number
    certificates: Array<{
      type: Base64String
      subject: PubKeyHex
      serialNumber: Base64String
      certifier: PubKeyHex
      revocationOutpoint: OutpointString
      signature: HexString
      fields: Record<CertificateFieldNameUnder50Bytes, Base64String>
      certifierInfo: {
        name: EntityNameStringMax100Bytes
        iconUrl: EntityIconURLStringMax500Bytes
        description: DescriptionString5to50Bytes
        trust: PositiveIntegerMax10
      }
      publiclyRevealedKeyring: Record<CertificateFieldNameUnder50Bytes, Base64String>
      decryptedFields: Record<CertificateFieldNameUnder50Bytes, string>
    }>
  } {
    const resultReader = new ReaderUint8Array(result)
    const totalCertificates = this.#requireInteger(
      resultReader.readVarIntNumStrict(false),
      'discovery totalCertificates',
      0,
      0xffffffff
    )
    const certificates: Array<{
      type: Base64String
      subject: PubKeyHex
      serialNumber: Base64String
      certifier: PubKeyHex
      revocationOutpoint: OutpointString
      signature: HexString
      fields: Record<CertificateFieldNameUnder50Bytes, Base64String>
      certifierInfo: {
        name: EntityNameStringMax100Bytes
        iconUrl: EntityIconURLStringMax500Bytes
        description: DescriptionString5to50Bytes
        trust: PositiveIntegerMax10
      }
      publiclyRevealedKeyring: Record<CertificateFieldNameUnder50Bytes, Base64String>
      decryptedFields: Record<CertificateFieldNameUnder50Bytes, string>
    }> = []
    while (!resultReader.eof()) {
      this.#requirePageCapacity(certificates.length, requestedLimit, 'discover')
      const certBinLen = resultReader.readVarIntNumStrict(false)
      const certBin = resultReader.read(certBinLen)
      const cert = Certificate.fromBinary(certBin)
      const nameLength = resultReader.readVarIntNumStrict(false)
      const name = toUTF8Strict(resultReader.read(nameLength))
      const iconUrlLength = resultReader.readVarIntNumStrict(false)
      const iconUrl = toUTF8Strict(resultReader.read(iconUrlLength))
      const descriptionLength = resultReader.readVarIntNumStrict(false)
      const description = toUTF8Strict(resultReader.read(descriptionLength))
      const trust = this.#requireInteger(resultReader.readUInt8(), 'discovery trust', 1, 10)
      const publiclyRevealedKeyring: Record<CertificateFieldNameUnder50Bytes, Base64String> = {}
      const numPublicKeyringEntries = resultReader.readVarIntNumStrict(false)
      this.#requireResponseCollectionLength(
        resultReader,
        numPublicKeyringEntries,
        'discovery public keyring'
      )
      for (let j = 0; j < numPublicKeyringEntries; j++) {
        const fieldKeyLen = resultReader.readVarIntNumStrict(false)
        const fieldKey = this.#readRecordKey(resultReader, fieldKeyLen, 'discovery public keyring')
        const fieldValueLen = resultReader.readVarIntNumStrict(false)
        this.#setUniqueWireRecordEntry(
          publiclyRevealedKeyring,
          fieldKey,
          toBase64(resultReader.read(fieldValueLen)),
          'discovery public keyring'
        )
      }
      const decryptedFields: Record<CertificateFieldNameUnder50Bytes, string> = {}
      const numDecryptedFields = resultReader.readVarIntNumStrict(false)
      this.#requireResponseCollectionLength(
        resultReader,
        numDecryptedFields,
        'discovery decrypted fields'
      )
      for (let k = 0; k < numDecryptedFields; k++) {
        const fieldKeyLen = resultReader.readVarIntNumStrict(false)
        const fieldKey = this.#readRecordKey(
          resultReader,
          fieldKeyLen,
          'discovery decrypted fields'
        )
        const fieldValueLen = resultReader.readVarIntNumStrict(false)
        this.#setUniqueWireRecordEntry(
          decryptedFields,
          fieldKey,
          toUTF8Strict(resultReader.read(fieldValueLen)),
          'discovery decrypted fields'
        )
      }
      certificates.push({
        ...cert,
        signature: cert.signature as string,
        certifierInfo: { iconUrl, name, description, trust },
        publiclyRevealedKeyring,
        decryptedFields
      })
    }
    this.#assertPageCount(certificates.length, totalCertificates, 'discover')
    return {
      totalCertificates,
      certificates
    }
  }

  async discoverByIdentityKey(
    args: {
      seekPermission?: BooleanDefaultTrue
      identityKey: PubKeyHex
      limit?: PositiveIntegerDefault10Max10000
      offset?: PositiveIntegerOrZero
    },
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<DiscoverCertificatesResult> {
    validateWalletArgs('discoverByIdentityKey', args)
    const bindingRequest = snapshotWalletResultRequest('discoverByIdentityKey', args)
    const paramWriter = new WriterUint8Array()
    paramWriter.write(UtilsToUint8Array(args.identityKey, 'hex'))
    if (typeof args.limit === 'number') {
      paramWriter.writeVarIntNum(args.limit)
    } else {
      paramWriter.writeVarIntNum(-1)
    }
    if (typeof args.offset === 'number') {
      paramWriter.writeVarIntNum(args.offset)
    } else {
      paramWriter.writeVarIntNum(-1)
    }
    // Serialize seekPermission
    this.#writeOptionalBool(paramWriter, args.seekPermission)
    const result = await this.#transmit(
      'discoverByIdentityKey',
      originator,
      paramWriter.toUint8Array()
    )
    return validateWalletResult(
      'discoverByIdentityKey',
      this.#parseDiscoveryResult(result, args.limit),
      bindingRequest
    )
  }

  async discoverByAttributes(
    args: {
      seekPermission?: BooleanDefaultTrue
      attributes: Record<CertificateFieldNameUnder50Bytes, string>
      limit?: PositiveIntegerDefault10Max10000
      offset?: PositiveIntegerOrZero
    },
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<DiscoverCertificatesResult> {
    validateWalletArgs('discoverByAttributes', args)
    const bindingRequest = snapshotWalletResultRequest('discoverByAttributes', args)
    const paramWriter = new WriterUint8Array()
    const attributeKeys = Object.keys(args.attributes)
    paramWriter.writeVarIntNum(attributeKeys.length)
    for (const attrKey of attributeKeys) {
      const attrKeyBytes = UtilsToUint8Array(attrKey, 'utf8')
      const attrValueBytes = UtilsToUint8Array(args.attributes[attrKey], 'utf8')
      paramWriter.writeVarIntNum(attrKeyBytes.length)
      paramWriter.write(attrKeyBytes)
      paramWriter.writeVarIntNum(attrValueBytes.length)
      paramWriter.write(attrValueBytes)
    }
    if (typeof args.limit === 'number') {
      paramWriter.writeVarIntNum(args.limit)
    } else {
      paramWriter.writeVarIntNum(-1)
    }
    if (typeof args.offset === 'number') {
      paramWriter.writeVarIntNum(args.offset)
    } else {
      paramWriter.writeVarIntNum(-1)
    }
    // Serialize seekPermission
    this.#writeOptionalBool(paramWriter, args.seekPermission)
    const result = await this.#transmit(
      'discoverByAttributes',
      originator,
      paramWriter.toUint8Array()
    )
    return validateWalletResult(
      'discoverByAttributes',
      this.#parseDiscoveryResult(result, args.limit),
      bindingRequest
    )
  }

  async isAuthenticated(
    args: {},
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<{ authenticated: true }> {
    validateWalletArgs('isAuthenticated', args)
    const result = await this.#transmit('isAuthenticated', originator)
    this.#requireResponseLength(result, 1, 'isAuthenticated')
    if (result[0] !== 0 && result[0] !== 1) {
      throw new Error('Wallet returned an invalid authentication verdict')
    }
    // The historical interface annotation says `true`, but implementations
    // and the wire protocol legitimately report an exact false verdict.
    // @ts-expect-error
    return { authenticated: result[0] === 1 }
  }

  async waitForAuthentication(
    args: {},
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<{ authenticated: true }> {
    validateWalletArgs('waitForAuthentication', args)
    const result = await this.#transmit('waitForAuthentication', originator)
    this.#requireEmptyResponse(result, 'waitForAuthentication')
    return { authenticated: true }
  }

  async getHeight(
    args: {},
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<{ height: PositiveInteger }> {
    validateWalletArgs('getHeight', args)
    const result = await this.#transmit('getHeight', originator)
    const resultReader = new ReaderUint8Array(result)
    const height = resultReader.readVarIntNumStrict(false)
    this.#assertResponseConsumed(resultReader, 'getHeight')
    if (height < 1 || height > 0xffffffff) throw new Error('Wallet returned an invalid height')
    return { height }
  }

  async getHeaderForHeight(
    args: { height: PositiveInteger },
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<{ header: HexString }> {
    validateWalletArgs('getHeaderForHeight', args)
    if (!Number.isInteger(args.height) || args.height < 1 || args.height > 0xffffffff) {
      throw new Error('getHeaderForHeight requires a height from 1 to 4294967295')
    }
    const paramWriter = new WriterUint8Array()
    paramWriter.writeVarIntNum(args.height)
    const header = await this.#transmit(
      'getHeaderForHeight',
      originator,
      paramWriter.toUint8Array()
    )
    this.#requireResponseLength(header, 80, 'getHeaderForHeight')
    return {
      header: toHex(header)
    }
  }

  async getNetwork(
    args: {},
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<{ network: 'mainnet' | 'testnet' }> {
    validateWalletArgs('getNetwork', args)
    const net = await this.#transmit('getNetwork', originator)
    this.#requireResponseLength(net, 1, 'getNetwork')
    if (net[0] !== 0 && net[0] !== 1) throw new Error('Wallet returned an invalid network')
    return {
      network: net[0] === 0 ? 'mainnet' : 'testnet'
    }
  }

  async getVersion(
    args: {},
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<{ version: VersionString7To30Bytes }> {
    validateWalletArgs('getVersion', args)
    const version = await this.#transmit('getVersion', originator)
    if (version.length < 7 || version.length > 30) {
      throw new Error('Wallet returned an invalid version')
    }
    return {
      version: toUTF8Strict(version)
    }
  }

  #assertResponseConsumed(reader: ReaderUint8Array, call: string): void {
    if (!reader.eof()) throw new Error(`Wallet Wire ${call} response contains trailing data`)
  }

  #assertPageCount(returned: number, total: number, call: string): void {
    if (returned > total) {
      throw new Error(
        `Wallet Wire ${call} response returned ${returned} records but declared a total of ${total}`
      )
    }
  }

  #requirePageCapacity(returned: number, requestedLimit: number | undefined, call: string): void {
    const maximum = requestedLimit ?? 10
    if (returned >= maximum) {
      throw new Error(`Wallet Wire ${call} response exceeds the requested page limit of ${maximum}`)
    }
  }

  #requireResponseCollectionLength(
    reader: ReaderUint8Array,
    length: number,
    fieldName: string,
    minimumBytesPerItem = 1,
    maximum = MAX_WIRE_RESPONSE_COLLECTION_ITEMS
  ): number {
    if (!Number.isSafeInteger(length) || length < 0 || length > maximum) {
      throw new Error(`Wallet Wire ${fieldName} exceeds the maximum collection size of ${maximum}`)
    }
    if (length > Math.floor(reader.remaining() / minimumBytesPerItem)) {
      throw new Error(`Wallet Wire ${fieldName} count exceeds the remaining response data`)
    }
    return length
  }

  #readBooleanFlag(reader: ReaderUint8Array, fieldName: string): boolean {
    const flag = reader.readInt8()
    if (flag !== 0 && flag !== 1) {
      throw new Error(`Invalid ${fieldName} flag: expected 0 or 1, received ${flag}`)
    }
    return flag === 1
  }

  #readRecordKey(
    reader: ReaderUint8Array,
    length: number,
    recordName: string
  ): CertificateFieldNameUnder50Bytes {
    if (length < 1 || length > 50) {
      throw new Error(`Invalid ${recordName} key length: expected 1–50 bytes, received ${length}`)
    }
    const key = toUTF8Strict(reader.read(length))
    if (isUnsafeRecordKey(key)) throw new Error(`Unsafe ${recordName} key: ${key}`)
    return key
  }

  #setUniqueWireRecordEntry<T>(
    record: Record<string, T>,
    key: string,
    value: T,
    recordName: string
  ): void {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      throw new Error(`Duplicate ${recordName} key: ${key}`)
    }
    record[key] = value
  }

  #readCompressedPublicKey(reader: ReaderUint8Array, _fieldName: string): PubKeyHex {
    const bytes = reader.read(33)
    PublicKey.fromDER(Array.from(bytes))
    return toHex(bytes)
  }

  #readSecurityLevel(reader: ReaderUint8Array, fieldName: string): SecurityLevel {
    const securityLevel = reader.readUInt8()
    if (securityLevel !== 0 && securityLevel !== 1 && securityLevel !== 2) {
      throw new Error(`Invalid ${fieldName} security level: ${securityLevel}`)
    }
    return securityLevel
  }

  #requireInteger(value: number, fieldName: string, minimum: number, maximum: number): number {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new Error(
        `Invalid ${fieldName}: expected an integer from ${minimum} to ${maximum}, received ${String(value)}`
      )
    }
    return value
  }

  #requireResponseLength(result: Uint8Array, length: number, call: string): void {
    if (result.length !== length) {
      throw new Error(`Wallet Wire ${call} response has an invalid length`)
    }
  }

  #requireEmptyResponse(result: Uint8Array, call: string): void {
    this.#requireResponseLength(result, 0, call)
  }
}
