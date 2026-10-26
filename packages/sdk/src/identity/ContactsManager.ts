import type {
  PubKeyHex,
  WalletInterface,
  WalletOutput,
  WalletProtocol
} from '../wallet/Wallet.interfaces.js'
import { parseWalletOutpoint, validateBase64String } from '../wallet/validationHelpers.js'
import WalletClient from '../wallet/WalletClient.js'
import { toArray, toBase64, toHex as UtilsToHex, toUTF8Strict } from '../primitives/utils.js'
import Random from '../primitives/Random.js'
import PublicKey from '../primitives/PublicKey.js'
import type { DisplayableIdentity } from './types/index.js'
import LockingScript from '../script/LockingScript.js'
import PushDrop from '../script/templates/PushDrop.js'
import Transaction from '../transaction/Transaction.js'
import { isPlainRecord, isUnsafeRecordKey } from '../primitives/SafeRecord.js'
import { utf8ByteLength } from '../primitives/UTF8.js'
/**
 * A user-maintained local identity assertion. Saving a contact is an explicit
 * personal trust decision, analogous to installing a local trust anchor or
 * accepting a self-signed certificate. Within this wallet, that saved
 * identity-key association is authoritative because the user or application
 * validated it independently of third parties. This authority is local: it is
 * not an independent certifier attestation and must not be exported or shown
 * to another user as if a third party had verified it merely because its shape
 * is {@link DisplayableIdentity}.
 */
export type Contact = DisplayableIdentity & { metadata?: Record<string, any> }

const CONTACT_PROTOCOL_ID: WalletProtocol = [2, 'contact']
const MAX_CONTACTS = 1000
const MAX_CONTACT_PLAINTEXT_BYTES = 64 * 1024
const MAX_CONTACT_CIPHERTEXT_BYTES = MAX_CONTACT_PLAINTEXT_BYTES + 1024
const MAX_CONTACT_BEEF_BYTES = 16 * 1024 * 1024
const DISPLAY_FIELDS = [
  'name',
  'avatarURL',
  'abbreviatedKey',
  'identityKey',
  'badgeIconURL',
  'badgeLabel',
  'badgeClickURL'
] as const

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

function ownData(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  if (descriptor == null || !('value' in descriptor)) {
    throw new Error(`Invalid contact: ${key} must be an own data property`)
  }
  return descriptor.value
}

function utf8Length(value: string): number {
  return utf8ByteLength(value)
}

function containsDisallowedControl(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 9 || (code > 10 && code < 13) || (code > 13 && code < 32) || code === 127) {
      return true
    }
  }
  return false
}

function boundedString(
  value: unknown,
  field: string,
  maximumBytes: number,
  allowEmpty = true
): string {
  if (typeof value !== 'string') throw new Error(`Invalid contact: ${field} must be a string`)
  const length = utf8Length(value)
  if ((!allowEmpty && length === 0) || length > maximumBytes || containsDisallowedControl(value)) {
    throw new Error(`Invalid contact: ${field} is empty, oversized, or contains control characters`)
  }
  return value
}

function validateIdentityKey(value: unknown): PubKeyHex {
  const key = boundedString(value, 'identityKey', 66, false)
  if (!/^(?:02|03)[0-9a-f]{64}$/.test(key)) {
    throw new Error('Invalid contact: identityKey must be a canonical compressed public key')
  }
  try {
    if (PublicKey.fromString(key).toString() !== key) throw new Error('non-canonical key')
  } catch {
    throw new Error('Invalid contact: identityKey must be a canonical compressed public key')
  }
  return key
}

function safeResource(value: unknown, field: string): string {
  const resource = boundedString(value, field, 2048)
  if (/^(?:javascript|data|vbscript|file|blob):/i.test(resource.trim())) {
    throw new Error(`Invalid contact: ${field} uses an unsafe URL scheme`)
  }
  return resource
}

function safeNavigation(value: unknown): string {
  const navigation = boundedString(value, 'badgeClickURL', 2048)
  if (navigation === '') return navigation
  let parsed: URL
  try {
    parsed = new URL(navigation)
  } catch {
    throw new Error('Invalid contact: badgeClickURL must be an absolute HTTPS URL')
  }
  const localHttp =
    parsed.protocol === 'http:' &&
    (parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '::1' ||
      parsed.hostname === '[::1]')
  if (
    (parsed.protocol !== 'https:' && !localHttp) ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    throw new Error('Invalid contact: badgeClickURL must be a credential-free HTTPS URL')
  }
  return parsed.toString()
}

