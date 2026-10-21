import {
  AcquireCertificateArgs,
  Base64String,
  BasketStringUnder300Bytes,
  BEEF,
  BooleanDefaultFalse,
  BooleanDefaultTrue,
  Byte,
  CertificateFieldNameUnder50Bytes,
  DecimalString,
  DescriptionString5to50Bytes,
  EntityIconURLStringMax500Bytes,
  EntityNameStringMax100Bytes,
  HexString,
  ISOTimestampString,
  KeyIDStringUnder800Bytes,
  LabelStringUnder300Bytes,
  OriginatorDomainNameStringUnder250Bytes,
  OutpointString,
  OutputTagStringUnder300Bytes,
  PositiveInteger,
  PositiveIntegerDefault10Max10000,
  PositiveIntegerMax10,
  PositiveIntegerOrZero,
  ProtocolString5To400Bytes,
  PubKeyHex,
  ProveCertificateArgs,
  ProveCertificateResult,
  SatoshiValue,
  SecurityLevel,
  SignActionArgs,
  SignActionResult,
  TXIDHexString,
  VersionString7To30Bytes,
  WalletCertificate,
  WalletInterface
} from '../Wallet.interfaces.js'
import { snapshotWalletResultRequest, validateWalletResult } from '../WalletResultValidation.js'
import calls, { CallType } from './WalletWireCalls.js'
import { validateWalletArgs } from '../WalletArgumentValidation.js'

declare const window: {
  CWI?: WalletInterface
} & Window

/**
 * Facilitates wallet operations over the window.CWI interface.
 */
