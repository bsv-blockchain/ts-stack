
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
import WalletWire from './WalletWire.js'
import Certificate from '../../auth/certificates/Certificate.js'
import * as Utils from '../../primitives/utils.js'
import calls, { CallType } from './WalletWireCalls.js'
import { WalletError } from '../WalletError.js'

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

  constructor (wire: WalletWire) {
    this.wire = wire
  }

  private async transmit (
    call: CallType,
    originator: OriginatorDomainNameStringUnder250Bytes = '',
    params: number[] = []
  ): Promise<number[]> {
    const frameWriter = new Utils.Writer()
    frameWriter.writeUInt8(calls[call])
    const originatorArray = Utils.toArray(originator, 'utf8')
    frameWriter.writeUInt8(originatorArray.length)
    frameWriter.write(originatorArray)
    if (params.length > 0) {
      frameWriter.write(params)
    }
    const frame = frameWriter.toArray()
    const result = await this.wire.transmitToWallet(frame)
    const resultReader = new Utils.Reader(result)
    const errorByte = resultReader.readUInt8()
    if (errorByte === 0) {
      const resultFrame = resultReader.read()
      return resultFrame
    } else {
      // Deserialize the error message length
      const errorMessageLength = resultReader.readVarIntNum()
      const errorMessageBytes = resultReader.read(errorMessageLength)
      const errorMessage = Utils.toUTF8(errorMessageBytes)

      // Deserialize the stack trace length
      const stackTraceLength = resultReader.readVarIntNum()
      const stackTraceBytes = resultReader.read(stackTraceLength)
      const stackTrace = Utils.toUTF8(stackTraceBytes)

      // Construct a custom wallet error
      const e = new WalletError(errorMessage, errorByte, stackTrace)
      throw e
    }
  }

  async createAction (
    args: CreateActionArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<CreateActionResult> {
    const paramWriter = new Utils.Writer()

    // Serialize description
    this.writeUTF8(paramWriter, args.description)

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
        this.serializeCreateActionInput(paramWriter, input)
      }
    }

    // Serialize outputs
    if (args.outputs == null) {
      paramWriter.writeVarIntNum(-1)
    } else {
      paramWriter.writeVarIntNum(args.outputs.length)
      for (const output of args.outputs) {
        this.serializeCreateActionOutput(paramWriter, output)
      }
    }

    // Serialize lockTime, version
    this.writeOptionalVarInt(paramWriter, args.lockTime)
    this.writeOptionalVarInt(paramWriter, args.version)

    // Serialize labels
    this.writeUTF8Array(paramWriter, args.labels)

    // Serialize options
    this.serializeCreateActionOptions(paramWriter, args.options)

    // Transmit and parse response
    const result = await this.transmit('createAction', originator, paramWriter.toArray())
    return this.parseCreateActionResult(result)
  }

  private parseCreateActionResult (result: number[]): CreateActionResult {
    const resultReader = new Utils.Reader(result)
    const response: CreateActionResult = {}

    if (resultReader.readInt8() === 1) {
      response.txid = Utils.toHex(resultReader.read(32))
    }

    if (resultReader.readInt8() === 1) {
      response.tx = resultReader.read(resultReader.readVarIntNum())
    }

    const noSendChangeLength = resultReader.readVarIntNum()
    if (noSendChangeLength >= 0) {
      response.noSendChange = []
      for (let i = 0; i < noSendChangeLength; i++) {
        response.noSendChange.push(this.readOutpoint(resultReader))
      }
    }

    const sendWithResults = this.readSendWithResults(resultReader)
    if (sendWithResults != null) response.sendWithResults = sendWithResults

    if (resultReader.readInt8() === 1) {
      const tx = resultReader.read(resultReader.readVarIntNum())
      const referenceBytes = resultReader.read(resultReader.readVarIntNum())
      response.signableTransaction = { tx, reference: Utils.toBase64(referenceBytes) }
    }

    return response
  }

  async signAction (
    args: SignActionArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<SignActionResult> {
    const paramWriter = new Utils.Writer()

    // Serialize spends
    const spendIndexes = Object.keys(args.spends)
    paramWriter.writeVarIntNum(spendIndexes.length)
    for (const index of spendIndexes) {
      paramWriter.writeVarIntNum(Number(index))
      const spend = args.spends[Number(index)]
      const unlockingScriptBytes = Utils.toArray(spend.unlockingScript, 'hex')
      paramWriter.writeVarIntNum(unlockingScriptBytes.length)
      paramWriter.write(unlockingScriptBytes)
      this.writeOptionalVarInt(paramWriter, spend.sequenceNumber)
    }

    // Serialize reference
    const referenceBytes = Utils.toArray(args.reference, 'base64')
    paramWriter.writeVarIntNum(referenceBytes.length)
    paramWriter.write(referenceBytes)

    // Serialize options
    this.serializeSignActionOptions(paramWriter, args.options)

    // Transmit and parse response
    const result = await this.transmit('signAction', originator, paramWriter.toArray())
    const resultReader = new Utils.Reader(result)

    const response: SignActionResult = {}
    if (resultReader.readInt8() === 1) {
      response.txid = Utils.toHex(resultReader.read(32))
    }
    if (resultReader.readInt8() === 1) {
      response.tx = resultReader.read(resultReader.readVarIntNum())
    }
    const sendWithResults = this.readSendWithResults(resultReader)
    if (sendWithResults != null) response.sendWithResults = sendWithResults

    return response
  }

  async abortAction (
    args: { reference: Base64String },
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<{ aborted: true }> {
    await this.transmit(
      'abortAction',
      originator,
      Utils.toArray(args.reference, 'base64')
    )
    return { aborted: true }
  }

  async listActions (
    args: ListActionsArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<ListActionsResult> {
    const paramWriter = new Utils.Writer()

    // Serialize labels (always-present array, no -1 sentinel)
    paramWriter.writeVarIntNum(args.labels.length)
    for (const label of args.labels) {
      this.writeUTF8(paramWriter, label)
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
      this.writeOptionalBool(paramWriter, option)
    }

    this.writeOptionalVarInt(paramWriter, args.limit)
    this.writeOptionalVarInt(paramWriter, args.offset)
    this.writeOptionalBool(paramWriter, args.seekPermission)

    const result = await this.transmit('listActions', originator, paramWriter.toArray())
    const resultReader = new Utils.Reader(result)
    const totalActions = resultReader.readVarIntNum()
    const actions: ListActionsResult['actions'] = []
    for (let i = 0; i < totalActions; i++) {
      actions.push(this.parseAction(resultReader))
    }
    return { totalActions, actions }
  }

  private parseActionStatus (code: number): ActionStatus {
    const status = ACTION_STATUS_MAP[code]
    if (status == null) throw new Error(`Unknown status code: ${code}`)
    return status
  }

  private parseAction (reader: Utils.Reader): ListActionsResult['actions'][number] {
    const txid = Utils.toHex(reader.read(32))
    const satoshis = reader.readVarIntNum()
    const status = this.parseActionStatus(reader.readInt8())
    const isOutgoing = reader.readInt8() === 1
    const description = Utils.toUTF8(reader.read(reader.readVarIntNum()))

    const action: any = { txid, satoshis, status, isOutgoing, description, version: 0, lockTime: 0 }

    const labelsLen = reader.readVarIntNum()
    if (labelsLen >= 0) {
      action.labels = []
      for (let j = 0; j < labelsLen; j++) {
        action.labels.push(Utils.toUTF8(reader.read(reader.readVarIntNum())))
      }
    }

    action.version = reader.readVarIntNum()
    action.lockTime = reader.readVarIntNum()

    const inputsLen = reader.readVarIntNum()
    if (inputsLen >= 0) {
      action.inputs = []
      for (let k = 0; k < inputsLen; k++) {
        action.inputs.push(this.parseActionInput(reader))
      }
    }

    const outputsLen = reader.readVarIntNum()
    if (outputsLen >= 0) {
      action.outputs = []
      for (let l = 0; l < outputsLen; l++) {
        action.outputs.push(this.parseActionOutput(reader))
      }
    }

    return action
  }

  private parseActionInput (reader: Utils.Reader): {
    sourceOutpoint: OutpointString
    sourceSatoshis: SatoshiValue
    sourceLockingScript?: HexString
    unlockingScript?: HexString
    inputDescription: DescriptionString5to50Bytes
    sequenceNumber: PositiveIntegerOrZero
  } {
    const sourceOutpoint = this.readOutpoint(reader)
    const sourceSatoshis = reader.readVarIntNum()
    const srcLockLen = reader.readVarIntNum()
    const sourceLockingScript = srcLockLen >= 0 ? Utils.toHex(reader.read(srcLockLen)) : undefined
    const unlockLen = reader.readVarIntNum()
    const unlockingScript = unlockLen >= 0 ? Utils.toHex(reader.read(unlockLen)) : undefined
    const inputDescription = Utils.toUTF8(reader.read(reader.readVarIntNum()))
    const sequenceNumber = reader.readVarIntNum()
    return { sourceOutpoint, sourceSatoshis, sourceLockingScript, unlockingScript, inputDescription, sequenceNumber }
  }

  private parseActionOutput (reader: Utils.Reader): {
    outputIndex: PositiveIntegerOrZero
    satoshis: SatoshiValue
    lockingScript?: HexString
    spendable: boolean
    outputDescription: DescriptionString5to50Bytes
    basket: BasketStringUnder300Bytes
    tags: OutputTagStringUnder300Bytes[]
    customInstructions?: string
  } {
    const outputIndex = reader.readVarIntNum()
    const satoshis = reader.readVarIntNum()
    const lockLen = reader.readVarIntNum()
    const lockingScript = lockLen >= 0 ? Utils.toHex(reader.read(lockLen)) : undefined
    const spendable = reader.readInt8() === 1
    const outputDescription = Utils.toUTF8(reader.read(reader.readVarIntNum()))
    const basketLen = reader.readVarIntNum()
    const basket = basketLen >= 0 ? Utils.toUTF8(reader.read(basketLen)) : undefined
    const tagsLen = reader.readVarIntNum()
    const tags: string[] = []
    if (tagsLen >= 0) {
      for (let m = 0; m < tagsLen; m++) {
        tags.push(Utils.toUTF8(reader.read(reader.readVarIntNum())))
      }
    }
    const custLen = reader.readVarIntNum()
    const customInstructions = custLen >= 0 ? Utils.toUTF8(reader.read(custLen)) : undefined
    return { outputIndex, satoshis, lockingScript, spendable, outputDescription, basket: basket as BasketStringUnder300Bytes, tags, customInstructions }
  }

  async internalizeAction (
    args: InternalizeActionArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<{ accepted: true }> {
    const paramWriter = new Utils.Writer()
    paramWriter.writeVarIntNum(args.tx.length)
    paramWriter.write(args.tx)
    paramWriter.writeVarIntNum(args.outputs.length)
    for (const out of args.outputs) {
      this.serializeInternalizeOutput(paramWriter, out)
    }
    this.writeUTF8Array(paramWriter, typeof args.labels === 'object' ? args.labels : undefined)
    const descriptionAsArray = Utils.toArray(args.description)
    paramWriter.writeVarIntNum(descriptionAsArray.length)
    paramWriter.write(descriptionAsArray)
    this.writeOptionalBool(paramWriter, args.seekPermission)
    await this.transmit('internalizeAction', originator, paramWriter.toArray())
    return { accepted: true }
  }

  private serializeInternalizeOutput (
    writer: Utils.Writer,
    out: InternalizeActionArgs['outputs'][number]
  ): void {
    writer.writeVarIntNum(out.outputIndex)
    if (out.protocol === 'wallet payment') {
      if (out.paymentRemittance == null) {
        throw new Error('Payment remittance is required for wallet payment')
      }
      writer.writeUInt8(1)
      writer.write(Utils.toArray(out.paymentRemittance.senderIdentityKey, 'hex'))
      const prefix = Utils.toArray(out.paymentRemittance.derivationPrefix, 'base64')
      writer.writeVarIntNum(prefix.length)
      writer.write(prefix)
      const suffix = Utils.toArray(out.paymentRemittance.derivationSuffix, 'base64')
      writer.writeVarIntNum(suffix.length)
      writer.write(suffix)
    } else {
      writer.writeUInt8(2)
      const basket = Utils.toArray(out.insertionRemittance?.basket, 'utf8')
      writer.writeVarIntNum(basket.length)
      writer.write(basket)
      this.writeOptionalUTF8(writer, out.insertionRemittance?.customInstructions)
      const tags = out.insertionRemittance?.tags
      if (typeof tags === 'object') {
        writer.writeVarIntNum(tags.length)
        for (const tag of tags) {
          const t = Utils.toArray(tag, 'utf8')
          writer.writeVarIntNum(t.length)
          writer.write(t)
        }
      } else {
        writer.writeVarIntNum(0)
      }
    }
  }

  async listOutputs (
    args: ListOutputsArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<ListOutputsResult> {
    const paramWriter = new Utils.Writer()
    this.writeUTF8(paramWriter, args.basket)
    if (typeof args.tags === 'object') {
      paramWriter.writeVarIntNum(args.tags.length)
      for (const tag of args.tags) {
        this.writeUTF8(paramWriter, tag)
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
    this.writeOptionalBool(paramWriter, args.includeCustomInstructions)
    this.writeOptionalBool(paramWriter, args.includeTags)
    this.writeOptionalBool(paramWriter, args.includeLabels)
    this.writeOptionalVarInt(paramWriter, args.limit)
    this.writeOptionalVarInt(paramWriter, args.offset)
    this.writeOptionalBool(paramWriter, args.seekPermission)

    const result = await this.transmit('listOutputs', originator, paramWriter.toArray())
    const resultReader = new Utils.Reader(result)
    const totalOutputs = resultReader.readVarIntNum()
    const beefLength = resultReader.readVarIntNum()
    const BEEF = beefLength >= 0 ? resultReader.read(beefLength) : undefined
    const outputs: ListOutputsResult['outputs'] = []
    for (let i = 0; i < totalOutputs; i++) {
      outputs.push(this.parseListOutputEntry(resultReader))
    }
    return { totalOutputs, BEEF, outputs }
  }

  private parseListOutputEntry (reader: Utils.Reader): ListOutputsResult['outputs'][number] {
    const outpoint = this.readOutpoint(reader)
    const satoshis = reader.readVarIntNum()
    const output: ListOutputsResult['outputs'][number] = { spendable: true, outpoint, satoshis }
    const scriptLen = reader.readVarIntNum()
    if (scriptLen >= 0) output.lockingScript = Utils.toHex(reader.read(scriptLen))
    const custLen = reader.readVarIntNum()
    if (custLen >= 0) output.customInstructions = Utils.toUTF8(reader.read(custLen))
    const tagsLen = reader.readVarIntNum()
    if (tagsLen !== -1) {
      const tags: OutputTagStringUnder300Bytes[] = []
      for (let i = 0; i < tagsLen; i++) {
        tags.push(Utils.toUTF8(reader.read(reader.readVarIntNum())))
      }
      output.tags = tags
    }
    const labelsLen = reader.readVarIntNum()
    if (labelsLen !== -1) {
      const labels: LabelStringUnder300Bytes[] = []
      for (let i = 0; i < labelsLen; i++) {
        labels.push(Utils.toUTF8(reader.read(reader.readVarIntNum())))
      }
      output.labels = labels
    }
    return output
  }

  async relinquishOutput (
    args: { basket: BasketStringUnder300Bytes, output: OutpointString },
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<{ relinquished: true }> {
    const paramWriter = new Utils.Writer()
    const basketAsArray = Utils.toArray(args.basket, 'utf8')
    paramWriter.writeVarIntNum(basketAsArray.length)
    paramWriter.write(basketAsArray)
    paramWriter.write(this.encodeOutpoint(args.output))
    await this.transmit('relinquishOutput', originator, paramWriter.toArray())
    return { relinquished: true }
  }

  private encodeOutpoint (outpoint: OutpointString): number[] {
    const writer = new Utils.Writer()
    const [txid, index] = outpoint.split('.')
    writer.write(Utils.toArray(txid, 'hex'))
    writer.writeVarIntNum(Number(index))
    return writer.toArray()
  }

  private readOutpoint (reader: Utils.Reader): OutpointString {
    const txid = Utils.toHex(reader.read(32))
    const index = reader.readVarIntNum()
    return `${txid}.${index}`
  }

  async getPublicKey (
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
    const paramWriter = new Utils.Writer()
    paramWriter.writeUInt8(args.identityKey ? 1 : 0)
    if (args.identityKey) {
      paramWriter.write(
        this.encodePrivilegedParams(args.privileged, args.privilegedReason)
      )
    } else {
      args.protocolID ??= [SecurityLevels.Silent, 'default']
      args.keyID ??= ''
      paramWriter.write(
        this.encodeKeyRelatedParams(
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
    this.writeOptionalBool(paramWriter, args.seekPermission)

    const result = await this.transmit(
      'getPublicKey',
      originator,
      paramWriter.toArray()
    )
    return {
      publicKey: Utils.toHex(result)
    }
  }

  async revealCounterpartyKeyLinkage (
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
    const paramWriter = new Utils.Writer()
    paramWriter.write(
      this.encodePrivilegedParams(args.privileged, args.privilegedReason)
    )
    paramWriter.write(Utils.toArray(args.counterparty, 'hex'))
    paramWriter.write(Utils.toArray(args.verifier, 'hex'))
    const result = await this.transmit(
      'revealCounterpartyKeyLinkage',
      originator,
      paramWriter.toArray()
    )
    const resultReader = new Utils.Reader(result)
    const prover = Utils.toHex(resultReader.read(33))
    const verifier = Utils.toHex(resultReader.read(33))
    const counterparty = Utils.toHex(resultReader.read(33))
    const revelationTimeLength = resultReader.readVarIntNum()
    const revelationTime = Utils.toUTF8(
      resultReader.read(revelationTimeLength)
    )
    const encryptedLinkageLength = resultReader.readVarIntNum()
    const encryptedLinkage = resultReader.read(encryptedLinkageLength)
    const encryptedLinkageProofLength = resultReader.readVarIntNum()
    const encryptedLinkageProof = resultReader.read(
      encryptedLinkageProofLength
    )
    return {
      prover,
      verifier,
      counterparty,
      revelationTime,
      encryptedLinkage,
      encryptedLinkageProof
    }
  }

  async revealSpecificKeyLinkage (
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
    const paramWriter = new Utils.Writer()
    paramWriter.write(
      this.encodeKeyRelatedParams(
        args.protocolID,
        args.keyID,
        args.counterparty,
        args.privileged,
        args.privilegedReason
      )
    )
    paramWriter.write(Utils.toArray(args.verifier, 'hex'))
    const result = await this.transmit(
      'revealSpecificKeyLinkage',
      originator,
      paramWriter.toArray()
    )
    const resultReader = new Utils.Reader(result)
    const prover = Utils.toHex(resultReader.read(33))
    const verifier = Utils.toHex(resultReader.read(33))
    const counterparty = Utils.toHex(resultReader.read(33))
    const securityLevel = resultReader.readUInt8()
    const protocolLength = resultReader.readVarIntNum()
    const protocol = Utils.toUTF8(resultReader.read(protocolLength))
    const keyIDLength = resultReader.readVarIntNum()
    const keyID = Utils.toUTF8(resultReader.read(keyIDLength))
    const encryptedLinkageLength = resultReader.readVarIntNum()
    const encryptedLinkage = resultReader.read(encryptedLinkageLength)
    const encryptedLinkageProofLength = resultReader.readVarIntNum()
    const encryptedLinkageProof = resultReader.read(
      encryptedLinkageProofLength
    )
    const proofType = resultReader.readUInt8()
    return {
      prover,
      verifier,
      counterparty,
      protocolID: [securityLevel as SecurityLevel, protocol],
      keyID,
      encryptedLinkage,
      encryptedLinkageProof,
      proofType
    }
  }

  async encrypt (
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
    const paramWriter = new Utils.Writer()
    paramWriter.write(
      this.encodeKeyRelatedParams(
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
    this.writeOptionalBool(paramWriter, args.seekPermission)
    return {
      ciphertext: await this.transmit(
        'encrypt',
        originator,
        paramWriter.toArray()
      )
    }
  }

  async decrypt (
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
    const paramWriter = new Utils.Writer()
    paramWriter.write(
      this.encodeKeyRelatedParams(
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
    this.writeOptionalBool(paramWriter, args.seekPermission)
    return {
      plaintext: await this.transmit(
        'decrypt',
        originator,
        paramWriter.toArray()
      )
    }
  }

  async createHmac (
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
    const paramWriter = new Utils.Writer()
    paramWriter.write(
      this.encodeKeyRelatedParams(
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
    this.writeOptionalBool(paramWriter, args.seekPermission)
    return {
      hmac: await this.transmit(
        'createHmac',
        originator,
        paramWriter.toArray()
      )
    }
  }

  async verifyHmac (
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
    const paramWriter = new Utils.Writer()
    paramWriter.write(
      this.encodeKeyRelatedParams(
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
    this.writeOptionalBool(paramWriter, args.seekPermission)
    await this.transmit('verifyHmac', originator, paramWriter.toArray())
    return { valid: true }
  }

  async createSignature (
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
    const paramWriter = new Utils.Writer()
    paramWriter.write(
      this.encodeKeyRelatedParams(
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
    this.writeOptionalBool(paramWriter, args.seekPermission)
    return {
      signature: await this.transmit(
        'createSignature',
        originator,
        paramWriter.toArray()
      )
    }
  }

  async verifySignature (
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
    const paramWriter = new Utils.Writer()
    paramWriter.write(
      this.encodeKeyRelatedParams(
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
    this.writeOptionalBool(paramWriter, args.seekPermission)
    await this.transmit('verifySignature', originator, paramWriter.toArray())
    return { valid: true }
  }

  /** Writes an optional boolean as Int8: 1/0 if present, -1 if absent. */
  private writeOptionalBool (writer: Utils.Writer, val: boolean | undefined): void {
    if (typeof val === 'boolean') {
      writer.writeInt8(val ? 1 : 0)
    } else {
      writer.writeInt8(-1)
    }
  }

  /** Writes an optional number as VarInt: the value if present, -1 if absent. */
  private writeOptionalVarInt (writer: Utils.Writer, val: number | undefined): void {
    if (typeof val === 'number') {
      writer.writeVarIntNum(val)
    } else {
      writer.writeVarIntNum(-1)
    }
  }

  /** Writes a UTF-8 string as (VarInt length, bytes). */
  private writeUTF8 (writer: Utils.Writer, val: string | undefined): void {
    const bytes = Utils.toArray(val ?? '', 'utf8')
    writer.writeVarIntNum(bytes.length)
    writer.write(bytes)
  }

  /** Writes an optional UTF-8 string: (VarInt length, bytes) if non-empty, -1 if absent/empty. */
  private writeOptionalUTF8 (writer: Utils.Writer, val: string | undefined): void {
    if (val != null && val !== '') {
      const bytes = Utils.toArray(val, 'utf8')
      writer.writeVarIntNum(bytes.length)
      writer.write(bytes)
    } else {
      writer.writeVarIntNum(-1)
    }
  }

  /** Writes an array of UTF-8 strings as (VarInt count, ...items). -1 if null. */
  private writeUTF8Array (writer: Utils.Writer, arr: string[] | undefined): void {
    if (arr == null) {
      writer.writeVarIntNum(-1)
    } else {
      writer.writeVarIntNum(arr.length)
      for (const item of arr) {
        const bytes = Utils.toArray(item, 'utf8')
        writer.writeVarIntNum(bytes.length)
        writer.write(bytes)
      }
    }
  }

  /** Writes an array of hex-encoded txids (each 32 bytes) as (VarInt count, ...items). -1 if null. */
  private writeTxidArray (writer: Utils.Writer, arr: string[] | undefined): void {
    if (arr == null) {
      writer.writeVarIntNum(-1)
    } else {
      writer.writeVarIntNum(arr.length)
      for (const txid of arr) {
        writer.write(Utils.toArray(txid, 'hex'))
      }
    }
  }

  /** Reads a list of SendWithResults entries from a binary reader. */
  private readSendWithResults (
    reader: Utils.Reader
  ): Array<{ txid: TXIDHexString, status: SendWithResultStatus }> | undefined {
    const len = reader.readVarIntNum()
    if (len < 0) return undefined
    const results: Array<{ txid: TXIDHexString, status: SendWithResultStatus }> = []
    for (let i = 0; i < len; i++) {
      const txid = Utils.toHex(reader.read(32))
      const code = reader.readInt8()
      const status: SendWithResultStatus = code === 2 ? 'sending' : code === 3 ? 'failed' : 'unproven'
      results.push({ txid, status })
    }
    return results
  }

  /** Serializes a single createAction input to the writer. */
  private serializeCreateActionInput (
    writer: Utils.Writer,
    input: {
      outpoint: OutpointString
      unlockingScript?: string
      unlockingScriptLength?: number
      inputDescription: string
      sequenceNumber?: number
    }
  ): void {
    writer.write(this.encodeOutpoint(input.outpoint))

    if (input.unlockingScript != null && input.unlockingScript !== '') {
      const bytes = Utils.toArray(input.unlockingScript, 'hex')
      writer.writeVarIntNum(bytes.length)
      writer.write(bytes)
    } else {
      writer.writeVarIntNum(-1)
      writer.writeVarIntNum(input.unlockingScriptLength ?? 0)
    }

    this.writeUTF8(writer, input.inputDescription)
    this.writeOptionalVarInt(writer, input.sequenceNumber)
  }

  /** Serializes a single createAction output to the writer. */
  private serializeCreateActionOutput (
    writer: Utils.Writer,
    output: {
      lockingScript: string
      satoshis: number
      outputDescription: string
      basket?: string
      customInstructions?: string
      tags?: string[]
    }
  ): void {
    const lockingBytes = Utils.toArray(output.lockingScript, 'hex')
    writer.writeVarIntNum(lockingBytes.length)
    writer.write(lockingBytes)
    writer.writeVarIntNum(output.satoshis)
    this.writeUTF8(writer, output.outputDescription)
    this.writeOptionalUTF8(writer, output.basket)
    this.writeOptionalUTF8(writer, output.customInstructions)
    this.writeUTF8Array(writer, output.tags)
  }

  /** Serializes createAction options to the writer (Int8 presence byte + fields). */
  private serializeCreateActionOptions (
    writer: Utils.Writer,
    options: {
      signAndProcess?: boolean
      acceptDelayedBroadcast?: boolean
      trustSelf?: string
      knownTxids?: string[]
      returnTXIDOnly?: boolean
      noSend?: boolean
      noSendChange?: OutpointString[]
      sendWith?: string[]
      randomizeOutputs?: boolean
    } | undefined
  ): void {
    if (options == null) {
      writer.writeInt8(0)
      return
    }
    writer.writeInt8(1)
    this.writeOptionalBool(writer, options.signAndProcess)
    this.writeOptionalBool(writer, options.acceptDelayedBroadcast)
    writer.writeInt8(options.trustSelf === 'known' ? 1 : -1)
    this.writeTxidArray(writer, options.knownTxids)
    this.writeOptionalBool(writer, options.returnTXIDOnly)
    this.writeOptionalBool(writer, options.noSend)
    if (options.noSendChange == null) {
      writer.writeVarIntNum(-1)
    } else {
      writer.writeVarIntNum(options.noSendChange.length)
      for (const outpoint of options.noSendChange) {
        writer.write(this.encodeOutpoint(outpoint))
      }
    }
    this.writeTxidArray(writer, options.sendWith)
    this.writeOptionalBool(writer, options.randomizeOutputs)
  }

  /** Serializes signAction options to the writer (Int8 presence byte + fields). */
  private serializeSignActionOptions (
    writer: Utils.Writer,
    options: {
      acceptDelayedBroadcast?: boolean
      returnTXIDOnly?: boolean
      noSend?: boolean
      sendWith?: string[]
    } | undefined
  ): void {
    if (options == null) {
      writer.writeInt8(0)
      return
    }
    writer.writeInt8(1)
    this.writeOptionalBool(writer, options.acceptDelayedBroadcast)
    this.writeOptionalBool(writer, options.returnTXIDOnly)
    this.writeOptionalBool(writer, options.noSend)
    this.writeTxidArray(writer, options.sendWith)
  }

  private encodeKeyRelatedParams (
    protocolID: [SecurityLevel, ProtocolString5To400Bytes],
    keyID: KeyIDStringUnder800Bytes,
    counterparty?: PubKeyHex,
    privileged?: boolean,
    privilegedReason?: string
  ): number[] {
    const paramWriter = new Utils.Writer()
    paramWriter.writeUInt8(protocolID[0])
    const protocolAsArray = Utils.toArray(protocolID[1], 'utf8')
    paramWriter.writeVarIntNum(protocolAsArray.length)
    paramWriter.write(protocolAsArray)
    const keyIDAsArray = Utils.toArray(keyID, 'utf8')
    paramWriter.writeVarIntNum(keyIDAsArray.length)
    paramWriter.write(keyIDAsArray)
    if (typeof counterparty !== 'string') {
      paramWriter.writeUInt8(0)
    } else if (counterparty === 'self') {
      paramWriter.writeUInt8(11)
    } else if (counterparty === 'anyone') {
      paramWriter.writeUInt8(12)
    } else {
      paramWriter.write(Utils.toArray(counterparty, 'hex'))
    }
    paramWriter.write(
      this.encodePrivilegedParams(privileged, privilegedReason)
    )
    return paramWriter.toArray()
  }

  async acquireCertificate (
    args: AcquireCertificateArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<AcquireCertificateResult> {
    const paramWriter = new Utils.Writer()
    paramWriter.write(Utils.toArray(args.type, 'base64'))
    paramWriter.write(Utils.toArray(args.certifier, 'hex'))

    const fieldEntries = Object.entries(args.fields)
    paramWriter.writeVarIntNum(fieldEntries.length)
    for (const [key, value] of fieldEntries) {
      const keyAsArray = Utils.toArray(key, 'utf8')
      const valueAsArray = Utils.toArray(value, 'utf8')

      paramWriter.writeVarIntNum(keyAsArray.length)
      paramWriter.write(keyAsArray)

      paramWriter.writeVarIntNum(valueAsArray.length)
      paramWriter.write(valueAsArray)
    }

    paramWriter.write(
      this.encodePrivilegedParams(args.privileged, args.privilegedReason)
    )
    paramWriter.writeUInt8(args.acquisitionProtocol === 'direct' ? 1 : 2)

    if (args.acquisitionProtocol === 'direct') {
      paramWriter.write(Utils.toArray(args.serialNumber, 'base64'))
      paramWriter.write(this.encodeOutpoint(args.revocationOutpoint ?? ''))
      const signatureAsArray = Utils.toArray(args.signature, 'hex')
      paramWriter.writeVarIntNum(signatureAsArray.length)
      paramWriter.write(signatureAsArray)

      const keyringRevealerAsArray =
        args.keyringRevealer === 'certifier'
          ? [11]
          : Utils.toArray(args.keyringRevealer, 'hex')
      paramWriter.write(keyringRevealerAsArray)

      const keyringKeys = Object.keys(args.keyringForSubject ?? {})
      paramWriter.writeVarIntNum(keyringKeys.length)
      for (const key of keyringKeys) {
        const keyringKeysAsArray = Utils.toArray(key, 'utf8')
        paramWriter.writeVarIntNum(keyringKeysAsArray.length)
        paramWriter.write(keyringKeysAsArray)
        const keyringForSubjectAsArray = Utils.toArray(
          args.keyringForSubject?.[key],
          'base64'
        )
        paramWriter.writeVarIntNum(keyringForSubjectAsArray.length)
        paramWriter.write(keyringForSubjectAsArray)
      }
    } else {
      const certifierUrlAsArray = Utils.toArray(args.certifierUrl, 'utf8')
      paramWriter.writeVarIntNum(certifierUrlAsArray.length)
      paramWriter.write(certifierUrlAsArray)
    }

    const result = await this.transmit(
      'acquireCertificate',
      originator,
      paramWriter.toArray()
    )
    const cert = Certificate.fromBinary(result)
    return {
      ...cert,
      signature: cert.signature as string
    }
  }

  private encodePrivilegedParams (
    privileged?: boolean,
    privilegedReason?: string
  ): number[] {
    const paramWriter = new Utils.Writer()
    if (typeof privileged === 'boolean') {
      paramWriter.writeInt8(privileged ? 1 : 0)
    } else {
      paramWriter.writeInt8(-1)
    }
    if (typeof privilegedReason === 'string') {
      const privilegedReasonAsArray = Utils.toArray(privilegedReason, 'utf8')
      paramWriter.writeInt8(privilegedReasonAsArray.length)
      paramWriter.write(privilegedReasonAsArray)
    } else {
      paramWriter.writeInt8(-1)
    }
    return paramWriter.toArray()
  }

  async listCertificates (
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
    const paramWriter = new Utils.Writer()
    paramWriter.writeVarIntNum(args.certifiers.length)
    for (const certifier of args.certifiers) {
      paramWriter.write(Utils.toArray(certifier, 'hex'))
    }

    paramWriter.writeVarIntNum(args.types.length)
    for (const type of args.types) {
      paramWriter.write(Utils.toArray(type, 'base64'))
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
    paramWriter.write(
      this.encodePrivilegedParams(args.privileged, args.privilegedReason)
    )
    const result = await this.transmit(
      'listCertificates',
      originator,
      paramWriter.toArray()
    )
    const resultReader = new Utils.Reader(result)
    const totalCertificates = resultReader.readVarIntNum()
    const certificates: CertificateResult[] = []
    for (let i = 0; i < totalCertificates; i++) {
      const certificateLength = resultReader.readVarIntNum()
      const certificateBin = resultReader.read(certificateLength)
      const cert = Certificate.fromBinary(certificateBin)
      const keyringForVerifier: Record<string, string> = {}
      if (resultReader.readInt8() === 1) {
        const numFields = resultReader.readVarIntNum()
        for (let i = 0; i < numFields; i++) {
          const fieldKeyLength = resultReader.readVarIntNum()
          const fieldKey = Utils.toUTF8(resultReader.read(fieldKeyLength))
          const fieldValueLength = resultReader.readVarIntNum()
          keyringForVerifier[fieldKey] = Utils.toBase64(
            resultReader.read(fieldValueLength)
          )
        }
      }
      const verifierLength = resultReader.readVarIntNum()
      let verifier: string | undefined
      if (verifierLength > 0) {
        verifier = Utils.toUTF8(resultReader.read(verifierLength))
      }
      certificates.push({
        ...cert,
        signature: cert.signature as string,
        keyring: keyringForVerifier,
        verifier
      })
    }
    return {
      totalCertificates,
      certificates
    }
  }

  async proveCertificate (
    args: ProveCertificateArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<ProveCertificateResult> {
    const paramWriter = new Utils.Writer()
    const typeAsArray = Utils.toArray(args.certificate.type, 'base64')
    paramWriter.write(typeAsArray)
    const subjectAsArray = Utils.toArray(args.certificate.subject, 'hex')
    paramWriter.write(subjectAsArray)
    const serialNumberAsArray = Utils.toArray(
      args.certificate.serialNumber,
      'base64'
    )
    paramWriter.write(serialNumberAsArray)
    const certifierAsArray = Utils.toArray(args.certificate.certifier, 'hex')
    paramWriter.write(certifierAsArray)
    const revocationOutpointAsArray = this.encodeOutpoint(
      args.certificate.revocationOutpoint ?? ''
    )
    paramWriter.write(revocationOutpointAsArray)
    const signatureAsArray = Utils.toArray(args.certificate.signature, 'hex')
    paramWriter.writeVarIntNum(signatureAsArray.length)
    paramWriter.write(signatureAsArray)
    const fieldEntries = Object.entries(args.certificate.fields ?? {})
    paramWriter.writeVarIntNum(fieldEntries.length)
    for (const [key, value] of fieldEntries) {
      const keyAsArray = Utils.toArray(key, 'utf8')
      const valueAsArray = Utils.toArray(value, 'utf8')
      paramWriter.writeVarIntNum(keyAsArray.length)
      paramWriter.write(keyAsArray)
      paramWriter.writeVarIntNum(valueAsArray.length)
      paramWriter.write(valueAsArray)
    }
    paramWriter.writeVarIntNum(args.fieldsToReveal.length)
    for (const field of args.fieldsToReveal) {
      const fieldAsArray = Utils.toArray(field, 'utf8')
      paramWriter.writeVarIntNum(fieldAsArray.length)
      paramWriter.write(fieldAsArray)
    }
    paramWriter.write(Utils.toArray(args.verifier, 'hex'))
    paramWriter.write(
      this.encodePrivilegedParams(args.privileged, args.privilegedReason)
    )
    const result = await this.transmit(
      'proveCertificate',
      originator,
      paramWriter.toArray()
    )
    const resultReader = new Utils.Reader(result)
    const numFields = resultReader.readVarIntNum()
    const keyringForVerifier: Record<string, string> = {}
    for (let i = 0; i < numFields; i++) {
      const fieldKeyLength = resultReader.readVarIntNum()
      const fieldKey = Utils.toUTF8(resultReader.read(fieldKeyLength))
      const fieldValueLength = resultReader.readVarIntNum()
      keyringForVerifier[fieldKey] = Utils.toBase64(
        resultReader.read(fieldValueLength)
      )
    }
    return {
      keyringForVerifier
    }
  }

  async relinquishCertificate (
    args: {
      type: Base64String
      serialNumber: Base64String
      certifier: PubKeyHex
    },
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<{ relinquished: true }> {
    const paramWriter = new Utils.Writer()
    const typeAsArray = Utils.toArray(args.type, 'base64')
    paramWriter.write(typeAsArray)
    const serialNumberAsArray = Utils.toArray(args.serialNumber, 'base64')
    paramWriter.write(serialNumberAsArray)
    const certifierAsArray = Utils.toArray(args.certifier, 'hex')
    paramWriter.write(certifierAsArray)
    await this.transmit(
      'relinquishCertificate',
      originator,
      paramWriter.toArray()
    )
    return { relinquished: true }
  }

  private parseDiscoveryResult (result: number[]): {
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
      publiclyRevealedKeyring: Record<
      CertificateFieldNameUnder50Bytes,
      Base64String
      >
      decryptedFields: Record<CertificateFieldNameUnder50Bytes, string>
    }>
  } {
    const resultReader = new Utils.Reader(result)
    const totalCertificates = resultReader.readVarIntNum()
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
      publiclyRevealedKeyring: Record<
      CertificateFieldNameUnder50Bytes,
      Base64String
      >
      decryptedFields: Record<CertificateFieldNameUnder50Bytes, string>
    }> = []
    for (let i = 0; i < totalCertificates; i++) {
      const certBinLen = resultReader.readVarIntNum()
      const certBin = resultReader.read(certBinLen)
      const cert = Certificate.fromBinary(certBin)
      const nameLength = resultReader.readVarIntNum()
      const name = Utils.toUTF8(resultReader.read(nameLength))
      const iconUrlLength = resultReader.readVarIntNum()
      const iconUrl = Utils.toUTF8(resultReader.read(iconUrlLength))
      const descriptionLength = resultReader.readVarIntNum()
      const description = Utils.toUTF8(resultReader.read(descriptionLength))
      const trust = resultReader.readUInt8()
      const publiclyRevealedKeyring = {}
      const numPublicKeyringEntries = resultReader.readVarIntNum()
      for (let j = 0; j < numPublicKeyringEntries; j++) {
        const fieldKeyLen = resultReader.readVarIntNum()
        const fieldKey = Utils.toUTF8(resultReader.read(fieldKeyLen))
        const fieldValueLen = resultReader.readVarIntNum()
        publiclyRevealedKeyring[fieldKey] = resultReader.read(fieldValueLen)
      }
      const decryptedFields = {}
      const numDecryptedFields = resultReader.readVarIntNum()
      for (let k = 0; k < numDecryptedFields; k++) {
        const fieldKeyLen = resultReader.readVarIntNum()
        const fieldKey = Utils.toUTF8(resultReader.read(fieldKeyLen))
        const fieldValueLen = resultReader.readVarIntNum()
        decryptedFields[fieldKey] = Utils.toUTF8(
          resultReader.read(fieldValueLen)
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
    return {
      totalCertificates,
      certificates
    }
  }

  async discoverByIdentityKey (
    args: {
      seekPermission?: BooleanDefaultTrue
      identityKey: PubKeyHex
      limit?: PositiveIntegerDefault10Max10000
      offset?: PositiveIntegerOrZero
    },
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<DiscoverCertificatesResult> {
    const paramWriter = new Utils.Writer()
    paramWriter.write(Utils.toArray(args.identityKey, 'hex'))
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
    this.writeOptionalBool(paramWriter, args.seekPermission)
    const result = await this.transmit(
      'discoverByIdentityKey',
      originator,
      paramWriter.toArray()
    )
    return this.parseDiscoveryResult(result)
  }

  async discoverByAttributes (
    args: {
      seekPermission?: BooleanDefaultTrue
      attributes: Record<CertificateFieldNameUnder50Bytes, string>
      limit?: PositiveIntegerDefault10Max10000
      offset?: PositiveIntegerOrZero
    },
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<DiscoverCertificatesResult> {
    const paramWriter = new Utils.Writer()
    const attributeKeys = Object.keys(args.attributes)
    paramWriter.writeVarIntNum(attributeKeys.length)
    for (const attrKey of attributeKeys) {
      paramWriter.writeVarIntNum(attrKey.length)
      paramWriter.write(Utils.toArray(attrKey, 'utf8'))
      paramWriter.writeVarIntNum(args.attributes[attrKey].length)
      paramWriter.write(
        Utils.toArray(args.attributes[attrKey], 'utf8')
      )
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
    this.writeOptionalBool(paramWriter, args.seekPermission)
    const result = await this.transmit(
      'discoverByAttributes',
      originator,
      paramWriter.toArray()
    )
    return this.parseDiscoveryResult(result)
  }

  async isAuthenticated (
    args: {},
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<{ authenticated: true }> {
    const result = await this.transmit('isAuthenticated', originator)
    // @ts-expect-error
    return { authenticated: result[0] === 1 }
  }

  async waitForAuthentication (
    args: {},
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<{ authenticated: true }> {
    await this.transmit('waitForAuthentication', originator)
    return { authenticated: true }
  }

  async getHeight (
    args: {},
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<{ height: PositiveInteger }> {
    const result = await this.transmit('getHeight', originator)
    const resultReader = new Utils.Reader(result)
    return {
      height: resultReader.readVarIntNum()
    }
  }

  async getHeaderForHeight (
    args: { height: PositiveInteger },
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<{ header: HexString }> {
    const paramWriter = new Utils.Writer()
    paramWriter.writeVarIntNum(args.height)
    const header = await this.transmit(
      'getHeaderForHeight',
      originator,
      paramWriter.toArray()
    )
    return {
      header: Utils.toHex(header)
    }
  }

  async getNetwork (
    args: {},
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<{ network: 'mainnet' | 'testnet' }> {
    const net = await this.transmit('getNetwork', originator)
    return {
      network: net[0] === 0 ? 'mainnet' : 'testnet'
    }
  }

  async getVersion (
    args: {},
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<{ version: VersionString7To30Bytes }> {
    const version = await this.transmit('getVersion', originator)
    return {
      version: Utils.toUTF8(version)
    }
  }
}
