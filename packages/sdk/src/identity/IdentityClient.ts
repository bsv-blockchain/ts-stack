import {
  DEFAULT_IDENTITY_CLIENT_OPTIONS,
  defaultIdentity,
  DisplayableIdentity,
  IdentityClientOptions,
  KNOWN_IDENTITY_TYPES
} from './types/index.js'
import type {
  Base64String,
  CertificateFieldNameUnder50Bytes,
  DiscoverByAttributesArgs,
  DiscoverByIdentityKeyArgs,
  IdentityCertificate,
  OriginatorDomainNameStringUnder250Bytes,
  PubKeyHex,
  WalletCertificate,
  WalletInterface
} from '../wallet/Wallet.interfaces.js'
import { validateBase64String } from '../wallet/validationHelpers.js'
import WalletClient from '../wallet/WalletClient.js'
import Transaction from '../transaction/Transaction.js'
import type { BroadcastFailure, BroadcastResponse } from '../transaction/Broadcaster.js'
import Certificate from '../auth/certificates/Certificate.js'
import LockingScript from '../script/LockingScript.js'
import PushDrop from '../script/templates/PushDrop.js'
import { toArray, toUTF8Strict } from '../primitives/utils.js'
import LookupResolver from '../overlay-tools/LookupResolver.js'
import TopicBroadcaster from '../overlay-tools/SHIPBroadcaster.js'
import { withDoubleSpendRetry } from '../overlay-tools/withDoubleSpendRetry.js'
import { ContactsManager, Contact } from './ContactsManager.js'
import { isUnsafeRecordKey } from '../primitives/SafeRecord.js'
import { utf8ByteLength } from '../primitives/UTF8.js'

/**
 * Maximum number of identity certificates to parse synchronously before yielding to the
 * event loop. Keeps the main thread responsive when an overlay query returns many results
 * (e.g. a bulk enrichment of N identityKeys).
 */
const PARSE_BATCH_SIZE = 32
const MAX_IDENTITY_RESULTS = 10000
const MAX_IDENTITY_LOOKUP_BEEF_BYTES = 16 * 1024 * 1024
const MAX_IDENTITY_TEXT_BYTES = 4096
const MAX_IDENTITY_RESOURCE_BYTES = 2048

function identityRecord(value: unknown, field: string, allowNull = false): Record<string, unknown> {
  if (allowNull && value == null) return Object.create(null)
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid display identity: ${field} must be a plain object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`Invalid display identity: ${field} must be a plain object`)
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || isUnsafeRecordKey(key)) {
      throw new Error(`Invalid display identity: ${field} contains an unsafe field`)
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor == null || !('value' in descriptor)) {
      throw new Error(`Invalid display identity: ${field}.${key} must be a data property`)
    }
  }
  return value as Record<string, unknown>
}

function identityData(record: Record<string, unknown>, key: string): unknown {
  return Object.getOwnPropertyDescriptor(record, key)?.value
}

function hasUnsafeDisplayControl(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (
      code < 9 ||
      (code > 10 && code < 13) ||
      (code > 13 && code < 32) ||
      code === 127 ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ||
      code === 0xfeff
    ) {
      return true
    }
  }
  return false
}

function identityString(
  value: unknown,
  field: string,
  fallback = '',
  maximumBytes = MAX_IDENTITY_TEXT_BYTES
): string {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value !== 'string')
    throw new Error(`Invalid display identity: ${field} must be a string`)
  if (utf8ByteLength(value) > maximumBytes || hasUnsafeDisplayControl(value)) {
    throw new Error(`Invalid display identity: ${field} is oversized or contains unsafe controls`)
  }
  return value
}

function identityResource(value: unknown, field: string, fallback: string): string {
  const resource = identityString(value, field, fallback, MAX_IDENTITY_RESOURCE_BYTES)
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(resource.trim())
  if (scheme == null) return resource
  if (scheme[1].toLowerCase() !== 'https' && scheme[1].toLowerCase() !== 'http') {
    throw new Error(`Invalid display identity: ${field} uses an unsafe URL scheme`)
  }
  let parsed: URL
  try {
    parsed = new URL(resource)
  } catch {
    throw new Error(`Invalid display identity: ${field} must be a valid resource URL`)
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error(`Invalid display identity: ${field} must not contain credentials`)
  }
  return resource
}

function identityPushOpcode(value: number[]): number {
  if (value.length <= 75) return value.length
  if (value.length <= 0xff) return 0x4c
  if (value.length <= 0xffff) return 0x4d
  return 0x4e
}

function assertCanonicalIdentityTokenScript(
  lockingScript: LockingScript,
  fields: number[][]
): void {
  if (fields.length !== 2) throw new Error('Identity token must contain exactly two fields')
  const chunks = lockingScript.chunks
  if (
    chunks.length !== 5 ||
    chunks[0].op !== 33 ||
    chunks[0].data?.length !== 33 ||
    chunks[1].op !== 0xac ||
    chunks[2].op !== identityPushOpcode(fields[0]) ||
    chunks[3].op !== identityPushOpcode(fields[1]) ||
    chunks[4].op !== 0x6d
  ) {
    throw new Error('Identity token must use the canonical signed PushDrop script')
  }
}

function revelationInputOutpoint(transaction: Transaction, inputIndex: number): string {
  const input = transaction.inputs[inputIndex]
  if (
    input == null ||
    !Number.isSafeInteger(input.sourceOutputIndex) ||
    input.sourceOutputIndex < 0 ||
    input.sourceOutputIndex > 0xffffffff
  ) {
    throw new Error('Revelation transaction input is malformed')
  }
  const embeddedTxid = input.sourceTransaction?.id('hex')
  if (
    input.sourceTXID !== undefined &&
    embeddedTxid !== undefined &&
    input.sourceTXID.toLowerCase() !== embeddedTxid.toLowerCase()
  ) {
    throw new Error('Revelation transaction input source mismatch')
  }
  const txid = input.sourceTXID ?? embeddedTxid
  if (typeof txid !== 'string' || !/^[0-9a-f]{64}$/i.test(txid)) {
    throw new Error('Revelation transaction input has no canonical source ID')
  }
  return `${txid.toLowerCase()}.${input.sourceOutputIndex}`
}

