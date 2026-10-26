import PublicKey from '@bsv/sdk/primitives/PublicKey'
import P2PKH from '@bsv/sdk/script/templates/P2PKH'
import Transaction from '@bsv/sdk/transaction/Transaction'
import type { AtomicBEEF, WalletInterface } from '@bsv/sdk/wallet/Wallet.interfaces'
import { LCH_SETTLEMENT_PROFILES, LCH_TRANSACTION_EVIDENCE_POLICIES } from './constants.js'
import {
  validatePaymentDelivery,
  validatePaymentDemand,
  type AcquisitionValidationOptions
} from './acquisition.js'
import { lchAssert } from './errors.js'
import { fromHex, objectId, toBase64Url, toHex } from './hash.js'
import { signObject, verifySignedObject } from './objects.js'
import { PublicBRC77Verifier } from './signatures.js'
import { BRC29_PAYMENT_PROTOCOL } from './walletPayment.js'
import type {
  LCHSignatureVerifier,
  LCHSigner,
  LCHTransactionState,
  LCHUint,
  LCHValue,
  SignedObject
} from './types.js'
import {
  ownDataValue,
  requiredOwnDataValue,
  snapshotBytes,
  snapshotSignedObject,
  snapshotStringArray,
  snapshotStringSet
} from './boundary.js'

const MAX_UINT64 = 0xffffffffffffffffn

export interface AuthorizedOutputPolicy {
  evidenceProvider: Uint8Array
  evidenceEndpoint: string
  evidencePolicy?: string
  minimumTransactionState?: Extract<LCHTransactionState, 'accepted'>
  deliveryProvider: Uint8Array
  deliveryEndpoint: string
  retrievalEndpoint: string
  allowInsecureLocalEndpoint?: boolean
}

export interface PaymentAuthorizationStore {
  get(demandId: string): Promise<SignedObject | undefined>
  putIfAbsent(demandId: string, authorization: SignedObject): Promise<SignedObject>
}

export class MemoryPaymentAuthorizationStore implements PaymentAuthorizationStore {
  private readonly authorizations = new Map<string, SignedObject>()

  constructor(private readonly maximumEntries = 100_000) {
    lchAssert(
      Number.isSafeInteger(maximumEntries) && maximumEntries > 0,
      'ERR_LCH_PAYMENT',
      'Payment Authorization store capacity is invalid'
    )
  }

  async get(demandId: string): Promise<SignedObject | undefined> {
    const authorization = this.authorizations.get(demandId)
    return authorization === undefined
      ? undefined
      : snapshotSignedObject(authorization, 'Stored Payment Authorization')
  }

  async putIfAbsent(demandId: string, authorization: SignedObject): Promise<SignedObject> {
    const existing = this.authorizations.get(demandId)
    if (existing !== undefined)
      return snapshotSignedObject(existing, 'Stored Payment Authorization')
    lchAssert(
      this.authorizations.size < this.maximumEntries,
      'ERR_LCH_PAYMENT',
      'Payment Authorization store capacity is exhausted'
    )
    const owned = snapshotSignedObject(authorization, 'Payment Authorization')
    this.authorizations.set(demandId, owned)
    return snapshotSignedObject(owned, 'Stored Payment Authorization')
  }
}

export interface WalletAuthorizedOutputPayeeOptions {
  wallet: Pick<WalletInterface, 'getPublicKey'>
  signer: LCHSigner
  store?: PaymentAuthorizationStore
  verifier?: LCHSignatureVerifier
  now?: () => bigint
  random?: (length: number) => Uint8Array
  allowInsecureLocalOrigins?: readonly string[]
  supportedCriticalIdentifiers?: ReadonlySet<string>
}

/** Creates idempotent, Payee-signed destinations for offline-capable settlement. */
export class WalletAuthorizedOutputPayee {
  private readonly wallet: Pick<WalletInterface, 'getPublicKey'>
  private readonly signer: LCHSigner
  private readonly store: PaymentAuthorizationStore
  private readonly now: () => bigint
  private readonly random: (length: number) => Uint8Array
  private readonly verifier?: LCHSignatureVerifier
  private readonly validationOptions: AcquisitionValidationOptions

