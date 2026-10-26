import { LCH_LIMITS, LCH_VERSION } from './constants.js'
import {
  ciphertextLength as encryptedCiphertextLength,
  decryptSegmented,
  encryptSegmented,
  keyIdFor,
  validateEncryptionDescriptor,
  validateKeyGrantsForSelection,
  type SegmentedEncryptionOptions
} from './encryption.js'
import { lchAssert } from './errors.js'
import { frameLCH, parseLCH, type ParsedLCH } from './framing.js'
import { objectId, objectIri, objectPreimage, sha256, toHex } from './hash.js'
import {
  signObject,
  validateCriticalIdentifiers,
  validateExtensionIdentifiers,
  verifySignedObject,
  type SignedObjectVerificationOptions
} from './objects.js'
import { fixedTotal, recoveryUntil } from './payment.js'
import { validatePolicyReference } from './policy.js'
import { isPublicAddress } from './endpoints.js'
import { normalizeSelection } from './selection.js'
import { brc77SignerIdentity, isCompressedPublicKey, PublicBRC77Verifier } from './signatures.js'
import { validateTimeWindow } from './time.js'
import type {
  ContentSink,
  ContentSource,
  KeyGrant,
  LCHSignatureVerifier,
  LCHSigner,
  LCHValue,
  LicenseStore,
  Selection,
  SegmentedEncryptionDescriptor,
  SignedObject,
  UnverifiedLicenseResponse
} from './types.js'
import {
  ownDataValue,
  requiredOwnDataValue,
  snapshotBytes,
  snapshotLCHRecord,
  snapshotSignedObject,
  snapshotStringArray,
  snapshotStringSet
} from './boundary.js'

const ALL_SELECTION: Selection = { type: 'all' }

export interface RightsInterest extends Record<string, LCHValue> {
  interest: string
  holder: { name: string; identifier?: string }
  controller: Uint8Array
}

export interface ProtectedAsset {
  asset: Record<string, LCHValue>
  assetId: Uint8Array
  ciphertext: Uint8Array
  keys: Map<string, Uint8Array>
}

export interface ProtectOptions extends SegmentedEncryptionOptions {
  mediaType: string
  name: string
  rights: RightsInterest[]
  sink?: ContentSink
  workId?: string
  metadata?: Record<string, LCHValue>
  embedCiphertext?: boolean
}

export interface PublishedLCH extends ProtectedAsset {
  header: Record<string, LCHValue>
  bytes: Uint8Array
}

export class LCHPublisher {
  private readonly issuedEncryptionIds = new Set<string>()
  private readonly issuedKeyIds = new Set<string>()

  constructor(private readonly signer: LCHSigner) {}

  async protect(plaintext: Uint8Array, options: ProtectOptions): Promise<ProtectedAsset> {
    const unsafeName =
      options.name.includes('/') ||
      options.name.includes('\\') ||
      options.name.includes(String.fromCodePoint(0))
    lchAssert(
      options.name.length > 0 && !unsafeName && options.name !== '.' && options.name !== '..',
      'ERR_LCH_FRAMING',
      'Unsafe asset name'
    )
    lchAssert(
      options.rights.length > 0,
      'ERR_LCH_AUTHORITY',
      'Asset must declare at least one rights interest'
    )
    const encrypted = await encryptSegmented(plaintext, options)
    const encryptionId = toHex(encrypted.descriptor.encryptionId)
    const keyIds = encrypted.descriptor.keyPeriods.map(period => toHex(period.keyId))
    lchAssert(
      !this.issuedEncryptionIds.has(encryptionId) &&
        keyIds.every(keyId => !this.issuedKeyIds.has(keyId)) &&
        this.issuedEncryptionIds.size < LCH_LIMITS.cborEntries &&
        this.issuedKeyIds.size + keyIds.length <= LCH_LIMITS.cborEntries,
      'ERR_LCH_KEY',
      'Publisher random source reused or exhausted encryption material'
    )
    this.issuedEncryptionIds.add(encryptionId)
    for (const keyId of keyIds) this.issuedKeyIds.add(keyId)
    const locators = options.sink === undefined ? [] : await options.sink.put(encrypted.ciphertext)
    const representation: Record<string, LCHValue> = {
      ciphertextDigest: await sha256(encrypted.ciphertext),
      ciphertextLength: encrypted.ciphertext.length,
      plaintextDigest: await sha256(plaintext),
      encryption: encrypted.descriptor as unknown as Record<string, LCHValue>,
      locators
    }
    const asset: Record<string, LCHValue> = {
      mediaType: options.mediaType,
      name: options.name,
      ...(options.workId === undefined ? {} : { workId: options.workId }),
      representation,
      rights: options.rights,
      ...(options.metadata === undefined ? {} : { metadata: options.metadata })
    }
    return {
      asset,
      assetId: await objectId('asset', asset),
      ciphertext: encrypted.ciphertext,
      keys: encrypted.keys
    }
  }

