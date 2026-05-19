import {
  Random,
  Utils,
  PrivateKey,
  CreateHmacArgs,
  CreateHmacResult,
  CreateSignatureArgs,
  CreateSignatureResult,
  GetPublicKeyArgs,
  ProtoWallet,
  PubKeyHex,
  RevealCounterpartyKeyLinkageArgs,
  RevealCounterpartyKeyLinkageResult,
  RevealSpecificKeyLinkageArgs,
  RevealSpecificKeyLinkageResult,
  VerifyHmacArgs,
  VerifyHmacResult,
  VerifySignatureArgs,
  VerifySignatureResult,
  WalletDecryptArgs,
  WalletDecryptResult,
  WalletEncryptArgs,
  WalletEncryptResult
} from '@bsv/sdk'

/**
 * PrivilegedKeyManager
 *
 * This class manages a privileged (i.e., very sensitive) private key, obtained from
 * an external function (`keyGetter`), which might be backed by HSMs, secure enclaves,
 * or other secure storage. The manager retains the key in memory only for a limited
 * duration (`retentionPeriod`), uses XOR-based chunk-splitting obfuscation, and
 * includes decoy data to raise the difficulty of discovering the real key in memory.
 *
 * IMPORTANT: While these measures raise the bar for attackers, JavaScript environments
 * do not provide perfect in-memory secrecy.
 */
export class PrivilegedKeyManager implements ProtoWallet {
  /**
   * Function that will retrieve the PrivateKey from a secure environment,
   * e.g., an HSM or secure enclave. The reason for key usage is passed in
   * to help with user consent, auditing, and access policy checks.
   */
  private readonly keyGetter: (reason: string) => Promise<PrivateKey>

  /**
   * Time (in ms) for which the obfuscated key remains in memory
   * before being automatically destroyed.
   */
  private readonly retentionPeriod: number

  /**
   * A list of dynamically generated property names used to store
   * real key chunks (XORed with random pads).
   */
  private chunkPropNames: string[] = []

  /**
   * A list of dynamically generated property names used to store
   * the random pads that correspond to the real key chunks.
   */
  private chunkPadPropNames: string[] = []

  /**
   * A list of decoy property names that will be removed
   * when the real key is destroyed.
   */
  private decoyPropNamesDestroy: string[] = []

  /**
   * A list of decoy property names that remain in memory
   * even after the real key is destroyed (just to cause confusion).
   */
  private readonly decoyPropNamesRemain: string[] = []

  /**
   * Handle to the timer that will remove the key from memory
   * after the retention period. If the key is refreshed again
   * within that period, the timer is cleared and re-set.
   */
  private destroyTimer: any

  /**
   * Number of chunks to split the 32-byte key into.
   * Adjust to increase or decrease obfuscation complexity.
   */
  private readonly CHUNK_COUNT = 4

  /**
   * @param keyGetter - Asynchronous function that retrieves the PrivateKey from a secure environment.
   * @param retentionPeriod - Time in milliseconds to retain the obfuscated key in memory before zeroizing.
   */
  constructor (keyGetter: (reason: string) => Promise<PrivateKey>, retentionPeriod = 120_000) {
    this.keyGetter = keyGetter
    this.retentionPeriod = retentionPeriod

    // Initialize some random decoy properties that always remain:
    for (let i = 0; i < 2; i++) {
      const propName = this.generateRandomPropName()
      // Store random garbage to cause confusion
      ;(this as any)[propName] = Uint8Array.from(Random(16))
      this.decoyPropNamesRemain.push(propName)
    }
  }

  /**
   * Safely destroys the in-memory obfuscated key material by zeroizing
   * and deleting related fields. Also destroys some (but not all) decoy
   * properties to further confuse an attacker.
   */
  destroyKey (): void {
    try {
      // Zero out real chunk data
      for (const name of this.chunkPropNames) {
        const data: Uint8Array | undefined = (this as any)[name]
        if (data != null) {
          data.fill(0)
        }
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete (this as any)[name]
      }
      for (const name of this.chunkPadPropNames) {
        const data: Uint8Array | undefined = (this as any)[name]
        if (data != null) {
          data.fill(0)
        }
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete (this as any)[name]
      }

      // Destroy some decoys
      for (const name of this.decoyPropNamesDestroy) {
        const data: Uint8Array | undefined = (this as any)[name]
        if (data != null) {
          data.fill(0)
        }
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete (this as any)[name]
      }

      // Clear arrays of property names
      this.chunkPropNames = []
      this.chunkPadPropNames = []
      this.decoyPropNamesDestroy = []
    } catch (_intentionallyIgnored) {
      // Best-effort memory zeroing: if an individual property is already gone or the
      // fill/delete throws (e.g. frozen object in a test harness), we must still reach
      // the finally block to clear the destruction timer.  Propagating here would leave
      // the timer running and risk a second (no-op) destruction attempt.
    } finally {
      if (this.destroyTimer != null) {
        clearTimeout(this.destroyTimer)
        this.destroyTimer = undefined
      }
    }
  }

