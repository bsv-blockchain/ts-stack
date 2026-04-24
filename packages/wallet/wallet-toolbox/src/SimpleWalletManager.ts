import {
  WalletInterface,
  OriginatorDomainNameStringUnder250Bytes,
  GetPublicKeyArgs,
  GetPublicKeyResult,
  RevealCounterpartyKeyLinkageArgs,
  RevealCounterpartyKeyLinkageResult,
  RevealSpecificKeyLinkageArgs,
  RevealSpecificKeyLinkageResult,
  WalletEncryptArgs,
  WalletEncryptResult,
  WalletDecryptArgs,
  WalletDecryptResult,
  CreateHmacArgs,
  CreateHmacResult,
  VerifyHmacArgs,
  VerifyHmacResult,
  CreateSignatureArgs,
  CreateSignatureResult,
  VerifySignatureArgs,
  VerifySignatureResult,
  CreateActionArgs,
  CreateActionResult,
  SignActionArgs,
  SignActionResult,
  AbortActionArgs,
  AbortActionResult,
  ListActionsArgs,
  ListActionsResult,
  InternalizeActionArgs,
  InternalizeActionResult,
  ListOutputsArgs,
  ListOutputsResult,
  RelinquishOutputArgs,
  RelinquishOutputResult,
  AcquireCertificateArgs,
  AcquireCertificateResult,
  ListCertificatesArgs,
  ListCertificatesResult,
  ProveCertificateArgs,
  ProveCertificateResult,
  RelinquishCertificateArgs,
  RelinquishCertificateResult,
  DiscoverByIdentityKeyArgs,
  DiscoverByAttributesArgs,
  DiscoverCertificatesResult,
  AuthenticatedResult,
  GetHeightResult,
  GetHeaderArgs,
  GetHeaderResult,
  GetNetworkResult,
  GetVersionResult,
  Utils,
  Random,
  SymmetricKey,
  PrivateKey
} from '@bsv/sdk'
import { PrivilegedKeyManager } from './sdk/PrivilegedKeyManager'

/**
 * SimpleWalletManager is a slimmed-down wallet manager that only requires two things to authenticate:
 *  1. A primary key (32 bytes), which represents the core secret for the wallet.
 *  2. A privileged key manager (an instance of `PrivilegedKeyManager`), responsible for
 *     more sensitive operations.
 *
 * Once both pieces are provided (or if a snapshot containing the primary key is loaded,
 * and the privileged key manager is provided separately), the wallet becomes authenticated.
 *
 * After authentication, calls to the standard wallet methods (`createAction`, `signAction`, etc.)
 * are proxied to an underlying `WalletInterface` instance returned by a user-supplied `walletBuilder`.
 *
 * **Important**: This manager does not handle user password flows, recovery, or on-chain
 * token management. It is a straightforward wrapper that ensures the user has provided
 * both their main secret (primary key) and a privileged key manager before allowing usage.
 *
 * It also prevents calls from the special "admin originator" from being used externally.
 * (Any call that tries to use the admin originator as its originator, other than the manager itself,
 * will result in an error, ensuring that only internal operations can use that originator.)
 *
 * The manager can also save and load snapshots of its state. In this simplified version,
 * the snapshot only contains the primary key. If you load a snapshot, you still need to
 * re-provide the privileged key manager to complete authentication.
 */
export class SimpleWalletManager implements WalletInterface {
  /**
   * Whether the user is currently authenticated (meaning both the primary key
   * and privileged key manager have been provided).
   */
  authenticated: boolean

  /**
   * The domain name of the administrative originator (wallet operator / vendor, or your own).
   */
  private adminOriginator: OriginatorDomainNameStringUnder250Bytes

  /**
   * A function that, given the user's primary key and privileged key manager,
   * returns a new `WalletInterface` instance that handles the actual signing,
   * encryption, transaction building, etc.
   */
  private walletBuilder: (primaryKey: number[], privilegedKeyManager: PrivilegedKeyManager) => Promise<WalletInterface>

  /**
   * The underlying wallet instance that is built once authenticated.
   */
  private underlying?: WalletInterface