  async publish(
    protectedAsset: ProtectedAsset,
    acquisition: Array<Record<string, LCHValue>>,
    embedCiphertext = true
  ): Promise<PublishedLCH> {
    lchAssert(
      acquisition.length > 0,
      'ERR_LCH_PROFILE_UNSUPPORTED',
      'Header requires an acquisition entry'
    )
    validateAssetShape(protectedAsset.asset)
    const actualAssetId = await objectId('asset', protectedAsset.asset)
    lchAssert(
      protectedAsset.assetId instanceof Uint8Array &&
        toHex(actualAssetId) === toHex(protectedAsset.assetId),
      'ERR_LCH_CONTENT_DIGEST',
      'Protected Asset changed after its ID was computed'
    )
    const representation = mapValue(protectedAsset.asset.representation, 'representation')
    await validateCiphertext(protectedAsset.ciphertext, representation)
    const descriptor = mapValue(representation.encryption, 'encryption descriptor')
    const periods = (descriptor as unknown as SegmentedEncryptionDescriptor).keyPeriods
    lchAssert(
      protectedAsset.keys instanceof Map && protectedAsset.keys.size === periods.length,
      'ERR_LCH_KEY',
      'Protected Asset key set does not match its descriptor'
    )
    for (const period of periods) {
      const key = protectedAsset.keys.get(toHex(period.keyId))
      lchAssert(
        key instanceof Uint8Array &&
          key.length === 32 &&
          toHex(await keyIdFor(key)) === toHex(period.keyId),
        'ERR_LCH_KEY',
        'Protected Asset key material does not match its Key ID'
      )
    }
    const body: Record<string, LCHValue> = {
      lch: LCH_VERSION,
      asset: protectedAsset.asset,
      acquisition
    }
    const signatures = [await this.signer.sign(objectPreimage('header', body))]
    const header = { ...body, signatures }
    return {
      ...protectedAsset,
      header,
      bytes: frameLCH(header, embedCiphertext ? protectedAsset.ciphertext : undefined)
    }
  }
}

export interface InspectedLCH extends ParsedLCH {
  asset: Record<string, LCHValue>
  assetId: Uint8Array
  representation: Record<string, LCHValue>
  headerSigners: Uint8Array[]
}

export interface LCHReaderOptions {
  verifier?: LCHSignatureVerifier
  authorizeHeaderSigner?: (signer: Uint8Array, assetId: Uint8Array) => Promise<boolean>
  /** Critical Header and Asset semantics the reader fully implements. */
  supportedCriticalIdentifiers?: ReadonlySet<string>
}

export class LCHReader {
  private readonly verifier: LCHSignatureVerifier
  private readonly authorizeHeaderSigner?: LCHReaderOptions['authorizeHeaderSigner']
  private readonly supportedCriticalIdentifiers?: ReadonlySet<string>

  constructor(
    private readonly source: ContentSource,
    private readonly licenseStore?: LicenseStore,
    options: LCHReaderOptions = {}
  ) {
    const verifier = ownDataValue(options, 'verifier', 'LCH Reader options')
    const authorize = ownDataValue(options, 'authorizeHeaderSigner', 'LCH Reader options')
    lchAssert(
      verifier === undefined ||
        (verifier !== null &&
          typeof verifier === 'object' &&
          typeof (verifier as LCHSignatureVerifier).verify === 'function'),
      'ERR_LCH_SIGNATURE',
      'LCH Reader verifier is invalid'
    )
    lchAssert(
      authorize === undefined || typeof authorize === 'function',
      'ERR_LCH_AUTHORITY',
      'LCH Reader Header authorization callback is invalid'
    )
    this.verifier = (verifier as LCHSignatureVerifier | undefined) ?? new PublicBRC77Verifier()
    this.authorizeHeaderSigner = authorize as LCHReaderOptions['authorizeHeaderSigner']
    this.supportedCriticalIdentifiers = snapshotStringSet(
      ownDataValue(options, 'supportedCriticalIdentifiers', 'LCH Reader options'),
      'LCH Reader supportedCriticalIdentifiers'
    )
  }