  /**
   * Re/sets the destruction timer that removes the key from memory
   * after `retentionPeriod` ms. If a timer is already running, it
   * is cleared and re-set. This ensures the key remains in memory
   * for exactly the desired window after its most recent acquisition.
   */
  private scheduleKeyDestruction (): void {
    if (this.destroyTimer != null) {
      clearTimeout(this.destroyTimer)
    }
    this.destroyTimer = setTimeout(() => {
      this.destroyKey()
    }, this.retentionPeriod)
  }

  /**
   * XOR-based obfuscation on a per-chunk basis.
   * This function takes two equal-length byte arrays
   * and returns the XOR combination.
   */
  private xorBytes (a: Uint8Array, b: Uint8Array): Uint8Array {
    const out = new Uint8Array(a.length)
    for (let i = 0; i < a.length; i++) {
      out[i] = a[i] ^ b[i]
    }
    return out
  }

  /**
   * Splits the 32-byte key into `this.CHUNK_COUNT` smaller chunks
   * (mostly equal length; the last chunk picks up leftover bytes
   * if 32 is not evenly divisible).
   */
  private splitKeyIntoChunks (keyBytes: Uint8Array): Uint8Array[] {
    const chunkSize = Math.floor(keyBytes.length / this.CHUNK_COUNT)
    const chunks: Uint8Array[] = []
    let offset = 0

    for (let i = 0; i < this.CHUNK_COUNT; i++) {
      const size = i === this.CHUNK_COUNT - 1 ? keyBytes.length - offset : chunkSize
      chunks.push(keyBytes.slice(offset, offset + size))
      offset += size
    }
    return chunks
  }

  /**
   * Reassembles the chunks from the dynamic properties, XORs them
   * with their corresponding pads, and returns a single 32-byte
   * Uint8Array representing the raw key.
   */
  private reassembleKeyFromChunks (): Uint8Array | null {
    try {
      const chunkArrays: Uint8Array[] = []
      for (let i = 0; i < this.chunkPropNames.length; i++) {
        const chunkEnc = (this as any)[this.chunkPropNames[i]] as Uint8Array
        const chunkPad = (this as any)[this.chunkPadPropNames[i]] as Uint8Array
        if (chunkEnc == null || chunkPad == null || chunkEnc.length !== chunkPad.length) {
          return null
        }
        const rawChunk = this.xorBytes(chunkEnc, chunkPad)
        chunkArrays.push(rawChunk)
      }
      // Concat them back to a single 32-byte array:
      const totalLength = chunkArrays.reduce((sum, c) => sum + c.length, 0)
      if (totalLength !== 32) {
        // We only handle 32-byte keys
        return null
      }
      const rawKey = new Uint8Array(totalLength)
      let offset = 0
      for (const chunk of chunkArrays) {
        rawKey.set(chunk, offset)
        offset += chunk.length
        // Attempt to zero the ephemeral chunk
        chunk.fill(0)
      }
      return rawKey
    } catch (_intentionallyIgnored) {
      // Reassembly failed due to a missing property or type mismatch (e.g. the key was
      // already destroyed or was never stored).  Returning null signals "no key available"
      // to the caller, which will prompt re-authentication — propagating the raw error
      // would leak internal obfuscation details and bypass that recovery path.
      return null
    }
  }

  /**
   * Generates a random property name to store key chunks or decoy data.
   */
  private generateRandomPropName (): string {
    // E.g., 8 random hex characters for the property name
    const randomHex = Utils.toHex(Random(4))
    const extraBytes = Random(3)
    const extraNum = ((extraBytes[0] << 16) | (extraBytes[1] << 8) | extraBytes[2]) % 1000000
    return `_${randomHex}_${extraNum}`
  }

  /**
   * Forces a PrivateKey to be represented as exactly 32 bytes, left-padding
   * with zeros if its numeric value has fewer than 32 bytes.
   */
  private get32ByteRepresentation (privKey: PrivateKey): Uint8Array {
    // The internal "toArray()" can be up to 32 bytes, but sometimes fewer
    // if the numeric value has leading zeros.
    const buf = privKey.toArray()
    if (buf.length > 32) {
      throw new Error('PrivilegedKeyManager: Expected a 32-byte key, but got more.')
    }
    // Left-pad with zeros if needed
    const keyBytes = new Uint8Array(32)
    keyBytes.set(buf, 32 - buf.length)
    return keyBytes
  }

