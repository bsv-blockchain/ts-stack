import { PubKeyHex, WalletClient, WalletInterface, WalletProtocol } from '../wallet/index.js'
import { Utils, Random } from '../primitives/index.js'
import { DisplayableIdentity } from './types/index.js'
import { LockingScript, PushDrop } from '../script/index.js'
import { Transaction } from '../transaction/index.js'
export type Contact = DisplayableIdentity & { metadata?: Record<string, any> }

const CONTACT_PROTOCOL_ID: WalletProtocol = [2, 'contact']

// In-memory cache for cross-platform compatibility
class MemoryCache {
  private readonly cache = new Map<string, string>()

  getItem (key: string): string | null {
    return this.cache.get(key) ?? null
  }

  setItem (key: string, value: string): void {
    this.cache.set(key, value)
  }

  removeItem (key: string): void {
    this.cache.delete(key)
  }

  clear (): void {
    this.cache.clear()
  }
}

export class ContactsManager {
  private readonly wallet: WalletInterface
  private readonly cache = new MemoryCache()
  private readonly CONTACTS_CACHE_KEY = 'metanet-contacts'
  private readonly originator?: string

  constructor (wallet?: WalletInterface, originator?: string) {
    this.wallet = wallet ?? new WalletClient()
    this.originator = originator
  }

  /**
   * Load all records from the contacts basket
   * @param identityKey Optional specific identity key to fetch
   * @param forceRefresh Whether to force a check for new contact data
   * @param limit Maximum number of contacts to return
   * @returns A promise that resolves with an array of contacts
   */
  async getContacts (identityKey?: PubKeyHex, forceRefresh = false, limit = 1000): Promise<Contact[]> {
    if (!forceRefresh) {
      const fromCache = this.loadCachedContacts(identityKey)
      if (fromCache !== null) return fromCache
    }

    const tags = await this.buildIdentityKeyTags(identityKey)
    const outputs = await this.wallet.listOutputs(
      { basket: 'contacts', include: 'locking scripts', includeCustomInstructions: true, tags, limit },
      this.originator
    )

    if (outputs.outputs == null || outputs.outputs.length === 0) {
      this.cache.setItem(this.CONTACTS_CACHE_KEY, JSON.stringify([]))
      return []
    }

    const contacts = await this.decryptContactOutputs(outputs.outputs)
    this.cache.setItem(this.CONTACTS_CACHE_KEY, JSON.stringify(contacts))
    return identityKey != null ? contacts.filter(c => c.identityKey === identityKey) : contacts
  }

  /** Returns cached contacts (optionally filtered) or null if cache is missing/invalid. */
  private loadCachedContacts (identityKey?: PubKeyHex): Contact[] | null {
    const cached = this.cache.getItem(this.CONTACTS_CACHE_KEY)
    if (cached == null || cached === '') return null
    try {
      const cachedContacts: Contact[] = JSON.parse(cached)
      return identityKey != null ? cachedContacts.filter(c => c.identityKey === identityKey) : cachedContacts
    } catch (e) {
      console.warn('Invalid cached contacts JSON; will reload from chain', e)
      return null
    }
  }

  /** Builds the HMAC-based identity-key tag array; empty array if no identity key is given. */
  private async buildIdentityKeyTags (identityKey?: PubKeyHex): Promise<string[]> {
    if (identityKey == null) return []
    const { hmac: hashedIdentityKey } = await this.wallet.createHmac({
      protocolID: CONTACT_PROTOCOL_ID,
      keyID: identityKey,
      counterparty: 'self',
      data: Utils.toArray(identityKey, 'utf8')
    }, this.originator)
    return [`identityKey ${Utils.toHex(hashedIdentityKey)}`]
  }

  /** Decodes and decrypts all contact outputs in parallel, returning valid Contact objects. */
  private async decryptContactOutputs (
    rawOutputs: Awaited<ReturnType<WalletInterface['listOutputs']>>['outputs']
  ): Promise<Contact[]> {
    const decryptTasks: Array<{ keyID: string, ciphertext: number[] }> = []
    for (const output of rawOutputs) {
      try {
        if (output.lockingScript == null || output.customInstructions == null) continue
        const decoded = PushDrop.decode(LockingScript.fromHex(output.lockingScript))
        const keyID = JSON.parse(output.customInstructions).keyID
        decryptTasks.push({ keyID, ciphertext: decoded.fields[0] })
      } catch (error) {
        console.warn('ContactsManager: Failed to decode contact output:', error)
      }
    }

    const decryptResults = await Promise.allSettled(
      decryptTasks.map(async task =>
        await this.wallet.decrypt({ ciphertext: task.ciphertext, protocolID: CONTACT_PROTOCOL_ID, keyID: task.keyID, counterparty: 'self' }, this.originator)
      )
    )

    const contacts: Contact[] = []
    for (const result of decryptResults) {
      if (result.status === 'fulfilled') {
        try {
          contacts.push(JSON.parse(Utils.toUTF8(result.value.plaintext)) as Contact)
        } catch (error) {
          console.warn('ContactsManager: Failed to parse contact data:', error)
        }
      } else {
        console.warn('ContactsManager: Failed to decrypt contact output:', result.reason)
      }
    }
    return contacts
  }