  async inspect(bytes: Uint8Array): Promise<InspectedLCH> {
    const parsed = parseLCH(bytes)
    lchAssert(parsed.header.lch === LCH_VERSION, 'ERR_LCH_FRAMING', 'Unsupported LCH version')
    validateExtensionIdentifiers(parsed.header)
    validateCriticalIdentifiers(parsed.header, this.supportedCriticalIdentifiers)
    lchAssert(
      Array.isArray(parsed.header.acquisition) && parsed.header.acquisition.length > 0,
      'ERR_LCH_PROFILE_UNSUPPORTED',
      'Header has no acquisition entry'
    )
    const asset = mapValue(parsed.header.asset, 'Asset Body')
    validateExtensionIdentifiers(asset)
    validateCriticalIdentifiers(asset, this.supportedCriticalIdentifiers)
    validateAssetShape(asset)
    const representation = mapValue(asset.representation, 'representation')
    const assetId = await objectId('asset', asset)
    const headerSigners = await verifyHeaderAuthorization(
      parsed.header,
      asset,
      assetId,
      this.verifier,
      this.authorizeHeaderSigner
    )
    if (parsed.ciphertext !== undefined) await validateCiphertext(parsed.ciphertext, representation)
    else {
      const locators = representation.locators
      lchAssert(
        Array.isArray(locators) && locators.length > 0,
        'ERR_LCH_CONTENT_UNAVAILABLE',
        'Detached LCH has no content locator'
      )
    }
    return { ...parsed, asset, assetId, representation, headerSigners }
  }

  async resolve(inspected: InspectedLCH): Promise<Uint8Array> {
    const representation = snapshotLCHRecord(
      requiredOwnDataValue(inspected, 'representation', 'Inspected LCH'),
      'Inspected representation'
    )
    const embedded = ownDataValue(inspected, 'ciphertext', 'Inspected LCH')
    if (embedded !== undefined) {
      lchAssert(
        embedded instanceof Uint8Array,
        'ERR_LCH_CONTENT_DIGEST',
        'Embedded ciphertext is invalid'
      )
      const ciphertext = snapshotBytes(embedded, 'Embedded ciphertext')
      await validateCiphertext(ciphertext, representation)
      return ciphertext
    }
    const locators = representation.locators
    lchAssert(
      Array.isArray(locators),
      'ERR_LCH_CONTENT_UNAVAILABLE',
      'Representation locators are invalid'
    )
    let lastError: unknown
    for (const locator of locators) {
      if (typeof locator !== 'string') continue
      try {
        const returned = await this.source.read(locator)
        lchAssert(
          returned instanceof Uint8Array,
          'ERR_LCH_CONTENT_UNAVAILABLE',
          'Content source returned invalid bytes'
        )
        const ciphertext = returned.slice()
        await validateCiphertext(ciphertext, representation)
        return ciphertext
      } catch (error) {
        lastError = error
      }
    }
    throw new Error('No valid ciphertext source was available', { cause: lastError })
  }

  async decrypt(
    inspected: InspectedLCH,
    keys: ReadonlyMap<string, Uint8Array>,
    selection: Selection = ALL_SELECTION
  ): Promise<Uint8Array> {
    const representation = snapshotLCHRecord(
      requiredOwnDataValue(inspected, 'representation', 'Inspected LCH'),
      'Inspected representation'
    )
    const embedded = ownDataValue(inspected, 'ciphertext', 'Inspected LCH')
    const ownedInspected = {
      representation,
      ...(embedded === undefined
        ? {}
        : {
            ciphertext:
              embedded instanceof Uint8Array
                ? snapshotBytes(embedded, 'Embedded ciphertext')
                : embedded
          })
    } as unknown as InspectedLCH
    selection = snapshotLCHRecord(selection, 'Decryption selection') as unknown as Selection
    const ciphertext = await this.resolve(ownedInspected)
    const descriptor = mapValue(representation.encryption, 'encryption descriptor')
    const plaintext = await decryptSegmented(
      ciphertext,
      descriptor as unknown as SegmentedEncryptionDescriptor,
      keys,
      selection
    )
    if (selection.type === 'all' && representation.plaintextDigest !== undefined) {
      const digest = representation.plaintextDigest
      lchAssert(
        digest instanceof Uint8Array &&
          digest.length === 32 &&
          toHex(await sha256(plaintext)) === toHex(digest),
        'ERR_LCH_CONTENT_DIGEST',
        'Plaintext digest mismatch'
      )
    }
    return plaintext
  }