  /**
   * Returns the privileged key needed to perform cryptographic operations.
   * Uses in-memory chunk-based obfuscation if the key was already fetched.
   * Otherwise, it calls out to `keyGetter`, splits the 32-byte representation
   * of the key, XORs each chunk with a random pad, and stores them under
   * dynamic property names. Also populates new decoy properties.
   *
   * @param reason - The reason for why the key is needed, passed to keyGetter.
   * @returns The PrivateKey object needed for cryptographic operations.
   */
  private async getPrivilegedKey (reason: string): Promise<PrivateKey> {
    // If we already have chunk properties, try reassemble
    if (this.chunkPropNames.length > 0 && this.chunkPadPropNames.length > 0) {
      const rawKeyBytes = this.reassembleKeyFromChunks()
      if (rawKeyBytes?.length === 32) {
        // Convert 32 raw bytes back to a PrivateKey
        // (Leading zeros are preserved, but PrivateKey() will parse it as a big integer.)
        const hexKey = Utils.toHex([...rawKeyBytes]) // 64 hex chars
        rawKeyBytes.fill(0) // Zero ephemeral copy
        this.scheduleKeyDestruction()
        return new PrivateKey(hexKey, 'hex')
      }
    }

    // Otherwise, fetch a fresh key from the secure environment
    const fetchedKey = await this.keyGetter(reason)

    // Force 32‑byte representation (left-pad if necessary)
    const keyBytes = this.get32ByteRepresentation(fetchedKey)

    // Clean up any old data first (in case we had something stale)
    this.destroyKey()

    // Split the key
    const chunks = this.splitKeyIntoChunks(keyBytes)

    // Store new chunk data under random property names
    for (const chunk of chunks) {
      const chunkProp = this.generateRandomPropName()
      const padProp = this.generateRandomPropName()
      this.chunkPropNames.push(chunkProp)
      this.chunkPadPropNames.push(padProp)

      // Generate random pad of the same length as the chunk
      const pad = Uint8Array.from(Random(chunk.length))
      // XOR the chunk to obfuscate
      const obf = this.xorBytes(chunk, pad)

      // Store them in dynamic properties
      ;(this as any)[chunkProp] = obf
      ;(this as any)[padProp] = pad
    }

    // Generate some decoy properties that will be destroyed with the key
    for (let i = 0; i < 2; i++) {
      const decoyProp = this.generateRandomPropName()
      ;(this as any)[decoyProp] = Uint8Array.from(Random(32))
      this.decoyPropNamesDestroy.push(decoyProp)
    }

    // Zero out ephemeral original
    keyBytes.fill(0)

    // Schedule destruction
    this.scheduleKeyDestruction()

    // Return the newly fetched key as a normal PrivateKey
    return fetchedKey
  }

  async getPublicKey (args: GetPublicKeyArgs): Promise<{ publicKey: PubKeyHex }> {
    return await new ProtoWallet(await this.getPrivilegedKey(args.privilegedReason as string)).getPublicKey(args)
  }

  async revealCounterpartyKeyLinkage (
    args: RevealCounterpartyKeyLinkageArgs
  ): Promise<RevealCounterpartyKeyLinkageResult> {
    return await new ProtoWallet(await this.getPrivilegedKey(args.privilegedReason as string)).revealCounterpartyKeyLinkage(
      args
    )
  }

  async revealSpecificKeyLinkage (args: RevealSpecificKeyLinkageArgs): Promise<RevealSpecificKeyLinkageResult> {
    return await new ProtoWallet(await this.getPrivilegedKey(args.privilegedReason as string)).revealSpecificKeyLinkage(args)
  }

  async encrypt (args: WalletEncryptArgs): Promise<WalletEncryptResult> {
    return await new ProtoWallet(await this.getPrivilegedKey(args.privilegedReason as string)).encrypt(args)
  }

  async decrypt (args: WalletDecryptArgs): Promise<WalletDecryptResult> {
    return await new ProtoWallet(await this.getPrivilegedKey(args.privilegedReason as string)).decrypt(args)
  }

  async createHmac (args: CreateHmacArgs): Promise<CreateHmacResult> {
    return await new ProtoWallet(await this.getPrivilegedKey(args.privilegedReason as string)).createHmac(args)
  }

  async verifyHmac (args: VerifyHmacArgs): Promise<VerifyHmacResult> {
    return await new ProtoWallet(await this.getPrivilegedKey(args.privilegedReason as string)).verifyHmac(args)
  }

  async createSignature (args: CreateSignatureArgs): Promise<CreateSignatureResult> {
    return await new ProtoWallet(await this.getPrivilegedKey(args.privilegedReason as string)).createSignature(args)
  }

  async verifySignature (args: VerifySignatureArgs): Promise<VerifySignatureResult> {
    return await new ProtoWallet(await this.getPrivilegedKey(args.privilegedReason as string)).verifySignature(args)
  }
}