function assertRevelationTransactionTemplate(signable: Transaction, signed: Transaction): void {
  if (
    signable.version !== signed.version ||
    signable.lockTime !== signed.lockTime ||
    signable.inputs.length !== signed.inputs.length ||
    signable.outputs.length !== signed.outputs.length
  ) {
    throw new Error('Signed revelation transaction substituted the authorized template')
  }
  for (let index = 0; index < signable.inputs.length; index++) {
    if (
      revelationInputOutpoint(signable, index) !== revelationInputOutpoint(signed, index) ||
      (signable.inputs[index].sequence ?? 0xffffffff) !==
        (signed.inputs[index].sequence ?? 0xffffffff)
    ) {
      throw new Error('Signed revelation transaction substituted an authorized input')
    }
  }
  for (let index = 0; index < signable.outputs.length; index++) {
    if (
      signable.outputs[index].satoshis !== signed.outputs[index].satoshis ||
      signable.outputs[index].lockingScript.toHex() !== signed.outputs[index].lockingScript.toHex()
    ) {
      throw new Error('Signed revelation transaction substituted an authorized output')
    }
  }
}

/**
 * Yield control to the event loop so queued microtasks / timers can run. Uses
 * `scheduler.yield()` when available (Chromium) or a 0ms macrotask fallback.
 */
async function yieldToEventLoop(): Promise<void> {
  const sched = (globalThis as any).scheduler
  if (sched != null && typeof sched.yield === 'function') {
    return sched.yield()
  }
  return await new Promise<void>(resolve => setTimeout(resolve, 0))
}

/** Optional recovery policy for personal contact enrichment, never for public discovery. */
export interface ContactResolutionOptions {
  /**
   * Default `throw` preserves contact failures. Opt into `fallback` to continue public
   * discovery without contact overrides after a contact failure or timeout.
   */
  contactErrorMode?: 'throw' | 'fallback'
  /**
   * Contact-only deadline, an integer from 1 to 60000 milliseconds. Default: 2000 in
   * fallback mode, otherwise no deadline. This bounds the caller's wait; it cannot
   * cancel an underlying wallet request or dismiss a pending wallet permission prompt.
   */
  contactTimeoutMs?: number
  /**
   * Receives the original contact failure (or a timeout Error) when fallback is used.
   * Use it to display a partial-result warning. Callback exceptions propagate.
   */
  onContactError?: (error: unknown) => void
}

/** Options for {@link IdentityClient.resolveByIdentityKey}. */
export interface ResolveByIdentityKeyOptions extends ContactResolutionOptions {
  /**
   * Opt-in to consulting personal contacts before/alongside the overlay. Default `false`.
   *
   * Most callers (including any client without a populated contacts basket) pay no benefit
   * from the contacts path and incur its setup cost. Set `true` only in UI contexts where
   * the user has likely saved contacts and a local cache hit is preferable to a fresh overlay
   * answer. A matching saved contact is a locally authoritative personal assertion—equivalent
   * to a user-installed trust anchor or accepted self-signed certificate—and may override the
   * overlay result. “Authoritative” is scoped to this user's saved association:
   * it is not evidence of a third-party certifier's attestation and does not
   * transfer as a trust claim to another wallet or user.
   */
  useContacts?: boolean
  /**
   * Legacy alias for {@link useContacts}. When provided, takes precedence over the new flag.
   * Kept for binary compatibility — new code should use `useContacts`.
   */
  overrideWithContacts?: boolean
  /**
   * When `true` (and {@link useContacts} is also true), fire contacts and overlay in parallel
   * rather than short-circuiting on a contacts hit. Use only when callers specifically need a
   * fresh overlay answer alongside any cached contact record.
   */
  parallel?: boolean
}

/** Options for {@link IdentityClient.resolveByAttributes}. */
export interface ResolveByAttributesOptions extends ContactResolutionOptions {
  /**
   * Opt-in to consulting personal contacts before/alongside the overlay. Default `false`.
   * See {@link ResolveByIdentityKeyOptions.useContacts}.
   */
  useContacts?: boolean
  /**
   * Legacy alias for {@link useContacts}. Takes precedence when provided. Enabling it carries the
   * same local-authority semantics; “override” does not add third-party validation.
   */
  overrideWithContacts?: boolean
  /**
   * When `true` (and {@link useContacts} is also true), fire contacts and overlay in parallel.
   */
  parallel?: boolean
}

interface NormalizedResolutionOptions {
  useContacts: boolean
  parallel: boolean
  contactErrorMode: 'throw' | 'fallback'
  contactTimeoutMs?: number
  onContactError?: (error: unknown) => void
}

const RESOLUTION_OPTION_FIELDS = new Set([
  'useContacts',
  'overrideWithContacts',
  'parallel',
  'contactErrorMode',
  'contactTimeoutMs',
  'onContactError'
])

function normalizeContactPolicy(
  options: Record<string, unknown>
): Omit<NormalizedResolutionOptions, 'useContacts' | 'parallel'> {
  const mode = identityData(options, 'contactErrorMode')
  const contactErrorMode = mode === undefined ? 'throw' : mode
  const contactTimeoutMs = identityData(options, 'contactTimeoutMs')
  const onContactError = identityData(options, 'onContactError')
  if (contactErrorMode !== 'throw' && contactErrorMode !== 'fallback') {
    throw new Error('Invalid identity options: contactErrorMode must be throw or fallback')
  }
  if (
    contactTimeoutMs !== undefined &&
    (typeof contactTimeoutMs !== 'number' ||
      !Number.isInteger(contactTimeoutMs) ||
      contactTimeoutMs < 1 ||
      contactTimeoutMs > 60000)
  ) {
    throw new Error('Invalid identity options: contactTimeoutMs must be an integer from 1 to 60000')
  }
  if (onContactError !== undefined && typeof onContactError !== 'function') {
    throw new Error('Invalid identity options: onContactError must be a function')
  }
  return {
    contactErrorMode,
    contactTimeoutMs:
      (contactTimeoutMs as number | undefined) ??
      (contactErrorMode === 'fallback' ? 2000 : undefined),
    onContactError: onContactError as ((error: unknown) => void) | undefined
  }
}