  async storedLicense(
    assetId: Uint8Array,
    offerId?: Uint8Array
  ): Promise<SignedObject | undefined> {
    const stored = await this.licenseStore?.get(
      toHex(assetId),
      offerId === undefined ? undefined : toHex(offerId)
    )
    if (stored === undefined) return undefined
    return snapshotSignedObject(
      requiredOwnDataValue(stored, 'license', 'Stored License'),
      'Stored License'
    )
  }
}

export interface OfferOptions {
  assetId: Uint8Array
  usageProfile: string
  seller: Uint8Array
  licenseIssuer: Uint8Array
  requiredInterests: string[]
  policy: Record<string, LCHValue>
  payment: Record<string, LCHValue>
  keyDelivery: Record<string, LCHValue>
  enforcement: Record<string, LCHValue>
  notBefore: number | bigint
  notAfter?: number | bigint
  nonce: Uint8Array
  authorityIds?: Uint8Array[]
  humanTerms?: Array<Record<string, LCHValue>>
  extensions?: Record<string, LCHValue>
  critical?: string[]
  /** Explicitly permits a loopback HTTP payment endpoint for local development. */
  allowInsecureLocalPaymentEndpoint?: boolean
}

export interface OfferValidationOptions extends SignedObjectVerificationOptions {
  /** Exact loopback origins permitted to use HTTP for local development. */
  allowInsecureLocalOrigins?: readonly string[]
}

export interface LicenseOptions {
  assetId: Uint8Array
  offerId: Uint8Array
  requestId: Uint8Array
  issuer: Uint8Array
  subject: Uint8Array
  issuedAt: number | bigint
  agreement: Record<string, LCHValue>
  selection: Selection
  segmentSelection?: Extract<Selection, { type: 'segments' }>
  fulfillments?: Array<Record<string, LCHValue>>
  keyGrants?: KeyGrant[]
  encryption?: SegmentedEncryptionDescriptor
  notBefore?: number | bigint
  notAfter?: number | bigint
}

export class LCHIssuer {
  constructor(private readonly signer: LCHSigner) {}

  async createOffer(options: OfferOptions): Promise<SignedObject> {
    lchAssert(
      toHex(options.seller) === toHex(this.signer.identityKey),
      'ERR_LCH_SIGNATURE',
      'Offer signer is not the Seller'
    )
    const recovery = options.payment.recoveryPeriodSeconds
    lchAssert(
      typeof recovery === 'number' || typeof recovery === 'bigint',
      'ERR_LCH_QUOTE',
      'Payment offer must declare a recovery period'
    )
    recoveryUntil(0n, recovery)
    validateTimeWindow({ notBefore: options.notBefore, notAfter: options.notAfter })
    lchAssert(
      typeof options.keyDelivery.mechanism === 'string' &&
        typeof options.enforcement.class === 'string',
      'ERR_LCH_PROFILE_UNSUPPORTED',
      'Offer mechanisms are incomplete'
    )
    const body: Record<string, LCHValue> = {
      version: 1,
      assetId: options.assetId,
      usageProfile: options.usageProfile,
      seller: options.seller,
      licenseIssuer: options.licenseIssuer,
      requiredInterests: options.requiredInterests,
      ...(options.authorityIds === undefined ? {} : { authorityIds: options.authorityIds }),
      policy: options.policy,
      payment: options.payment,
      keyDelivery: options.keyDelivery,
      enforcement: options.enforcement,
      notBefore: options.notBefore,
      ...(options.notAfter === undefined ? {} : { notAfter: options.notAfter }),
      nonce: options.nonce
    }
    if (options.humanTerms !== undefined) body.humanTerms = options.humanTerms
    if (options.extensions !== undefined) body.extensions = options.extensions
    if (options.critical !== undefined) body.critical = options.critical
    await validateOfferBody(body, options.seller, {
      allowInsecureLocalOrigins:
        options.allowInsecureLocalPaymentEndpoint === true &&
        typeof options.payment.endpoint === 'string'
          ? localOrigin(options.payment.endpoint)
          : []
    })
    return signObject('offer', body, this.signer)
  }