function sanitizeJsonValue(value: unknown, depth: number, state: { nodes: number }): JsonValue {
  if (depth > 10 || ++state.nodes > 2000)
    throw new Error('Invalid contact metadata: structure is too complex')
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Invalid contact metadata: numbers must be finite')
    return value
  }
  if (Array.isArray(value)) {
    if (value.length > 1000) throw new Error('Invalid contact metadata: arrays are too large')
    const sanitized: JsonValue[] = []
    for (let index = 0; index < value.length; index++) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) {
        throw new Error('Invalid contact metadata: arrays must be dense')
      }
      sanitized.push(sanitizeJsonValue(value[index], depth + 1, state))
    }
    return sanitized
  }
  if (!isPlainRecord(value)) throw new Error('Invalid contact metadata: values must be JSON data')
  const result: { [key: string]: JsonValue } = {}
  const keys = Reflect.ownKeys(value)
  if (keys.length > 200) throw new Error('Invalid contact metadata: objects have too many fields')
  for (const key of keys) {
    if (typeof key !== 'string' || isUnsafeRecordKey(key) || utf8Length(key) > 200) {
      throw new Error('Invalid contact metadata: unsafe or oversized field name')
    }
    result[key] = sanitizeJsonValue(ownData(value, key), depth + 1, state)
  }
  return result
}

function sanitizeMetadata(value: unknown): Record<string, JsonValue> | undefined {
  if (value === undefined) return undefined
  if (!isPlainRecord(value)) throw new Error('Invalid contact metadata: an object is required')
  const sanitized = sanitizeJsonValue(value, 0, { nodes: 0 }) as Record<string, JsonValue>
  if (utf8Length(JSON.stringify(sanitized)) > MAX_CONTACT_PLAINTEXT_BYTES / 2) {
    throw new Error('Invalid contact metadata: encoded value is too large')
  }
  return sanitized
}

function validateContact(value: unknown, metadataOverride?: unknown): Contact {
  if (!isPlainRecord(value)) throw new Error('Invalid contact: an object is required')
  const allowed = new Set<string>([...DISPLAY_FIELDS, 'metadata'])
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key) || isUnsafeRecordKey(key)) {
      throw new Error(`Invalid contact: unexpected field ${String(key)}`)
    }
    ownData(value, key)
  }
  for (const field of DISPLAY_FIELDS) ownData(value, field)

  const validated: Contact = {
    name: boundedString(ownData(value, 'name'), 'name', 500, false),
    avatarURL: safeResource(ownData(value, 'avatarURL'), 'avatarURL'),
    abbreviatedKey: boundedString(ownData(value, 'abbreviatedKey'), 'abbreviatedKey', 256),
    identityKey: validateIdentityKey(ownData(value, 'identityKey')),
    badgeIconURL: safeResource(ownData(value, 'badgeIconURL'), 'badgeIconURL'),
    badgeLabel: boundedString(ownData(value, 'badgeLabel'), 'badgeLabel', 1000),
    badgeClickURL: safeNavigation(ownData(value, 'badgeClickURL'))
  }
  const metadata = sanitizeMetadata(
    metadataOverride === undefined && Object.prototype.hasOwnProperty.call(value, 'metadata')
      ? ownData(value, 'metadata')
      : metadataOverride
  )
  if (metadata !== undefined) validated.metadata = metadata
  return validated
}

function bytes(value: unknown, field: string, minimum: number, maximum: number): number[] {
  const array = value instanceof Uint8Array ? Array.from(value) : value
  if (!Array.isArray(array) || array.length < minimum || array.length > maximum) {
    throw new Error(`${field} must contain ${minimum}-${maximum} bytes`)
  }
  for (let index = 0; index < array.length; index++) {
    if (
      !Object.prototype.hasOwnProperty.call(array, index) ||
      !Number.isInteger(array[index]) ||
      array[index] < 0 ||
      array[index] > 255
    ) {
      throw new Error(`${field} must be a dense byte array`)
    }
  }
  return Array.from(array)
}

function pushOpcode(value: number[]): number {
  if (value.length <= 75) return value.length
  if (value.length <= 0xff) return 0x4c
  if (value.length <= 0xffff) return 0x4d
  return 0x4e
}

function assertCanonicalSignedPushDrop(
  lockingScript: LockingScript,
  ciphertext: number[],
  signature: number[]
): void {
  const chunks = lockingScript.chunks
  if (
    chunks.length !== 5 ||
    chunks[0].op !== 33 ||
    chunks[0].data?.length !== 33 ||
    chunks[1].op !== 0xac ||
    chunks[2].op !== pushOpcode(ciphertext) ||
    chunks[3].op !== pushOpcode(signature) ||
    chunks[4].op !== 0x6d
  ) {
    throw new Error('Contact output must use the canonical signed PushDrop script')
  }
}

// In-memory cache for cross-platform compatibility
class MemoryCache {
  readonly #cache = new Map<string, string>()

  getItem(key: string): string | null {
    return this.#cache.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.#cache.set(key, value)
  }

  removeItem(key: string): void {
    this.#cache.delete(key)
  }

