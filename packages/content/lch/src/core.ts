import { LCH_MECHANISMS, LCH_VERSION } from './constants.js'
import {
  decryptSegmented,
  encryptSegmented,
  validateKeyGrantsForSelection,
  type SegmentedEncryptionOptions
} from './encryption.js'
import { lchAssert } from './errors.js'
import { frameLCH, parseLCH, type ParsedLCH } from './framing.js'
import { objectId, objectIri, objectPreimage, sha256, toHex } from './hash.js'
import { signObject, verifySignedObject } from './objects.js'
import { fixedTotal, recoveryUntil } from './payment.js'
import { normalizeSelection } from './selection.js'
import { brc77SignerIdentity, PublicBRC77Verifier } from './signatures.js'
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
  SignedObject
} from './types.js'

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
  constructor(private readonly signer: LCHSigner) {}

  async protect(plaintext: Uint8Array, options: ProtectOptions): Promise<ProtectedAsset> {
    const unsafeName =
      options.name.includes('/') ||
      options.name.includes('\\') ||
      options.name.includes(String.fromCharCode(0))
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
}

export class LCHReader {
  constructor(
    private readonly source: ContentSource,
    private readonly licenseStore?: LicenseStore,
    private readonly options: LCHReaderOptions = {}
  ) {}

  async inspect(bytes: Uint8Array): Promise<InspectedLCH> {
    const parsed = parseLCH(bytes)
    lchAssert(parsed.header.lch === LCH_VERSION, 'ERR_LCH_FRAMING', 'Unsupported LCH version')
    lchAssert(
      Array.isArray(parsed.header.acquisition) && parsed.header.acquisition.length > 0,
      'ERR_LCH_PROFILE_UNSUPPORTED',
      'Header has no acquisition entry'
    )
    const asset = mapValue(parsed.header.asset, 'Asset Body')
    validateAssetShape(asset)
    const representation = mapValue(asset.representation, 'representation')
    const assetId = await objectId('asset', asset)
    const headerSigners = await verifyHeaderAuthorization(
      parsed.header,
      asset,
      assetId,
      this.options.verifier ?? new PublicBRC77Verifier(),
      this.options.authorizeHeaderSigner
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
    if (inspected.ciphertext !== undefined) return inspected.ciphertext
    const locators = inspected.representation.locators
    lchAssert(
      Array.isArray(locators),
      'ERR_LCH_CONTENT_UNAVAILABLE',
      'Representation locators are invalid'
    )
    let lastError: unknown
    for (const locator of locators) {
      if (typeof locator !== 'string') continue
      try {
        const ciphertext = await this.source.read(locator)
        await validateCiphertext(ciphertext, inspected.representation)
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
    selection: Selection = { type: 'all' }
  ): Promise<Uint8Array> {
    const ciphertext = await this.resolve(inspected)
    const descriptor = mapValue(inspected.representation.encryption, 'encryption descriptor')
    const plaintext = await decryptSegmented(
      ciphertext,
      descriptor as unknown as SegmentedEncryptionDescriptor,
      keys,
      selection
    )
    if (selection.type === 'all' && inspected.representation.plaintextDigest !== undefined) {
      const digest = inspected.representation.plaintextDigest
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
    return stored?.license
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
  recover(requestId: Uint8Array): Promise<SignedObject | undefined>
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

  recover(requestId: Uint8Array): Promise<SignedObject | undefined> {
    return this.transport.recover(requestId)
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
    asset.name.includes(String.fromCharCode(0))
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
      representation.locators.every(locator => typeof locator === 'string'),
    'ERR_LCH_FRAMING',
    'Asset representation is invalid'
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
      signatures.every(signature => signature instanceof Uint8Array),
    'ERR_LCH_SIGNATURE',
    'Header signatures are invalid'
  )
  const rights = asset.rights
  lchAssert(
    Array.isArray(rights) && rights.length > 0,
    'ERR_LCH_AUTHORITY',
    'Asset rights are absent'
  )
  const controllers = rights.map(right => {
    const map = mapValue(right, 'rights interest')
    const holder = mapValue(map.holder, 'rights holder')
    const controller = map.controller
    lchAssert(
      typeof map.interest === 'string' &&
        map.interest.length > 0 &&
        typeof holder.name === 'string' &&
        holder.name.length > 0 &&
        controller instanceof Uint8Array &&
        controller.length === 33,
      'ERR_LCH_AUTHORITY',
      'Rights interest or Controller is invalid'
    )
    return toHex(controller)
  })
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
    if (!(await verifier.verify(preimage, signature))) continue
    const authorized =
      controllers.includes(toHex(signer)) ||
      (authorize !== undefined && (await authorize(signer, assetId)))
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
  seller: Uint8Array
): Promise<string> {
  await verifySignedObject('offer', offer, verifier, seller)
  const notBefore = offer.body.notBefore
  const notAfter = offer.body.notAfter
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
  return objectIri('offer', offer.body)
}

export { LCH_MECHANISMS }