export default class WindowCWISubstrate implements WalletInterface {
  private readonly CWI: WalletInterface
  constructor() {
    if (typeof window !== 'object') {
      throw new TypeError('The window.CWI substrate requires a global window object.')
    }
    if (typeof window.CWI !== 'object') {
      throw new TypeError(
        'The window.CWI interface does not appear to be bound to the window object.'
      )
    }
    const boundCWI = window.CWI
    this.CWI = new Proxy(boundCWI, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver)
        if (
          typeof property !== 'string' ||
          !Object.prototype.hasOwnProperty.call(calls, property) ||
          typeof value !== 'function'
        ) {
          return value
        }
        return (args: unknown, ...rest: unknown[]) => {
          validateWalletArgs(property as CallType, args)
          return Reflect.apply(value, target, [args, ...rest])
        }
      }
    })
  }

  private async validatedResult<T>(
    call: CallType,
    pending: Promise<T>,
    request?: unknown
  ): Promise<T> {
    return validateWalletResult(call, await pending, request)
  }

  async createAction(
    args: {
      description: DescriptionString5to50Bytes
      inputs?: Array<{
        tx?: BEEF
        outpoint: OutpointString
        unlockingScript?: HexString
        unlockingScriptLength?: PositiveInteger
        inputDescription: DescriptionString5to50Bytes
        sequenceNumber?: PositiveIntegerOrZero
      }>
      outputs?: Array<{
        lockingScript: HexString
        satoshis: SatoshiValue
        outputDescription: DescriptionString5to50Bytes
        basket?: BasketStringUnder300Bytes
        customInstructions?: string
        tags?: OutputTagStringUnder300Bytes[]
      }>
      lockTime?: PositiveIntegerOrZero
      version?: PositiveIntegerOrZero
      labels?: LabelStringUnder300Bytes[]
      options?: {
        signAndProcess?: BooleanDefaultTrue
        acceptDelayedBroadcast?: BooleanDefaultTrue
        trustSelf?: 'known'
        knownTxids?: TXIDHexString[]
        returnTXIDOnly?: BooleanDefaultFalse
        noSend?: BooleanDefaultFalse
        noSendChange?: OutpointString[]
        sendWith?: TXIDHexString[]
      }
    },
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<{
    txid?: TXIDHexString
    tx?: BEEF
    noSendChange?: OutpointString[]
    sendWithResults?: Array<{
      txid: TXIDHexString
      status: 'unproven' | 'sending' | 'failed'
    }>
    signableTransaction?: { tx: BEEF; reference: Base64String }
  }> {
    const bindingRequest = snapshotWalletResultRequest('createAction', args)
    return await this.validatedResult(
      'createAction',
      this.CWI.createAction(args, originator),
      bindingRequest
    )
  }

  async signAction(
    args: SignActionArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<SignActionResult> {
    const bindingRequest = snapshotWalletResultRequest('signAction', args)
    return await this.validatedResult(
      'signAction',
      this.CWI.signAction(args, originator),
      bindingRequest
    )
  }

  async abortAction(
    args: { reference: Base64String },
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<{ aborted: boolean }> {
    return await this.validatedResult('abortAction', this.CWI.abortAction(args, originator))
  }

  async listActions(
    args: {
      labels: LabelStringUnder300Bytes[]
      labelQueryMode?: 'any' | 'all'
      includeLabels?: BooleanDefaultFalse
      includeInputs?: BooleanDefaultFalse
      includeInputSourceLockingScripts?: BooleanDefaultFalse
      includeInputUnlockingScripts?: BooleanDefaultFalse
      includeOutputs?: BooleanDefaultFalse
      includeOutputLockingScripts?: BooleanDefaultFalse
      limit?: PositiveIntegerDefault10Max10000
      offset?: PositiveIntegerOrZero
    },
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<{
    totalActions: PositiveIntegerOrZero
    actions: Array<{
      txid: TXIDHexString
      satoshis: SatoshiValue
      status:
        | 'completed'
        | 'unprocessed'
        | 'sending'
        | 'unproven'
        | 'unsigned'
        | 'nosend'
        | 'nonfinal'
        | 'failed'
      isOutgoing: boolean
      description: DescriptionString5to50Bytes
      labels?: LabelStringUnder300Bytes[]
      version: PositiveIntegerOrZero
      lockTime: PositiveIntegerOrZero
      inputs?: Array<{
        sourceOutpoint: OutpointString
        sourceSatoshis: SatoshiValue
        sourceLockingScript?: HexString
        unlockingScript?: HexString
        inputDescription: DescriptionString5to50Bytes
        sequenceNumber: PositiveIntegerOrZero
      }>
      outputs?: Array<{
        outputIndex: PositiveIntegerOrZero
        satoshis: SatoshiValue
        lockingScript?: HexString
        spendable: boolean
        outputDescription: DescriptionString5to50Bytes
        basket: BasketStringUnder300Bytes
        tags: OutputTagStringUnder300Bytes[]
        customInstructions?: string
      }>
    }>
  }> {
    const bindingRequest = snapshotWalletResultRequest('listActions', args)
    return await this.validatedResult(
      'listActions',
      this.CWI.listActions(args, originator),
      bindingRequest
    )
  }

  async internalizeAction(
    args: {
      tx: BEEF
      outputs: Array<{
        outputIndex: PositiveIntegerOrZero
        protocol: 'wallet payment' | 'basket insertion'
        paymentRemittance?: {
          derivationPrefix: Base64String
          derivationSuffix: Base64String
          senderIdentityKey: PubKeyHex
        }
        insertionRemittance?: {
          basket: BasketStringUnder300Bytes
          customInstructions?: string
          tags?: OutputTagStringUnder300Bytes[]
        }
      }>
      description: DescriptionString5to50Bytes
      labels?: LabelStringUnder300Bytes[]
    },
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<{ accepted: true }> {
    return await this.validatedResult(
      'internalizeAction',
      this.CWI.internalizeAction(args, originator)
    )
  }

  async listOutputs(
    args: {
      basket: BasketStringUnder300Bytes
      tags?: OutputTagStringUnder300Bytes[]
      tagQueryMode?: 'all' | 'any'
      include?: 'locking scripts' | 'entire transactions'
      includeCustomInstructions?: BooleanDefaultFalse
      includeTags?: BooleanDefaultFalse
      includeLabels?: BooleanDefaultFalse
      limit?: PositiveIntegerDefault10Max10000
      offset?: PositiveIntegerOrZero
    },
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<{
    totalOutputs: PositiveIntegerOrZero | DecimalString
    outputs: Array<{
      outpoint: OutpointString
      satoshis: SatoshiValue
      lockingScript?: HexString
      tx?: BEEF
      spendable: boolean
      customInstructions?: string
      tags?: OutputTagStringUnder300Bytes[]
      labels?: LabelStringUnder300Bytes[]
    }>
  }> {
    const bindingRequest = snapshotWalletResultRequest('listOutputs', args)
    return await this.validatedResult(
      'listOutputs',
      this.CWI.listOutputs(args, originator),
      bindingRequest
    )
  }

  async relinquishOutput(
    args: { basket: BasketStringUnder300Bytes; output: OutpointString },
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<{ relinquished: true }> {
    return await this.validatedResult(
      'relinquishOutput',
      this.CWI.relinquishOutput(args, originator)
    )
  }

  async getPublicKey(
    args: {
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
    return await this.validatedResult('getPublicKey', this.CWI.getPublicKey(args, originator))
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
    encryptedLinkageProof: Byte[]
  }> {
    const bindingRequest = snapshotWalletResultRequest('revealCounterpartyKeyLinkage', args)
    return await this.validatedResult(
      'revealCounterpartyKeyLinkage',
      this.CWI.revealCounterpartyKeyLinkage(args, originator),
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
    const bindingRequest = snapshotWalletResultRequest('revealSpecificKeyLinkage', args)
    return await this.validatedResult(
      'revealSpecificKeyLinkage',
      this.CWI.revealSpecificKeyLinkage(args, originator),
      bindingRequest
    )
  }

  async encrypt(
    args: {
      plaintext: Byte[]
      protocolID: [SecurityLevel, ProtocolString5To400Bytes]
      keyID: KeyIDStringUnder800Bytes
      privilegedReason?: DescriptionString5to50Bytes
      counterparty?: PubKeyHex
      privileged?: BooleanDefaultFalse
    },
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<{ ciphertext: Byte[] }> {
    return await this.validatedResult('encrypt', this.CWI.encrypt(args, originator))
  }

  async decrypt(
    args: {
      ciphertext: Byte[]
      protocolID: [SecurityLevel, ProtocolString5To400Bytes]
      keyID: KeyIDStringUnder800Bytes
      privilegedReason?: DescriptionString5to50Bytes
      counterparty?: PubKeyHex
      privileged?: BooleanDefaultFalse
    },
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<{ plaintext: Byte[] }> {
    return await this.validatedResult('decrypt', this.CWI.decrypt(args, originator))
  }

  async createHmac(
    args: {
      data: Byte[]
      protocolID: [SecurityLevel, ProtocolString5To400Bytes]
      keyID: KeyIDStringUnder800Bytes
      privilegedReason?: DescriptionString5to50Bytes
      counterparty?: PubKeyHex
      privileged?: BooleanDefaultFalse
    },
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<{ hmac: Byte[] }> {
    return await this.validatedResult('createHmac', this.CWI.createHmac(args, originator))
  }

  async verifyHmac(
    args: {
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
    return await this.validatedResult('verifyHmac', this.CWI.verifyHmac(args, originator))
  }

  async createSignature(
    args: {
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
    return await this.validatedResult('createSignature', this.CWI.createSignature(args, originator))
  }

  async verifySignature(
    args: {
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
    return await this.validatedResult('verifySignature', this.CWI.verifySignature(args, originator))
  }

  async acquireCertificate(
    args: AcquireCertificateArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<WalletCertificate> {
    const bindingRequest = snapshotWalletResultRequest('acquireCertificate', args)
    return await this.validatedResult(
      'acquireCertificate',
      this.CWI.acquireCertificate(args, originator),
      bindingRequest
    )
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
  ): Promise<{
    totalCertificates: PositiveIntegerOrZero
    certificates: Array<{
      type: Base64String
      subject: PubKeyHex
      serialNumber: Base64String
      certifier: PubKeyHex
      revocationOutpoint: OutpointString
      signature: HexString
      fields: Record<CertificateFieldNameUnder50Bytes, string>
    }>
  }> {
    const bindingRequest = snapshotWalletResultRequest('listCertificates', args)
    return await this.validatedResult(
      'listCertificates',
      this.CWI.listCertificates(args, originator),
      bindingRequest
    )
  }

  async proveCertificate(
    args: ProveCertificateArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<ProveCertificateResult> {
    const bindingRequest = snapshotWalletResultRequest('proveCertificate', args)
    return await this.validatedResult(
      'proveCertificate',
      this.CWI.proveCertificate(args, originator),
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
    return await this.validatedResult(
      'relinquishCertificate',
      this.CWI.relinquishCertificate(args, originator)
    )
  }

  async discoverByIdentityKey(
    args: {
      identityKey: PubKeyHex
      limit?: PositiveIntegerDefault10Max10000
      offset?: PositiveIntegerOrZero
    },
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<{
    totalCertificates: PositiveIntegerOrZero
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
  }> {
    const bindingRequest = snapshotWalletResultRequest('discoverByIdentityKey', args)
    return await this.validatedResult(
      'discoverByIdentityKey',
      this.CWI.discoverByIdentityKey(args, originator),
      bindingRequest
    )
  }

  async discoverByAttributes(
    args: {
      attributes: Record<CertificateFieldNameUnder50Bytes, string>
      limit?: PositiveIntegerDefault10Max10000
      offset?: PositiveIntegerOrZero
    },
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<{
    totalCertificates: PositiveIntegerOrZero
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
  }> {
    const bindingRequest = snapshotWalletResultRequest('discoverByAttributes', args)
    return await this.validatedResult(
      'discoverByAttributes',
      this.CWI.discoverByAttributes(args, originator),
      bindingRequest
    )
  }

  async isAuthenticated(
    args: object,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<{ authenticated: true }> {
    return await this.validatedResult('isAuthenticated', this.CWI.isAuthenticated(args, originator))
  }

  async waitForAuthentication(
    args: object,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<{ authenticated: true }> {
    return await this.validatedResult(
      'waitForAuthentication',
      this.CWI.waitForAuthentication(args, originator)
    )
  }

  async getHeight(
    args: object,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<{ height: PositiveInteger }> {
    return await this.validatedResult('getHeight', this.CWI.getHeight(args, originator))
  }

  async getHeaderForHeight(
    args: { height: PositiveInteger },
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<{ header: HexString }> {
    return await this.validatedResult(
      'getHeaderForHeight',
      this.CWI.getHeaderForHeight(args, originator)
    )
  }

  async getNetwork(
    args: object,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<{ network: 'mainnet' | 'testnet' }> {
    return await this.validatedResult('getNetwork', this.CWI.getNetwork(args, originator))
  }

  async getVersion(
    args: object,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<{ version: VersionString7To30Bytes }> {
    return await this.validatedResult('getVersion', this.CWI.getVersion(args, originator))
  }
}
