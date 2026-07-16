import { DEFAULT_IDENTITY_CLIENT_OPTIONS, defaultIdentity, DisplayableIdentity, KNOWN_IDENTITY_TYPES } from './types/index.js'
import {
  Base64String,
  CertificateFieldNameUnder50Bytes,
  DiscoverByAttributesArgs,
  DiscoverByIdentityKeyArgs,
  IdentityCertificate,
  OriginatorDomainNameStringUnder250Bytes,
  PubKeyHex,
  WalletCertificate,
  WalletClient,
  WalletInterface
} from '../wallet/index.js'
import { BroadcastFailure, BroadcastResponse, Transaction } from '../transaction/index.js'
import Certificate from '../auth/certificates/Certificate.js'
import { PushDrop } from '../script/index.js'
import { PrivateKey, Utils } from '../primitives/index.js'
import { LookupResolver, SHIPBroadcaster, TopicBroadcaster, withDoubleSpendRetry } from '../overlay-tools/index.js'
import { ContactsManager, Contact } from './ContactsManager.js'

/**
 * Maximum number of identity certificates to parse synchronously before yielding to the
 * event loop. Keeps the main thread responsive when an overlay query returns many results
 * (e.g. a bulk enrichment of N identityKeys).
 */
const PARSE_BATCH_SIZE = 32

/**
 * Yield control to the event loop so queued microtasks / timers can run. Uses
 * `scheduler.yield()` when available (Chromium) or a 0ms macrotask fallback.
 */
