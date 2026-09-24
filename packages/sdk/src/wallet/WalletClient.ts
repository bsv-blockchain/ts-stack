import {
  AcquireCertificateArgs,
  AcquireCertificateResult,
  Base64String,
  BasketStringUnder300Bytes,
  BooleanDefaultFalse,
  Byte,
  CertificateFieldNameUnder50Bytes,
  CreateActionArgs,
  CreateActionResult,
  DescriptionString5to50Bytes,
  DiscoverCertificatesResult,
  HexString,
  InternalizeActionArgs,
  ISOTimestampString,
  KeyIDStringUnder800Bytes,
  ListActionsArgs,
  ListActionsResult,
  ListCertificatesResult,
  ListOutputsArgs,
  ListOutputsResult,
  OriginatorDomainNameStringUnder250Bytes,
  OutpointString,
  PositiveInteger,
  PositiveIntegerDefault10Max10000,
  PositiveIntegerOrZero,
  ProtocolString5To400Bytes,
  ProveCertificateArgs,
  ProveCertificateResult,
  PubKeyHex,
  SecurityLevel,
  SignActionArgs,
  SignActionResult,
  VersionString7To30Bytes,
  WalletInterface,
  AuthenticatedResult
} from './Wallet.interfaces.js'
import WindowCWISubstrate from './substrates/window.CWI.js'
import XDMSubstrate from './substrates/XDM.js'
import WalletWireTransceiver from './substrates/WalletWireTransceiver.js'
import HTTPWalletWire from './substrates/HTTPWalletWire.js'
import HTTPWalletJSON from './substrates/HTTPWalletJSON.js'
import ReactNativeWebView from './substrates/ReactNativeWebView.js'
import {
  validateAbortActionArgs,
  validateAcquireDirectCertificateArgs,
  validateAcquireIssuanceCertificateArgs,
  validateCreateHmacArgs,
  validateCreateSignatureArgs,
  validateCreateActionArgs,
  validateDiscoverByAttributesArgs,
  validateDiscoverByIdentityKeyArgs,
  validateInternalizeActionArgs,
  validateGetHeaderArgs,
  validateGetPublicKeyArgs,
  validateListActionsArgs,
  validateListCertificatesArgs,
  validateListOutputsArgs,
  validateProveCertificateArgs,
  validateRevealCounterpartyKeyLinkageArgs,
  validateRevealSpecificKeyLinkageArgs,
  validateRelinquishCertificateArgs,
  validateRelinquishOutputArgs,
  validateSignActionArgs,
  validateOriginator,
  validateNoArgs,
  validateVerifyHmacArgs,
  validateVerifySignatureArgs,
  validateWalletDecryptArgs,
  validateWalletEncryptArgs
} from './validationHelpers.js'
import { WERR_INVALID_PARAMETER } from './WERR_INVALID_PARAMETER.js'
import { snapshotWalletResultRequest, validateWalletResult } from './WalletResultValidation.js'
import { CallType } from './substrates/WalletWireCalls.js'

const MAX_FAST_SUBSTRATE_RESPONSE_WAIT = 1000
const MAX_XDM_RESPONSE_WAIT = 200

/**
 * The SDK is how applications communicate with wallets over a communications substrate.
 */
export default class WalletClient implements WalletInterface {
  public substrate: 'auto' | WalletInterface
  originator?: OriginatorDomainNameStringUnder250Bytes
  constructor(
    substrate:
      | 'auto'
      | 'Cicada'
      | 'XDM'
      | 'window.CWI'
      | 'json-api'
      | 'react-native'
      | 'secure-json-api'
      | WalletInterface = 'auto',
    originator?: OriginatorDomainNameStringUnder250Bytes
  ) {
    const normalizedOriginator = validateOriginator(originator)
    if (substrate === 'Cicada') {
      substrate = new WalletWireTransceiver(new HTTPWalletWire(normalizedOriginator))
    }
    if (substrate === 'window.CWI') substrate = new WindowCWISubstrate()
    if (substrate === 'XDM') substrate = new XDMSubstrate()
    if (substrate === 'json-api') substrate = new HTTPWalletJSON(normalizedOriginator)
    // The BRC-100 originator identifies the calling app; it is not a browser
    // MessageEvent origin and must not be used as an RN bridge filter.
    if (substrate === 'react-native') substrate = new ReactNativeWebView()
    if (substrate === 'secure-json-api')
      substrate = new HTTPWalletJSON(normalizedOriginator, 'https://localhost:2121')
    this.substrate = substrate
    this.originator = normalizedOriginator
  }