  constructor(options: WalletAuthorizedOutputPayeeOptions) {
    const wallet = ownDataValue(options, 'wallet', 'Authorized Output Payee options')
    const signer = ownDataValue(options, 'signer', 'Authorized Output Payee options')
    const store = ownDataValue(options, 'store', 'Authorized Output Payee options')
    const verifier = ownDataValue(options, 'verifier', 'Authorized Output Payee options')
    const now = ownDataValue(options, 'now', 'Authorized Output Payee options')
    const random = ownDataValue(options, 'random', 'Authorized Output Payee options')
    lchAssert(
      wallet !== null &&
        typeof wallet === 'object' &&
        typeof (wallet as Pick<WalletInterface, 'getPublicKey'>).getPublicKey === 'function',
      'ERR_LCH_PAYMENT',
      'Authorized Output Payee wallet is invalid'
    )
    lchAssert(
      signer !== null &&
        typeof signer === 'object' &&
        (signer as LCHSigner).identityKey instanceof Uint8Array &&
        typeof (signer as LCHSigner).sign === 'function',
      'ERR_LCH_SIGNATURE',
      'Authorized Output Payee signer is invalid'
    )
    lchAssert(
      store === undefined ||
        (store !== null &&
          typeof store === 'object' &&
          typeof (store as PaymentAuthorizationStore).get === 'function' &&
          typeof (store as PaymentAuthorizationStore).putIfAbsent === 'function'),
      'ERR_LCH_PAYMENT',
      'Payment Authorization store is invalid'
    )
    lchAssert(
      verifier === undefined ||
        (verifier !== null &&
          typeof verifier === 'object' &&
          typeof (verifier as LCHSignatureVerifier).verify === 'function'),
      'ERR_LCH_SIGNATURE',
      'Payment verifier is invalid'
    )
    lchAssert(
      now === undefined || typeof now === 'function',
      'ERR_LCH_PAYMENT',
      'Payment clock is invalid'
    )
    lchAssert(
      random === undefined || typeof random === 'function',
      'ERR_LCH_KEY',
      'Payment random source is invalid'
    )
    const configuredWallet = wallet as Pick<WalletInterface, 'getPublicKey'>
    this.wallet = { getPublicKey: configuredWallet.getPublicKey.bind(configuredWallet) }
    const configuredSigner = signer as LCHSigner
    this.signer = {
      identityKey: snapshotBytes(configuredSigner.identityKey, 'Payment Authorization signer'),
      sign: configuredSigner.sign.bind(configuredSigner)
    }
    this.store =
      (store as PaymentAuthorizationStore | undefined) ?? new MemoryPaymentAuthorizationStore()
    this.verifier = verifier as LCHSignatureVerifier | undefined
    this.now = (now as (() => bigint) | undefined) ?? (() => BigInt(Math.floor(Date.now() / 1000)))
    this.random = (random as ((length: number) => Uint8Array) | undefined) ?? secureRandom
    this.validationOptions = snapshotAcquisitionOptions(options, 'Authorized Output Payee options')
  }