  async issueLicense(options: LicenseOptions): Promise<SignedObject> {
    lchAssert(
      toHex(options.issuer) === toHex(this.signer.identityKey),
      'ERR_LCH_SIGNATURE',
      'License signer is not the issuer'
    )
    const selection = normalizeSelection(options.selection)
    validateTimeWindow({ notBefore: options.notBefore, notAfter: options.notAfter })
    await validatePolicyReference(options.agreement)
    lchAssert(
      options.assetId.length === 32 &&
        options.offerId.length === 32 &&
        options.requestId.length === 32 &&
        options.subject.length === 33 &&
        (typeof options.issuedAt === 'bigint' || Number.isSafeInteger(options.issuedAt)) &&
        options.agreement.digest instanceof Uint8Array &&
        options.agreement.digest.length === 32,
      'ERR_LCH_LICENSE',
      'License identifiers, subject, issuance time, or Agreement digest are invalid'
    )
    const segmentSelection =
      options.segmentSelection === undefined
        ? undefined
        : (normalizeSelection(options.segmentSelection) as Extract<Selection, { type: 'segments' }>)
    if (options.encryption !== undefined) {
      const keySelection = segmentSelection ?? (selection.type === 'all' ? selection : undefined)
      lchAssert(
        keySelection !== undefined,
        'ERR_LCH_SELECTION',
        'A partial encrypted License requires exact segment selection'
      )
      validateKeyGrantsForSelection(options.encryption, keySelection, options.keyGrants ?? [])
    }
    const body: Record<string, LCHValue> = {
      version: 1,
      assetId: options.assetId,
      offerId: options.offerId,
      requestId: options.requestId,
      issuer: options.issuer,
      subject: options.subject,
      issuedAt: options.issuedAt,
      ...(options.notBefore === undefined ? {} : { notBefore: options.notBefore }),
      ...(options.notAfter === undefined ? {} : { notAfter: options.notAfter }),
      agreement: options.agreement,
      selection: selection as unknown as Record<string, LCHValue>,
      ...(segmentSelection === undefined
        ? {}
        : {
            segmentSelection: segmentSelection as unknown as Record<string, LCHValue>
          }),
      fulfillments: options.fulfillments ?? [],
      keyGrants: (options.keyGrants ?? []) as unknown as Array<Record<string, LCHValue>>
    }
    return signObject('license', body, this.signer)
  }

  quoteFixed(requirements: ReadonlyArray<{ satoshis: number | bigint }>): bigint {
    return fixedTotal(requirements)
  }
}

export interface AcquisitionTransport {
  preflight(request: SignedObject): Promise<void>
  quote(request: SignedObject): Promise<SignedObject>
  deliver(quote: SignedObject, payment: Uint8Array): Promise<SignedObject>
  recoverUnverified?(requestId: Uint8Array): Promise<UnverifiedLicenseResponse | undefined>
  /** @deprecated Implement recoverUnverified. Legacy results are wrapped as unverified. */
  recover?(requestId: Uint8Array): Promise<SignedObject | UnverifiedLicenseResponse | undefined>
}

export class LCHAcquisition {
  constructor(private readonly transport: AcquisitionTransport) {}

  preflight(request: SignedObject): Promise<void> {
    return this.transport.preflight(request)
  }

  quote(request: SignedObject): Promise<SignedObject> {
    return this.transport.quote(request)
  }

  deliver(quote: SignedObject, finalizedAtomicBeef: Uint8Array): Promise<SignedObject> {
    return this.transport.deliver(quote, finalizedAtomicBeef)
  }

  /**
   * Returns an explicitly unverified transport wrapper.
   *
   * Prefer `LCHMultipayBuyer.recover`, which requires the complete funded
   * acquisition and settlement context and returns only a validated License.
   */
  async recoverUnverified(requestId: Uint8Array): Promise<UnverifiedLicenseResponse | undefined> {
    if (typeof this.transport.recoverUnverified === 'function') {
      return await this.transport.recoverUnverified(requestId)
    }
    lchAssert(
      typeof this.transport.recover === 'function',
      'ERR_LCH_LICENSE',
      'The acquisition transport does not support License recovery'
    )
    const legacy = await this.transport.recover(requestId)
    if (legacy === undefined) return undefined
    if ('unverifiedLicense' in legacy) return legacy
    return { unverifiedLicense: legacy }
  }

  /** @deprecated Use recoverUnverified and validate the result with full acquisition context. */
  recover(requestId: Uint8Array): Promise<UnverifiedLicenseResponse | undefined> {
    return this.recoverUnverified(requestId)
  }
}