  private async validatedResult<T>(
    call: CallType,
    pending: Promise<T>,
    request?: unknown
  ): Promise<T> {
    return validateWalletResult(call, await pending, request)
  }

  async connectToSubstrate(): Promise<void> {
    if (typeof this.substrate === 'object') {
      return // substrate is already connected
    }

    const attemptSubstrate = async (
      factory: () => WalletInterface,
      timeout?: number,
      connectedFactory?: () => WalletInterface
    ): Promise<{ success: boolean; sub?: WalletInterface }> => {
      try {
        const sub = factory()
        let result
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined
        if (typeof timeout === 'number') {
          try {
            result = await Promise.race([
              sub.getVersion({}),
              new Promise<never>((_resolve, reject) => {
                timeoutHandle = setTimeout(() => reject(new Error('Timed out.')), timeout)
              })
            ])
          } finally {
            if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
          }
        } else {
          result = await sub.getVersion({})
        }
        validateWalletResult('getVersion', result)
        // Probe deadlines bound discovery, not later calls that may await user approval.
        return { success: true, sub: connectedFactory?.() ?? sub }
      } catch {
        return { success: false }
      }
    }

    // Try all substrates concurrently, select first available by priority order
    const fastAttempts = [
      attemptSubstrate(() => new WindowCWISubstrate(), MAX_FAST_SUBSTRATE_RESPONSE_WAIT),
      attemptSubstrate(
        () => new WalletWireTransceiver(new HTTPWalletWire(this.originator)),
        MAX_FAST_SUBSTRATE_RESPONSE_WAIT
      ),
      attemptSubstrate(
        () => new HTTPWalletJSON(this.originator, 'https://localhost:2121'),
        MAX_FAST_SUBSTRATE_RESPONSE_WAIT
      ),
      attemptSubstrate(() => new HTTPWalletJSON(this.originator), MAX_FAST_SUBSTRATE_RESPONSE_WAIT),
      attemptSubstrate(
        () => new ReactNativeWebView('*', MAX_FAST_SUBSTRATE_RESPONSE_WAIT),
        MAX_FAST_SUBSTRATE_RESPONSE_WAIT,
        () => new ReactNativeWebView()
      )
    ]

    const fastResults = await Promise.allSettled(fastAttempts)
    const fastSuccessful = fastResults
      .filter(
        (r): r is PromiseFulfilledResult<{ success: boolean; sub?: WalletInterface }> =>
          r.status === 'fulfilled' && r.value.success && r.value.sub !== undefined
      )
      .map(r => r.value.sub)

    if (fastSuccessful.length > 0) {
      this.substrate = fastSuccessful[0]!
      return
    }

    // Fall back to slower XDM substrate
    const xdmResult = await attemptSubstrate(
      () => new XDMSubstrate('*', MAX_XDM_RESPONSE_WAIT),
      MAX_XDM_RESPONSE_WAIT,
      () => new XDMSubstrate()
    )
    if (xdmResult.success && xdmResult.sub !== undefined) {
      this.substrate = xdmResult.sub
    } else {
      throw new Error(
        'No wallet available over any communication substrate. Install a BSV wallet today!'
      )
    }
  }

  async createAction(args: CreateActionArgs): Promise<CreateActionResult> {
    validateCreateActionArgs(args)
    const bindingRequest = snapshotWalletResultRequest('createAction', args)
    await this.connectToSubstrate()
    return await this.validatedResult(
      'createAction',
      (this.substrate as WalletInterface).createAction(args, this.originator),
      bindingRequest
    )
  }

  async signAction(args: SignActionArgs): Promise<SignActionResult> {
    validateSignActionArgs(args)
    const bindingRequest = snapshotWalletResultRequest('signAction', args)
    await this.connectToSubstrate()
    return await this.validatedResult(
      'signAction',
      (this.substrate as WalletInterface).signAction(args, this.originator),
      bindingRequest
    )
  }

  async abortAction(args: { reference: Base64String }): Promise<{ aborted: boolean }> {
    validateAbortActionArgs(args)
    await this.connectToSubstrate()
    return await this.validatedResult(
      'abortAction',
      (this.substrate as WalletInterface).abortAction(args, this.originator)
    )
  }