  /**
   * The privileged key manager, responsible for sensitive tasks.
   */
  private underlyingPrivilegedKeyManager?: PrivilegedKeyManager

  /**
   * The primary key (32 bytes) that unlocks the wallet functionality.
   */
  private primaryKey?: number[]

  /**
   * Constructs a new `SimpleWalletManager`.
   *
   * @param adminOriginator The domain name of the administrative originator.
   * @param walletBuilder   A function that, given a primary key and privileged key manager,
   *                        returns a fully functional `WalletInterface`.
   * @param stateSnapshot   If provided, a previously saved snapshot of the wallet's state.
   *                        If the snapshot contains a primary key, it will be loaded immediately
   *                        (though you will still need to provide a privileged key manager to authenticate).
   */
  constructor(
    adminOriginator: OriginatorDomainNameStringUnder250Bytes,
    walletBuilder: (primaryKey: number[], privilegedKeyManager: PrivilegedKeyManager) => Promise<WalletInterface>,
    stateSnapshot?: number[]
  ) {
    this.authenticated = false
    this.adminOriginator = adminOriginator
    this.walletBuilder = walletBuilder

    if (stateSnapshot) {
      this.loadSnapshot(stateSnapshot)
    }
  }

  /**
   * Provides the primary key (32 bytes) needed for authentication.
   * If a privileged key manager has already been provided, we attempt to build
   * the underlying wallet. Otherwise, we wait until the manager is also provided.
   *
   * @param key A 32-byte primary key.
   */
  async providePrimaryKey(key: number[]): Promise<void> {
    this.primaryKey = key
    await this.tryBuildUnderlying()
  }

  /**
   * Provides the privileged key manager needed for sensitive tasks.
   * If a primary key has already been provided (or loaded from a snapshot),
   * we attempt to build the underlying wallet. Otherwise, we wait until the key is provided.
   *
   * @param manager An instance of `PrivilegedKeyManager`.
   */
  async providePrivilegedKeyManager(manager: PrivilegedKeyManager): Promise<void> {
    this.underlyingPrivilegedKeyManager = manager
    await this.tryBuildUnderlying()
  }

  /**
   * Internal method that checks if we have both the primary key and privileged manager.
   * If so, we build the underlying wallet instance and become authenticated.
   */
  private async tryBuildUnderlying(): Promise<void> {
    if (this.authenticated) {
      throw new Error('The user is already authenticated.')
    }
    if (!this.primaryKey || !this.underlyingPrivilegedKeyManager) {
      return
    }
    // Build the underlying wallet:
    this.underlying = await this.walletBuilder(this.primaryKey, this.underlyingPrivilegedKeyManager)
    this.authenticated = true
  }

  /**
   * Destroys the underlying wallet, returning to a default (unauthenticated) state.
   *
   * This clears the primary key, the privileged key manager, and the `authenticated` flag.
   */
  destroy(): void {
    this.underlying = undefined
    this.underlyingPrivilegedKeyManager = undefined
    this.authenticated = false
    this.primaryKey = undefined
  }

  /**
   * Saves the current wallet state (including just the primary key)
   * into an encrypted snapshot. This snapshot can be stored and later
   * passed to `loadSnapshot` to restore the primary key (and partially authenticate).
   *
   * **Note**: The snapshot does NOT include the privileged key manager.
   * You must still provide that separately after loading the snapshot
   * in order to complete authentication.
   *
   * @remarks
   * Storing the snapshot (which contains the primary key) provides a significant
   * portion of the wallet's secret material. It must be protected carefully.
   *
   * @returns A byte array representing the encrypted snapshot.
   * @throws {Error} if no primary key is currently set.
   */
  saveSnapshot(): number[] {
    if (!this.primaryKey) {
      throw new Error('No primary key is set; cannot save snapshot.')
    }

    // Generate a random snapshot encryption key:
    const snapshotKey = Random(32)

    // For this simple wallet manager, we only store the primary key.
    const writer = new Utils.Writer()
    // Write a 1-byte version:
    writer.writeUInt8(1)
    // Write a varint length and then the primary key bytes:
    writer.writeVarIntNum(this.primaryKey.length)
    writer.write(this.primaryKey)

    const snapshotPreimage = writer.toArray()

    // Encrypt the data with the snapshotKey:
    const encryptedPayload = new SymmetricKey(snapshotKey).encrypt(snapshotPreimage) as number[]

    // Build the final snapshot: [ snapshotKey (32 bytes) + encryptedPayload ]
    const snapshotWriter = new Utils.Writer()
    snapshotWriter.write(snapshotKey)
    snapshotWriter.write(encryptedPayload)

    return snapshotWriter.toArray()
  }