async function validateCiphertext(
  ciphertext: Uint8Array,
  representation: Record<string, LCHValue>
): Promise<void> {
  const length = representation.ciphertextLength
  const digest = representation.ciphertextDigest
  lchAssert(
    (typeof length === 'number' || typeof length === 'bigint') &&
      BigInt(ciphertext.length) === BigInt(length),
    'ERR_LCH_CONTENT_DIGEST',
    'Ciphertext length mismatch'
  )
  lchAssert(
    digest instanceof Uint8Array &&
      digest.length === 32 &&
      toHex(await sha256(ciphertext)) === toHex(digest),
    'ERR_LCH_CONTENT_DIGEST',
    'Ciphertext digest mismatch'
  )
}

function validateAssetShape(asset: Record<string, LCHValue>): void {
  lchAssert(
    typeof asset.mediaType === 'string' &&
      asset.mediaType.length > 0 &&
      typeof asset.name === 'string' &&
      asset.name.length > 0,
    'ERR_LCH_FRAMING',
    'Asset media type or name is invalid'
  )
  const unsafeName =
    asset.name.includes('/') ||
    asset.name.includes('\\') ||
    asset.name.includes(String.fromCodePoint(0))
  lchAssert(
    !unsafeName && asset.name !== '.' && asset.name !== '..',
    'ERR_LCH_FRAMING',
    'Asset name is unsafe'
  )
  const representation = mapValue(asset.representation, 'representation')
  const ciphertextLength = representation.ciphertextLength
  const validCiphertextLength =
    typeof ciphertextLength === 'bigint'
      ? ciphertextLength >= 0n
      : typeof ciphertextLength === 'number' &&
        Number.isSafeInteger(ciphertextLength) &&
        ciphertextLength >= 0
  lchAssert(
    representation.ciphertextDigest instanceof Uint8Array &&
      representation.ciphertextDigest.length === 32 &&
      validCiphertextLength &&
      Array.isArray(representation.locators) &&
      representation.locators.length <= 64 &&
      representation.locators.every(
        locator => typeof locator === 'string' && locator.length > 0 && locator.length <= 8192
      ) &&
      (representation.plaintextDigest === undefined ||
        (representation.plaintextDigest instanceof Uint8Array &&
          representation.plaintextDigest.length === 32)),
    'ERR_LCH_FRAMING',
    'Asset representation is invalid'
  )
  const descriptor = mapValue(representation.encryption, 'encryption descriptor')
  validateEncryptionDescriptor(descriptor as unknown as SegmentedEncryptionDescriptor)
  lchAssert(
    BigInt(ciphertextLength as number | bigint) ===
      encryptedCiphertextLength(descriptor as unknown as SegmentedEncryptionDescriptor),
    'ERR_LCH_CONTENT_DIGEST',
    'Representation length does not match its encryption descriptor'
  )
}

async function verifyHeaderAuthorization(
  header: Record<string, LCHValue>,
  asset: Record<string, LCHValue>,
  assetId: Uint8Array,
  verifier: LCHSignatureVerifier,
  authorize: LCHReaderOptions['authorizeHeaderSigner']
): Promise<Uint8Array[]> {
  const signatures = header.signatures
  lchAssert(
    Array.isArray(signatures) &&
      signatures.length > 0 &&
      signatures.length <= 64 &&
      signatures.every(
        signature =>
          signature instanceof Uint8Array && signature.length > 0 && signature.length <= 4096
      ),
    'ERR_LCH_SIGNATURE',
    'Header signatures are invalid'
  )
  const rights = asset.rights
  lchAssert(
    Array.isArray(rights) && rights.length > 0,
    'ERR_LCH_AUTHORITY',
    'Asset rights are absent'
  )
  const controllers = new Set(
    rights.map(right => {
      const map = mapValue(right, 'rights interest')
      const holder = mapValue(map.holder, 'rights holder')
      const controller = map.controller
      lchAssert(
        typeof map.interest === 'string' &&
          map.interest.length > 0 &&
          typeof holder.name === 'string' &&
          holder.name.length > 0 &&
          controller instanceof Uint8Array &&
          isCompressedPublicKey(controller),
        'ERR_LCH_AUTHORITY',
        'Rights interest or Controller is invalid'
      )
      return toHex(controller)
    })
  )
  const body = { ...header }
  delete body.signatures
  const preimage = objectPreimage('header', body)
  const accepted: Uint8Array[] = []
  for (const signature of signatures as Uint8Array[]) {
    let signer: Uint8Array
    try {
      signer = brc77SignerIdentity(signature)
    } catch {
      continue
    }
    if ((await verifier.verify(preimage.slice(), signature.slice())) !== true) continue
    const authorized =
      controllers.has(toHex(signer)) ||
      (authorize !== undefined && (await authorize(signer.slice(), assetId.slice())) === true)
    if (authorized) accepted.push(signer)
  }
  lchAssert(accepted.length > 0, 'ERR_LCH_AUTHORITY', 'No valid Header signer is authorized')
  return accepted
}