  async authorize(demand: SignedObject, policy: AuthorizedOutputPolicy): Promise<SignedObject> {
    demand = snapshotSignedObject(demand, 'Payment Demand')
    policy = snapshotAuthorizedOutputPolicy(policy)
    const demandId = await validatePaymentDemand(demand, this.verifier, this.validationOptions)
    const demandIdHex = toHex(demandId)
    const authorizedAt = this.now()
    const existing = await this.store.get(demandIdHex)
    if (existing !== undefined) {
      const ownedExisting = snapshotSignedObject(existing, 'Stored Payment Authorization')
      await validatePaymentAuthorization(
        ownedExisting,
        demand,
        authorizedAt,
        this.verifier,
        this.validationOptions
      )
      return ownedExisting
    }
    lchAssert(
      demand.body.settlementProfile === LCH_SETTLEMENT_PROFILES.authorizedOutput,
      'ERR_LCH_PROFILE_UNSUPPORTED',
      'Payment Demand does not permit authorized-output settlement'
    )
    const payee = memberBytes(demand.body, 'payee', 33, 'Demand Payee')
    equal(payee, this.signer.identityKey, 'Payment Authorization Payee')
    bytes(policy.evidenceProvider, 33, 'Evidence provider')
    bytes(policy.deliveryProvider, 33, 'Delivery provider')
    endpoint(policy.evidenceEndpoint, policy.allowInsecureLocalEndpoint)
    endpoint(policy.deliveryEndpoint, policy.allowInsecureLocalEndpoint)
    endpoint(policy.retrievalEndpoint, policy.allowInsecureLocalEndpoint)
    const evidencePolicy =
      policy.evidencePolicy ?? LCH_TRANSACTION_EVIDENCE_POLICIES.signedProcessorAcceptance
    lchAssert(
      evidencePolicy === LCH_TRANSACTION_EVIDENCE_POLICIES.signedProcessorAcceptance,
      'ERR_LCH_PROFILE_UNSUPPORTED',
      'Transaction evidence policy is unsupported'
    )
    const minimumTransactionState = policy.minimumTransactionState ?? 'accepted'
    const authorizedUntil = uint(demand.body.expiresAt, 'Demand expiry')
    lchAssert(
      authorizedAt < authorizedUntil,
      'ERR_LCH_PAYMENT',
      'Payment Demand expired before authorization'
    )
    const returnedDerivationSuffix = this.random(32)
    bytes(returnedDerivationSuffix, 32, 'Derivation suffix')
    const derivationSuffix = snapshotBytes(returnedDerivationSuffix, 'Derivation suffix')
    const derivationPrefix = memberBytes(demand.body, 'derivationPrefix', 32, 'Derivation prefix')
    const buyer = memberBytes(demand.body, 'buyer', 33, 'Demand buyer')
    const keyID = `${toBase64Url(derivationPrefix)} ${toBase64Url(derivationSuffix)}`
    const publicKey = requiredOwnDataValue(
      await this.wallet.getPublicKey({
        protocolID: [...BRC29_PAYMENT_PROTOCOL],
        keyID,
        counterparty: toHex(buyer),
        forSelf: true
      }),
      'publicKey',
      'Wallet getPublicKey result'
    )
    lchAssert(typeof publicKey === 'string', 'ERR_LCH_PAYMENT', 'Wallet public key is invalid')
    const lockingScript = new P2PKH()
      .lock(PublicKey.fromString(publicKey).toAddress())
      .toUint8Array()
    const authorization = await signObject(
      'payment-authorization',
      {
        version: 1,
        settlementProfile: LCH_SETTLEMENT_PROFILES.authorizedOutput,
        demandId,
        requestId: memberBytes(demand.body, 'requestId', 32, 'Request ID'),
        payee,
        buyer,
        satoshis: demand.body.satoshis!,
        derivationPrefix,
        derivationSuffix,
        lockingScript,
        authorizedAt,
        authorizedUntil,
        recoveryUntil: demand.body.recoveryUntil!,
        evidenceProvider: policy.evidenceProvider,
        evidenceEndpoint: policy.evidenceEndpoint,
        evidencePolicy,
        minimumTransactionState,
        deliveryProvider: policy.deliveryProvider,
        deliveryEndpoint: policy.deliveryEndpoint,
        retrievalEndpoint: policy.retrievalEndpoint
      },
      this.signer
    )
    const stored = snapshotSignedObject(
      await this.store.putIfAbsent(demandIdHex, authorization),
      'Stored Payment Authorization'
    )
    await validatePaymentAuthorization(
      stored,
      demand,
      authorizedAt,
      this.verifier,
      this.validationOptions
    )
    return stored
  }
}

export interface TransactionEvidenceOptions {
  authorizationId: Uint8Array
  txid: Uint8Array
  state: Extract<LCHTransactionState, 'accepted'>
  policy: string
  observedAt: LCHUint
}

export interface PaymentDeliveryAcknowledgementOptions {
  authorizationId: Uint8Array
  deliveryId: Uint8Array
  demandId: Uint8Array
  requestId: Uint8Array
  payee: Uint8Array
  storedAt: LCHUint
  availableUntil: LCHUint
  retrievalEndpoint: string
  allowInsecureLocalEndpoint?: boolean
}

/** Signs evidence emitted by a transaction processor or durable Delivery custodian. */
export class LCHSettlementService {
  constructor(private readonly signer: LCHSigner) {}

  createTransactionEvidence(options: TransactionEvidenceOptions): Promise<SignedObject> {
    bytes(options.authorizationId, 32, 'Payment Authorization ID')
    bytes(options.txid, 32, 'Transaction ID')
    lchAssert(
      options.state === 'accepted',
      'ERR_LCH_PAYMENT',
      'Transaction evidence state is invalid'
    )
    lchAssert(
      options.policy === LCH_TRANSACTION_EVIDENCE_POLICIES.signedProcessorAcceptance,
      'ERR_LCH_PROFILE_UNSUPPORTED',
      'Transaction evidence policy is unsupported'
    )
    uint(options.observedAt, 'Transaction evidence time')
    return signObject(
      'transaction-evidence',
      {
        version: 1,
        authorizationId: options.authorizationId,
        txid: options.txid,
        provider: this.signer.identityKey,
        state: options.state,
        policy: options.policy,
        observedAt: options.observedAt
      },
      this.signer
    )
  }