  /**
   * Loads a previously saved state snapshot (produced by `saveSnapshot`).
   * This will restore the primary key but will **not** restore the privileged key manager
   * (that must be provided separately to complete authentication).
   *
   * @param snapshot A byte array that was previously returned by `saveSnapshot`.
   * @throws {Error} If the snapshot format is invalid or decryption fails.
   */
  async loadSnapshot(snapshot: number[]): Promise<void> {
    try {
      const reader = new Utils.Reader(snapshot)

      // First 32 bytes is the snapshotKey:
      const snapshotKey = reader.read(32)

      // The rest is the encrypted payload:
      const encryptedPayload = reader.read()

      // Decrypt the payload with the snapshotKey:
      const decrypted = new SymmetricKey(snapshotKey).decrypt(encryptedPayload) as number[]

      const payloadReader = new Utils.Reader(decrypted)

      // Check version:
      const version = payloadReader.readUInt8()
      if (version !== 1) {
        throw new Error(`Unsupported snapshot version: ${version}`)
      }

      // Read the varint length and the primary key:
      const pkLength = payloadReader.readVarIntNum()
      const pk = payloadReader.read(pkLength)

      this.primaryKey = pk

      // Attempt to build the underlying wallet if the privileged manager is already provided:
      await this.tryBuildUnderlying()
    } catch (error) {
      throw new Error(`Failed to load snapshot: ${(error as Error).message}`)
    }
  }