  clear(): void {
    this.#cache.clear()
  }
}

/**
 * Manages the wallet user's local identity trust anchors.
 *
 * Authenticating the encrypted contact output proves that this wallet stored
 * the record; the act of saving it is what records the user's independent
 * validation of the identity-key association. Reads therefore return the
 * saved record as locally authoritative rather than re-adjudicating it against
 * an overlay. Network-imported data must never be placed in this basket until
 * the user or application has validated and deliberately accepted it.
 */
export class ContactsManager {
  readonly #wallet: WalletInterface
  readonly #cache = new MemoryCache()
  readonly #CONTACTS_CACHE_KEY = 'metanet-contacts'
  readonly #originator?: string

  // Performance state — prevents thundering herd of concurrent contact loads and
  // short-circuits the overlay path entirely when we've previously observed an
  // empty contacts basket. Both are invalidated by saveContact/removeContact and
  // by an explicit forceRefresh.
  #inFlightLoad: Promise<Contact[]> | null = null
  #knownEmpty = false

  constructor(wallet?: WalletInterface, originator?: string) {
    this.#wallet = wallet ?? new WalletClient()
    this.#originator = originator
  }

  /**
   * Load all records from the contacts basket.
   *
   * Returned records are authoritative local assertions selected and stored by
   * this wallet's user. The authority covers the saved identity-key association
   * and its local labels/metadata within this wallet. Callers must not
   * reinterpret it as fresh overlay evidence, a third-party certificate, or a
   * trust decision made for another user.
   *
   * Concurrent calls share a single in-flight load (no thundering herd). After
   * the basket has been observed empty once, subsequent calls return `[]`
   * synchronously without hitting the wallet — until `forceRefresh` is passed
   * or a contact is saved/removed.
   *
   * @param identityKey Optional specific identity key to fetch
   * @param forceRefresh Whether to force a check for new contact data
   * @param limit Maximum number of contacts to return
   */
  async getContacts(
    identityKey?: PubKeyHex,
    forceRefresh = false,
    limit = MAX_CONTACTS
  ): Promise<Contact[]> {
    const selectedIdentity =
      identityKey === undefined ? undefined : validateIdentityKey(identityKey)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CONTACTS) {
      throw new Error(`Invalid contact limit: expected an integer from 1 to ${MAX_CONTACTS}`)
    }
    if (forceRefresh) this.#invalidate()