  createDeliveryAcknowledgement(
    options: PaymentDeliveryAcknowledgementOptions
  ): Promise<SignedObject> {
    bytes(options.authorizationId, 32, 'Payment Authorization ID')
    bytes(options.deliveryId, 32, 'Payment Delivery ID')
    bytes(options.demandId, 32, 'Demand ID')
    bytes(options.requestId, 32, 'Request ID')
    bytes(options.payee, 33, 'Payee identity')
    const storedAt = uint(options.storedAt, 'Delivery storage time')
    const availableUntil = uint(options.availableUntil, 'Delivery availability deadline')
    lchAssert(
      storedAt < availableUntil,
      'ERR_LCH_DELIVERY',
      'Delivery availability window is empty'
    )
    endpoint(options.retrievalEndpoint, options.allowInsecureLocalEndpoint)
    return signObject(
      'payment-delivery-ack',
      {
        version: 1,
        authorizationId: options.authorizationId,
        deliveryId: options.deliveryId,
        demandId: options.demandId,
        requestId: options.requestId,
        payee: options.payee,
        provider: this.signer.identityKey,
        storedAt: options.storedAt,
        availableUntil: options.availableUntil,
        retrievalEndpoint: options.retrievalEndpoint
      },
      this.signer
    )
  }
}

export interface AuthorizedOutputEvidence {
  authorization: SignedObject
  delivery: SignedObject
  transactionEvidence: SignedObject
  deliveryAcknowledgement: SignedObject
}

export interface TransactionEvidenceRequest {
  authorization: SignedObject
  atomicBeef: Uint8Array
}

export interface PaymentDeliveryStoreRequest {
  authorization: SignedObject
  delivery: SignedObject
}

export interface StoredPaymentDelivery {
  authorization: SignedObject
  delivery: SignedObject
  deliveryAcknowledgement: SignedObject
}

export async function validatePaymentDeliveryRetrieval(
  request: SignedObject,
  authorization: SignedObject,
  verifier: LCHSignatureVerifier = new PublicBRC77Verifier(),
  options: AcquisitionValidationOptions = {}
): Promise<Uint8Array> {
  request = snapshotSignedObject(request, 'Payment Delivery Retrieval')
  authorization = snapshotSignedObject(authorization, 'Payment Authorization')
  options = snapshotAcquisitionOptions(options, 'Settlement validation options')
  const payee = memberBytes(request.body, 'payee', 33, 'Retrieval Payee')
  await verifySignedObject('payment-delivery-retrieval', request, verifier, payee, options)
  await verifySignedObject('payment-authorization', authorization, verifier, payee, options)
  equal(
    memberBytes(request.body, 'authorizationId', 32, 'Payment Authorization ID'),
    await objectId('payment-authorization', authorization.body),
    'Payment Authorization ID'
  )
  equalMember(request.body, authorization.body, 'payee', 33, 'Payee')
  uint(request.body.requestedAt, 'Delivery retrieval time')
  memberBytes(request.body, 'nonce', 16, 'Delivery retrieval nonce')
  return objectId('payment-delivery-retrieval', request.body)
}