async function yieldToEventLoop (): Promise<void> {
  const sched = (globalThis as any).scheduler
  if (sched != null && typeof sched.yield === 'function') {
    return sched.yield()
  }
  return await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

/** Options for {@link IdentityClient.resolveByIdentityKey}. */
export interface ResolveByIdentityKeyOptions {
  /**
   * Opt-in to consulting personal contacts before/alongside the overlay. Default `false`.
   *
   * Most callers (including any client without a populated contacts basket) pay no benefit
   * from the contacts path and incur its setup cost. Set `true` only in UI contexts where
   * the user has likely saved contacts and a local cache hit is preferable to a fresh overlay
   * answer.
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
export interface ResolveByAttributesOptions {
  /**
   * Opt-in to consulting personal contacts before/alongside the overlay. Default `false`.
   * See {@link ResolveByIdentityKeyOptions.useContacts}.
   */
  useContacts?: boolean
  /** Legacy alias for {@link useContacts}. Takes precedence when provided. */
  overrideWithContacts?: boolean
  /**
   * When `true` (and {@link useContacts} is also true), fire contacts and overlay in parallel.
   */
  parallel?: boolean
}

/** Normalize either legacy boolean / new options object into a canonical { useContacts, parallel }. */
function normalizeOpts (
  raw: boolean | ResolveByIdentityKeyOptions | ResolveByAttributesOptions | undefined
): { useContacts: boolean, parallel: boolean } {
  if (raw === undefined) return { useContacts: false, parallel: false }
  if (typeof raw === 'boolean') return { useContacts: raw, parallel: false }
  const useContacts = raw.overrideWithContacts ?? raw.useContacts ?? false
  return { useContacts, parallel: raw.parallel === true }
}

/**
 * IdentityClient lets you discover who others are, and let the world know who you are.
 */
export class IdentityClient {
  private readonly wallet: WalletInterface
  private readonly contactsManager: ContactsManager
  constructor (
    wallet?: WalletInterface,
    private readonly options = DEFAULT_IDENTITY_CLIENT_OPTIONS,
    private readonly originator?: OriginatorDomainNameStringUnder250Bytes
  ) {
    this.originator = originator
    this.wallet = wallet ?? new WalletClient()
    this.contactsManager = new ContactsManager(this.wallet, this.originator)
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
  async publiclyRevealAttributes (
    certificate: WalletCertificate,
    fieldsToReveal: CertificateFieldNameUnder50Bytes[]
  ): Promise<BroadcastResponse | BroadcastFailure> {
    if (Object.keys(certificate.fields).length === 0) {
      throw new Error(
        'Public reveal failed: Certificate has no fields to reveal!'
      )
    }
    if (fieldsToReveal.length === 0) {
      throw new Error(
        'Public reveal failed: You must reveal at least one field!'
      )
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
      await masterCert.verify()
    } catch (_certVerificationError) {
      // Low-level cert error details are suppressed — surface a user-facing message only
      throw new Error('Public reveal failed: Certificate verification failed!')
    }

    // Given we already have a master certificate from a certifier,
    // create an anyone verifiable certificate with selectively revealed fields
    const { keyringForVerifier } = await this.wallet.proveCertificate(
      {
        certificate,
        fieldsToReveal,
        verifier: new PrivateKey(1).toPublicKey().toString()
      },
      this.originator
    )

    // Build the lockingScript with pushdrop.create() and the transaction with createAction()
    const lockingScript = await new PushDrop(this.wallet, this.originator).lock(
      [
        Utils.toArray(
          JSON.stringify({ ...certificate, keyring: keyringForVerifier })
        )
      ],
      this.options.protocolID,
      this.options.keyID,
      'anyone',
      true,
      true
    )
    // Consider verification and if this is necessary
    // counterpartyCanVerifyMyOwnership: true

    const { tx } = await this.wallet.createAction(
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
      this.originator
    )

    if (tx !== undefined) {
      // Submit the transaction to an overlay
      const broadcaster = new TopicBroadcaster(['tm_identity'], {
        networkPreset: (await this.wallet.getNetwork({})).network
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
   *  - Default short-circuits: if a contact matches, the overlay is skipped entirely.
   *  - `{ parallel: true }` fires contacts and overlay in parallel; contact wins on hit.
   *
   * @param args - Arguments for requesting the discovery based on the identity key.
   * @param opts - Boolean (legacy) or options object. Boolean `true` ≡ `{ useContacts: true }`.
   */
  async resolveByIdentityKey (
    args: DiscoverByIdentityKeyArgs,
    opts: boolean | ResolveByIdentityKeyOptions = false
  ): Promise<DisplayableIdentity[]> {
    const { useContacts, parallel } = normalizeOpts(opts)

    // Fast path: skip contacts entirely. Default — straight overlay query,
    // no listOutputs / decrypt / cache churn.
    if (!useContacts) {
      const certificatesResult = await this.wallet.discoverByIdentityKey(args, this.originator)
      const certs = certificatesResult?.certificates ?? []
      return await IdentityClient.parseIdentities(certs)
    }

    if (!parallel) {
      const contacts = await this.contactsManager.getContacts(args.identityKey)
      if (contacts.length > 0) return contacts

      const certificatesResult = await this.wallet.discoverByIdentityKey(args, this.originator)
      const certs = certificatesResult?.certificates ?? []
      return await IdentityClient.parseIdentities(certs)
    }

    const [contacts, certificatesResult] = await Promise.all([
      this.contactsManager.getContacts(args.identityKey),
      this.wallet.discoverByIdentityKey(args, this.originator)
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
   *
   * @param args - Attributes and optional parameters used to discover certificates.
   * @param opts - Boolean (legacy) or options object. Boolean `true` ≡ `{ useContacts: true }`.
   */
  async resolveByAttributes (
    args: DiscoverByAttributesArgs,
    opts: boolean | ResolveByAttributesOptions = false
  ): Promise<DisplayableIdentity[]> {
    const { useContacts, parallel } = normalizeOpts(opts)

    // Fast path: skip contacts entirely.
    if (!useContacts) {
      const certificatesResult = await this.wallet.discoverByAttributes(args, this.originator)
      const certs = certificatesResult?.certificates ?? []
      return await IdentityClient.parseIdentities(certs)
    }

    if (!parallel) {
      const contacts = await this.contactsManager.getContacts()
      const matches = this.matchContactsByAttributes(contacts, args)
      if (matches.length > 0) return matches

      const certificatesResult = await this.wallet.discoverByAttributes(args, this.originator)
      const certs = certificatesResult?.certificates ?? []
      if (contacts.length === 0) return await IdentityClient.parseIdentities(certs)
      const contactByKey = new Map<PubKeyHex, Contact>(
        contacts.map((contact) => [contact.identityKey, contact] as const)
      )
      return await IdentityClient.parseIdentitiesWithOverrides(certs, contactByKey)
    }

    const [contacts, certificatesResult] = await Promise.all([
      this.contactsManager.getContacts(),
      this.wallet.discoverByAttributes(args, this.originator)
    ])

    const certs = certificatesResult?.certificates ?? []
    if (contacts.length === 0) return await IdentityClient.parseIdentities(certs)
    const contactByKey = new Map<PubKeyHex, Contact>(
      contacts.map((contact) => [contact.identityKey, contact] as const)
    )
    return await IdentityClient.parseIdentitiesWithOverrides(certs, contactByKey)
  }

  /**
   * Best-effort match of contacts against a `DiscoverByAttributesArgs.attributes` shape.
   * Used by the contacts-first path of {@link resolveByAttributes} to decide whether the overlay
   * can be skipped. Compares string-valued attributes against same-named fields on the contact's
   * decrypted record. Returns the subset of contacts that match every supplied attribute.
   */
  private matchContactsByAttributes (
    contacts: Contact[],
    args: DiscoverByAttributesArgs
  ): Contact[] {
    const attrs = (args).attributes
    if (attrs == null || typeof attrs !== 'object' || Array.isArray(attrs)) return []
    const entries = Object.entries(attrs as Record<string, unknown>).filter(
      ([, v]) => typeof v === 'string' && v.length > 0
    ) as Array<[string, string]>
    if (entries.length === 0) return []
    return contacts.filter((contact) => {
      const bag: Record<string, unknown> = {
        name: contact.name,
        identityKey: contact.identityKey
      }
      return entries.every(([k, v]) => {
        const candidate = bag[k]
        return typeof candidate === 'string' && candidate.toLowerCase() === v.toLowerCase()
      })
    })
  }

  /**
   * Remove public certificate revelation from overlay services by spending the identity token
   * @param serialNumber - Unique serial number of the certificate to revoke revelation
   */
  async revokeCertificateRevelation (
    serialNumber: Base64String
  ): Promise<void> {
    // 1. Find existing UTXO
    const lookupResolver = new LookupResolver({
      networkPreset: (await this.wallet.getNetwork({})).network
    })
    const result = await lookupResolver.query({
      service: 'ls_identity',
      query: {
        serialNumber
      }
    })

    if (result.type !== 'output-list') { throw new Error('Failed to get lookup result') }

    const topicBroadcaster = new SHIPBroadcaster(['tm_identity'], {
      networkPreset: (await this.wallet.getNetwork({})).network,
      requireAcknowledgmentFromAllHostsForTopics: [],
      requireAcknowledgmentFromAnyHostForTopics: [],
      requireAcknowledgmentFromSpecificHostsForTopics: { tm_identity: [] }
    })

    await withDoubleSpendRetry(async () => {
      const tx = Transaction.fromBEEF(result.outputs[0].beef)
      const outpoint = `${tx.id('hex')}.${this.options.outputIndex}`
      const lockingScript = tx.outputs[this.options.outputIndex].lockingScript

      if (lockingScript === undefined || outpoint === undefined) {
        throw new Error('Failed to get locking script for revelation output!')
      }

      // 2. Parse results
      const { signableTransaction } = await this.wallet.createAction(
        {
          description: 'Spend certificate revelation token',
          inputBEEF: result.outputs[0].beef,
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
        this.originator
      )

      if (signableTransaction === undefined) {
        throw new Error('Failed to create signable transaction')
      }

      const partialTx = Transaction.fromBEEF(signableTransaction.tx)

      const unlocker = new PushDrop(this.wallet, this.originator).unlock(
        this.options.protocolID,
        this.options.keyID,
        'anyone'
      )

      const unlockingScript = await unlocker.sign(
        partialTx,
        this.options.outputIndex
      )

      const { tx: signedTx } = await this.wallet.signAction(
        {
          reference: signableTransaction.reference,
          spends: {
            [this.options.outputIndex]: {
              unlockingScript: unlockingScript.toHex()
            }
          },
          options: {
            acceptDelayedBroadcast: false,
            noSend: true
          }
        },
        this.originator
      )

      if (signedTx === undefined) {
        throw new Error('Failed to sign transaction')
      }

      await topicBroadcaster.broadcast(Transaction.fromAtomicBEEF(signedTx))
    }, topicBroadcaster)
  }

  /**
   * Load all records from the contacts basket
   * @param identityKey Optional specific identity key to fetch
   * @param forceRefresh Whether to force a check for new contact data
   * @param limit Optional limit on number of contacts to fetch
   * @returns A promise that resolves with an array of contacts
   */
  public async getContacts (
    identityKey?: PubKeyHex,
    forceRefresh = false,
    limit = 1000
  ): Promise<Contact[]> {
    return await this.contactsManager.getContacts(
      identityKey,
      forceRefresh,
      limit
    )
  }

  /**
   * Save or update a Metanet contact
   * @param contact The displayable identity information for the contact
   * @param metadata Optional metadata to store with the contact (ex. notes, aliases, etc)
   */
  public async saveContact (
    contact: DisplayableIdentity,
    metadata?: Record<string, any>
  ): Promise<void> {
    return await this.contactsManager.saveContact(contact, metadata)
  }

  /**
   * Remove a contact from the contacts basket
   * @param identityKey The identity key of the contact to remove
   */
  public async removeContact (identityKey: PubKeyHex): Promise<void> {
    return await this.contactsManager.removeContact(identityKey)
  }

  /**
   * Parse an array of certificates into DisplayableIdentity records, yielding to the
   * event loop every {@link PARSE_BATCH_SIZE} entries so large result sets don't hog
   * the main thread. Equivalent to `certs.map(parseIdentity)` for small inputs.
   */
  static async parseIdentities (certs: IdentityCertificate[]): Promise<DisplayableIdentity[]> {
    const n = certs.length
    if (n <= PARSE_BATCH_SIZE) {
      return certs.map((c) => IdentityClient.parseIdentity(c))
    }
    const out: DisplayableIdentity[] = new Array(n)
    for (let i = 0; i < n; i++) {
      out[i] = IdentityClient.parseIdentity(certs[i])
      if ((i + 1) % PARSE_BATCH_SIZE === 0) await yieldToEventLoop()
    }
    return out
  }

  /**
   * Same as {@link parseIdentities} but consults a contact override map keyed by subject
   * identity key. Used by `resolveByAttributes` when contacts are loaded.
   */
  static async parseIdentitiesWithOverrides (
    certs: IdentityCertificate[],
    contactByKey: Map<PubKeyHex, Contact>
  ): Promise<DisplayableIdentity[]> {
    const n = certs.length
    if (n <= PARSE_BATCH_SIZE) {
      return certs.map((cert) => contactByKey.get(cert.subject) ?? IdentityClient.parseIdentity(cert))
    }
    const out: DisplayableIdentity[] = new Array(n)
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
  static parseIdentity (
    identityToParse: IdentityCertificate
  ): DisplayableIdentity {
    const { type, decryptedFields, certifierInfo } = identityToParse
    let name, avatarURL, badgeLabel, badgeIconURL, badgeClickURL

    // Parse out the name to display based on the specific certificate type which has clearly defined fields.
    switch (type) {
      case KNOWN_IDENTITY_TYPES.xCert:
        name = decryptedFields.userName
        avatarURL = decryptedFields.profilePhoto
        badgeLabel = `X account certified by ${certifierInfo.name}`
        badgeIconURL = certifierInfo.iconUrl
        badgeClickURL = 'https://socialcert.net' // (no dedicated page yet)
        break
      case KNOWN_IDENTITY_TYPES.discordCert:
        name = decryptedFields.userName
        avatarURL = decryptedFields.profilePhoto
        badgeLabel = `Discord account certified by ${certifierInfo.name}`
        badgeIconURL = certifierInfo.iconUrl
        badgeClickURL = 'https://socialcert.net' // (no dedicated page yet)
        break
      case KNOWN_IDENTITY_TYPES.emailCert:
        name = decryptedFields.email
        avatarURL = 'XUTZxep7BBghAJbSBwTjNfmcsDdRFs5EaGEgkESGSgjJVYgMEizu'
        badgeLabel = `Email certified by ${certifierInfo.name}`
        badgeIconURL = certifierInfo.iconUrl
        badgeClickURL = 'https://socialcert.net' // (no dedicated page yet)
        break
      case KNOWN_IDENTITY_TYPES.phoneCert:
        name = decryptedFields.phoneNumber
        avatarURL = 'XUTLxtX3ELNUwRhLwL7kWNGbdnFM8WG2eSLv84J7654oH8HaJWrU'
        badgeLabel = `Phone certified by ${certifierInfo.name}`
        badgeIconURL = certifierInfo.iconUrl
        badgeClickURL = 'https://socialcert.net' // (no dedicated page yet)
        break
      case KNOWN_IDENTITY_TYPES.identiCert:
        name = `${decryptedFields.firstName} ${decryptedFields.lastName}`
        avatarURL = decryptedFields.profilePhoto
        badgeLabel = `Government ID certified by ${certifierInfo.name}`
        badgeIconURL = certifierInfo.iconUrl
        badgeClickURL = 'https://identicert.me' // (no dedicated page yet)
        break
      case KNOWN_IDENTITY_TYPES.registrant:
        name = decryptedFields.name
        avatarURL = decryptedFields.icon
        badgeLabel = `Entity certified by ${certifierInfo.name}`
        badgeIconURL = certifierInfo.iconUrl
        badgeClickURL = 'https://bsv-blockchain.github.io/ts-sdk/reference/identity/' // (no dedicated page yet)
        break
      case KNOWN_IDENTITY_TYPES.coolCert:
        name = decryptedFields.cool === 'true' ? 'Cool Person!' : 'Not cool!'
        break
      case KNOWN_IDENTITY_TYPES.anyone:
        name = 'Anyone'
        avatarURL = 'XUT4bpQ6cpBaXi1oMzZsXfpkWGbtp2JTUYAoN7PzhStFJ6wLfoeR'
        badgeLabel =
          'Represents the ability for anyone to access this information.'
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
        const parsed = IdentityClient.tryToParseGenericIdentity(
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
      name,
      avatarURL,
      abbreviatedKey:
        identityToParse.subject.length > 0
          ? `${identityToParse.subject.substring(0, 10)}...`
          : '',
      identityKey: identityToParse.subject,
      badgeIconURL,
      badgeLabel,
      badgeClickURL
    }
  }

  /**
   * Helper to check if a value is a non-empty string
   */
  private static hasValue (value: any): value is string {
    return value !== undefined && value !== null && value !== ''
  }

  /**
   * Try to parse identity information from unknown certificate types
   * by checking common field names
   */
  private static tryToParseGenericIdentity (
    type: string,
    decryptedFields: Record<string, any>,
    certifierInfo: any
  ): {
      name: string
      avatarURL: string
      badgeLabel: string
      badgeIconURL: string
      badgeClickURL: string
    } {
    // Try to construct a name from common field patterns
    const firstName = decryptedFields.firstName
    const lastName = decryptedFields.lastName
    let fullName: string | undefined
    if (IdentityClient.hasValue(firstName) && IdentityClient.hasValue(lastName)) {
      fullName = `${firstName} ${lastName}`
    } else if (IdentityClient.hasValue(firstName)) {
      fullName = firstName
    } else if (IdentityClient.hasValue(lastName)) {
      fullName = lastName
    }

    let name: string | undefined
    if (IdentityClient.hasValue(decryptedFields.name)) {
      name = decryptedFields.name
    } else if (IdentityClient.hasValue(decryptedFields.userName)) {
      name = decryptedFields.userName
    } else if (fullName !== undefined) {
      name = fullName
    } else if (IdentityClient.hasValue(decryptedFields.email)) {
      name = decryptedFields.email
    } else {
      name = defaultIdentity.name
    }

    // Try to find an avatar/photo from common field names
    let avatarURL: string | undefined
    if (IdentityClient.hasValue(decryptedFields.profilePhoto)) {
      avatarURL = decryptedFields.profilePhoto
    } else if (IdentityClient.hasValue(decryptedFields.avatar)) {
      avatarURL = decryptedFields.avatar
    } else if (IdentityClient.hasValue(decryptedFields.icon)) {
      avatarURL = decryptedFields.icon
    } else if (IdentityClient.hasValue(decryptedFields.photo)) {
      avatarURL = decryptedFields.photo
    } else {
      avatarURL = defaultIdentity.avatarURL
    }

    // Generate badge information
    const badgeLabel = IdentityClient.hasValue(certifierInfo?.name)
      ? `${type} certified by ${String(certifierInfo.name)}`
      : defaultIdentity.badgeLabel

    const badgeIconURL = IdentityClient.hasValue(certifierInfo?.iconUrl)
      ? certifierInfo.iconUrl
      : defaultIdentity.badgeIconURL
    const badgeClickURL = defaultIdentity.badgeClickURL

    return { name, avatarURL, badgeLabel, badgeIconURL, badgeClickURL }
  }
}