  /**
   * Returns whether the user is currently authenticated (the wallet has a primary key
   * and a privileged key manager). If not authenticated, an error is thrown.
   *
   * @param _ Not used in this manager.
   * @param originator The originator domain, which must not be the admin originator.
   * @throws If not authenticated, or if the originator is the admin.
   */
  async isAuthenticated(_: {}, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<AuthenticatedResult> {
    this.ensureCanCall(originator)
    return { authenticated: true }
  }

  /**
   * Blocks until the user is authenticated (by providing primaryKey and privileged manager).
   * If not authenticated yet, it waits until that occurs.
   *
   * @param _ Not used in this manager.
   * @param originator The originator domain, which must not be the admin originator.
   * @throws If the originator is the admin.
   */
  async waitForAuthentication(
    _: {},
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<AuthenticatedResult> {
    if (originator === this.adminOriginator) {
      throw new Error('External applications cannot use the admin originator.')
    }
    while (!this.authenticated) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    return { authenticated: true }
  }

  async getPublicKey(
    args: GetPublicKeyArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<GetPublicKeyResult> {
    this.ensureCanCall(originator)
    return this.underlying!.getPublicKey(args, originator)
  }

  async revealCounterpartyKeyLinkage(
    args: RevealCounterpartyKeyLinkageArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<RevealCounterpartyKeyLinkageResult> {
    this.ensureCanCall(originator)
    return this.underlying!.revealCounterpartyKeyLinkage(args, originator)
  }

  async revealSpecificKeyLinkage(
    args: RevealSpecificKeyLinkageArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<RevealSpecificKeyLinkageResult> {
    this.ensureCanCall(originator)
    return this.underlying!.revealSpecificKeyLinkage(args, originator)
  }

  async encrypt(
    args: WalletEncryptArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<WalletEncryptResult> {
    this.ensureCanCall(originator)
    return this.underlying!.encrypt(args, originator)
  }

  async decrypt(
    args: WalletDecryptArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<WalletDecryptResult> {
    this.ensureCanCall(originator)
    return this.underlying!.decrypt(args, originator)
  }

  async createHmac(
    args: CreateHmacArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<CreateHmacResult> {
    this.ensureCanCall(originator)
    return this.underlying!.createHmac(args, originator)
  }

  async verifyHmac(
    args: VerifyHmacArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<VerifyHmacResult> {
    this.ensureCanCall(originator)
    return this.underlying!.verifyHmac(args, originator)
  }

  async createSignature(
    args: CreateSignatureArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<CreateSignatureResult> {
    this.ensureCanCall(originator)
    return this.underlying!.createSignature(args, originator)
  }

  async verifySignature(
    args: VerifySignatureArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<VerifySignatureResult> {
    this.ensureCanCall(originator)
    return this.underlying!.verifySignature(args, originator)
  }

  async createAction(
    args: CreateActionArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<CreateActionResult> {
    this.ensureCanCall(originator)
    return this.underlying!.createAction(args, originator)
  }

  async signAction(
    args: SignActionArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<SignActionResult> {
    this.ensureCanCall(originator)
    return this.underlying!.signAction(args, originator)
  }

  async abortAction(
    args: AbortActionArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<AbortActionResult> {
    this.ensureCanCall(originator)
    return this.underlying!.abortAction(args, originator)
  }

  async listActions(
    args: ListActionsArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<ListActionsResult> {
    this.ensureCanCall(originator)
    return this.underlying!.listActions(args, originator)
  }

  async internalizeAction(
    args: InternalizeActionArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<InternalizeActionResult> {
    this.ensureCanCall(originator)
    return this.underlying!.internalizeAction(args, originator)
  }

  async listOutputs(
    args: ListOutputsArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<ListOutputsResult> {
    this.ensureCanCall(originator)
    return this.underlying!.listOutputs(args, originator)
  }

  async relinquishOutput(
    args: RelinquishOutputArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<RelinquishOutputResult> {
    this.ensureCanCall(originator)
    return this.underlying!.relinquishOutput(args, originator)
  }

  async acquireCertificate(
    args: AcquireCertificateArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<AcquireCertificateResult> {
    this.ensureCanCall(originator)
    return this.underlying!.acquireCertificate(args, originator)
  }

  async listCertificates(
    args: ListCertificatesArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<ListCertificatesResult> {
    this.ensureCanCall(originator)
    return this.underlying!.listCertificates(args, originator)
  }

  async proveCertificate(
    args: ProveCertificateArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<ProveCertificateResult> {
    this.ensureCanCall(originator)
    return this.underlying!.proveCertificate(args, originator)
  }

  async relinquishCertificate(
    args: RelinquishCertificateArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<RelinquishCertificateResult> {
    this.ensureCanCall(originator)
    return this.underlying!.relinquishCertificate(args, originator)
  }

  async discoverByIdentityKey(
    args: DiscoverByIdentityKeyArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<DiscoverCertificatesResult> {
    this.ensureCanCall(originator)
    return this.underlying!.discoverByIdentityKey(args, originator)
  }

  async discoverByAttributes(
    args: DiscoverByAttributesArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<DiscoverCertificatesResult> {
    this.ensureCanCall(originator)
    return this.underlying!.discoverByAttributes(args, originator)
  }

  async getHeight(_: {}, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<GetHeightResult> {
    this.ensureCanCall(originator)
    return this.underlying!.getHeight({}, originator)
  }

  async getHeaderForHeight(
    args: GetHeaderArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<GetHeaderResult> {
    this.ensureCanCall(originator)
    return this.underlying!.getHeaderForHeight(args, originator)
  }

  async getNetwork(_: {}, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<GetNetworkResult> {
    this.ensureCanCall(originator)
    return this.underlying!.getNetwork({}, originator)
  }

  async getVersion(_: {}, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<GetVersionResult> {
    this.ensureCanCall(originator)
    return this.underlying!.getVersion({}, originator)
  }

  /**
   * A small helper that throws if the user is not authenticated or if the
   * provided originator is the admin (which is not permitted externally).
   */
  private ensureCanCall(originator?: OriginatorDomainNameStringUnder250Bytes) {
    if (originator === this.adminOriginator) {
      throw new Error('External applications cannot use the admin originator.')
    }
    if (!this.authenticated) {
      throw new Error('User is not authenticated.')
    }
  }
}