export async function validatePaymentAuthorization(
  authorization: SignedObject,
  demand: SignedObject,
  currentTime?: LCHUint,
  verifier: LCHSignatureVerifier = new PublicBRC77Verifier(),
  options: AcquisitionValidationOptions = {}
): Promise<Uint8Array> {
  authorization = snapshotSignedObject(authorization, 'Payment Authorization')
  demand = snapshotSignedObject(demand, 'Payment Demand')
  options = snapshotAcquisitionOptions(options, 'Settlement validation options')
  const demandId = await validatePaymentDemand(demand, verifier, options)
  lchAssert(
    demand.body.settlementProfile === LCH_SETTLEMENT_PROFILES.authorizedOutput,
    'ERR_LCH_PROFILE_UNSUPPORTED',
    'Payment Demand does not permit authorized-output settlement'
  )
  const payee = memberBytes(authorization.body, 'payee', 33, 'Authorization Payee')
  await verifySignedObject('payment-authorization', authorization, verifier, payee, options)
  lchAssert(
    authorization.body.settlementProfile === LCH_SETTLEMENT_PROFILES.authorizedOutput,
    'ERR_LCH_PROFILE_UNSUPPORTED',
    'Payment Authorization profile is unsupported'
  )
  equal(memberBytes(authorization.body, 'demandId', 32, 'Demand ID'), demandId, 'Demand ID')
  equalMember(authorization.body, demand.body, 'requestId', 32, 'Request ID')
  equalMember(authorization.body, demand.body, 'payee', 33, 'Payee')
  equalMember(authorization.body, demand.body, 'buyer', 33, 'Buyer')
  equalMember(authorization.body, demand.body, 'derivationPrefix', 32, 'Derivation prefix')
  lchAssert(
    uint(authorization.body.satoshis, 'Authorization amount') ===
      uint(demand.body.satoshis, 'Demand amount'),
    'ERR_LCH_PAYMENT',
    'Payment Authorization amount does not match the Demand'
  )
  memberBytes(authorization.body, 'derivationSuffix', 32, 'Derivation suffix')
  const lockingScript = memberBytes(
    authorization.body,
    'lockingScript',
    undefined,
    'Authorized locking script'
  )
  lchAssert(lockingScript.length <= 10_000, 'ERR_LCH_PAYMENT', 'Authorized script is too large')
  const authorizedAt = uint(authorization.body.authorizedAt, 'Authorization time')
  const authorizedUntil = uint(authorization.body.authorizedUntil, 'Authorization deadline')
  const expiresAt = uint(demand.body.expiresAt, 'Demand expiry')
  lchAssert(
    authorizedAt < authorizedUntil && authorizedUntil <= expiresAt,
    'ERR_LCH_PAYMENT',
    'Payment Authorization deadlines are invalid'
  )
  if (currentTime !== undefined) {
    const current = uint(currentTime, 'Authorization validation time')
    lchAssert(
      authorizedAt <= current && current < authorizedUntil,
      'ERR_LCH_PAYMENT',
      'Payment Authorization is not currently valid'
    )
  }
  lchAssert(
    uint(authorization.body.recoveryUntil, 'Authorization recovery deadline') ===
      uint(demand.body.recoveryUntil, 'Demand recovery deadline'),
    'ERR_LCH_PAYMENT',
    'Payment Authorization recovery deadline does not match the Demand'
  )
  memberBytes(authorization.body, 'evidenceProvider', 33, 'Evidence provider')
  memberBytes(authorization.body, 'deliveryProvider', 33, 'Delivery provider')
  endpointMember(authorization.body, 'evidenceEndpoint', options)
  endpointMember(authorization.body, 'deliveryEndpoint', options)
  endpointMember(authorization.body, 'retrievalEndpoint', options)
  lchAssert(
    authorization.body.evidencePolicy ===
      LCH_TRANSACTION_EVIDENCE_POLICIES.signedProcessorAcceptance &&
      authorization.body.minimumTransactionState === 'accepted',
    'ERR_LCH_PROFILE_UNSUPPORTED',
    'Payment Authorization evidence policy is unsupported'
  )
  return objectId('payment-authorization', authorization.body)
}