  async listActions(args: ListActionsArgs): Promise<ListActionsResult> {
    validateListActionsArgs(args)
    const bindingRequest = snapshotWalletResultRequest('listActions', args)
    await this.connectToSubstrate()
    return await this.validatedResult(
      'listActions',
      (this.substrate as WalletInterface).listActions(args, this.originator),
      bindingRequest
    )
  }

  async internalizeAction(args: InternalizeActionArgs): Promise<{ accepted: true }> {
    validateInternalizeActionArgs(args)
    await this.connectToSubstrate()
    return await this.validatedResult(
      'internalizeAction',
      (this.substrate as WalletInterface).internalizeAction(args, this.originator)
    )
  }

  async listOutputs(args: ListOutputsArgs): Promise<ListOutputsResult> {
    validateListOutputsArgs(args)
    const bindingRequest = snapshotWalletResultRequest('listOutputs', args)
    await this.connectToSubstrate()
    return await this.validatedResult(
      'listOutputs',
      (this.substrate as WalletInterface).listOutputs(args, this.originator),
      bindingRequest
    )
  }

  async relinquishOutput(args: {
    basket: BasketStringUnder300Bytes
    output: OutpointString
  }): Promise<{ relinquished: true }> {
    validateRelinquishOutputArgs(args)
    await this.connectToSubstrate()
    return await this.validatedResult(
      'relinquishOutput',
      (this.substrate as WalletInterface).relinquishOutput(args, this.originator)
    )
  }

  async getPublicKey(args: {
    identityKey?: true
    protocolID?: [SecurityLevel, ProtocolString5To400Bytes]
    keyID?: KeyIDStringUnder800Bytes
    privileged?: BooleanDefaultFalse
    privilegedReason?: DescriptionString5to50Bytes
    counterparty?: PubKeyHex
    forSelf?: BooleanDefaultFalse
  }): Promise<{ publicKey: PubKeyHex }> {
    validateGetPublicKeyArgs(args)
    await this.connectToSubstrate()
    return await this.validatedResult(
      'getPublicKey',
      (this.substrate as WalletInterface).getPublicKey(args, this.originator)
    )
  }

  async revealCounterpartyKeyLinkage(args: {
    counterparty: PubKeyHex
    verifier: PubKeyHex
    privilegedReason?: DescriptionString5to50Bytes
    privileged?: BooleanDefaultFalse
  }): Promise<{
    prover: PubKeyHex
    verifier: PubKeyHex
    counterparty: PubKeyHex
    revelationTime: ISOTimestampString
    encryptedLinkage: Byte[]
    encryptedLinkageProof: Byte[]
  }> {
    validateRevealCounterpartyKeyLinkageArgs(args)
    const bindingRequest = snapshotWalletResultRequest('revealCounterpartyKeyLinkage', args)
    await this.connectToSubstrate()
    return await this.validatedResult(
      'revealCounterpartyKeyLinkage',
      (this.substrate as WalletInterface).revealCounterpartyKeyLinkage(args, this.originator),
      bindingRequest
    )
  }

  async revealSpecificKeyLinkage(args: {
    counterparty: PubKeyHex
    verifier: PubKeyHex
    protocolID: [SecurityLevel, ProtocolString5To400Bytes]
    keyID: KeyIDStringUnder800Bytes
    privilegedReason?: DescriptionString5to50Bytes
    privileged?: BooleanDefaultFalse
  }): Promise<{
    prover: PubKeyHex
    verifier: PubKeyHex
    counterparty: PubKeyHex
    protocolID: [SecurityLevel, ProtocolString5To400Bytes]
    keyID: KeyIDStringUnder800Bytes
    encryptedLinkage: Byte[]
    encryptedLinkageProof: Byte[]
    proofType: Byte
  }> {
    validateRevealSpecificKeyLinkageArgs(args)
    const bindingRequest = snapshotWalletResultRequest('revealSpecificKeyLinkage', args)
    await this.connectToSubstrate()
    return await this.validatedResult(
      'revealSpecificKeyLinkage',
      (this.substrate as WalletInterface).revealSpecificKeyLinkage(args, this.originator),
      bindingRequest
    )
  }