function mapValue(value: LCHValue | undefined, name: string): Record<string, LCHValue> {
  lchAssert(
    value !== undefined &&
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      !(value instanceof Uint8Array),
    'ERR_LCH_FRAMING',
    `${name} must be a map`
  )
  return value
}

export async function validateOffer(
  offer: SignedObject,
  verifier: LCHSignatureVerifier,
  seller: Uint8Array,
  options: OfferValidationOptions = {}
): Promise<string> {
  offer = snapshotSignedObject(offer, 'Offer')
  seller = snapshotBytes(seller, 'Offer seller')
  const supportedCriticalIdentifiers = snapshotStringSet(
    ownDataValue(options, 'supportedCriticalIdentifiers', 'Offer validation options'),
    'Offer supportedCriticalIdentifiers'
  )
  const allowInsecureLocalOrigins = snapshotStringArray(
    ownDataValue(options, 'allowInsecureLocalOrigins', 'Offer validation options'),
    'Offer allowInsecureLocalOrigins'
  )
  options = { supportedCriticalIdentifiers, allowInsecureLocalOrigins }
  await verifySignedObject('offer', offer, verifier, seller, options)
  await validateOfferBody(offer.body, seller, options)
  return objectIri('offer', offer.body)
}

async function validateOfferBody(
  body: Record<string, LCHValue>,
  expectedSeller: Uint8Array,
  options: OfferValidationOptions = {}
): Promise<void> {
  const assetId = body.assetId
  const seller = body.seller
  const licenseIssuer = body.licenseIssuer
  const nonce = body.nonce
  lchAssert(
    assetId instanceof Uint8Array &&
      assetId.length === 32 &&
      seller instanceof Uint8Array &&
      isCompressedPublicKey(seller) &&
      toHex(seller) === toHex(expectedSeller) &&
      licenseIssuer instanceof Uint8Array &&
      isCompressedPublicKey(licenseIssuer) &&
      nonce instanceof Uint8Array &&
      nonce.length === 16 &&
      typeof body.usageProfile === 'string' &&
      body.usageProfile.length > 0,
    'ERR_LCH_LICENSE',
    'Offer identity, Asset, profile, or nonce is invalid'
  )
  lchAssert(
    Array.isArray(body.requiredInterests) &&
      body.requiredInterests.length > 0 &&
      body.requiredInterests.length <= LCH_LIMITS.cborEntries &&
      body.requiredInterests.every(
        value =>
          typeof value === 'string' &&
          value.length > 0 &&
          value.length <= 4096 &&
          !hasControlCharacter(value)
      ) &&
      new Set(body.requiredInterests).size === body.requiredInterests.length,
    'ERR_LCH_AUTHORITY',
    'Offer required interests are invalid'
  )
  if (body.authorityIds !== undefined)
    lchAssert(
      Array.isArray(body.authorityIds) &&
        body.authorityIds.length > 0 &&
        body.authorityIds.length <= LCH_LIMITS.cborEntries &&
        body.authorityIds.every(value => value instanceof Uint8Array && value.length === 32) &&
        new Set(body.authorityIds.map(value => toHex(value as Uint8Array))).size ===
          body.authorityIds.length,
      'ERR_LCH_AUTHORITY',
      'Offer Authority IDs are invalid'
    )
  await validatePolicyReference(body.policy)
  if (body.humanTerms !== undefined) {
    lchAssert(
      Array.isArray(body.humanTerms) && body.humanTerms.length <= 64,
      'ERR_LCH_TERMS',
      'Offer human terms are invalid'
    )
    for (const term of body.humanTerms) {
      await validatePolicyReference(term, { mediaType: undefined })
      const language = mapValue(term, 'Human term').language
      lchAssert(
        language === undefined ||
          (typeof language === 'string' && language.length > 0 && language.length <= 255),
        'ERR_LCH_TERMS',
        'Human-term language is invalid'
      )
    }
  }
  const payment = mapValue(body.payment, 'Offer Payment')
  const keyDelivery = mapValue(body.keyDelivery, 'Offer key delivery')
  const enforcement = mapValue(body.enforcement, 'Offer enforcement')
  lchAssert(
    typeof payment.protocol === 'string' &&
      payment.protocol.length > 0 &&
      typeof payment.endpoint === 'string' &&
      payment.endpoint.length > 0 &&
      payment.endpoint.length <= 8192 &&
      payment.asset === 'BSV' &&
      payment.unit === 'satoshi' &&
      (typeof payment.recoveryPeriodSeconds === 'number' ||
        typeof payment.recoveryPeriodSeconds === 'bigint') &&
      typeof keyDelivery.mechanism === 'string' &&
      keyDelivery.mechanism.length > 0 &&
      typeof enforcement.class === 'string' &&
      enforcement.class.length > 0,
    'ERR_LCH_PROFILE_UNSUPPORTED',
    'Offer mechanisms are incomplete'
  )
  recoveryUntil(0n, payment.recoveryPeriodSeconds)
  validateOfferEndpoint(payment.endpoint, options.allowInsecureLocalOrigins)
  const pricing = mapValue(payment.pricing, 'Offer pricing')
  lchAssert(
    pricing.kind === 'fixed' || pricing.kind === 'unit' || pricing.kind === 'quote',
    'ERR_LCH_QUOTE',
    'Offer pricing kind is unsupported'
  )
  if (pricing.kind === 'fixed' || pricing.kind === 'unit')
    lchAssert(
      Array.isArray(pricing.requirements) &&
        pricing.requirements.length > 0 &&
        pricing.requirements.length <= LCH_LIMITS.cborEntries,
      'ERR_LCH_QUOTE',
      'Offer pricing requirements are absent'
    )
  if (pricing.kind === 'unit') {
    const unitSize = exactUint(pricing.unitSize)
    const minimumUnits = exactUint(pricing.minimumUnits)
    const maximumUnits =
      pricing.maximumUnits === undefined ? undefined : exactUint(pricing.maximumUnits)
    lchAssert(
      typeof pricing.quantityUnit === 'string' &&
        pricing.quantityUnit.length > 0 &&
        unitSize !== undefined &&
        unitSize > 0n &&
        minimumUnits !== undefined &&
        (maximumUnits === undefined || maximumUnits >= minimumUnits),
      'ERR_LCH_QUOTE',
      'Offer unit pricing is invalid'
    )
  }
  const notBefore = body.notBefore
  const notAfter = body.notAfter
  lchAssert(
    typeof notBefore === 'number' || typeof notBefore === 'bigint',
    'ERR_LCH_LICENSE',
    'Offer notBefore is absent'
  )
  lchAssert(
    notAfter === undefined || typeof notAfter === 'number' || typeof notAfter === 'bigint',
    'ERR_LCH_LICENSE',
    'Offer notAfter is invalid'
  )
  validateTimeWindow({ notBefore, notAfter })
}