export async function validateAuthorizedOutputEvidence(
  bundle: AuthorizedOutputEvidence,
  demand: SignedObject,
  atomicBeef: Uint8Array,
  verifier: LCHSignatureVerifier = new PublicBRC77Verifier(),
  options: AcquisitionValidationOptions = {}
): Promise<Uint8Array> {
  demand = snapshotSignedObject(demand, 'Payment Demand')
  atomicBeef = atomicBeef.slice()
  options = snapshotAcquisitionOptions(options, 'Settlement validation options')
  const authorization = snapshotSignedObject(
    requiredOwnDataValue(bundle, 'authorization', 'Authorized Output Evidence'),
    'Payment Authorization'
  )
  const delivery = snapshotSignedObject(
    requiredOwnDataValue(bundle, 'delivery', 'Authorized Output Evidence'),
    'Payment Delivery'
  )
  const transactionEvidence = snapshotSignedObject(
    requiredOwnDataValue(bundle, 'transactionEvidence', 'Authorized Output Evidence'),
    'Transaction Evidence'
  )
  const deliveryAcknowledgement = snapshotSignedObject(
    requiredOwnDataValue(bundle, 'deliveryAcknowledgement', 'Authorized Output Evidence'),
    'Payment Delivery Acknowledgement'
  )
  const authorizationId = await validatePaymentAuthorization(
    authorization,
    demand,
    undefined,
    verifier,
    options
  )
  const deliveryId = await validatePaymentDelivery(delivery, verifier, options)
  const demandId = await objectId('payment-demand', demand.body)
  equal(memberBytes(delivery.body, 'demandId', 32, 'Delivery Demand ID'), demandId, 'Demand ID')
  equalMember(delivery.body, demand.body, 'requestId', 32, 'Request ID')
  equalMember(delivery.body, demand.body, 'buyer', 33, 'Buyer')
  equalMember(delivery.body, authorization.body, 'derivationPrefix', 32, 'Derivation prefix')
  equalMember(delivery.body, authorization.body, 'derivationSuffix', 32, 'Derivation suffix')
  equal(
    memberBytes(delivery.body, 'atomicBeef', undefined, 'Delivery Atomic BEEF'),
    atomicBeef,
    'Completion Atomic BEEF'
  )
  const transaction = parseAtomicBeef(atomicBeef)
  const outputIndex = index(delivery.body.outputIndex)
  const output = transaction.outputs[outputIndex]
  lchAssert(output?.satoshis !== undefined, 'ERR_LCH_PAYMENT', 'Authorized output is absent')
  lchAssert(
    BigInt(output.satoshis) === uint(demand.body.satoshis, 'Demand amount'),
    'ERR_LCH_PAYMENT',
    'Authorized output amount does not match the Demand'
  )
  equal(
    output.lockingScript.toUint8Array(),
    memberBytes(authorization.body, 'lockingScript', undefined, 'Authorized locking script'),
    'Authorized output locking script'
  )
  await validateTransactionEvidence(
    transactionEvidence,
    authorization,
    authorizationId,
    transaction,
    verifier,
    options
  )
  await validateDeliveryAcknowledgement(
    deliveryAcknowledgement,
    authorization,
    delivery,
    authorizationId,
    deliveryId,
    verifier,
    options
  )
  return demandId
}

export async function validateTransactionEvidence(
  evidence: SignedObject,
  authorization: SignedObject,
  authorizationId: Uint8Array,
  transaction: Transaction,
  verifier: LCHSignatureVerifier,
  options: AcquisitionValidationOptions = {}
): Promise<void> {
  evidence = snapshotSignedObject(evidence, 'Transaction Evidence')
  authorization = snapshotSignedObject(authorization, 'Payment Authorization')
  bytes(authorizationId, 32, 'Payment Authorization ID')
  authorizationId = snapshotBytes(authorizationId, 'Payment Authorization ID')
  options = snapshotAcquisitionOptions(options, 'Settlement validation options')
  const transactionId = fromHex(transaction.id('hex'))
  const provider = memberBytes(evidence.body, 'provider', 33, 'Evidence provider')
  equal(
    provider,
    memberBytes(authorization.body, 'evidenceProvider', 33, 'Authorized evidence provider'),
    'Evidence provider'
  )
  await verifySignedObject('transaction-evidence', evidence, verifier, provider, options)
  equal(
    memberBytes(evidence.body, 'authorizationId', 32, 'Payment Authorization ID'),
    authorizationId,
    'Payment Authorization ID'
  )
  equal(memberBytes(evidence.body, 'txid', 32, 'Transaction ID'), transactionId, 'Transaction ID')
  const state = memberString(evidence.body, 'state') as LCHTransactionState
  const minimum = memberString(authorization.body, 'minimumTransactionState') as LCHTransactionState
  lchAssert(
    state === 'accepted' &&
      minimum === 'accepted' &&
      transactionStateRank(state) >= transactionStateRank(minimum),
    'ERR_LCH_PAYMENT',
    'Transaction evidence does not meet the authorized minimum state'
  )
  lchAssert(
    memberString(evidence.body, 'policy') === memberString(authorization.body, 'evidencePolicy'),
    'ERR_LCH_PAYMENT',
    'Transaction evidence policy does not match the Authorization'
  )
  const observedAt = uint(evidence.body.observedAt, 'Transaction evidence time')
  lchAssert(
    observedAt >= uint(authorization.body.authorizedAt, 'Authorization time') &&
      observedAt < uint(authorization.body.recoveryUntil, 'Recovery deadline'),
    'ERR_LCH_PAYMENT',
    'Transaction evidence time is outside the authorized recovery window'
  )
}