  /**
   * Save or update a Metanet contact
   * @param contact The displayable identity information for the contact
   * @param metadata Optional metadata to store with the contact (ex. notes, aliases, etc)
   */
  async saveContact (contact: DisplayableIdentity, metadata?: Record<string, any>): Promise<void> {
    const cached = this.cache.getItem(this.CONTACTS_CACHE_KEY)
    const contacts: Contact[] = (cached != null && cached !== '') ? JSON.parse(cached) : await this.getContacts()
    const contactToStore: Contact = { ...contact, metadata }
    const existingIndex = contacts.findIndex(c => c.identityKey === contact.identityKey)
    if (existingIndex >= 0) contacts[existingIndex] = contactToStore
    else contacts.push(contactToStore)

    const hashedIdentityKey = await this.hashIdentityKey(contact.identityKey)
    const outputs = await this.wallet.listOutputs({
      basket: 'contacts', include: 'entire transactions', includeCustomInstructions: true,
      tags: [`identityKey ${Utils.toHex(hashedIdentityKey)}`], limit: 100
    }, this.originator)

    const { existingOutput, keyID } = await this.findExistingOutput(outputs, contact.identityKey)
    const lockingScript = await this.encryptAndLock(contactToStore, keyID)

    if (existingOutput != null) {
      await this.updateContactOutput(outputs, existingOutput, lockingScript, keyID, hashedIdentityKey, contact)
    } else {
      await this.createContactOutput(lockingScript, keyID, hashedIdentityKey, contact)
    }
    this.cache.setItem(this.CONTACTS_CACHE_KEY, JSON.stringify(contacts))
  }

  /** Computes the HMAC-based hash of an identity key for tag indexing. */
  private async hashIdentityKey (identityKey: string): Promise<number[]> {
    const { hmac } = await this.wallet.createHmac({
      protocolID: CONTACT_PROTOCOL_ID, keyID: identityKey, counterparty: 'self',
      data: Utils.toArray(identityKey, 'utf8')
    }, this.originator)
    return hmac
  }

  /** Scans existing outputs to find the one matching the given identity key; returns output + keyID. */
  private async findExistingOutput (
    outputs: Awaited<ReturnType<WalletInterface['listOutputs']>>,
    identityKey: string
  ): Promise<{ existingOutput: any, keyID: string }> {
    let existingOutput: any = null
    let keyID = Utils.toBase64(Random(32))
    if (outputs.outputs == null) return { existingOutput, keyID }
    for (const output of outputs.outputs) {
      try {
        const [txid, outputIndex] = output.outpoint.split('.')
        const tx = Transaction.fromBEEF(outputs.BEEF as number[], txid)
        const decoded = PushDrop.decode(tx.outputs[Number(outputIndex)].lockingScript)
        if (output.customInstructions == null) continue
        keyID = JSON.parse(output.customInstructions).keyID
        const { plaintext } = await this.wallet.decrypt(
          { ciphertext: decoded.fields[0], protocolID: CONTACT_PROTOCOL_ID, keyID, counterparty: 'self' }, this.originator
        )
        const storedContact: Contact = JSON.parse(Utils.toUTF8(plaintext))
        if (storedContact.identityKey === identityKey) { existingOutput = output; break }
      } catch (_malformedOrUndecryptableOutput) { /* skip */ }
    }
    return { existingOutput, keyID }
  }

  /** Encrypts a contact and produces its PushDrop locking script. */
  private async encryptAndLock (contactData: Contact, keyID: string): Promise<LockingScript> {
    const { ciphertext } = await this.wallet.encrypt({
      plaintext: Utils.toArray(JSON.stringify(contactData), 'utf8'),
      protocolID: CONTACT_PROTOCOL_ID, keyID, counterparty: 'self'
    }, this.originator)
    return await new PushDrop(this.wallet, this.originator).lock([ciphertext], CONTACT_PROTOCOL_ID, keyID, 'self')
  }

  /** Spends an existing contact output and creates a replacement with updated data. */
  private async updateContactOutput (
    outputs: Awaited<ReturnType<WalletInterface['listOutputs']>>,
    existingOutput: any,
    lockingScript: LockingScript,
    keyID: string,
    hashedIdentityKey: number[],
    contact: DisplayableIdentity
  ): Promise<void> {
    const [txid, outputIndex] = String(existingOutput.outpoint).split('.')
    const prevOutpoint = `${txid}.${outputIndex}` as const
    const pushdrop = new PushDrop(this.wallet, this.originator)
    const { signableTransaction } = await this.wallet.createAction({
      description: 'Update Contact',
      inputBEEF: outputs.BEEF as number[],
      inputs: [{ outpoint: prevOutpoint, unlockingScriptLength: 74, inputDescription: 'Spend previous contact output' }],
      outputs: [{
        basket: 'contacts', satoshis: 1, lockingScript: lockingScript.toHex(),
        outputDescription: `Updated Contact: ${contact.name ?? contact.identityKey.slice(0, 10)}`,
        tags: [`identityKey ${Utils.toHex(hashedIdentityKey)}`], customInstructions: JSON.stringify({ keyID })
      }],
      options: { acceptDelayedBroadcast: false, randomizeOutputs: false }
    }, this.originator)
    if (signableTransaction == null) throw new Error('Unable to update contact')
    const unlockingScript = await pushdrop.unlock(CONTACT_PROTOCOL_ID, keyID, 'self')
      .sign(Transaction.fromBEEF(signableTransaction.tx), 0)
    const { tx } = await this.wallet.signAction({
      reference: signableTransaction.reference,
      spends: { 0: { unlockingScript: unlockingScript.toHex() } }
    }, this.originator)
    if (tx == null) throw new Error('Failed to update contact output')
  }