  async encrypt(args: {
    plaintext: Byte[]
    protocolID: [SecurityLevel, ProtocolString5To400Bytes]
    keyID: KeyIDStringUnder800Bytes
    privilegedReason?: DescriptionString5to50Bytes
    counterparty?: PubKeyHex
    privileged?: BooleanDefaultFalse
  }): Promise<{ ciphertext: Byte[] }> {
    validateWalletEncryptArgs(args)
    await this.connectToSubstrate()
    return await this.validatedResult(
      'encrypt',
      (this.substrate as WalletInterface).encrypt(args, this.originator)
    )
  }

  async decrypt(args: {
    ciphertext: Byte[]
    protocolID: [SecurityLevel, ProtocolString5To400Bytes]
    keyID: KeyIDStringUnder800Bytes
    privilegedReason?: DescriptionString5to50Bytes
    counterparty?: PubKeyHex
    privileged?: BooleanDefaultFalse
  }): Promise<{ plaintext: Byte[] }> {
    validateWalletDecryptArgs(args)
    await this.connectToSubstrate()
    return await this.validatedResult(
      'decrypt',
      (this.substrate as WalletInterface).decrypt(args, this.originator)
    )
  }

  async createHmac(args: {
    data: Byte[]
    protocolID: [SecurityLevel, ProtocolString5To400Bytes]
    keyID: KeyIDStringUnder800Bytes
    privilegedReason?: DescriptionString5to50Bytes
    counterparty?: PubKeyHex
    privileged?: BooleanDefaultFalse
  }): Promise<{ hmac: Byte[] }> {
    validateCreateHmacArgs(args)
    await this.connectToSubstrate()
    return await this.validatedResult(
      'createHmac',
      (this.substrate as WalletInterface).createHmac(args, this.originator)
    )
  }

  async verifyHmac(args: {
    data: Byte[]
    hmac: Byte[]
    protocolID: [SecurityLevel, ProtocolString5To400Bytes]
    keyID: KeyIDStringUnder800Bytes
    privilegedReason?: DescriptionString5to50Bytes
    counterparty?: PubKeyHex
    privileged?: BooleanDefaultFalse
  }): Promise<{ valid: true }> {
    validateVerifyHmacArgs(args)
    await this.connectToSubstrate()
    return await this.validatedResult(
      'verifyHmac',
      (this.substrate as WalletInterface).verifyHmac(args, this.originator)
    )
  }

  async createSignature(args: {
    data?: Byte[]
    hashToDirectlySign?: Byte[]
    protocolID: [SecurityLevel, ProtocolString5To400Bytes]
    keyID: KeyIDStringUnder800Bytes
    privilegedReason?: DescriptionString5to50Bytes
    counterparty?: PubKeyHex
    privileged?: BooleanDefaultFalse
  }): Promise<{ signature: Byte[] }> {
    validateCreateSignatureArgs(args)
    await this.connectToSubstrate()
    return await this.validatedResult(
      'createSignature',
      (this.substrate as WalletInterface).createSignature(args, this.originator)
    )
  }

  async verifySignature(args: {
    data?: Byte[]
    hashToDirectlyVerify?: Byte[]
    signature: Byte[]
    protocolID: [SecurityLevel, ProtocolString5To400Bytes]
    keyID: KeyIDStringUnder800Bytes
    privilegedReason?: DescriptionString5to50Bytes
    counterparty?: PubKeyHex
    forSelf?: BooleanDefaultFalse
    privileged?: BooleanDefaultFalse
  }): Promise<{ valid: true }> {
    validateVerifySignatureArgs(args)
    await this.connectToSubstrate()
    return await this.validatedResult(
      'verifySignature',
      (this.substrate as WalletInterface).verifySignature(args, this.originator)
    )
  }

  async acquireCertificate(args: AcquireCertificateArgs): Promise<AcquireCertificateResult> {
    if (args.acquisitionProtocol === 'direct') {
      validateAcquireDirectCertificateArgs(args)
    } else if (args.acquisitionProtocol === 'issuance') {
      validateAcquireIssuanceCertificateArgs(args)
    } else {
      throw new WERR_INVALID_PARAMETER(
        'acquisitionProtocol',
        `valid. ${String(args.acquisitionProtocol)} is unrecognized.`
      )
    }
    const bindingRequest = snapshotWalletResultRequest('acquireCertificate', args)
    await this.connectToSubstrate()
    return await this.validatedResult(
      'acquireCertificate',
      (this.substrate as WalletInterface).acquireCertificate(args, this.originator),
      bindingRequest
    )
  }