/** Normalize legacy booleans and validate the additive contact recovery policy. */
function normalizeOpts(
  raw: boolean | ResolveByIdentityKeyOptions | ResolveByAttributesOptions | undefined
): NormalizedResolutionOptions {
  if (raw === undefined || typeof raw === 'boolean') {
    return { useContacts: raw === true, parallel: false, contactErrorMode: 'throw' }
  }
  const options = identityRecord(raw, 'options')
  for (const key of Reflect.ownKeys(options)) {
    if (!RESOLUTION_OPTION_FIELDS.has(String(key))) {
      throw new Error(`Invalid identity options: unexpected field ${String(key)}`)
    }
  }
  const useContacts = identityData(options, 'useContacts')
  const overrideWithContacts = identityData(options, 'overrideWithContacts')
  const parallel = identityData(options, 'parallel')
  const contactPolicy = normalizeContactPolicy(options)
  for (const [field, value] of [
    ['useContacts', useContacts],
    ['overrideWithContacts', overrideWithContacts],
    ['parallel', parallel]
  ] as const) {
    if (value !== undefined && typeof value !== 'boolean') {
      throw new Error(`Invalid identity options: ${field} must be a boolean`)
    }
  }
  return {
    useContacts: (overrideWithContacts ?? useContacts ?? false) as boolean,
    parallel: parallel === true,
    ...contactPolicy
  }
}

/**
 * IdentityClient lets you discover who others are, and let the world know who you are.
 */