export async function validateDeliveryAcknowledgement(
  acknowledgement: SignedObject,
  authorization: SignedObject,
  delivery: SignedObject,
  authorizationId: Uint8Array,
  deliveryId: Uint8Array,
  verifier: LCHSignatureVerifier,
  options: AcquisitionValidationOptions
): Promise<void> {
  acknowledgement = snapshotSignedObject(acknowledgement, 'Payment Delivery Acknowledgement')
  authorization = snapshotSignedObject(authorization, 'Payment Authorization')
  delivery = snapshotSignedObject(delivery, 'Payment Delivery')
  bytes(authorizationId, 32, 'Payment Authorization ID')
  bytes(deliveryId, 32, 'Payment Delivery ID')
  authorizationId = snapshotBytes(authorizationId, 'Payment Authorization ID')
  deliveryId = snapshotBytes(deliveryId, 'Payment Delivery ID')
  options = snapshotAcquisitionOptions(options, 'Settlement validation options')
  const provider = memberBytes(acknowledgement.body, 'provider', 33, 'Delivery provider')
  equal(
    provider,
    memberBytes(authorization.body, 'deliveryProvider', 33, 'Authorized delivery provider'),
    'Delivery provider'
  )
  await verifySignedObject('payment-delivery-ack', acknowledgement, verifier, provider, options)
  equal(
    memberBytes(acknowledgement.body, 'authorizationId', 32, 'Payment Authorization ID'),
    authorizationId,
    'Payment Authorization ID'
  )
  equal(
    memberBytes(acknowledgement.body, 'deliveryId', 32, 'Payment Delivery ID'),
    deliveryId,
    'Payment Delivery ID'
  )
  equalMember(acknowledgement.body, delivery.body, 'demandId', 32, 'Demand ID')
  equalMember(acknowledgement.body, delivery.body, 'requestId', 32, 'Request ID')
  equalMember(acknowledgement.body, authorization.body, 'payee', 33, 'Payee')
  const storedAt = uint(acknowledgement.body.storedAt, 'Delivery storage time')
  const availableUntil = uint(acknowledgement.body.availableUntil, 'Delivery availability deadline')
  lchAssert(
    storedAt >= uint(authorization.body.authorizedAt, 'Authorization time') &&
      storedAt < uint(authorization.body.recoveryUntil, 'Recovery deadline') &&
      storedAt < availableUntil &&
      availableUntil >= uint(authorization.body.recoveryUntil, 'Recovery deadline'),
    'ERR_LCH_DELIVERY',
    'Delivery is not retained through the recovery deadline'
  )
  const retrieval = endpointMember(acknowledgement.body, 'retrievalEndpoint', options)
  lchAssert(
    retrieval === memberString(authorization.body, 'retrievalEndpoint'),
    'ERR_LCH_DELIVERY',
    'Delivery retrieval endpoint does not match the Authorization'
  )
}

function transactionStateRank(value: LCHTransactionState): number {
  const states: LCHTransactionState[] = ['finalized', 'broadcast', 'accepted', 'mined']
  const rank = states.indexOf(value)
  lchAssert(rank >= 0, 'ERR_LCH_PAYMENT', 'Transaction evidence state is invalid')
  return rank
}

function parseAtomicBeef(value: Uint8Array): Transaction {
  try {
    return Transaction.fromAtomicBEEF(value as AtomicBEEF)
  } catch (error) {
    throw new Error('Authorized-output Atomic BEEF could not be parsed', { cause: error })
  }
}

function secureRandom(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length))
}

function bytes(
  value: unknown,
  length: number | undefined,
  name: string
): asserts value is Uint8Array {
  lchAssert(
    value instanceof Uint8Array &&
      value.length > 0 &&
      (length === undefined || value.length === length),
    'ERR_LCH_PAYMENT',
    `${name} is invalid`
  )
}

function memberBytes(
  body: Record<string, LCHValue>,
  key: string,
  length: number | undefined,
  name: string
): Uint8Array {
  const value = body[key]
  bytes(value, length, name)
  return value
}

function memberString(body: Record<string, LCHValue>, key: string): string {
  const value = body[key]
  lchAssert(typeof value === 'string' && value.length > 0, 'ERR_LCH_PAYMENT', `${key} is absent`)
  return value
}

function uint(value: unknown, name: string): bigint {
  lchAssert(
    typeof value === 'bigint' || (typeof value === 'number' && Number.isSafeInteger(value)),
    'ERR_LCH_PAYMENT',
    `${name} must be an exact integer`
  )
  const result = BigInt(value)
  lchAssert(result >= 0n && result <= MAX_UINT64, 'ERR_LCH_PAYMENT', `${name} is outside uint64`)
  return result
}

function index(value: unknown): number {
  lchAssert(
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
    'ERR_LCH_PAYMENT',
    'Payment output index is invalid'
  )
  return value
}