  async listCertificates(args: {
    certifiers: PubKeyHex[]
    types: Base64String[]
    limit?: PositiveIntegerDefault10Max10000
    offset?: PositiveIntegerOrZero
    privileged?: BooleanDefaultFalse
    privilegedReason?: DescriptionString5to50Bytes
  }): Promise<ListCertificatesResult> {
    validateListCertificatesArgs(args)
    const bindingRequest = snapshotWalletResultRequest('listCertificates', args)
    await this.connectToSubstrate()
    return await this.validatedResult(
      'listCertificates',
      (this.substrate as WalletInterface).listCertificates(args, this.originator),
      bindingRequest
    )
  }

  async proveCertificate(args: ProveCertificateArgs): Promise<ProveCertificateResult> {
    validateProveCertificateArgs(args)
    const bindingRequest = snapshotWalletResultRequest('proveCertificate', args)
    await this.connectToSubstrate()
    return await this.validatedResult(
      'proveCertificate',
      (this.substrate as WalletInterface).proveCertificate(args, this.originator),
      bindingRequest
    )
  }

  async relinquishCertificate(args: {
    type: Base64String
    serialNumber: Base64String
    certifier: PubKeyHex
  }): Promise<{ relinquished: true }> {
    validateRelinquishCertificateArgs(args)
    await this.connectToSubstrate()
    return await this.validatedResult(
      'relinquishCertificate',
      (this.substrate as WalletInterface).relinquishCertificate(args, this.originator)
    )
  }

  async discoverByIdentityKey(args: {
    identityKey: PubKeyHex
    limit?: PositiveIntegerDefault10Max10000
    offset?: PositiveIntegerOrZero
  }): Promise<DiscoverCertificatesResult> {
    validateDiscoverByIdentityKeyArgs(args)
    const bindingRequest = snapshotWalletResultRequest('discoverByIdentityKey', args)
    await this.connectToSubstrate()
    return await this.validatedResult(
      'discoverByIdentityKey',
      (this.substrate as WalletInterface).discoverByIdentityKey(args, this.originator),
      bindingRequest
    )
  }

  async discoverByAttributes(args: {
    attributes: Record<CertificateFieldNameUnder50Bytes, string>
    limit?: PositiveIntegerDefault10Max10000
    offset?: PositiveIntegerOrZero
  }): Promise<DiscoverCertificatesResult> {
    validateDiscoverByAttributesArgs(args)
    const bindingRequest = snapshotWalletResultRequest('discoverByAttributes', args)
    await this.connectToSubstrate()
    return await this.validatedResult(
      'discoverByAttributes',
      (this.substrate as WalletInterface).discoverByAttributes(args, this.originator),
      bindingRequest
    )
  }

  async isAuthenticated(args: object = {}): Promise<AuthenticatedResult> {
    validateNoArgs(args)
    await this.connectToSubstrate()
    return await this.validatedResult(
      'isAuthenticated',
      (this.substrate as WalletInterface).isAuthenticated(args, this.originator)
    )
  }

  async waitForAuthentication(args: object = {}): Promise<{ authenticated: true }> {
    validateNoArgs(args)
    await this.connectToSubstrate()
    return await this.validatedResult(
      'waitForAuthentication',
      (this.substrate as WalletInterface).waitForAuthentication(args, this.originator)
    )
  }

  async getHeight(args: object = {}): Promise<{ height: PositiveInteger }> {
    validateNoArgs(args)
    await this.connectToSubstrate()
    return await this.validatedResult(
      'getHeight',
      (this.substrate as WalletInterface).getHeight(args, this.originator)
    )
  }

  async getHeaderForHeight(args: { height: PositiveInteger }): Promise<{ header: HexString }> {
    validateGetHeaderArgs(args)
    await this.connectToSubstrate()
    return await this.validatedResult(
      'getHeaderForHeight',
      (this.substrate as WalletInterface).getHeaderForHeight(args, this.originator)
    )
  }

  async getNetwork(args: object = {}): Promise<{ network: 'mainnet' | 'testnet' }> {
    validateNoArgs(args)
    await this.connectToSubstrate()
    return await this.validatedResult(
      'getNetwork',
      (this.substrate as WalletInterface).getNetwork(args, this.originator)
    )
  }

  async getVersion(args: object = {}): Promise<{ version: VersionString7To30Bytes }> {
    validateNoArgs(args)
    await this.connectToSubstrate()
    return await this.validatedResult(
      'getVersion',
      (this.substrate as WalletInterface).getVersion(args, this.originator)
    )
  }
}