function validateOfferEndpoint(value: LCHValue | undefined, allowed: readonly string[] = []): void {
  lchAssert(
    typeof value === 'string' && value.length > 0 && value.length <= 8192,
    'ERR_LCH_ENDPOINT',
    'Offer payment endpoint is invalid'
  )
  let endpoint: URL
  try {
    endpoint = new URL(value)
  } catch {
    lchAssert(false, 'ERR_LCH_ENDPOINT', 'Offer payment endpoint is not an absolute URL')
  }
  const local =
    allowed.includes(endpoint.origin) &&
    ['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname)
  const directAddress = /^[\d.]+$/u.test(endpoint.hostname) || endpoint.hostname.includes(':')
  lchAssert(
    (endpoint.protocol === 'https:' || local) &&
      (local ||
        (endpoint.hostname !== 'localhost' &&
          (!directAddress || isPublicAddress(endpoint.hostname)))) &&
      endpoint.username === '' &&
      endpoint.password === '' &&
      endpoint.hash === '',
    'ERR_LCH_ENDPOINT',
    'Offer payment endpoint must be HTTPS without userinfo or fragment'
  )
}

function localOrigin(value: string): string[] {
  try {
    return [new URL(value).origin]
  } catch {
    return []
  }
}

function exactUint(value: LCHValue | undefined): bigint | undefined {
  if (typeof value === 'bigint')
    return value >= 0n && value <= 0xffffffffffffffffn ? value : undefined
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value)
  return undefined
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!
    if (codePoint <= 0x1f || codePoint === 0x7f) return true
  }
  return false
}

export { LCH_MECHANISMS } from './constants.js'