  /** Creates a new on-chain contact output. */
  private async createContactOutput (
    lockingScript: LockingScript,
    keyID: string,
    hashedIdentityKey: number[],
    contact: DisplayableIdentity
  ): Promise<void> {
    const { tx } = await this.wallet.createAction({
      description: 'Add Contact',
      outputs: [{
        basket: 'contacts', satoshis: 1, lockingScript: lockingScript.toHex(),
        outputDescription: `Contact: ${contact.name ?? contact.identityKey.slice(0, 10)}`,
        tags: [`identityKey ${Utils.toHex(hashedIdentityKey)}`], customInstructions: JSON.stringify({ keyID })
      }],
      options: { acceptDelayedBroadcast: false, randomizeOutputs: false }
    }, this.originator)
    if (tx == null) throw new Error('Failed to create contact output')
  }

  /**
   * Remove a contact from the contacts basket
   * @param identityKey The identity key of the contact to remove
   */
  async removeContact (identityKey: string): Promise<void> {
    // Update in-memory cache
    const cached = this.cache.getItem(this.CONTACTS_CACHE_KEY)
    if (cached != null && cached !== '') {
      try {
        const contacts: Contact[] = JSON.parse(cached)
        this.cache.setItem(this.CONTACTS_CACHE_KEY, JSON.stringify(contacts.filter(c => c.identityKey !== identityKey)))
      } catch (e) {
        console.warn('Failed to update cache after contact removal:', e)
      }
    }

    const tags = await this.buildIdentityKeyTags(identityKey)
    const outputs = await this.wallet.listOutputs(
      { basket: 'contacts', include: 'entire transactions', includeCustomInstructions: true, tags, limit: 100 },
      this.originator
    )
    if (outputs.outputs == null) return

    for (const output of outputs.outputs) {
      try {
        const spent = await this.trySpendContactOutput(output, outputs, identityKey)
        if (spent) return
      } catch (_malformedOrUndecryptableOutput) { /* skip */ }
    }
  }

  /** Attempts to decrypt and spend a single output if it matches the given identity key. Returns true if spent. */
  private async trySpendContactOutput (
    output: Awaited<ReturnType<WalletInterface['listOutputs']>>['outputs'][number],
    outputs: Awaited<ReturnType<WalletInterface['listOutputs']>>,
    identityKey: string
  ): Promise<boolean> {
    const [txid, outputIndex] = String(output.outpoint).split('.')
    const tx = Transaction.fromBEEF(outputs.BEEF as number[], txid)
    const decoded = PushDrop.decode(tx.outputs[Number(outputIndex)].lockingScript)
    if (output.customInstructions == null) return false
    const keyID = JSON.parse(output.customInstructions).keyID
    const { plaintext } = await this.wallet.decrypt(
      { ciphertext: decoded.fields[0], protocolID: CONTACT_PROTOCOL_ID, keyID, counterparty: 'self' }, this.originator
    )
    const storedContact: Contact = JSON.parse(Utils.toUTF8(plaintext))
    if (storedContact.identityKey !== identityKey) return false

    const prevOutpoint = `${txid}.${outputIndex}` as const
    const pushdrop = new PushDrop(this.wallet, this.originator)
    const { signableTransaction } = await this.wallet.createAction({
      description: 'Delete Contact',
      inputBEEF: outputs.BEEF as number[],
      inputs: [{ outpoint: prevOutpoint, unlockingScriptLength: 74, inputDescription: 'Spend contact output to delete' }],
      outputs: [],
      options: { acceptDelayedBroadcast: false, randomizeOutputs: false }
    }, this.originator)
    if (signableTransaction == null) throw new Error('Unable to delete contact')
    const unlockingScript = await pushdrop.unlock(CONTACT_PROTOCOL_ID, keyID, 'self')
      .sign(Transaction.fromBEEF(signableTransaction.tx), 0)
    const { tx: deleteTx } = await this.wallet.signAction({
      reference: signableTransaction.reference,
      spends: { 0: { unlockingScript: unlockingScript.toHex() } }
    }, this.originator)
    if (deleteTx == null) throw new Error('Failed to delete contact output')
    return true
  }
}