    if (this.#knownEmpty) return []

    if (!forceRefresh) {
      const fromCache = this.#loadCachedContacts(selectedIdentity)
      if (fromCache !== null)
        return fromCache.slice(0, limit).map(contact => validateContact(contact))
    }

    // Coalesce concurrent loads onto a single Promise so a fan-out of N
    // identity calls produces ONE listOutputs + decrypt batch, not N.
    this.#inFlightLoad ??= this.#loadContactsFromWallet().finally(() => {
      this.#inFlightLoad = null
    })
    const all = await this.#inFlightLoad
    const selected =
      selectedIdentity == null ? all : all.filter(c => c.identityKey === selectedIdentity)
    return selected.slice(0, limit).map(contact => validateContact(contact))
  }

  /** Reset cached state. Call after writes. */
  #invalidate(): void {
    this.#cache.removeItem(this.#CONTACTS_CACHE_KEY)
    this.#knownEmpty = false
    this.#inFlightLoad = null
  }

  /** Underlying wallet load — invoked at most once concurrently via `inFlightLoad`. */
  async #loadContactsFromWallet(): Promise<Contact[]> {
    // Always load the full basket so subsequent filters (by identityKey) hit cache.
    // Tag filtering is reserved for explicit per-key write paths.
    const outputs = await this.#wallet.listOutputs(
      {
        basket: 'contacts',
        include: 'locking scripts',
        includeCustomInstructions: true,
        tags: [],
        limit: MAX_CONTACTS
      },
      this.#originator
    )

    if (!Array.isArray(outputs.outputs) || outputs.outputs.length > MAX_CONTACTS) {
      throw new Error(
        `Invalid contacts result: outputs must be an array of at most ${MAX_CONTACTS} entries`
      )
    }
    if (outputs.outputs.length === 0) {
      this.#cache.setItem(this.#CONTACTS_CACHE_KEY, JSON.stringify([]))
      this.#knownEmpty = true
      return []
    }

    const contacts = await this.#decryptContactOutputs(outputs.outputs)
    this.#cache.setItem(this.#CONTACTS_CACHE_KEY, JSON.stringify(contacts))
    return contacts
  }

  /** Returns cached contacts (optionally filtered) or null if cache is missing/invalid. */
  #loadCachedContacts(identityKey?: PubKeyHex): Contact[] | null {
    const cached = this.#cache.getItem(this.#CONTACTS_CACHE_KEY)
    if (cached == null || cached === '') return null
    try {
      const parsed: unknown = JSON.parse(cached)
      if (!Array.isArray(parsed) || parsed.length > MAX_CONTACTS)
        throw new Error('Invalid cached contacts array')
      const cachedContacts = parsed.map(entry => validateContact(entry))
      return identityKey != null
        ? cachedContacts.filter(c => c.identityKey === identityKey)
        : cachedContacts
    } catch (e) {
      console.warn('Invalid cached contacts JSON; will reload from chain', e)
      return null
    }
  }

  /** Builds the HMAC-based identity-key tag array; empty array if no identity key is given. */
  async #buildIdentityKeyTags(identityKey?: PubKeyHex): Promise<string[]> {
    if (identityKey == null) return []
    identityKey = validateIdentityKey(identityKey)
    const { hmac: hashedIdentityKey } = await this.#wallet.createHmac(
      {
        protocolID: CONTACT_PROTOCOL_ID,
        keyID: identityKey,
        counterparty: 'self',
        data: toArray(identityKey, 'utf8')
      },
      this.#originator
    )
    return [`identityKey ${UtilsToHex(bytes(hashedIdentityKey, 'contact identity HMAC', 32, 32))}`]
  }

  #readKeyID(customInstructions: unknown): string {
    if (typeof customInstructions !== 'string' || utf8Length(customInstructions) > 256) {
      throw new Error('Invalid contact custom instructions')
    }
    const parsed: unknown = JSON.parse(customInstructions)
    if (
      !isPlainRecord(parsed) ||
      Reflect.ownKeys(parsed).length !== 1 ||
      !Object.prototype.hasOwnProperty.call(parsed, 'keyID')
    ) {
      throw new Error('Invalid contact custom instructions')
    }
    const keyID = ownData(parsed, 'keyID')
    if (typeof keyID !== 'string') throw new Error('Invalid contact keyID')
    return validateBase64String(keyID, 'contact keyID', 32, 32)
  }

  async #authenticateContactScript(lockingScript: LockingScript, keyID: string): Promise<number[]> {
    const decoded = PushDrop.decode(lockingScript)
    if (decoded.fields.length !== 2) throw new Error('Invalid contact PushDrop field count')
    const ciphertext = bytes(
      decoded.fields[0],
      'contact ciphertext',
      1,
      MAX_CONTACT_CIPHERTEXT_BYTES
    )
    const signature = bytes(decoded.fields[1], 'contact signature', 8, 80)
    assertCanonicalSignedPushDrop(lockingScript, ciphertext, signature)
    const publicKeyResult = await this.#wallet.getPublicKey(
      {
        protocolID: CONTACT_PROTOCOL_ID,
        keyID,
        counterparty: 'self'
      },
      this.#originator
    )
    const expectedKey = validateIdentityKey(publicKeyResult.publicKey)
    if (decoded.lockingPublicKey.toString() !== expectedKey) {
      throw new Error('Contact output is not locked to its declared keyID')
    }
    const signatureResult = await this.#wallet.verifySignature(
      {
        data: ciphertext,
        signature,
        protocolID: CONTACT_PROTOCOL_ID,
        keyID,
        counterparty: 'self'
      },
      this.#originator
    )
    if (signatureResult.valid !== true) throw new Error('Invalid contact field signature')
    return ciphertext
  }

  #parseContactPlaintext(value: unknown): Contact {
    const plaintext = bytes(value, 'contact plaintext', 1, MAX_CONTACT_PLAINTEXT_BYTES)
    const parsed: unknown = JSON.parse(toUTF8Strict(plaintext))
    return validateContact(parsed)
  }

  /** Decodes and decrypts all contact outputs in parallel, returning valid Contact objects. */
  async #decryptContactOutputs(
    rawOutputs: Awaited<ReturnType<WalletInterface['listOutputs']>>['outputs']
  ): Promise<Contact[]> {
    const decryptResults = await Promise.allSettled(
      rawOutputs.slice(0, MAX_CONTACTS).map(async output => {
        if (output.lockingScript == null || output.customInstructions == null) {
          throw new Error('Contact output is missing its locking script or custom instructions')
        }
        if (
          typeof output.lockingScript !== 'string' ||
          output.lockingScript.length > MAX_CONTACT_CIPHERTEXT_BYTES * 2 + 4096
        ) {
          throw new Error('Contact locking script is oversized')
        }
        const keyID = this.#readKeyID(output.customInstructions)
        const ciphertext = await this.#authenticateContactScript(
          LockingScript.fromHex(output.lockingScript),
          keyID
        )
        const decrypted = await this.#wallet.decrypt(
          {
            ciphertext,
            protocolID: CONTACT_PROTOCOL_ID,
            keyID,
            counterparty: 'self'
          },
          this.#originator
        )
        return this.#parseContactPlaintext(decrypted.plaintext)
      })
    )

    const contacts: Contact[] = []
    for (const result of decryptResults) {
      if (result.status === 'fulfilled') {
        contacts.push(result.value)
      } else {
        console.warn('ContactsManager: Failed to decrypt contact output:', result.reason)
      }
    }
    return contacts
  }

  /**
   * Save or update a Metanet contact. This installs or replaces a local trust
   * anchor: the wallet will treat the saved identity-key association as the
   * user's authoritative personal decision. Only save identities independently
   * validated by the user or application; do not auto-import untrusted network
   * discovery results into this method.
   * @param contact The displayable identity information for the contact
   * @param metadata Optional metadata to store with the contact (ex. notes, aliases, etc)
   */
  async saveContact(contact: DisplayableIdentity, metadata?: Record<string, any>): Promise<void> {
    const contactToStore = validateContact(contact, metadata)
    const cached = this.#cache.getItem(this.#CONTACTS_CACHE_KEY)
    const cachedContacts = cached != null && cached !== '' ? this.#loadCachedContacts() : null
    const contacts = cachedContacts ?? (await this.getContacts())
    const existingIndex = contacts.findIndex(c => c.identityKey === contactToStore.identityKey)
    if (existingIndex >= 0) contacts[existingIndex] = contactToStore
    else contacts.push(contactToStore)

    const hashedIdentityKey = await this.#hashIdentityKey(contactToStore.identityKey)
    const outputs = await this.#wallet.listOutputs(
      {
        basket: 'contacts',
        include: 'entire transactions',
        includeCustomInstructions: true,
        tags: [`identityKey ${UtilsToHex(hashedIdentityKey)}`],
        limit: 100
      },
      this.#originator
    )

    const { existingOutput, keyID } = await this.#findExistingOutput(
      outputs,
      contactToStore.identityKey
    )
    const lockingScript = await this.#encryptAndLock(contactToStore, keyID)

    if (existingOutput != null) {
      await this.#updateContactOutput(
        outputs,
        existingOutput,
        lockingScript,
        keyID,
        hashedIdentityKey,
        contactToStore
      )
    } else {
      await this.#createContactOutput(lockingScript, keyID, hashedIdentityKey, contactToStore)
    }
    this.#cache.setItem(this.#CONTACTS_CACHE_KEY, JSON.stringify(contacts))
    this.#knownEmpty = false
    this.#inFlightLoad = null
  }

  /** Computes the HMAC-based hash of an identity key for tag indexing. */
  async #hashIdentityKey(identityKey: string): Promise<number[]> {
    const validatedKey = validateIdentityKey(identityKey)
    const { hmac } = await this.#wallet.createHmac(
      {
        protocolID: CONTACT_PROTOCOL_ID,
        keyID: validatedKey,
        counterparty: 'self',
        data: toArray(validatedKey, 'utf8')
      },
      this.#originator
    )
    return bytes(hmac, 'contact identity HMAC', 32, 32)
  }

  /** Scans existing outputs to find the one matching the given identity key; returns output + keyID. */
  async #findExistingOutput(
    outputs: Awaited<ReturnType<WalletInterface['listOutputs']>>,
    identityKey: string
  ): Promise<{ existingOutput: WalletOutput | null; keyID: string }> {
    if (!Array.isArray(outputs.outputs) || outputs.outputs.length > 100) {
      throw new Error('Invalid contact lookup result')
    }
    const matches: Array<{ output: WalletOutput; keyID: string }> = []
    for (const output of outputs.outputs) {
      try {
        if (output.customInstructions == null) {
          throw new Error('Contact output is missing custom instructions')
        }
        const candidateKeyID = this.#readKeyID(output.customInstructions)
        const { lockingScript } = this.#readListedSource(output, outputs)
        const ciphertext = await this.#authenticateContactScript(lockingScript, candidateKeyID)
        const { plaintext } = await this.#wallet.decrypt(
          {
            ciphertext,
            protocolID: CONTACT_PROTOCOL_ID,
            keyID: candidateKeyID,
            counterparty: 'self'
          },
          this.#originator
        )
        const storedContact = this.#parseContactPlaintext(plaintext)
        if (storedContact.identityKey === identityKey) {
          matches.push({ output, keyID: candidateKeyID })
        }
      } catch (error) {
        throw new Error('Unable to authenticate a contact lookup result', { cause: error })
      }
    }
    if (matches.length > 1) throw new Error('Multiple contact outputs exist for this identity')
    if (matches.length === 1) {
      return { existingOutput: matches[0].output, keyID: matches[0].keyID }
    }
    if (outputs.outputs.length !== 0) {
      throw new Error('Contact lookup returned an output for a different identity')
    }
    return {
      existingOutput: null,
      keyID: validateBase64String(toBase64(Random(32)), 'contact keyID', 32, 32)
    }
  }

  #readListedSource(
    output: WalletOutput,
    outputs: Awaited<ReturnType<WalletInterface['listOutputs']>>
  ): { outpoint: `${string}.${number}`; lockingScript: LockingScript; satoshis: number } {
    const { txid, vout } = parseWalletOutpoint(output.outpoint)
    if (outputs.BEEF == null) throw new Error('Contact output is missing source BEEF')
    bytes(outputs.BEEF, 'contact source BEEF', 1, MAX_CONTACT_BEEF_BYTES)
    const sourceTransaction = Transaction.fromBEEF(outputs.BEEF, txid)
    if (sourceTransaction.id('hex') !== txid)
      throw new Error('Contact source transaction ID mismatch')
    const sourceOutput = sourceTransaction.outputs[vout]
    if (sourceOutput?.lockingScript == null) throw new Error('Contact source output is missing')
    if (!Number.isSafeInteger(sourceOutput.satoshis) || sourceOutput.satoshis! < 0) {
      throw new Error('Contact source output has invalid satoshis')
    }
    if (
      output.lockingScript !== undefined &&
      output.lockingScript !== sourceOutput.lockingScript.toHex()
    ) {
      throw new Error('Contact locking script does not match source BEEF')
    }
    return {
      outpoint: `${txid}.${vout}`,
      lockingScript: sourceOutput.lockingScript,
      satoshis: sourceOutput.satoshis!
    }
  }

  #parseAtomicTransaction(value: unknown, field: string): Transaction {
    const binary = bytes(value, field, 1, MAX_CONTACT_BEEF_BYTES)
    return Transaction.fromAtomicBEEF(binary)
  }

  #inputOutpoint(transaction: Transaction, inputIndex: number): string {
    const input = transaction.inputs[inputIndex]
    if (
      input == null ||
      !Number.isSafeInteger(input.sourceOutputIndex) ||
      input.sourceOutputIndex < 0
    ) {
      throw new Error('Contact transaction input is malformed')
    }
    const embeddedTxid = input.sourceTransaction?.id('hex')
    if (
      input.sourceTXID !== undefined &&
      embeddedTxid !== undefined &&
      input.sourceTXID !== embeddedTxid
    ) {
      throw new Error('Contact transaction input source mismatch')
    }
    const txid = input.sourceTXID ?? embeddedTxid
    if (txid == null || !/^[0-9a-f]{64}$/.test(txid))
      throw new Error('Contact transaction input has no canonical source ID')
    return `${txid}.${input.sourceOutputIndex}`
  }

  #findBoundInput(transaction: Transaction, outpoint: string): number {
    const matches: number[] = []
    for (let index = 0; index < transaction.inputs.length; index++) {
      if (this.#inputOutpoint(transaction, index) === outpoint) matches.push(index)
    }
    if (matches.length !== 1)
      throw new Error('Contact transaction does not spend the exact contact outpoint once')
    return matches[0]
  }

  #assertTransactionTemplate(signable: Transaction, signed: Transaction): void {
    if (
      signable.version !== signed.version ||
      signable.lockTime !== signed.lockTime ||
      signable.inputs.length !== signed.inputs.length ||
      signable.outputs.length !== signed.outputs.length
    ) {
      throw new Error('Signed contact transaction substituted the authorized transaction template')
    }
    for (let index = 0; index < signable.inputs.length; index++) {
      if (
        this.#inputOutpoint(signable, index) !== this.#inputOutpoint(signed, index) ||
        (signable.inputs[index].sequence ?? 0xffffffff) !==
          (signed.inputs[index].sequence ?? 0xffffffff)
      ) {
        throw new Error('Signed contact transaction substituted an authorized input')
      }
    }
    for (let index = 0; index < signable.outputs.length; index++) {
      const expected = signable.outputs[index]
      const actual = signed.outputs[index]
      if (
        expected.satoshis !== actual.satoshis ||
        expected.lockingScript.toHex() !== actual.lockingScript.toHex()
      ) {
        throw new Error('Signed contact transaction substituted an authorized output')
      }
    }
  }

  #requireContactOutput(transaction: Transaction, lockingScript: LockingScript): void {
    const expectedHex = lockingScript.toHex()
    const matches = transaction.outputs.filter(
      output => output.satoshis === 1 && output.lockingScript.toHex() === expectedHex
    )
    if (matches.length !== 1)
      throw new Error('Contact transaction does not contain the exact requested output')
  }

  async #abortPartialAction(reference: string): Promise<void> {
    try {
      await this.#wallet.abortAction({ reference }, this.#originator)
    } catch {
      // Preserve the primary validation/signing error. A hostile or failed wallet
      // may also refuse cleanup, but the reference is never returned to the caller.
    }
  }

  /** Encrypts a contact and produces its PushDrop locking script. */
  async #encryptAndLock(contactData: Contact, keyID: string): Promise<LockingScript> {
    const plaintext = toArray(JSON.stringify(validateContact(contactData)), 'utf8')
    if (plaintext.length > MAX_CONTACT_PLAINTEXT_BYTES)
      throw new Error('Contact plaintext is too large')
    const { ciphertext } = await this.#wallet.encrypt(
      {
        plaintext,
        protocolID: CONTACT_PROTOCOL_ID,
        keyID,
        counterparty: 'self'
      },
      this.#originator
    )
    const validatedCiphertext = bytes(
      ciphertext,
      'contact ciphertext',
      1,
      MAX_CONTACT_CIPHERTEXT_BYTES
    )
    return await new PushDrop(this.#wallet, this.#originator).lock(
      [validatedCiphertext],
      CONTACT_PROTOCOL_ID,
      keyID,
      'self'
    )
  }

  /** Spends an existing contact output and creates a replacement with updated data. */
  async #updateContactOutput(
    outputs: Awaited<ReturnType<WalletInterface['listOutputs']>>,
    existingOutput: WalletOutput,
    lockingScript: LockingScript,
    keyID: string,
    hashedIdentityKey: number[],
    contact: DisplayableIdentity
  ): Promise<void> {
    const source = this.#readListedSource(existingOutput, outputs)
    const prevOutpoint = source.outpoint
    const pushdrop = new PushDrop(this.#wallet, this.#originator)
    const { signableTransaction } = await this.#wallet.createAction(
      {
        description: 'Update Contact',
        inputBEEF: outputs.BEEF as number[],
        inputs: [
          {
            outpoint: prevOutpoint,
            unlockingScriptLength: 74,
            inputDescription: 'Spend previous contact output'
          }
        ],
        outputs: [
          {
            basket: 'contacts',
            satoshis: 1,
            lockingScript: lockingScript.toHex(),
            outputDescription: `Updated Contact: ${contact.name ?? contact.identityKey.slice(0, 10)}`,
            tags: [`identityKey ${UtilsToHex(hashedIdentityKey)}`],
            customInstructions: JSON.stringify({ keyID })
          }
        ],
        options: { acceptDelayedBroadcast: false, randomizeOutputs: false }
      },
      this.#originator
    )
    if (signableTransaction == null) throw new Error('Unable to update contact')
    const reference = signableTransaction.reference
    try {
      const signable = this.#parseAtomicTransaction(
        signableTransaction.tx,
        'contact signable transaction'
      )
      const inputIndex = this.#findBoundInput(signable, prevOutpoint)
      this.#requireContactOutput(signable, lockingScript)
      const unlockingScript = await pushdrop
        .unlock(
          CONTACT_PROTOCOL_ID,
          keyID,
          'self',
          'all',
          false,
          source.satoshis,
          source.lockingScript
        )
        .sign(signable, inputIndex)
      const signedResult = await this.#wallet.signAction(
        {
          reference,
          spends: { [inputIndex]: { unlockingScript: unlockingScript.toHex() } }
        },
        this.#originator
      )
      const tx = signedResult?.tx
      if (tx == null) throw new Error('Failed to update contact output')
      const signed = this.#parseAtomicTransaction(tx, 'signed contact transaction')
      this.#assertTransactionTemplate(signable, signed)
      if (this.#findBoundInput(signed, prevOutpoint) !== inputIndex) {
        throw new Error('Signed contact transaction moved the authorized input')
      }
      if (signed.inputs[inputIndex].unlockingScript?.toHex() !== unlockingScript.toHex()) {
        throw new Error(
          'Signed contact transaction omitted or substituted the authorized signature'
        )
      }
      this.#requireContactOutput(signed, lockingScript)
    } catch (error) {
      await this.#abortPartialAction(reference)
      throw error
    }
  }

  /** Creates a new on-chain contact output. */
  async #createContactOutput(
    lockingScript: LockingScript,
    keyID: string,
    hashedIdentityKey: number[],
    contact: DisplayableIdentity
  ): Promise<void> {
    const { tx } = await this.#wallet.createAction(
      {
        description: 'Add Contact',
        outputs: [
          {
            basket: 'contacts',
            satoshis: 1,
            lockingScript: lockingScript.toHex(),
            outputDescription: `Contact: ${contact.name ?? contact.identityKey.slice(0, 10)}`,
            tags: [`identityKey ${UtilsToHex(hashedIdentityKey)}`],
            customInstructions: JSON.stringify({ keyID })
          }
        ],
        options: { acceptDelayedBroadcast: false, randomizeOutputs: false }
      },
      this.#originator
    )
    if (tx == null) throw new Error('Failed to create contact output')
    const created = this.#parseAtomicTransaction(tx, 'created contact transaction')
    this.#requireContactOutput(created, lockingScript)
  }

  /**
   * Remove a contact from the contacts basket
   * @param identityKey The identity key of the contact to remove
   */
  async removeContact(identityKey: string): Promise<void> {
    identityKey = validateIdentityKey(identityKey)
    const tags = await this.#buildIdentityKeyTags(identityKey)
    const outputs = await this.#wallet.listOutputs(
      {
        basket: 'contacts',
        include: 'entire transactions',
        includeCustomInstructions: true,
        tags,
        limit: 100
      },
      this.#originator
    )
    if (!Array.isArray(outputs.outputs) || outputs.outputs.length > 100) {
      throw new Error('Invalid contact removal lookup result')
    }

    for (const output of outputs.outputs) {
      try {
        const spent = await this.#trySpendContactOutput(output, outputs, identityKey)
        if (spent) {
          this.#commitCachedRemoval(identityKey)
          return
        }
      } catch (error) {
        throw new Error('Unable to authenticate or remove a contact output', { cause: error })
      }
    }
    this.#commitCachedRemoval(identityKey)
  }

  /** Commits the derived cache change only after the on-chain removal succeeds or is absent. */
  #commitCachedRemoval(identityKey: string): void {
    const cached = this.#cache.getItem(this.#CONTACTS_CACHE_KEY)
    if (cached == null || cached === '') {
      this.#inFlightLoad = null
      return
    }
    const contacts = this.#loadCachedContacts()
    if (contacts == null) {
      this.#invalidate()
      return
    }
    const remaining = contacts.filter(c => c.identityKey !== identityKey)
    this.#cache.setItem(this.#CONTACTS_CACHE_KEY, JSON.stringify(remaining))
    this.#knownEmpty = remaining.length === 0
    this.#inFlightLoad = null
  }

  /** Attempts to decrypt and spend a single output if it matches the given identity key. Returns true if spent. */
  async #trySpendContactOutput(
    output: Awaited<ReturnType<WalletInterface['listOutputs']>>['outputs'][number],
    outputs: Awaited<ReturnType<WalletInterface['listOutputs']>>,
    identityKey: string
  ): Promise<boolean> {
    if (output.customInstructions == null) return false
    const keyID = this.#readKeyID(output.customInstructions)
    const source = this.#readListedSource(output, outputs)
    const ciphertext = await this.#authenticateContactScript(source.lockingScript, keyID)
    const { plaintext } = await this.#wallet.decrypt(
      {
        ciphertext,
        protocolID: CONTACT_PROTOCOL_ID,
        keyID,
        counterparty: 'self'
      },
      this.#originator
    )
    const storedContact = this.#parseContactPlaintext(plaintext)
    if (storedContact.identityKey !== identityKey) return false

    const prevOutpoint = source.outpoint
    const pushdrop = new PushDrop(this.#wallet, this.#originator)
    const { signableTransaction } = await this.#wallet.createAction(
      {
        description: 'Delete Contact',
        inputBEEF: outputs.BEEF as number[],
        inputs: [
          {
            outpoint: prevOutpoint,
            unlockingScriptLength: 74,
            inputDescription: 'Spend contact output to delete'
          }
        ],
        outputs: [],
        options: { acceptDelayedBroadcast: false, randomizeOutputs: false }
      },
      this.#originator
    )
    if (signableTransaction == null) throw new Error('Unable to delete contact')
    const reference = signableTransaction.reference
    try {
      const signable = this.#parseAtomicTransaction(
        signableTransaction.tx,
        'contact deletion transaction'
      )
      const inputIndex = this.#findBoundInput(signable, prevOutpoint)
      const unlockingScript = await pushdrop
        .unlock(
          CONTACT_PROTOCOL_ID,
          keyID,
          'self',
          'all',
          false,
          source.satoshis,
          source.lockingScript
        )
        .sign(signable, inputIndex)
      const signedResult = await this.#wallet.signAction(
        {
          reference,
          spends: { [inputIndex]: { unlockingScript: unlockingScript.toHex() } }
        },
        this.#originator
      )
      const deleteTx = signedResult?.tx
      if (deleteTx == null) throw new Error('Failed to delete contact output')
      const signed = this.#parseAtomicTransaction(deleteTx, 'signed contact deletion transaction')
      this.#assertTransactionTemplate(signable, signed)
      if (this.#findBoundInput(signed, prevOutpoint) !== inputIndex) {
        throw new Error('Signed contact deletion moved the authorized input')
      }
      if (signed.inputs[inputIndex].unlockingScript?.toHex() !== unlockingScript.toHex()) {
        throw new Error('Signed contact deletion omitted or substituted the authorized signature')
      }
      return true
    } catch (error) {
      await this.#abortPartialAction(reference)
      throw error
    }
  }
}