function equal(value: Uint8Array, expected: Uint8Array, name: string): void {
  lchAssert(toHex(value) === toHex(expected), 'ERR_LCH_PAYMENT', `${name} does not match`)
}

function equalMember(
  left: Record<string, LCHValue>,
  right: Record<string, LCHValue>,
  key: string,
  length: number,
  name: string
): void {
  equal(memberBytes(left, key, length, name), memberBytes(right, key, length, name), name)
}

function endpointMember(
  body: Record<string, LCHValue>,
  key: string,
  options: AcquisitionValidationOptions
): string {
  const value = memberString(body, key)
  let origin = ''
  try {
    origin = new URL(value).origin
  } catch {
    lchAssert(false, 'ERR_LCH_ENDPOINT', 'Settlement endpoint is not an absolute URL')
  }
  const local = options.allowInsecureLocalOrigins?.includes(origin) === true
  endpoint(value, local)
  return value
}

function endpoint(value: string, allowInsecureLocal = false): void {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    lchAssert(false, 'ERR_LCH_ENDPOINT', 'Settlement endpoint is not an absolute URL')
  }
  lchAssert(
    (parsed.protocol === 'https:' ||
      (allowInsecureLocal &&
        parsed.protocol === 'http:' &&
        ['127.0.0.1', '[::1]', 'localhost'].includes(parsed.hostname))) &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.hash === '',
    'ERR_LCH_ENDPOINT',
    'Settlement endpoint must be HTTPS without userinfo or fragment'
  )
}

function snapshotAcquisitionOptions(value: object, name: string): AcquisitionValidationOptions {
  return {
    allowInsecureLocalOrigins: snapshotStringArray(
      ownDataValue(value, 'allowInsecureLocalOrigins', name),
      `${name}.allowInsecureLocalOrigins`
    ),
    supportedCriticalIdentifiers: snapshotStringSet(
      ownDataValue(value, 'supportedCriticalIdentifiers', name),
      `${name}.supportedCriticalIdentifiers`
    )
  }
}

function snapshotAuthorizedOutputPolicy(value: unknown): AuthorizedOutputPolicy {
  const name = 'Authorized Output Policy'
  const evidenceProvider = requiredOwnDataValue(value, 'evidenceProvider', name)
  const deliveryProvider = requiredOwnDataValue(value, 'deliveryProvider', name)
  bytes(evidenceProvider, 33, 'Evidence provider')
  bytes(deliveryProvider, 33, 'Delivery provider')
  const evidenceEndpoint = requiredOwnDataValue(value, 'evidenceEndpoint', name)
  const deliveryEndpoint = requiredOwnDataValue(value, 'deliveryEndpoint', name)
  const retrievalEndpoint = requiredOwnDataValue(value, 'retrievalEndpoint', name)
  lchAssert(
    typeof evidenceEndpoint === 'string' &&
      typeof deliveryEndpoint === 'string' &&
      typeof retrievalEndpoint === 'string',
    'ERR_LCH_ENDPOINT',
    'Authorized Output Policy endpoints are invalid'
  )
  const evidencePolicy = ownDataValue(value, 'evidencePolicy', name)
  const minimumTransactionState = ownDataValue(value, 'minimumTransactionState', name)
  const allowInsecureLocalEndpoint = ownDataValue(value, 'allowInsecureLocalEndpoint', name)
  lchAssert(
    evidencePolicy === undefined || typeof evidencePolicy === 'string',
    'ERR_LCH_PROFILE_UNSUPPORTED',
    'Authorized Output evidence policy is invalid'
  )
  lchAssert(
    minimumTransactionState === undefined || minimumTransactionState === 'accepted',
    'ERR_LCH_PROFILE_UNSUPPORTED',
    'Authorized Output minimum transaction state is invalid'
  )
  lchAssert(
    allowInsecureLocalEndpoint === undefined || typeof allowInsecureLocalEndpoint === 'boolean',
    'ERR_LCH_ENDPOINT',
    'Authorized Output endpoint policy is invalid'
  )
  return {
    evidenceProvider: snapshotBytes(evidenceProvider, 'Evidence provider'),
    evidenceEndpoint,
    ...(evidencePolicy === undefined ? {} : { evidencePolicy }),
    ...(minimumTransactionState === undefined ? {} : { minimumTransactionState }),
    deliveryProvider: snapshotBytes(deliveryProvider, 'Delivery provider'),
    deliveryEndpoint,
    retrievalEndpoint,
    ...(allowInsecureLocalEndpoint === undefined ? {} : { allowInsecureLocalEndpoint })
  }
}