export class IdentityClient {
  readonly #wallet: WalletInterface
  private readonly contactsManager: ContactsManager
  readonly #originator?: OriginatorDomainNameStringUnder250Bytes
  private readonly options: IdentityClientOptions
  constructor(
    wallet?: WalletInterface,
    options: Partial<IdentityClientOptions> = {},
    originator?: OriginatorDomainNameStringUnder250Bytes
  ) {
    this.options = { ...DEFAULT_IDENTITY_CLIENT_OPTIONS, ...options }
    this.#wallet = wallet ?? new WalletClient()
    this.#originator = originator
    this.contactsManager = new ContactsManager(this.#wallet, this.#originator)
  }

  async #getResolutionContacts(
    options: NormalizedResolutionOptions,
    identityKey?: PubKeyHex
  ): Promise<Contact[]> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const contacts = this.contactsManager.getContacts(identityKey)
      if (options.contactTimeoutMs === undefined) return await contacts
      return await Promise.race([
        contacts,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('Identity contact resolution timed out')),
            options.contactTimeoutMs
          )
        })
      ])
    } catch (error) {
      if (options.contactErrorMode === 'throw') throw error
      options.onContactError?.(error)
      return []
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /**
   * Publicly reveals selected fields from a given certificate by creating a publicly verifiable certificate.
   * The publicly revealed certificate is included in a blockchain transaction and broadcast to a federated overlay node.
   *
   * @param {Certificate} certificate - The master certificate to selectively reveal.
   * @param {CertificateFieldNameUnder50Bytes[]} fieldsToReveal - An array of certificate field names to reveal. Only these fields will be included in the public certificate.
   *
   * @returns {Promise<object>} A promise that resolves with the broadcast result from the overlay network.
   * @throws {Error} Throws an error if the certificate is invalid, the fields cannot be revealed, or if the broadcast fails.
   */
  async publiclyRevealAttributes(
    certificate: WalletCertificate,
    fieldsToReveal: CertificateFieldNameUnder50Bytes[]
  ): Promise<BroadcastResponse | BroadcastFailure> {
    const certificateObject = identityRecord(certificate, 'certificate')
    const certificateFields = identityRecord(
      identityData(certificateObject, 'fields'),
      'certificate.fields'
    )
    if (Object.keys(certificateFields).length === 0) {
      throw new Error('Public reveal failed: Certificate has no fields to reveal!')
    }
    if (!Array.isArray(fieldsToReveal) || fieldsToReveal.length === 0) {
      throw new Error('Public reveal failed: You must reveal at least one field!')
    }
    if (fieldsToReveal.length > 100) {
      throw new Error('Public reveal failed: You may reveal at most 100 fields!')
    }
    const requestedFields = new Set<string>()
    for (let index = 0; index < fieldsToReveal.length; index++) {
      if (!Object.prototype.hasOwnProperty.call(fieldsToReveal, index)) {
        throw new Error('Public reveal failed: fieldsToReveal must be a dense array!')
      }
      const fieldName = identityString(fieldsToReveal[index], `fieldsToReveal[${index}]`, '', 50)
      if (fieldName === '' || isUnsafeRecordKey(fieldName)) {
        throw new Error('Public reveal failed: invalid certificate field name!')
      }
      if (requestedFields.has(fieldName)) {
        throw new Error('Public reveal failed: duplicate certificate field name!')
      }
      if (!Object.prototype.hasOwnProperty.call(certificateFields, fieldName)) {
        throw new Error('Public reveal failed: requested field is not present in the certificate!')
      }
      requestedFields.add(fieldName)
    }
    try {
      const masterCert = new Certificate(
        certificate.type,
        certificate.serialNumber,
        certificate.subject,
        certificate.certifier,
        certificate.revocationOutpoint,
        certificate.fields,
        certificate.signature
      )
      if (!(await masterCert.verify())) {
        throw new Error('Certificate verification failed')
      }
    } catch {
      // Low-level cert error details are suppressed — surface a user-facing message only
      throw new Error('Public reveal failed: Certificate verification failed!')
    }

    // Given we already have a master certificate from a certifier,
    // create an anyone verifiable certificate with selectively revealed fields
    const proof = await this.#wallet.proveCertificate(
      {
        certificate,
        fieldsToReveal,
        verifier: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
      },
      this.#originator
    )
    const proofObject = identityRecord(proof, 'proof result')
    const rawKeyring = identityRecord(
      identityData(proofObject, 'keyringForVerifier'),
      'proof result keyringForVerifier'
    )
    const keyringForVerifier: Record<string, string> = Object.create(null)
    const returnedFields = Object.keys(rawKeyring)
    if (
      returnedFields.length !== requestedFields.size ||
      returnedFields.some(field => !requestedFields.has(field))
    ) {
      throw new Error('Public reveal failed: wallet returned a keyring for unrequested fields!')
    }
    for (const fieldName of returnedFields) {
      keyringForVerifier[fieldName] = validateBase64String(
        identityData(rawKeyring, fieldName) as string,
        `keyringForVerifier.${fieldName}`,
        1,
        2048
      )
    }

    // Build the lockingScript with pushdrop.create() and the transaction with createAction()
    const lockingScript = await new PushDrop(this.#wallet, this.#originator).lock(
      [toArray(JSON.stringify({ ...certificate, keyring: keyringForVerifier }))],
      this.options.protocolID,
      this.options.keyID,
      'anyone',
      true,
      true
    )
    // Consider verification and if this is necessary
    // counterpartyCanVerifyMyOwnership: true

    const { tx } = await this.#wallet.createAction(
      {
        description: 'Create a new Identity Token',
        outputs: [
          {
            satoshis: this.options.tokenAmount,
            lockingScript: lockingScript.toHex(),
            outputDescription: 'Identity Token'
          }
        ],
        options: {
          randomizeOutputs: false
        }
      },
      this.#originator
    )

    if (tx !== undefined) {
      // Submit the transaction to an overlay
      const broadcaster = new TopicBroadcaster(['tm_identity'], {
        networkPreset: this.options.networkPreset ?? (await this.#wallet.getNetwork({})).network
      })
      return await broadcaster.broadcast(Transaction.fromAtomicBEEF(tx))
    }
    throw new Error('Public reveal failed: failed to create action!')
  }

  /**
   * Resolves displayable identity certificates issued to a given identity key.
   *
   * **Default behavior (changed): contacts are NOT consulted.** Most clients have no
   * contacts saved locally, so the previous "contacts-first" default paid setup cost for no
   * gain. Pass `{ useContacts: true }` to opt in — appropriate when you know the user has
   * saved contacts and prefers a local hit over a fresh overlay answer.
   *
   * When `useContacts: true`:
   *  - Default short-circuits: if a contact matches, the overlay is skipped entirely. This treats
   *    the saved contact as a locally authoritative personal assertion, analogous to a local trust
   *    anchor or self-signed certificate, not as an independent third-party attestation.
   *    The contact's authority comes from the user's prior independent validation;
   *    contact-output authentication proves local storage, not the real-world identity.
   *  - `{ parallel: true }` fires contacts and overlay in parallel; contact wins on hit.
   *
   * @param args - Arguments for requesting the discovery based on the identity key.
   * @param opts - Boolean (legacy) or options object. Boolean `true` ≡ `{ useContacts: true }`.
   */
  async resolveByIdentityKey(
    args: DiscoverByIdentityKeyArgs,
    opts: boolean | ResolveByIdentityKeyOptions = false
  ): Promise<DisplayableIdentity[]> {
    const options = normalizeOpts(opts)
    const { useContacts, parallel } = options

    // Fast path: skip contacts entirely. Default — straight overlay query,
    // no listOutputs / decrypt / cache churn.
    if (!useContacts) {
      const certificatesResult = await this.#wallet.discoverByIdentityKey(args, this.#originator)
      const certs = certificatesResult?.certificates ?? []
      return await IdentityClient.parseIdentities(certs)
    }

    if (!parallel) {
      const contacts = await this.#getResolutionContacts(options, args.identityKey)
      if (contacts.length > 0) return contacts

      const certificatesResult = await this.#wallet.discoverByIdentityKey(args, this.#originator)
      const certs = certificatesResult?.certificates ?? []
      return await IdentityClient.parseIdentities(certs)
    }

    const [contacts, certificatesResult] = await Promise.all([
      this.#getResolutionContacts(options, args.identityKey),
      this.#wallet.discoverByIdentityKey(args, this.#originator)
    ])

    if (contacts.length > 0) return contacts
    const certs = certificatesResult?.certificates ?? []
    return await IdentityClient.parseIdentities(certs)
  }

  /**
   * Resolves displayable identity certificates by specific identity attributes.
   *
   * **Default behavior (changed): contacts are NOT consulted.** See
   * {@link resolveByIdentityKey} for the reasoning. Pass `{ useContacts: true }` to opt in.
   * Opting in makes matching saved contacts locally authoritative and may override fresh overlay
   * presentation data. Applications should save contacts only after their own user/app validation
   * and must label contact-sourced identity as local rather than certifier-verified.
   *
   * @param args - Attributes and optional parameters used to discover certificates.
   * @param opts - Boolean (legacy) or options object. Boolean `true` ≡ `{ useContacts: true }`.
   */
  async resolveByAttributes(
    args: DiscoverByAttributesArgs,
    opts: boolean | ResolveByAttributesOptions = false
  ): Promise<DisplayableIdentity[]> {
    const options = normalizeOpts(opts)
    const { useContacts, parallel } = options

    // Fast path: skip contacts entirely.
    if (!useContacts) {
      const certificatesResult = await this.#wallet.discoverByAttributes(args, this.#originator)
      const certs = certificatesResult?.certificates ?? []
      return await IdentityClient.parseIdentities(certs)
    }

    if (!parallel) {
      const contacts = await this.#getResolutionContacts(options)
      const matches = this.#matchContactsByAttributes(contacts, args)
      if (matches.length > 0) return matches

      const certificatesResult = await this.#wallet.discoverByAttributes(args, this.#originator)
      const certs = certificatesResult?.certificates ?? []
      if (contacts.length === 0) return await IdentityClient.parseIdentities(certs)
      const contactByKey = new Map<PubKeyHex, Contact>(
        contacts.map(contact => [contact.identityKey, contact] as const)
      )
      return await IdentityClient.parseIdentitiesWithOverrides(certs, contactByKey)
    }

    const [contacts, certificatesResult] = await Promise.all([
      this.#getResolutionContacts(options),
      this.#wallet.discoverByAttributes(args, this.#originator)
    ])

    const certs = certificatesResult?.certificates ?? []
    if (contacts.length === 0) return await IdentityClient.parseIdentities(certs)
    const contactByKey = new Map<PubKeyHex, Contact>(
      contacts.map(contact => [contact.identityKey, contact] as const)
    )
    const matches = this.#matchContactsByAttributes(contacts, args)
    const matchedKeys = new Set(matches.map(contact => contact.identityKey))
    const discovered = await IdentityClient.parseIdentitiesWithOverrides(certs, contactByKey)
    const identities = [
      ...matches,
      ...discovered.filter(identity => !matchedKeys.has(identity.identityKey))
    ]
    if (identities.length > MAX_IDENTITY_RESULTS) {
      throw new Error(`Identity resolution exceeded ${MAX_IDENTITY_RESULTS} results`)
    }
    return identities
  }

  /**
   * Best-effort match of contacts against a `DiscoverByAttributesArgs.attributes` shape.
   * Used by the contacts-first path of {@link resolveByAttributes} to decide whether the overlay
   * can be skipped. Compares string-valued attributes against same-named fields on the contact's
   * decrypted record. The `any` selector matches a case-insensitive substring of name or
   * identityKey. Named selectors retain exact case-insensitive matching; all supplied
   * selectors must match. Contact assertions remain local, not certifier attestations.
   */
  #matchContactsByAttributes(contacts: Contact[], args: DiscoverByAttributesArgs): Contact[] {
    const attrs = args.attributes
    if (attrs == null || typeof attrs !== 'object' || Array.isArray(attrs)) return []
    let attributes: Record<string, unknown>
    try {
      attributes = identityRecord(attrs, 'attributes')
    } catch {
      return []
    }
    if (Reflect.ownKeys(attributes).length > 100) return []
    const entries: Array<[string, string]> = []
    for (const key of Object.keys(attributes)) {
      const value = identityData(attributes, key)
      if (
        typeof value === 'string' &&
        value.length > 0 &&
        utf8ByteLength(value) <= 500 &&
        !hasUnsafeDisplayControl(value)
      ) {
        entries.push([key, value])
      } else return []
    }
    if (entries.length === 0) return []
    return contacts.filter(contact => {
      const bag: Record<string, unknown> = {
        name: contact.name,
        identityKey: contact.identityKey
      }
      return entries.every(([k, v]) => {
        if (k === 'any') {
          const query = v.trim().toLowerCase()
          return (
            query.length > 0 &&
            (contact.name.toLowerCase().includes(query) ||
              contact.identityKey.toLowerCase().includes(query))
          )
        }
        const candidate = bag[k]
        return typeof candidate === 'string' && candidate.toLowerCase() === v.toLowerCase()
      })
    })
  }

  /**
   * Remove public certificate revelation from overlay services by spending the identity token
   * @param serialNumber - Unique serial number of the certificate to revoke revelation
   */
  async revokeCertificateRevelation(serialNumber: Base64String): Promise<void> {
    const requestedSerialNumber = validateBase64String(
      serialNumber,
      'serialNumber',
      32,
      32
    ) as Base64String
    const { publicKey: identityKey } = await this.#wallet.getPublicKey(
      { identityKey: true },
      this.#originator
    )
    const { publicKey: revelationLockingKey } = await this.#wallet.getPublicKey(
      {
        protocolID: this.options.protocolID,
        keyID: this.options.keyID,
        counterparty: 'anyone',
        forSelf: true
      },
      this.#originator
    )

    // 1. Find existing UTXO
    const lookupResolver = new LookupResolver({
      networkPreset: this.options.networkPreset ?? (await this.#wallet.getNetwork({})).network
    })
    const result = await lookupResolver.query({
      service: 'ls_identity',
      query: {
        serialNumber: requestedSerialNumber
      }
    })

    if (result.type !== 'output-list' || result.outputs.length === 0) {
      throw new Error('Failed to get lookup result')
    }
    if (result.outputs.length > MAX_IDENTITY_RESULTS) {
      throw new Error(`Identity revelation lookup exceeded ${MAX_IDENTITY_RESULTS} results`)
    }
    let aggregateBeefBytes = 0
    for (const output of result.outputs) {
      const beef: unknown = output.beef
      if (Array.isArray(beef) || beef instanceof Uint8Array) {
        aggregateBeefBytes += beef.length
        if (aggregateBeefBytes > MAX_IDENTITY_LOOKUP_BEEF_BYTES) {
          throw new Error(
            `Identity revelation lookup exceeded ${MAX_IDENTITY_LOOKUP_BEEF_BYTES} BEEF bytes`
          )
        }
      }
    }

    const revelationOutputs: Array<{
      beef: number[]
      outputIndex: number
      tx: Transaction
      txid: string
    }> = []
    for (const output of result.outputs) {
      try {
        const tx = Transaction.fromBEEF(output.beef)
        const sourceOutput = tx.outputs[output.outputIndex]
        if (sourceOutput?.lockingScript == null) continue
        const decoded = PushDrop.decode(sourceOutput.lockingScript)
        if (decoded.fields.length !== 2) continue
        assertCanonicalIdentityTokenScript(sourceOutput.lockingScript, decoded.fields)
        if (decoded.lockingPublicKey.toString() !== revelationLockingKey) continue

        const parsed: unknown = JSON.parse(toUTF8Strict(decoded.fields[0]))
        if (
          parsed == null ||
          typeof parsed !== 'object' ||
          Array.isArray(parsed) ||
          (parsed as Record<string, unknown>).serialNumber !== requestedSerialNumber ||
          (parsed as Record<string, unknown>).subject !== identityKey
        ) {
          continue
        }

        const certificate = parsed as WalletCertificate
        if (
          !(await new Certificate(
            certificate.type,
            certificate.serialNumber,
            certificate.subject,
            certificate.certifier,
            certificate.revocationOutpoint,
            certificate.fields,
            certificate.signature
          ).verify())
        ) {
          continue
        }

        const signatureResult = await this.#wallet.verifySignature(
          {
            data: decoded.fields[0],
            signature: decoded.fields[1],
            protocolID: this.options.protocolID,
            keyID: this.options.keyID,
            counterparty: 'anyone',
            forSelf: true
          },
          this.#originator
        )
        if (signatureResult.valid !== true) continue

        revelationOutputs.push({
          beef: output.beef,
          outputIndex: output.outputIndex,
          tx,
          txid: tx.id('hex')
        })
      } catch {
        // A lookup response is untrusted. Ignore malformed or unauthenticated outputs.
      }
    }

    if (revelationOutputs.length === 0) {
      throw new Error('No authenticated revelation output matches the requested certificate.')
    }

    const topicBroadcaster = new TopicBroadcaster(['tm_identity'], {
      networkPreset: this.options.networkPreset ?? (await this.#wallet.getNetwork({})).network
    })

    for (const revelation of revelationOutputs) {
      await withDoubleSpendRetry(async () => {
        const sourceOutput = revelation.tx.outputs[revelation.outputIndex]
        if (sourceOutput?.lockingScript == null || sourceOutput.satoshis == null) {
          throw new Error('Failed to get the revelation source output.')
        }
        const outpoint = `${revelation.txid}.${revelation.outputIndex}`

        // 2. Spend the exact authenticated result.
        const { signableTransaction } = await this.#wallet.createAction(
          {
            description: 'Spend certificate revelation token',
            inputBEEF: revelation.beef,
            inputs: [
              {
                inputDescription: 'Revelation token',
                outpoint,
                unlockingScriptLength: 74
              }
            ],
            options: {
              randomizeOutputs: false,
              acceptDelayedBroadcast: false,
              noSend: true
            }
          },
          this.#originator
        )

        if (signableTransaction === undefined) {
          throw new Error('Failed to create signable transaction')
        }

        const reference = signableTransaction.reference
        try {
          const partialTx = Transaction.fromAtomicBEEF(signableTransaction.tx)
          const matchingInputIndexes = partialTx.inputs.flatMap((_, inputIndex) =>
            revelationInputOutpoint(partialTx, inputIndex) === outpoint.toLowerCase()
              ? [inputIndex]
              : []
          )
          if (matchingInputIndexes.length !== 1) {
            throw new Error(
              'Wallet signable transaction does not contain the requested revelation input.'
            )
          }
          const inputIndex = matchingInputIndexes[0]

          const unlocker = new PushDrop(this.#wallet, this.#originator).unlock(
            this.options.protocolID,
            this.options.keyID,
            'anyone',
            'all',
            false,
            sourceOutput.satoshis,
            sourceOutput.lockingScript
          )

          const unlockingScript = await unlocker.sign(partialTx, inputIndex)
          const unlockingScriptHex = unlockingScript.toHex()
          const signResult = await this.#wallet.signAction(
            {
              reference,
              spends: {
                [inputIndex]: {
                  unlockingScript: unlockingScriptHex
                }
              },
              options: {
                acceptDelayedBroadcast: false,
                returnTXIDOnly: false,
                noSend: true
              }
            },
            this.#originator
          )

          if (signResult.tx === undefined) {
            throw new Error('Failed to sign transaction')
          }

          const signedTransaction = Transaction.fromAtomicBEEF(signResult.tx)
          assertRevelationTransactionTemplate(partialTx, signedTransaction)
          if (revelationInputOutpoint(signedTransaction, inputIndex) !== outpoint.toLowerCase()) {
            throw new Error('Signed transaction does not spend the requested revelation output.')
          }
          if (
            signedTransaction.inputs[inputIndex].unlockingScript?.toHex() !== unlockingScriptHex
          ) {
            throw new Error('Signed transaction substituted the authorized revelation script.')
          }
          if (
            signResult.txid !== undefined &&
            signResult.txid.toLowerCase() !== signedTransaction.id('hex').toLowerCase()
          ) {
            throw new Error('Signed revelation transaction ID does not match its transaction data.')
          }

          const broadcastResult = await topicBroadcaster.broadcast(signedTransaction)
          if (broadcastResult.status !== 'success') {
            throw new Error(
              `Failed to broadcast certificate revelation revocation: ${broadcastResult.code}: ${broadcastResult.description}`
            )
          }
        } catch (error) {
          try {
            await this.#wallet.abortAction({ reference }, this.#originator)
          } catch {
            // Preserve the primary error if an untrusted wallet refuses cleanup.
          }
          throw error
        }
      }, topicBroadcaster)
    }
  }

  /**
   * Load all records from the contacts basket
   * @param identityKey Optional specific identity key to fetch
   * @param forceRefresh Whether to force a check for new contact data
   * @param limit Optional limit on number of contacts to fetch
   * @returns A promise that resolves with an array of contacts
   */
  public async getContacts(
    identityKey?: PubKeyHex,
    forceRefresh = false,
    limit = 1000
  ): Promise<Contact[]> {
    return await this.contactsManager.getContacts(identityKey, forceRefresh, limit)
  }

  /**
   * Save or update a Metanet contact. Saving installs a wallet-local trust anchor for the
   * identity-key association. Validate it through the user or another independent channel before
   * recording it; the resulting authority is local and is not a third-party certification.
   * @param contact The displayable identity information for the contact
   * @param metadata Optional metadata to store with the contact (ex. notes, aliases, etc)
   */
  public async saveContact(
    contact: DisplayableIdentity,
    metadata?: Record<string, any>
  ): Promise<void> {
    return await this.contactsManager.saveContact(contact, metadata)
  }

  /**
   * Remove a contact from the contacts basket
   * @param identityKey The identity key of the contact to remove
   */
  public async removeContact(identityKey: PubKeyHex): Promise<void> {
    return await this.contactsManager.removeContact(identityKey)
  }

  /**
   * Parse an array of certificates into DisplayableIdentity records, yielding to the
   * event loop every {@link PARSE_BATCH_SIZE} entries so large result sets don't hog
   * the main thread. Equivalent to `certs.map(parseIdentity)` for small inputs.
   */
  static async parseIdentities(certs: IdentityCertificate[]): Promise<DisplayableIdentity[]> {
    if (!Array.isArray(certs) || certs.length > MAX_IDENTITY_RESULTS) {
      throw new Error(
        `Invalid identity result: expected at most ${MAX_IDENTITY_RESULTS} certificates`
      )
    }
    const n = certs.length
    if (n <= PARSE_BATCH_SIZE) {
      return certs.map(c => IdentityClient.parseIdentity(c))
    }
    const out: DisplayableIdentity[] = Array.from({ length: n })
    for (let i = 0; i < n; i++) {
      out[i] = IdentityClient.parseIdentity(certs[i])
      if ((i + 1) % PARSE_BATCH_SIZE === 0) await yieldToEventLoop()
    }
    return out
  }

  /**
   * Same as {@link parseIdentities} but consults a contact override map keyed by subject
   * identity key. Used by `resolveByAttributes` when contacts are loaded. The override expresses
   * local authority and must not be presented as newly verified third-party certificate evidence.
   */
  static async parseIdentitiesWithOverrides(
    certs: IdentityCertificate[],
    contactByKey: Map<PubKeyHex, Contact>
  ): Promise<DisplayableIdentity[]> {
    if (!Array.isArray(certs) || certs.length > MAX_IDENTITY_RESULTS) {
      throw new Error(
        `Invalid identity result: expected at most ${MAX_IDENTITY_RESULTS} certificates`
      )
    }
    const n = certs.length
    if (n <= PARSE_BATCH_SIZE) {
      return certs.map(cert => contactByKey.get(cert.subject) ?? IdentityClient.parseIdentity(cert))
    }
    const out: DisplayableIdentity[] = Array.from({ length: n })
    for (let i = 0; i < n; i++) {
      const cert = certs[i]
      out[i] = contactByKey.get(cert.subject) ?? IdentityClient.parseIdentity(cert)
      if ((i + 1) % PARSE_BATCH_SIZE === 0) await yieldToEventLoop()
    }
    return out
  }

  /**
   * Parse out identity and certifier attributes to display from an IdentityCertificate
   * @param identityToParse - The Identity Certificate to parse
   * @returns - IdentityToDisplay
   */
  static parseIdentity(identityToParse: IdentityCertificate): DisplayableIdentity {
    const identity = identityRecord(identityToParse, 'certificate')
    const type = identityString(identityData(identity, 'type'), 'type', '', 256)
    const subject = identityString(identityData(identity, 'subject'), 'subject', '', 256)
    const decryptedFields = identityRecord(
      identityData(identity, 'decryptedFields'),
      'decryptedFields'
    )
    if (Reflect.ownKeys(decryptedFields).length > 100) {
      throw new Error('Invalid display identity: decryptedFields has too many fields')
    }
    const certifierInfo = identityRecord(
      identityData(identity, 'certifierInfo'),
      'certifierInfo',
      true
    )
    const certifierName = identityString(
      identityData(certifierInfo, 'name'),
      'certifierInfo.name',
      '',
      500
    )
    const certifierIcon = identityResource(
      identityData(certifierInfo, 'iconUrl'),
      'certifierInfo.iconUrl',
      defaultIdentity.badgeIconURL
    )
    const field = (name: string): string =>
      identityString(identityData(decryptedFields, name), `decryptedFields.${name}`)
    let name, avatarURL, badgeLabel, badgeIconURL, badgeClickURL

    // Parse out the name to display based on the specific certificate type which has clearly defined fields.
    switch (type) {
      case KNOWN_IDENTITY_TYPES.xCert:
        name = field('userName')
        avatarURL = field('profilePhoto')
        badgeLabel =
          certifierName === ''
            ? defaultIdentity.badgeLabel
            : `X account certified by ${certifierName}`
        badgeIconURL = certifierIcon
        badgeClickURL = 'https://socialcert.net' // (no dedicated page yet)
        break
      case KNOWN_IDENTITY_TYPES.discordCert:
        name = field('userName')
        avatarURL = field('profilePhoto')
        badgeLabel =
          certifierName === ''
            ? defaultIdentity.badgeLabel
            : `Discord account certified by ${certifierName}`
        badgeIconURL = certifierIcon
        badgeClickURL = 'https://socialcert.net' // (no dedicated page yet)
        break
      case KNOWN_IDENTITY_TYPES.emailCert:
        name = field('email')
        avatarURL = 'XUTZxep7BBghAJbSBwTjNfmcsDdRFs5EaGEgkESGSgjJVYgMEizu'
        badgeLabel =
          certifierName === '' ? defaultIdentity.badgeLabel : `Email certified by ${certifierName}`
        badgeIconURL = certifierIcon
        badgeClickURL = 'https://socialcert.net' // (no dedicated page yet)
        break
      case KNOWN_IDENTITY_TYPES.phoneCert:
        name = field('phoneNumber')
        avatarURL = 'XUTLxtX3ELNUwRhLwL7kWNGbdnFM8WG2eSLv84J7654oH8HaJWrU'
        badgeLabel =
          certifierName === '' ? defaultIdentity.badgeLabel : `Phone certified by ${certifierName}`
        badgeIconURL = certifierIcon
        badgeClickURL = 'https://socialcert.net' // (no dedicated page yet)
        break
      case KNOWN_IDENTITY_TYPES.identiCert:
        name = `${field('firstName')} ${field('lastName')}`.trim()
        avatarURL = field('profilePhoto')
        badgeLabel =
          certifierName === ''
            ? defaultIdentity.badgeLabel
            : `Government ID certified by ${certifierName}`
        badgeIconURL = certifierIcon
        badgeClickURL = 'https://identicert.me' // (no dedicated page yet)
        break
      case KNOWN_IDENTITY_TYPES.registrant:
        name = field('name')
        avatarURL = field('icon')
        badgeLabel =
          certifierName === '' ? defaultIdentity.badgeLabel : `Entity certified by ${certifierName}`
        badgeIconURL = certifierIcon
        badgeClickURL = 'https://bsv-blockchain.github.io/ts-sdk/reference/identity/' // (no dedicated page yet)
        break
      case KNOWN_IDENTITY_TYPES.coolCert:
        name = field('cool') === 'true' ? 'Cool Person!' : 'Not cool!'
        break
      case KNOWN_IDENTITY_TYPES.anyone:
        name = 'Anyone'
        avatarURL = 'XUT4bpQ6cpBaXi1oMzZsXfpkWGbtp2JTUYAoN7PzhStFJ6wLfoeR'
        badgeLabel = 'Represents the ability for anyone to access this information.'
        badgeIconURL = 'XUUV39HVPkpmMzYNTx7rpKzJvXfeiVyQWg2vfSpjBAuhunTCA9uG'
        badgeClickURL = 'https://bsv-blockchain.github.io/ts-sdk/reference/identity/' // (no dedicated page yet)
        break
      case KNOWN_IDENTITY_TYPES.self:
        name = 'You'
        avatarURL = 'XUT9jHGk2qace148jeCX5rDsMftkSGYKmigLwU2PLLBc7Hm63VYR'
        badgeLabel = 'Represents your ability to access this information.'
        badgeIconURL = 'XUUV39HVPkpmMzYNTx7rpKzJvXfeiVyQWg2vfSpjBAuhunTCA9uG'
        badgeClickURL = 'https://bsv-blockchain.github.io/ts-sdk/reference/identity/' // (no dedicated page yet)
        break
      default: {
        const parsed = IdentityClient.#tryToParseGenericIdentity(
          type,
          decryptedFields,
          certifierInfo
        )
        name = parsed.name
        avatarURL = parsed.avatarURL
        badgeLabel = parsed.badgeLabel
        badgeIconURL = parsed.badgeIconURL
        badgeClickURL = parsed.badgeClickURL
        break
      }
    }

    return {
      name: identityString(name, 'name', defaultIdentity.name),
      avatarURL: identityResource(avatarURL, 'avatarURL', defaultIdentity.avatarURL),
      abbreviatedKey: subject.length > 0 ? `${subject.substring(0, 10)}...` : '',
      identityKey: subject,
      badgeIconURL: identityResource(badgeIconURL, 'badgeIconURL', defaultIdentity.badgeIconURL),
      badgeLabel: identityString(badgeLabel, 'badgeLabel', defaultIdentity.badgeLabel),
      badgeClickURL: identityResource(badgeClickURL, 'badgeClickURL', defaultIdentity.badgeClickURL)
    }
  }

  /**
   * Helper to check if a value is a non-empty string
   */
  static #hasValue(value: unknown): value is string {
    return typeof value === 'string' && value !== ''
  }

  static #genericIdentityName(decryptedFields: Record<string, unknown>): string {
    const get = (field: string): string =>
      identityString(identityData(decryptedFields, field), `decryptedFields.${field}`)
    const fullName = [get('firstName'), get('lastName')].filter(IdentityClient.#hasValue).join(' ')
    return (
      [get('name'), get('userName'), fullName, get('email')].find(IdentityClient.#hasValue) ??
      defaultIdentity.name
    )
  }

  static #genericIdentityAvatar(decryptedFields: Record<string, unknown>): string {
    const get = (field: string): string =>
      identityString(identityData(decryptedFields, field), `decryptedFields.${field}`)
    return (
      [get('profilePhoto'), get('avatar'), get('icon'), get('photo')].find(
        IdentityClient.#hasValue
      ) ?? defaultIdentity.avatarURL
    )
  }

  /**
   * Try to parse identity information from unknown certificate types
   * by checking common field names
   */
  static #tryToParseGenericIdentity(
    type: string,
    decryptedFields: Record<string, unknown>,
    certifierInfo: Record<string, unknown>
  ): {
    name: string
    avatarURL: string
    badgeLabel: string
    badgeIconURL: string
    badgeClickURL: string
  } {
    const name = IdentityClient.#genericIdentityName(decryptedFields)
    const avatarURL = IdentityClient.#genericIdentityAvatar(decryptedFields)

    // Generate badge information
    const certifierName = identityString(identityData(certifierInfo, 'name'), 'certifierInfo.name')
    const badgeLabel = IdentityClient.#hasValue(certifierName)
      ? `${type} certified by ${certifierName}`
      : defaultIdentity.badgeLabel

    const badgeIconURL = identityResource(
      identityData(certifierInfo, 'iconUrl'),
      'certifierInfo.iconUrl',
      defaultIdentity.badgeIconURL
    )
    const badgeClickURL = defaultIdentity.badgeClickURL

    return { name, avatarURL, badgeLabel, badgeIconURL, badgeClickURL }
  }
}
