import {
  MasterCertificate,
  OriginatorDomainNameStringUnder250Bytes,
  WalletInterface,
  ListCertificatesArgs,
  ListCertificatesResult,
  AbortActionArgs,
  AbortActionResult,
  AcquireCertificateArgs,
  AuthenticatedResult,
  CreateActionArgs,
  CreateActionResult,
  CreateHmacArgs,
  CreateHmacResult,
  CreateSignatureArgs,
  CreateSignatureResult,
  DiscoverByAttributesArgs,
  DiscoverByIdentityKeyArgs,
  DiscoverCertificatesResult,
  GetHeaderArgs,
  GetHeaderResult,
  GetHeightResult,
  GetNetworkResult,
  GetPublicKeyArgs,
  GetPublicKeyResult,
  GetVersionResult,
  InternalizeActionArgs,
  InternalizeActionResult,
  ListActionsArgs,
  ListActionsResult,
  ListOutputsArgs,
  ListOutputsResult,
  ProveCertificateArgs,
  ProveCertificateResult,
  RelinquishCertificateArgs,
  RelinquishCertificateResult,
  RelinquishOutputArgs,
  RelinquishOutputResult,
  RevealCounterpartyKeyLinkageArgs,
  RevealCounterpartyKeyLinkageResult,
  RevealSpecificKeyLinkageArgs,
  RevealSpecificKeyLinkageResult,
  SignActionArgs,
  SignActionResult,
  VerifyHmacArgs,
  VerifyHmacResult,
  VerifySignatureArgs,
  VerifySignatureResult,
  WalletCertificate,
  WalletDecryptArgs,
  WalletDecryptResult,
  WalletEncryptArgs,
  WalletEncryptResult,
  KeyDeriver,
  KeyDeriverApi,
  PrivateKey,
  ProtoWallet
} from '@bsv/sdk'

/**
 * MockWallet extends CompletedProtoWallet and provides concrete
 * implementations for select methods used for testing.
 */
export class MockWallet extends ProtoWallet
  implements WalletInterface {

  keyDeriver: KeyDeriver
  constructor(rootKeyOrKeyDeriver: PrivateKey | 'anyone' | KeyDeriverApi) {
    super(rootKeyOrKeyDeriver)

    if (rootKeyOrKeyDeriver instanceof KeyDeriver) {
      this.keyDeriver = rootKeyOrKeyDeriver
    } else if (
      typeof rootKeyOrKeyDeriver === 'string' ||
      rootKeyOrKeyDeriver instanceof PrivateKey
    ) {
      this.keyDeriver = new KeyDeriver(rootKeyOrKeyDeriver)
    } else {
      throw new Error('Invalid key deriver provided')
    }
  }

  getPublicKey: (args: GetPublicKeyArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<GetPublicKeyResult>
  revealCounterpartyKeyLinkage: (args: RevealCounterpartyKeyLinkageArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<RevealCounterpartyKeyLinkageResult>
  revealSpecificKeyLinkage: (args: RevealSpecificKeyLinkageArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<RevealSpecificKeyLinkageResult>
  encrypt: (args: WalletEncryptArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<WalletEncryptResult>
  decrypt: (args: WalletDecryptArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<WalletDecryptResult>
  createHmac: (args: CreateHmacArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<CreateHmacResult>
  verifyHmac: (args: VerifyHmacArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<VerifyHmacResult>
  createSignature: (args: CreateSignatureArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<CreateSignatureResult>
  verifySignature: (args: VerifySignatureArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<VerifySignatureResult>
  createAction: (args: CreateActionArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<CreateActionResult>
  signAction: (args: SignActionArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<SignActionResult>
  abortAction: (args: AbortActionArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<AbortActionResult>
  listActions: (args: ListActionsArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<ListActionsResult>
  listOutputs: (args: ListOutputsArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<ListOutputsResult>
  relinquishOutput: (args: RelinquishOutputArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<RelinquishOutputResult>
  acquireCertificate: (args: AcquireCertificateArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<WalletCertificate>
  relinquishCertificate: (args: RelinquishCertificateArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<RelinquishCertificateResult>
  discoverByIdentityKey: (args: DiscoverByIdentityKeyArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<DiscoverCertificatesResult>
  discoverByAttributes: (args: DiscoverByAttributesArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<DiscoverCertificatesResult>
  isAuthenticated: (args: object, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<AuthenticatedResult>
  waitForAuthentication: (args: object, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<AuthenticatedResult>
  getHeight: (args: object, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<GetHeightResult>
  getHeaderForHeight: (args: GetHeaderArgs, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<GetHeaderResult>
  getNetwork: (args: object, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<GetNetworkResult>
  getVersion: (args: object, originator?: OriginatorDomainNameStringUnder250Bytes) => Promise<GetVersionResult>
  private readonly storedCertificates: MasterCertificate[] = []

  /**
   * Add a master certificate to the wallet for testing purposes.
   */
  addMasterCertificate(masterCertificate: MasterCertificate): void {
    this.storedCertificates.push(masterCertificate)
  }


  /**
   * Given a certificate and fields to reveal, this method creates a keyring
   * for the verifier by leveraging the masterCertificate’s capabilities.
   */
  async proveCertificate(args: ProveCertificateArgs, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<ProveCertificateResult> {
    const storedCert = this.storedCertificates.find(sc =>
      sc.type === args.certificate.type &&
      sc.subject === args.certificate.subject &&
      sc.serialNumber === args.certificate.serialNumber &&
      sc.certifier === args.certificate.certifier
    )

    if (storedCert === undefined) {
      throw new Error('Certificate not found in MockWallet.')
    }

    // Create the keyring for the verifier (using the masterCertificate's method)
    const keyringForVerifier = await MasterCertificate.createKeyringForVerifier(
      this,
      storedCert.certifier,
      args.verifier,
      storedCert.fields,
      args.fieldsToReveal,
      storedCert.masterKeyring,
      storedCert.serialNumber
    )

    return { keyringForVerifier }
  }

  /**
   * Mock implementation of internalizeAction.
   * Logs the provided action details and returns a successful response.
   */
  async internalizeAction(args: InternalizeActionArgs, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<InternalizeActionResult> {
    console.log('Mock internalizeAction called with:', { args, originator })
    return await Promise.resolve({ accepted: true })
  }

  /**
   * Returns any certificates whose certifier and type match the requested sets.
   */
  async listCertificates(args: ListCertificatesArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes): Promise<ListCertificatesResult> {
    // Filter certificates by requested certifiers and types
    const filtered = this.storedCertificates.filter(cert => {
      return args.certifiers.includes(cert.certifier) && args.types.includes(cert.type)
    })

    // For testing, limit and offset can be ignored or handled trivially
    const totalCertificates = filtered.length

    return {
      totalCertificates,
      certificates: filtered.map(cert => ({
        type: cert.type,
        subject: cert.subject,
        serialNumber: cert.serialNumber,
        certifier: cert.certifier,
        revocationOutpoint: cert.revocationOutpoint,
        signature: cert.signature,
        fields: cert.fields
      }))
    }
  }
}
