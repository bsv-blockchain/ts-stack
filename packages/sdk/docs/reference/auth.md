# API

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

## Interfaces

| |
| --- |
| [AsyncSessionManager](#interface-asyncsessionmanager) |
| [AuthMessage](#interface-authmessage) |
| [PeerSession](#interface-peersession) |
| [RequestedCertificateSet](#interface-requestedcertificateset) |
| [RequestedCertificateTypeIDAndFieldList](#interface-requestedcertificatetypeidandfieldlist) |
| [SessionManagerOptions](#interface-sessionmanageroptions) |
| [SimplifiedFetchTransportOptions](#interface-simplifiedfetchtransportoptions) |
| [Transport](#interface-transport) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Interface: AsyncSessionManager

```ts
export interface AsyncSessionManager {
    addSession: (session: PeerSession) => Promise<void>;
    updateSession: (session: PeerSession) => Promise<void>;
    getSession: (identifier: string) => Promise<PeerSession | undefined>;
    removeSession: (session: PeerSession) => Promise<void>;
    hasSession: (identifier: string) => Promise<boolean>;
    claimMessageNonce?: (sessionNonce: string, messageNonce: string) => Promise<boolean>;
    claimInitialRequestNonce?: (identityKey: string, initialNonce: string) => Promise<boolean>;
}
```

See also: [PeerSession](./auth.md#interface-peersession), [string](./remittance.md#function-string)

#### Property claimInitialRequestNonce

Atomically claim an unsigned initial request nonce for one claimed identity.

```ts
claimInitialRequestNonce?: (identityKey: string, initialNonce: string) => Promise<boolean>
```
See also: [string](./remittance.md#function-string)

#### Property claimMessageNonce

Atomically claim a signed BRC-103 message nonce for one session.

Shared stores must implement this operation with a uniqueness constraint
or equivalent compare-and-set. Return `false` when the nonce was already
consumed. Peer fails closed when an asynchronous store omits this method.

```ts
claimMessageNonce?: (sessionNonce: string, messageNonce: string) => Promise<boolean>
```
See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: AuthMessage

```ts
export interface AuthMessage {
    version: string;
    messageType: "initialRequest" | "initialResponse" | "certificateRequest" | "certificateResponse" | "general";
    identityKey: string;
    nonce?: string;
    initialNonce?: string;
    yourNonce?: string;
    certificates?: VerifiableCertificate[];
    requestedCertificates?: RequestedCertificateSet;
    payload?: number[];
    signature?: number[];
}
```

See also: [RequestedCertificateSet](./auth.md#interface-requestedcertificateset), [VerifiableCertificate](./auth.md#class-verifiablecertificate), [string](./remittance.md#function-string)

#### Property requestedCertificates

Requested disclosure allowlist. Initial-exchange copies are not signed and
can be altered in transit. Authorization must depend on the certificates
and fields actually received and validated, never on this request alone.

```ts
requestedCertificates?: RequestedCertificateSet
```
See also: [RequestedCertificateSet](./auth.md#interface-requestedcertificateset)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: PeerSession

```ts
export interface PeerSession {
    isAuthenticated: boolean;
    sessionNonce?: string;
    peerNonce?: string;
    peerIdentityKey?: string;
    lastUpdate: number;
    certificatesRequired?: boolean;
    certificatesValidated?: boolean;
    certificatePolicy?: RequestedCertificateSet;
    pendingCertificateRequests?: Record<string, RequestedCertificateSet>;
}
```

See also: [RequestedCertificateSet](./auth.md#interface-requestedcertificateset), [string](./remittance.md#function-string)

#### Property certificatePolicy

Local handshake policy snapshot. Session stores must retain this field; never sent on the wire.

```ts
certificatePolicy?: RequestedCertificateSet
```
See also: [RequestedCertificateSet](./auth.md#interface-requestedcertificateset)

#### Property certificatesValidated

True when supplied certificates fit the legacy v0.1 request allowlist.

```ts
certificatesValidated?: boolean
```

#### Property isAuthenticated

True after the peer has proved control of the session identity key. This is
transport authentication, not application authorization or proof that all
configured certificate attributes were supplied.

```ts
isAuthenticated: boolean
```

#### Property pendingCertificateRequests

Locally issued standalone requests, keyed by their nonce. Not a wire correlation field.

```ts
pendingCertificateRequests?: Record<string, RequestedCertificateSet>
```
See also: [RequestedCertificateSet](./auth.md#interface-requestedcertificateset), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: RequestedCertificateSet

BRC-103 v0.1 certificate request/allowlist.

The current wire/API contract does not express all-of, any-of, threshold, or
optional-field semantics. For compatibility, validation establishes only
that every supplied certificate and disclosed field belongs to this set; it
does not establish that every listed type or field was supplied. Each party
remains free to choose what to request, what to provide, and how much to
disclose. The library standardizes selective revelation; it never declares
the actual disclosures sufficient for an application's decision. An
application must inspect the received certificates and decrypted fields and
terminate or constrain the session, access, or operation whenever those
actual disclosures do not satisfy its own policy.

```ts
export interface RequestedCertificateSet {
    certifiers: string[];
    types: RequestedCertificateTypeIDAndFieldList;
}
```

See also: [RequestedCertificateTypeIDAndFieldList](./auth.md#interface-requestedcertificatetypeidandfieldlist), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: RequestedCertificateTypeIDAndFieldList

```ts
export interface RequestedCertificateTypeIDAndFieldList {
    [certificateTypeID: string]: string[];
}
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: SessionManagerOptions

```ts
export interface SessionManagerOptions {
    maxSessions?: number;
    maxSessionIdleMs?: number;
    maxMessageNoncesPerSession?: number;
    maxInitialRequestNonces?: number;
    maxInitialRequestNoncesPerIdentity?: number;
    now?: () => number;
}
```

#### Property maxInitialRequestNonces

Maximum initial-request replay claims retained in process. Defaults to 100,000.

```ts
maxInitialRequestNonces?: number
```

#### Property maxInitialRequestNoncesPerIdentity

Maximum initial-request replay claims retained for one claimed identity. Defaults to 256.

```ts
maxInitialRequestNoncesPerIdentity?: number
```

#### Property maxMessageNoncesPerSession

Maximum one-time signed message nonces retained per session. Defaults to 100,000.

```ts
maxMessageNoncesPerSession?: number
```

#### Property maxSessionIdleMs

Idle lifetime for a session. Defaults to 30 minutes.

```ts
maxSessionIdleMs?: number
```

#### Property maxSessions

Maximum sessions retained in process. Defaults to 10,000.

```ts
maxSessions?: number
```

#### Property now

Testable clock source. Defaults to `Date.now`.

```ts
now?: () => number
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: SimplifiedFetchTransportOptions

```ts
export interface SimplifiedFetchTransportOptions {
    maxResponseBytes?: number;
    maxHandshakeResponseBytes?: number;
    requestTimeoutMs?: number;
}
```

#### Property maxHandshakeResponseBytes

Maximum buffered `/.well-known/auth` response body size.

```ts
maxHandshakeResponseBytes?: number
```

#### Property maxResponseBytes

Maximum buffered authenticated application-response body size.

```ts
maxResponseBytes?: number
```

#### Property requestTimeoutMs

Wall-clock deadline covering fetch and response-body consumption.

```ts
requestTimeoutMs?: number
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: Transport

```ts
export interface Transport {
    send: (message: AuthMessage) => Promise<void>;
    onData: (callback: (message: AuthMessage) => Promise<void>) => Promise<void>;
}
```

See also: [AuthMessage](./auth.md#interface-authmessage)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
## Classes

| |
| --- |
| [AuthFetch](#class-authfetch) |
| [Certificate](#class-certificate) |
| [CompletedProtoWallet](#class-completedprotowallet) |
| [MasterCertificate](#class-mastercertificate) |
| [Peer](#class-peer) |
| [SessionManager](#class-sessionmanager) |
| [SimplifiedFetchTransport](#class-simplifiedfetchtransport) |
| [VerifiableCertificate](#class-verifiablecertificate) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Class: AuthFetch

AuthFetch provides a lightweight fetch client for interacting with servers
over a simplified HTTP transport mechanism. It integrates session management, peer communication,
and certificate handling to enable secure and mutually-authenticated requests.

Additionally, it automatically handles 402 Payment Required responses by creating
and sending BSV payment transactions when necessary. The configured wallet's
`createAction` policy is the spending-authorization boundary: applications
should use a wallet that requires the intended user/policy approval.
Recipients may advertise already-validated ancestors through the optional
`x-bsv-payment-known-txids` response header. Up to 256 unique, valid lowercase
transaction IDs are forwarded to wallet `createAction` options, including
newly created payments after repricing. An absent or invalid-only header
preserves existing payment creation behavior.
The header is an optional SDK extension, not a standardized BRC-105 header.

Payment diagnostics retain only the URL origin, header names (and
`Content-Type`), amount, identity keys, retry counts, and bounded error
metadata. URL credentials/path/query, authorization values, transaction
bytes, and payment derivation material are not included.

```ts
export class AuthFetch {
    readonly #transportOptions: SimplifiedFetchTransportOptions;
    peers: Record<string, AuthPeer> = {};
    constructor(wallet: WalletInterface, requestedCertificates?: RequestedCertificateSet, sessionManager?: SessionManager | AsyncSessionManager, originator?: OriginatorDomainNameStringUnder250Bytes, transportOptions: SimplifiedFetchTransportOptions = {}, fetchClient?: typeof fetch)
    async fetch(url: string, config: SimplifiedFetchRequestOptions = {}): Promise<Response>
    async #getOrCreatePeer(baseURL: string): Promise<AuthPeer>
    async sendCertificateRequest(baseUrl: string, certificatesToRequest: RequestedCertificateSet): Promise<VerifiableCertificate[]>
    public consumeReceivedCertificates(): VerifiableCertificate[]
    #createTransport(baseURL: string): SimplifiedFetchTransport
    #writeOptionalText(writer: Writer, value: string): void
    #includedRequestHeaders(headers: Record<string, string>): Array<[
        string,
        string
    ]>
    #writeRequestHeaders(writer: Writer, headers: Array<[
        string,
        string
    ]>): void
    #defaultRequestBody(method: string, body: any, headers: Array<[
        string,
        string
    ]>): any
    async #writeRequestBody(writer: Writer, body: any): Promise<void>
    #base64NonceToLabelHex(base64Nonce: string): string
    #describeSimpleRequestBody(body: any): RequestBodySummary | undefined
    #describePlatformRequestBody(body: any): RequestBodySummary | undefined
    #describeSerializableRequestBody(body: any): RequestBodySummary
    #safeLogUrl(url: string): string
}
```

See also: [AsyncSessionManager](./auth.md#interface-asyncsessionmanager), [OriginatorDomainNameStringUnder250Bytes](./wallet.md#type-originatordomainnamestringunder250bytes), [RequestedCertificateSet](./auth.md#interface-requestedcertificateset), [SessionManager](./auth.md#class-sessionmanager), [SimplifiedFetchTransport](./auth.md#class-simplifiedfetchtransport), [SimplifiedFetchTransportOptions](./auth.md#interface-simplifiedfetchtransportoptions), [VerifiableCertificate](./auth.md#class-verifiablecertificate), [WalletInterface](./wallet.md#interface-walletinterface), [Writer](./primitives.md#class-writer), [string](./remittance.md#function-string)

#### Constructor

Constructs a new AuthFetch instance.

```ts
constructor(wallet: WalletInterface, requestedCertificates?: RequestedCertificateSet, sessionManager?: SessionManager | AsyncSessionManager, originator?: OriginatorDomainNameStringUnder250Bytes, transportOptions: SimplifiedFetchTransportOptions = {}, fetchClient?: typeof fetch)
```
See also: [AsyncSessionManager](./auth.md#interface-asyncsessionmanager), [OriginatorDomainNameStringUnder250Bytes](./wallet.md#type-originatordomainnamestringunder250bytes), [RequestedCertificateSet](./auth.md#interface-requestedcertificateset), [SessionManager](./auth.md#class-sessionmanager), [SimplifiedFetchTransportOptions](./auth.md#interface-simplifiedfetchtransportoptions), [WalletInterface](./wallet.md#interface-walletinterface)

Argument Details

+ **wallet**
  + The wallet instance for signing and authentication.
+ **requestedCertificates**
  + Optional v0.1 certificate allowlist/request. AuthFetch does not interpret allowlist validation as application authorization.

#### Method

Hex-encode a base64 BRC-105 nonce for case-stable wallet labels.

```ts
#base64NonceToLabelHex(base64Nonce: string): string
```
See also: [string](./remittance.md#function-string)

#### Method consumeReceivedCertificates

Return any certificates we've collected thus far, then clear them out.

```ts
public consumeReceivedCertificates(): VerifiableCertificate[]
```
See also: [VerifiableCertificate](./auth.md#class-verifiablecertificate)

#### Method fetch

Mutually authenticates and sends a HTTP request to a server.

1) Attempt the request.
2) If 402 Payment Required, ask the wallet to authorize, create, and send payment.
3) Return the final response.

```ts
async fetch(url: string, config: SimplifiedFetchRequestOptions = {}): Promise<Response>
```
See also: [string](./remittance.md#function-string)

Returns

A promise that resolves with the server's response, structured as a Response-like object.

Argument Details

+ **url**
  + The URL to send the request to.
+ **config**
  + Configuration options for the request, including method, headers, body,
optional payment retry controls, and optional `labels` merged onto any BRC-105 payment action.

Throws

Will throw an error if unsupported headers are used or other validation fails.

#### Method sendCertificateRequest

Request Certificates from a Peer

```ts
async sendCertificateRequest(baseUrl: string, certificatesToRequest: RequestedCertificateSet): Promise<VerifiableCertificate[]>
```
See also: [RequestedCertificateSet](./auth.md#interface-requestedcertificateset), [VerifiableCertificate](./auth.md#class-verifiablecertificate), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: Certificate

Represents an Identity Certificate as per the Wallet interface specifications.

This class provides methods to serialize and deserialize certificates, as well as signing and verifying the certificate's signature.

```ts
export default class Certificate {
    type: Base64String;
    serialNumber: Base64String;
    subject: PubKeyHex;
    certifier: PubKeyHex;
    revocationOutpoint: OutpointString;
    fields: Record<CertificateFieldNameUnder50Bytes, Base64String>;
    signature?: HexString;
    constructor(type: Base64String, serialNumber: Base64String, subject: PubKeyHex, certifier: PubKeyHex, revocationOutpoint: OutpointString, fields: Record<CertificateFieldNameUnder50Bytes, string>, signature?: HexString)
    toBinary(includeSignature: boolean = true): number[]
    static fromBinary(bin: number[] | Uint8Array): Certificate
    async verify(): Promise<boolean>
    async sign(certifierWallet: ProtoWallet): Promise<void>
    static getCertificateFieldEncryptionDetails(fieldName: string, serialNumber?: string): {
        protocolID: WalletProtocol;
        keyID: string;
    }
    static fromObject(obj: {
        type: Base64String;
        serialNumber: Base64String;
        subject: PubKeyHex;
        certifier: PubKeyHex;
        revocationOutpoint: OutpointString;
        fields: Record<CertificateFieldNameUnder50Bytes, Base64String>;
        signature?: HexString;
    }): Certificate
}
```

See also: [Base64String](./wallet.md#type-base64string), [CertificateFieldNameUnder50Bytes](./wallet.md#type-certificatefieldnameunder50bytes), [HexString](./wallet.md#type-hexstring), [OutpointString](./wallet.md#type-outpointstring), [ProtoWallet](./wallet.md#class-protowallet), [PubKeyHex](./wallet.md#type-pubkeyhex), [WalletProtocol](./wallet.md#type-walletprotocol), [sign](./compat.md#variable-sign), [string](./remittance.md#function-string), [verify](./compat.md#variable-verify)

#### Constructor

Constructs a new Certificate.

```ts
constructor(type: Base64String, serialNumber: Base64String, subject: PubKeyHex, certifier: PubKeyHex, revocationOutpoint: OutpointString, fields: Record<CertificateFieldNameUnder50Bytes, string>, signature?: HexString)
```
See also: [Base64String](./wallet.md#type-base64string), [CertificateFieldNameUnder50Bytes](./wallet.md#type-certificatefieldnameunder50bytes), [HexString](./wallet.md#type-hexstring), [OutpointString](./wallet.md#type-outpointstring), [PubKeyHex](./wallet.md#type-pubkeyhex), [string](./remittance.md#function-string)

Argument Details

+ **type**
  + Type identifier for the certificate, base64 encoded string, 32 bytes.
+ **serialNumber**
  + Unique serial number of the certificate, base64 encoded string, 32 bytes.
+ **subject**
  + The public key belonging to the certificate's subject, compressed public key hex string.
+ **certifier**
  + Public key of the certifier who issued the certificate, compressed public key hex string.
+ **revocationOutpoint**
  + The outpoint used to confirm that the certificate has not been revoked (TXID.OutputIndex), as a string.
+ **fields**
  + All the fields present in the certificate.
+ **signature**
  + Certificate signature by the certifier's private key, DER encoded hex string.

#### Property certifier

Public key of the certifier who issued the certificate, compressed public key hex string.

```ts
certifier: PubKeyHex
```
See also: [PubKeyHex](./wallet.md#type-pubkeyhex)

#### Property fields

All the fields present in the certificate, with field names as keys and encrypted field values as Base64 strings.

```ts
fields: Record<CertificateFieldNameUnder50Bytes, Base64String>
```
See also: [Base64String](./wallet.md#type-base64string), [CertificateFieldNameUnder50Bytes](./wallet.md#type-certificatefieldnameunder50bytes)

#### Property revocationOutpoint

The outpoint used to confirm that the certificate has not been revoked (TXID.OutputIndex), as a string.

```ts
revocationOutpoint: OutpointString
```
See also: [OutpointString](./wallet.md#type-outpointstring)

#### Property serialNumber

Unique serial number of the certificate, base64 encoded string, 32 bytes.

```ts
serialNumber: Base64String
```
See also: [Base64String](./wallet.md#type-base64string)

#### Property signature

Certificate signature by the certifier's private key, DER encoded hex string.

```ts
signature?: HexString
```
See also: [HexString](./wallet.md#type-hexstring)

#### Property subject

The public key belonging to the certificate's subject, compressed public key hex string.

```ts
subject: PubKeyHex
```
See also: [PubKeyHex](./wallet.md#type-pubkeyhex)

#### Property type

Type identifier for the certificate, base64 encoded string, 32 bytes.

```ts
type: Base64String
```
See also: [Base64String](./wallet.md#type-base64string)

#### Method fromBinary

Deserializes a certificate from binary format.

```ts
static fromBinary(bin: number[] | Uint8Array): Certificate
```
See also: [Certificate](./auth.md#class-certificate)

Returns

- The deserialized Certificate object.

Argument Details

+ **bin**
  + The binary data representing the certificate.

#### Method fromObject

Creates a Certificate instance from a plain object representation.

```ts
static fromObject(obj: {
    type: Base64String;
    serialNumber: Base64String;
    subject: PubKeyHex;
    certifier: PubKeyHex;
    revocationOutpoint: OutpointString;
    fields: Record<CertificateFieldNameUnder50Bytes, Base64String>;
    signature?: HexString;
}): Certificate
```
See also: [Base64String](./wallet.md#type-base64string), [Certificate](./auth.md#class-certificate), [CertificateFieldNameUnder50Bytes](./wallet.md#type-certificatefieldnameunder50bytes), [HexString](./wallet.md#type-hexstring), [OutpointString](./wallet.md#type-outpointstring), [PubKeyHex](./wallet.md#type-pubkeyhex)

Returns

A new Certificate instance.

Argument Details

+ **obj**
  + The object containing certificate data.

#### Method getCertificateFieldEncryptionDetails

Helper function which retrieves the protocol ID and key ID for certificate field encryption.

For master certificate creation, no serial number is provided because entropy is required
from both the client and the certifier. In this case, the `keyID` is simply the `fieldName`.

For VerifiableCertificates verifier keyring creation, both the serial number and field name are available,
so the `keyID` is formed by concatenating the `serialNumber` and `fieldName`.

```ts
static getCertificateFieldEncryptionDetails(fieldName: string, serialNumber?: string): {
    protocolID: WalletProtocol;
    keyID: string;
}
```
See also: [WalletProtocol](./wallet.md#type-walletprotocol), [string](./remittance.md#function-string)

Returns

An object containing:
- `protocolID` (WalletProtocol): The protocol ID for certificate field encryption.
- `keyID` (string): A unique key identifier. It is the `fieldName` if `serialNumber` is undefined,
otherwise it is a combination of `serialNumber` and `fieldName`.

Argument Details

+ **fieldName**
  + The name of the field within the certificate to be encrypted.
+ **serialNumber**
  + (Optional) The serial number of the certificate.

#### Method sign

Signs the certificate using the provided certifier wallet.

```ts
async sign(certifierWallet: ProtoWallet): Promise<void>
```
See also: [ProtoWallet](./wallet.md#class-protowallet)

Argument Details

+ **certifierWallet**
  + The wallet representing the certifier.

#### Method toBinary

Serializes the certificate into binary format, with or without a signature.

Certificate field presentation order is part of the historical signed
representation: this implementation orders field names with the host's
default `localeCompare` behavior. Reordering fields differently from the
representation used when the certificate was serialized or signed is not
equivalent and will make signature verification fail. Issuers and
verifiers must therefore preserve the original representation and use
compatible ordering environments.

```ts
toBinary(includeSignature: boolean = true): number[]
```

Returns

- The serialized certificate in binary format.

Argument Details

+ **includeSignature**
  + Whether to include the signature in the serialization.

#### Method verify

```ts
async verify(): Promise<boolean>
```

Returns

- A promise that resolves to true if the signature is valid;
it makes no revocation-status assertion.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: CompletedProtoWallet

```ts
export class CompletedProtoWallet extends ProtoWallet implements WalletInterface {
    keyDeriver: KeyDeriver;
    constructor(rootKeyOrKeyDeriver: PrivateKey | "anyone" | KeyDeriverApi)
    async isAuthenticated(): Promise<AuthenticatedResult>
    async waitForAuthentication(): Promise<AuthenticatedResult>
    async getNetwork(): Promise<GetNetworkResult>
    async getVersion(): Promise<GetVersionResult>
    async getPublicKey(args: GetPublicKeyArgs): Promise<{
        publicKey: PubKeyHex;
    }>
    async createAction(): Promise<CreateActionResult>
    async signAction(): Promise<SignActionResult>
    async abortAction(): Promise<AbortActionResult>
    async listActions(): Promise<ListActionsResult>
    async internalizeAction(): Promise<InternalizeActionResult>
    async listOutputs(): Promise<ListOutputsResult>
    async relinquishOutput(): Promise<RelinquishOutputResult>
    async acquireCertificate(): Promise<AcquireCertificateResult>
    async listCertificates(): Promise<ListCertificatesResult>
    async proveCertificate(): Promise<ProveCertificateResult>
    async relinquishCertificate(): Promise<RelinquishCertificateResult>
    async discoverByIdentityKey(): Promise<DiscoverCertificatesResult>
    async discoverByAttributes(): Promise<DiscoverCertificatesResult>
    async getHeight(): Promise<GetHeightResult>
    async getHeaderForHeight(): Promise<GetHeaderResult>
}
```

See also: [AbortActionResult](./wallet.md#interface-abortactionresult), [AcquireCertificateResult](./wallet.md#type-acquirecertificateresult), [AuthenticatedResult](./wallet.md#interface-authenticatedresult), [CreateActionResult](./wallet.md#interface-createactionresult), [DiscoverCertificatesResult](./wallet.md#interface-discovercertificatesresult), [GetHeaderResult](./wallet.md#interface-getheaderresult), [GetHeightResult](./wallet.md#interface-getheightresult), [GetNetworkResult](./wallet.md#interface-getnetworkresult), [GetPublicKeyArgs](./wallet.md#interface-getpublickeyargs), [GetVersionResult](./wallet.md#interface-getversionresult), [InternalizeActionResult](./wallet.md#interface-internalizeactionresult), [KeyDeriver](./wallet.md#class-keyderiver), [KeyDeriverApi](./wallet.md#interface-keyderiverapi), [ListActionsResult](./wallet.md#interface-listactionsresult), [ListCertificatesResult](./wallet.md#interface-listcertificatesresult), [ListOutputsResult](./wallet.md#interface-listoutputsresult), [PrivateKey](./primitives.md#class-privatekey), [ProtoWallet](./wallet.md#class-protowallet), [ProveCertificateResult](./wallet.md#interface-provecertificateresult), [PubKeyHex](./wallet.md#type-pubkeyhex), [RelinquishCertificateResult](./wallet.md#interface-relinquishcertificateresult), [RelinquishOutputResult](./wallet.md#interface-relinquishoutputresult), [SignActionResult](./wallet.md#interface-signactionresult), [WalletInterface](./wallet.md#interface-walletinterface)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: MasterCertificate

MasterCertificate extends the base Certificate class to manage a master keyring, enabling the creation of verifiable certificates.

It allows for the selective disclosure of certificate fields by creating a `VerifiableCertificate` for a specific verifier.
The `MasterCertificate` can securely decrypt each master key and re-encrypt it for a verifier, creating a customized
keyring containing only the keys necessary for the verifier to access designated fields.

Inputs are copied and bounded before wallet calls. New field-revelation keys
are encoded as exactly 32 bytes; decryption also accepts the historical
minimal big-endian 1–31-byte form and restores omitted leading zero bytes.

```ts
export class MasterCertificate extends Certificate {
    declare type: Base64String;
    declare serialNumber: Base64String;
    declare subject: PubKeyHex;
    declare certifier: PubKeyHex;
    declare revocationOutpoint: OutpointString;
    declare fields: Record<CertificateFieldNameUnder50Bytes, Base64String>;
    declare signature?: HexString;
    masterKeyring: Record<CertificateFieldNameUnder50Bytes, Base64String>;
    constructor(...[type, serialNumber, subject, certifier, revocationOutpoint, fields, masterKeyring, signature]: [
        type: Base64String,
        serialNumber: Base64String,
        subject: PubKeyHex,
        certifier: PubKeyHex,
        revocationOutpoint: OutpointString,
        fields: Record<CertificateFieldNameUnder50Bytes, Base64String>,
        masterKeyring: Record<CertificateFieldNameUnder50Bytes, Base64String>,
        signature?: HexString
    ])
    static async createCertificateFields(creatorWallet: ProtoWallet, certifierOrSubject: WalletCounterparty, fields: Record<CertificateFieldNameUnder50Bytes, string>, privileged?: boolean, privilegedReason?: string): Promise<CreateCertificateFieldsResult>
    static async createKeyringForVerifier(...[subjectWallet, certifier, verifier, fields, fieldsToReveal, masterKeyring, serialNumber, privileged, privilegedReason]: [
        subjectWallet: ProtoWallet,
        certifier: WalletCounterparty,
        verifier: WalletCounterparty,
        fields: Record<CertificateFieldNameUnder50Bytes, Base64String>,
        fieldsToReveal: string[],
        masterKeyring: Record<CertificateFieldNameUnder50Bytes, Base64String>,
        serialNumber: Base64String,
        privileged?: boolean,
        privilegedReason?: string
    ]): Promise<Record<CertificateFieldNameUnder50Bytes, string>>
    static async issueCertificateForSubject(certifierWallet: ProtoWallet, subject: WalletCounterparty, fields: Record<CertificateFieldNameUnder50Bytes, string>, certificateType: Base64String, getRevocationOutpoint = async (_serial: string): Promise<string> => "00".repeat(32), serialNumber?: string): Promise<MasterCertificate>
    static async decryptFields(subjectOrCertifierWallet: ProtoWallet, masterKeyring: Record<CertificateFieldNameUnder50Bytes, Base64String>, fields: Record<CertificateFieldNameUnder50Bytes, Base64String>, counterparty: WalletCounterparty, privileged?: boolean, privilegedReason?: string): Promise<Record<CertificateFieldNameUnder50Bytes, string>>
    static async decryptField(subjectOrCertifierWallet: ProtoWallet, masterKeyring: Record<CertificateFieldNameUnder50Bytes, Base64String>, fieldName: Base64String, fieldValue: Base64String, counterparty: WalletCounterparty, privileged?: boolean, privilegedReason?: string): Promise<{
        fieldRevelationKey: number[];
        decryptedFieldValue: string;
    }>
}
```

See also: [Base64String](./wallet.md#type-base64string), [Certificate](./auth.md#class-certificate), [CertificateFieldNameUnder50Bytes](./wallet.md#type-certificatefieldnameunder50bytes), [HexString](./wallet.md#type-hexstring), [OutpointString](./wallet.md#type-outpointstring), [ProtoWallet](./wallet.md#class-protowallet), [PubKeyHex](./wallet.md#type-pubkeyhex), [WalletCounterparty](./wallet.md#type-walletcounterparty), [string](./remittance.md#function-string)

#### Method createCertificateFields

Encrypts certificate fields for a subject and generates a master keyring.
This method returns a master keyring tied to a specific certifier or subject who will validate
and sign off on the fields, along with the encrypted certificate fields.

```ts
static async createCertificateFields(creatorWallet: ProtoWallet, certifierOrSubject: WalletCounterparty, fields: Record<CertificateFieldNameUnder50Bytes, string>, privileged?: boolean, privilegedReason?: string): Promise<CreateCertificateFieldsResult>
```
See also: [CertificateFieldNameUnder50Bytes](./wallet.md#type-certificatefieldnameunder50bytes), [ProtoWallet](./wallet.md#class-protowallet), [WalletCounterparty](./wallet.md#type-walletcounterparty), [string](./remittance.md#function-string)

Returns

A promise resolving to an object containing:
- `certificateFields` {Record<CertificateFieldNameUnder50Bytes, Base64String>}:
The encrypted certificate fields.
- `masterKeyring` {Record<CertificateFieldNameUnder50Bytes, Base64String>}:
The master keyring containing encrypted revelation keys for each field.

Argument Details

+ **creatorWallet**
  + The wallet of the creator responsible for encrypting the fields.
+ **certifierOrSubject**
  + The certifier or subject who will validate the certificate fields.
+ **fields**
  + A record of certificate field names (under 50 bytes) mapped to their values.
+ **privileged**
  + Whether this is a privileged request.
+ **privilegedReason**
  + Reason provided for privileged access, required if this is a privileged operation.   *

#### Method createKeyringForVerifier

Creates a keyring for a verifier, enabling them to decrypt specific certificate fields.
This method decrypts the master field keys for the specified fields and re-encrypts them
for the verifier's identity key. The result is a keyring containing the keys necessary
for the verifier to access the designated fields.

```ts
static async createKeyringForVerifier(...[subjectWallet, certifier, verifier, fields, fieldsToReveal, masterKeyring, serialNumber, privileged, privilegedReason]: [
    subjectWallet: ProtoWallet,
    certifier: WalletCounterparty,
    verifier: WalletCounterparty,
    fields: Record<CertificateFieldNameUnder50Bytes, Base64String>,
    fieldsToReveal: string[],
    masterKeyring: Record<CertificateFieldNameUnder50Bytes, Base64String>,
    serialNumber: Base64String,
    privileged?: boolean,
    privilegedReason?: string
]): Promise<Record<CertificateFieldNameUnder50Bytes, string>>
```
See also: [Base64String](./wallet.md#type-base64string), [CertificateFieldNameUnder50Bytes](./wallet.md#type-certificatefieldnameunder50bytes), [ProtoWallet](./wallet.md#class-protowallet), [WalletCounterparty](./wallet.md#type-walletcounterparty), [string](./remittance.md#function-string)

Returns

- A keyring mapping field names to encrypted field revelation keys, allowing the verifier to decrypt specified fields.

Argument Details

+ **subjectWallet**
  + The wallet instance of the subject, used to decrypt and re-encrypt field keys.
+ **verifier**
  + The verifier who will receive access to the selectively revealed fields. Can be an identity key as hex, 'anyone', or 'self'.
+ **fieldsToReveal**
  + An array of field names to be revealed to the verifier. Must be a subset of the certificate's fields.
+ **originator**
  + Optional originator identifier, used if additional context is needed for decryption and encryption operations.
+ **privileged**
  + Whether this is a privileged request.
+ **privilegedReason**
  + Reason provided for privileged access, required if this is a privileged operation.   *

Throws

Throws an error if:
- fieldsToReveal is not an array of strings.
- A field in `fieldsToReveal` does not exist in the certificate.
- The decrypted master field key fails to decrypt the corresponding field (indicating an invalid key).

#### Method decryptFields

Decrypts all fields in the MasterCertificate using the subject's or certifier's wallet.

This method allows the subject or certifier to decrypt the `masterKeyring` and retrieve
the encryption keys for each field, which are then used to decrypt the corresponding field values.
The counterparty used for decryption depends on how the certificate fields were created:
- If the certificate is self-signed, the counterparty should be set to 'self'.
- Otherwise, the counterparty should always be the other party involved in the certificate issuance process (the subject or certifier).

```ts
static async decryptFields(subjectOrCertifierWallet: ProtoWallet, masterKeyring: Record<CertificateFieldNameUnder50Bytes, Base64String>, fields: Record<CertificateFieldNameUnder50Bytes, Base64String>, counterparty: WalletCounterparty, privileged?: boolean, privilegedReason?: string): Promise<Record<CertificateFieldNameUnder50Bytes, string>>
```
See also: [Base64String](./wallet.md#type-base64string), [CertificateFieldNameUnder50Bytes](./wallet.md#type-certificatefieldnameunder50bytes), [ProtoWallet](./wallet.md#class-protowallet), [WalletCounterparty](./wallet.md#type-walletcounterparty), [string](./remittance.md#function-string)

Returns

A promise resolving to a record of field names and their decrypted values in plaintext.

Argument Details

+ **subjectOrCertifierWallet**
  + The wallet of the subject or certifier, used to decrypt the master keyring and field values.
+ **masterKeyring**
  + A record containing encrypted keys for each field.
+ **fields**
  + A record of encrypted field names and their values.
+ **counterparty**
  + The counterparty responsible for creating or signing the certificate. For self-signed certificates, use 'self'.
+ **privileged**
  + Whether this is a privileged request.
+ **privilegedReason**
  + Reason provided for privileged access, required if this is a privileged operation.

Throws

Throws an error if the `masterKeyring` is invalid or if decryption fails for any field.

#### Method issueCertificateForSubject

Issues a new MasterCertificate for a specified subject.

This method generates a certificate containing encrypted fields and a keyring
for the subject to decrypt all fields. Each field is encrypted with a randomly
generated symmetric key, which is then encrypted for the subject. The certificate
can also includes a revocation outpoint to manage potential revocation.

```ts
static async issueCertificateForSubject(certifierWallet: ProtoWallet, subject: WalletCounterparty, fields: Record<CertificateFieldNameUnder50Bytes, string>, certificateType: Base64String, getRevocationOutpoint = async (_serial: string): Promise<string> => "00".repeat(32), serialNumber?: string): Promise<MasterCertificate>
```
See also: [Base64String](./wallet.md#type-base64string), [CertificateFieldNameUnder50Bytes](./wallet.md#type-certificatefieldnameunder50bytes), [MasterCertificate](./auth.md#class-mastercertificate), [ProtoWallet](./wallet.md#class-protowallet), [WalletCounterparty](./wallet.md#type-walletcounterparty), [string](./remittance.md#function-string)

Returns

- A signed MasterCertificate instance containing the encrypted fields and subject specific keyring.

Argument Details

+ **certifierWallet**
  + The wallet of the certifier, used to sign the certificate and encrypt field keys.
+ **subject**
  + The subject for whom the certificate is issued.
+ **fields**
  + Unencrypted certificate fields to include, with their names and values.
+ **certificateType**
  + The 32-byte Base64 certificate type being issued.
+ **getRevocationOutpoint**
  + -
Optional function to obtain a revocation outpoint for the certificate. Defaults to a placeholder.
+ **updateProgress**
  + Optional callback for reporting progress updates during the operation. Defaults to a no-op.

Throws

Throws an error if any operation (e.g., encryption, signing) fails during certificate issuance.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: Peer

Represents a peer capable of performing mutual authentication.
Manages sessions, handles authentication handshakes, certificate requests and responses,
and sending and receiving general messages over a transport layer.

This version supports multiple concurrent sessions per peer identityKey.
Signed message nonces are accepted once per session and an unsigned initial
request remains partially authenticated until a signed follow-up proves the
claimed identity. BRC-103 does not encrypt the transport; callers must add
confidentiality and authorize the authenticated identity separately.

```ts
export class Peer {
    public sessionManager: SessionManager;
    readonly #transport: Transport;
    readonly #wallet: WalletInterface;
    certificatesToRequest: RequestedCertificateSet;
    readonly #initialResponseTimeouts = new Map<number, ReturnType<typeof setTimeout>>();
    #callbackIdCounter: number = 0;
    readonly #autoPersistLastSession: boolean = true;
    readonly #originator?: OriginatorDomainNameStringUnder250Bytes;
    #identityPublicKey?: string;
    readonly ready: Promise<void>;
    constructor(wallet: WalletInterface, transport: Transport, certificatesToRequest?: RequestedCertificateSet, sessionManager?: SessionManager | AsyncSessionManager, autoPersistLastSession?: boolean, originator?: OriginatorDomainNameStringUnder250Bytes)
    async toPeer(message: number[], identityKey?: string): Promise<void>
    async #touchSession(sessionNonce: string): Promise<void>
    async #markSessionAuthenticated(sessionNonce: string): Promise<void>
    async #claimIncomingMessageNonce(sessionNonce: string, messageNonce: string, messageType: AuthMessage["messageType"]): Promise<void>
    async #waitForCertificateValidation(sessionNonce: string, peerIdentityKey: string | undefined): Promise<void>
    #snapshotCertificatePolicy(policy: RequestedCertificateSet): RequestedCertificateSet
    #restoreOwnedCertificates(message: AuthMessage): void
    #matchesCertificatePolicy(certificates: VerifiableCertificate[], policy: RequestedCertificateSet): boolean
    async requestCertificates(certificatesToRequest: RequestedCertificateSet, identityKey?: string): Promise<void>
    async getAuthenticatedSession(identityKey?: string): Promise<PeerSession>
    listenForGeneralMessages(callback: (senderPublicKey: string, payload: number[]) => void | Promise<void>): number
    stopListeningForGeneralMessages(callbackID: number): void
    listenForCertificatesReceived(callback: (senderPublicKey: string, certs: VerifiableCertificate[], sessionNonce: string, peerNonce?: string) => void | Promise<void>): number
    stopListeningForCertificatesReceived(callbackID: number): void
    listenForCertificatesRequested(callback: (senderPublicKey: string, requestedCertificates: RequestedCertificateSet) => void | Promise<void>): number
    stopListeningForCertificatesRequested(callbackID: number): void
    #requireMatchingSessionIdentity(peerSession: PeerSession, claimedIdentityKey: string, messageType: AuthMessage["messageType"]): string
    async #handleIncomingMessage(message: AuthMessage): Promise<void>
    #releaseInitialResponseWaiters(peerSession: PeerSession): void
    async #answerInitialCertificateRequest(message: AuthMessage): Promise<void>
    async #processInitialResponse(message: AuthMessage): Promise<void>
    async sendCertificateResponse(verifierIdentityKey: string, certificates: VerifiableCertificate[]): Promise<void>
    async #getIdentityPublicKey(): Promise<string>
    static #utf8ToBytes(data: string): number[]
    static #base64ToBytes(data: string): number[]
}
```

See also: [AsyncSessionManager](./auth.md#interface-asyncsessionmanager), [AuthMessage](./auth.md#interface-authmessage), [OriginatorDomainNameStringUnder250Bytes](./wallet.md#type-originatordomainnamestringunder250bytes), [PeerSession](./auth.md#interface-peersession), [RequestedCertificateSet](./auth.md#interface-requestedcertificateset), [SessionManager](./auth.md#class-sessionmanager), [Transport](./auth.md#interface-transport), [VerifiableCertificate](./auth.md#class-verifiablecertificate), [WalletInterface](./wallet.md#interface-walletinterface), [base64ToBytes](./wallet.md#function-base64tobytes), [string](./remittance.md#function-string)

#### Constructor

Creates a new Peer instance

```ts
constructor(wallet: WalletInterface, transport: Transport, certificatesToRequest?: RequestedCertificateSet, sessionManager?: SessionManager | AsyncSessionManager, autoPersistLastSession?: boolean, originator?: OriginatorDomainNameStringUnder250Bytes)
```
See also: [AsyncSessionManager](./auth.md#interface-asyncsessionmanager), [OriginatorDomainNameStringUnder250Bytes](./wallet.md#type-originatordomainnamestringunder250bytes), [RequestedCertificateSet](./auth.md#interface-requestedcertificateset), [SessionManager](./auth.md#class-sessionmanager), [Transport](./auth.md#interface-transport), [WalletInterface](./wallet.md#interface-walletinterface)

Argument Details

+ **wallet**
  + The wallet instance used for cryptographic operations.
+ **transport**
  + The transport mechanism used for sending and receiving messages.
+ **certificatesToRequest**
  + Optional v0.1 certificate allowlist/request. Validation does not prove that every listed type or field was supplied; inspect received decrypted fields before authorization.
+ **autoPersistLastSession**
  + Whether to auto-persist the session with the last-interacted-with peer. Defaults to true.
+ **originator**
  + Optional originator domain name.

#### Property ready

Resolves when the transport's `onData` listener has been registered and
the peer is ready to send and receive messages.  Await this after
construction before calling `toPeer` or any other method that requires
the transport to be listening.

```ts
readonly ready: Promise<void>
```

Example

```ts
const peer = new Peer(wallet, transport)
await peer.ready
await peer.toPeer(payload)
```

#### Method

Handles incoming messages from the transport.

```ts
async #handleIncomingMessage(message: AuthMessage): Promise<void>
```
See also: [AuthMessage](./auth.md#interface-authmessage)

Argument Details

+ **message**
  + The incoming message to process.

#### Method getAuthenticatedSession

Retrieves a transport-authenticated session for a given peer identity. If no session exists
or the session is not authenticated, initiates a handshake to create or authenticate the session.

- If `identityKey` is provided, we look up any existing session for that identity key.
- If none is found or not authenticated, we do a new handshake.
- If `identityKey` is not provided, only the peer selected by the most recent
  successfully completed locally initiated handshake may be used. Inbound
  messages never select this implicit destination.

`isAuthenticated` proves control of the session identity key. It does not
grant application authorization. When certificates are configured, also
inspect `certificatesValidated` and the actual received/decrypted fields;
v0.1 allowlist validation does not prove complete policy fulfillment.

```ts
async getAuthenticatedSession(identityKey?: string): Promise<PeerSession>
```
See also: [PeerSession](./auth.md#interface-peersession), [string](./remittance.md#function-string)

Returns

- A promise that resolves with an authenticated `PeerSession`.

Argument Details

+ **identityKey**
  + The identity public key of the peer.

#### Method listenForCertificatesReceived

Registers an observer for certificates received from peers, not an acceptance hook.
Local certificate validation is committed and its waiters are released before observers
run. Throwing rejects message handling and stops subsequent observers; it does not
roll back validation or revoke the session. Apply acceptance policy through the locally
requested certificate set and explicit application authorization before protected work.

```ts
listenForCertificatesReceived(callback: (senderPublicKey: string, certs: VerifiableCertificate[], sessionNonce: string, peerNonce?: string) => void | Promise<void>): number
```
See also: [VerifiableCertificate](./auth.md#class-verifiablecertificate), [string](./remittance.md#function-string)

Returns

The ID of the callback listener.

Argument Details

+ **callback**
  + The function to call when certificates are received. The local and peer session nonces identify the exact validated exchange; callbacks that do not need them remain compatible.

#### Method listenForCertificatesRequested

Registers a callback to listen for certificates requested from peers.

This callback can run for an unsigned initial request, where
`senderPublicKey` is only a claimed destination key. Do not treat the
callback as an authentication/authorization event and do not disclose
plaintext fields from it. Use wallet-backed certificate proving so revealed
keys are encrypted to the claimed identity; later signed protocol messages
establish whether the requester controls that key.

```ts
listenForCertificatesRequested(callback: (senderPublicKey: string, requestedCertificates: RequestedCertificateSet) => void | Promise<void>): number
```
See also: [RequestedCertificateSet](./auth.md#interface-requestedcertificateset), [string](./remittance.md#function-string)

Returns

The ID of the callback listener.

Argument Details

+ **callback**
  + The function to call when a certificate request is received.

#### Method listenForGeneralMessages

Registers a callback to listen for general messages from peers.

```ts
listenForGeneralMessages(callback: (senderPublicKey: string, payload: number[]) => void | Promise<void>): number
```
See also: [string](./remittance.md#function-string)

Returns

The ID of the callback listener.

Argument Details

+ **callback**
  + The function to call when a general message is received.

#### Method requestCertificates

Sends a request for certificates to a peer.
This method allows a peer to dynamically request specific certificates after
an initial handshake or message has been exchanged.

```ts
async requestCertificates(certificatesToRequest: RequestedCertificateSet, identityKey?: string): Promise<void>
```
See also: [RequestedCertificateSet](./auth.md#interface-requestedcertificateset), [string](./remittance.md#function-string)

Returns

Resolves if the certificate request message is successfully sent.

Argument Details

+ **certificatesToRequest**
  + Specifies allowed certifiers, types, and fields to request. Under the legacy v0.1 contract, success does not prove that every listed type or field was supplied.
+ **identityKey**
  + The identity public key of the peer. If not provided, the current or last session identity is used.

Throws

Will throw an error if the peer session is not authenticated or if sending the request fails.

#### Method sendCertificateResponse

Sends a certificate response message containing the specified certificates to a peer.

```ts
async sendCertificateResponse(verifierIdentityKey: string, certificates: VerifiableCertificate[]): Promise<void>
```
See also: [VerifiableCertificate](./auth.md#class-verifiablecertificate), [string](./remittance.md#function-string)

Argument Details

+ **verifierIdentityKey**
  + The identity key of the peer requesting the certificates.
+ **certificates**
  + The list of certificates to include in the response.

Throws

Will throw an error if the transport fails to send the message.

#### Method stopListeningForCertificatesReceived

Cancels and unsubscribes a certificatesReceived listener.

```ts
stopListeningForCertificatesReceived(callbackID: number): void
```

Argument Details

+ **callbackID**
  + The ID of the certificates received callback to cancel.

#### Method stopListeningForCertificatesRequested

Cancels and unsubscribes a certificatesRequested listener.

```ts
stopListeningForCertificatesRequested(callbackID: number): void
```

Argument Details

+ **callbackID**
  + The ID of the requested certificates callback to cancel.

#### Method stopListeningForGeneralMessages

Removes a general message listener.

```ts
stopListeningForGeneralMessages(callbackID: number): void
```

Argument Details

+ **callbackID**
  + The ID of the callback to remove.

#### Method toPeer

Sends a general message to a peer, and initiates a handshake if necessary.

```ts
async toPeer(message: number[], identityKey?: string): Promise<void>
```
See also: [string](./remittance.md#function-string)

Argument Details

+ **message**
  + The message payload to send.
+ **identityKey**
  + The identity public key of the peer, or an exact session nonce for a transport response. If not provided, uses the peer from the most recent locally initiated handshake (if any). Inbound messages never select this implicit destination.

Throws

Will throw an error if the message fails to send.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: SessionManager

Manages sessions for peers, allowing multiple concurrent sessions
per identity key. Primary lookup is always by `sessionNonce`. Idle sessions,
total sessions, and one-time message nonce claims are bounded by default.
Capacity eviction removes only unauthenticated sessions. If every slot holds
an authenticated session, a new handshake is rejected until one expires or
is explicitly removed.

```ts
export class SessionManager {
    readonly #sessionNonceToSession: Map<string, PeerSession>;
    readonly #identityKeyToNonces: Map<string, Set<string>>;
    readonly #sessionNonceToIdentityKey: Map<string, string>;
    readonly #consumedMessageNonces: Map<string, Set<string>>;
    readonly #consumedInitialRequestNonces: Map<string, number>;
    readonly #initialRequestNonceKeysByIdentity: Map<string, Set<string>>;
    readonly #maxSessions: number;
    readonly #maxSessionIdleMs: number;
    readonly #maxMessageNoncesPerSession: number;
    readonly #maxInitialRequestNonces: number;
    readonly #maxInitialRequestNoncesPerIdentity: number;
    readonly #now: () => number;
    constructor(options: SessionManagerOptions = {})
    addSession(session: PeerSession): void
    updateSession(session: PeerSession): void
    getSession(identifier: string): PeerSession | undefined
    removeSession(session: PeerSession): void
    hasSession(identifier: string): boolean
    claimMessageNonce(sessionNonce: string, messageNonce: string): boolean
    claimInitialRequestNonce(identityKey: string, initialNonce: string): boolean
    pruneExpiredSessions(now = this.#currentTime()): number
    #pruneExpiredInitialRequestNonces(now: number): void
    #deleteInitialRequestNonce(identityKey: string, key: string): void
    #isExpired(session: PeerSession, now: number): boolean
    #removeSessionIndexes(session: PeerSession): void
    #evictLeastRecentlyUsedSession(): void
    #currentTime(): number
}
```

See also: [PeerSession](./auth.md#interface-peersession), [SessionManagerOptions](./auth.md#interface-sessionmanageroptions), [string](./remittance.md#function-string)

#### Property

Maps sessionNonce -> PeerSession

```ts
readonly #sessionNonceToSession: Map<string, PeerSession>
```
See also: [PeerSession](./auth.md#interface-peersession), [string](./remittance.md#function-string)

#### Property

Maps identityKey -> Set of sessionNonces

```ts
readonly #identityKeyToNonces: Map<string, Set<string>>
```
See also: [string](./remittance.md#function-string)

#### Method addSession

Adds a session to the manager, associating it with its sessionNonce,
and also with its peerIdentityKey (if any).

This does NOT overwrite existing sessions for the same peerIdentityKey,
allowing multiple concurrent sessions for the same peer.
At capacity, only an unauthenticated session may be evicted.

```ts
addSession(session: PeerSession): void
```
See also: [PeerSession](./auth.md#interface-peersession)

Argument Details

+ **session**
  + The peer session to add.

#### Method claimInitialRequestNonce

Atomically reject a replayed unsigned initial request before wallet work.

```ts
claimInitialRequestNonce(identityKey: string, initialNonce: string): boolean
```
See also: [string](./remittance.md#function-string)

#### Method claimMessageNonce

Atomically claim a one-time signed message nonce for an active session.

```ts
claimMessageNonce(sessionNonce: string, messageNonce: string): boolean
```
See also: [string](./remittance.md#function-string)

#### Method getSession

Retrieves a session based on a given identifier, which can be:
 - A sessionNonce, or
 - A peerIdentityKey.

If it is a `sessionNonce`, returns that exact session.
If it is a `peerIdentityKey`, returns the "best" (e.g. most recently updated,
authenticated) session associated with that peer, if any.

```ts
getSession(identifier: string): PeerSession | undefined
```
See also: [PeerSession](./auth.md#interface-peersession), [string](./remittance.md#function-string)

Returns

- The matching peer session, or undefined if not found.

Argument Details

+ **identifier**
  + The identifier for the session (sessionNonce or peerIdentityKey).

#### Method hasSession

Checks if a session exists for a given identifier (either sessionNonce or identityKey).

```ts
hasSession(identifier: string): boolean
```
See also: [string](./remittance.md#function-string)

Returns

- True if the session exists, false otherwise.

Argument Details

+ **identifier**
  + The identifier to check.

#### Method pruneExpiredSessions

Remove idle sessions and their identity/replay indexes.

```ts
pruneExpiredSessions(now = this.#currentTime()): number
```

#### Method removeSession

Removes a session from the manager by clearing all associated identifiers.

```ts
removeSession(session: PeerSession): void
```
See also: [PeerSession](./auth.md#interface-peersession)

Argument Details

+ **session**
  + The peer session to remove.

#### Method updateSession

Updates a session in the manager (primarily by re-adding it),
ensuring we record the latest data (e.g., isAuthenticated, lastUpdate, etc.).

```ts
updateSession(session: PeerSession): void
```
See also: [PeerSession](./auth.md#interface-peersession)

Argument Details

+ **session**
  + The peer session to update.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: SimplifiedFetchTransport

Implements an HTTP-specific transport for handling Peer mutual authentication messages.
This class integrates with fetch to send and receive authenticated messages between peers.
It rejects redirects and applies fixed byte/count limits to buffered bodies,
signed headers, request framing, signatures, request IDs, and certificate
request headers before allocating or verifying attacker-controlled data.

```ts
export class SimplifiedFetchTransport implements Transport {
    fetchClient: typeof fetch;
    baseUrl: string;
    readonly #maxHandshakeResponseBytes: number;
    readonly #requestTimeoutMs: number;
    constructor(baseUrl: string, fetchClient: typeof fetch = defaultFetch, options: SimplifiedFetchTransportOptions = {})
    async send(message: AuthMessage): Promise<void>
    async #fetchAuthMessage(url: string, message: AuthMessage, signal: AbortSignal): Promise<Response>
    async #sendAuthMessage(message: AuthMessage): Promise<void>
    #encodeRequestBody(body: number[], contentType: string): string | Uint8Array
    #prepareGeneralRequest(message: AuthMessage): any
    async #fetchGeneralResponse(url: string, request: any, signal: AbortSignal): Promise<Response>
    #validateResponseAuthentication(url: string, response: Response, body: number[]): void
    #parseRequestedCertificates(url: string, response: Response): RequestedCertificateSet | undefined
    #collectSignedResponseHeaders(response: Response): Array<[
        string,
        string
    ]>
    #writeGeneralResponsePayload(response: Response, body: number[]): number[]
    #createGeneralResponseMessage(url: string, response: Response, body: number[]): AuthMessage
    async #sendGeneralMessage(message: AuthMessage): Promise<void>
    async #withDeadline<T>(url: string, work: (signal: AbortSignal) => Promise<T>): Promise<T>
    async onData(callback: (message: AuthMessage) => Promise<void>): Promise<void>
    #createNetworkError(url: string, originalError: unknown): Error
    #createUnauthenticatedResponseError(url: string, response: Response, bodyBytes: number[], missingHeaders: string[] = []): Error
    #createMalformedHeaderError(url: string, headerName: string, headerValue: string, cause: unknown): Error
    #getBodyPreview(bodyBytes: number[], contentType: string | null): string | undefined
    #isTextualContent(contentType: string | null, sample: number[]): boolean
    #formatBinaryPreview(bytes: number[], truncated: boolean): string
    deserializeRequestPayload(payload: number[]): {
        method: string;
        urlPostfix: string;
        headers: Record<string, string>;
        body: number[];
        requestId: string;
    }
}
```

See also: [AuthMessage](./auth.md#interface-authmessage), [RequestedCertificateSet](./auth.md#interface-requestedcertificateset), [SimplifiedFetchTransportOptions](./auth.md#interface-simplifiedfetchtransportoptions), [Transport](./auth.md#interface-transport), [string](./remittance.md#function-string)

#### Constructor

Constructs a new instance of SimplifiedFetchTransport.

```ts
constructor(baseUrl: string, fetchClient: typeof fetch = defaultFetch, options: SimplifiedFetchTransportOptions = {})
```
See also: [SimplifiedFetchTransportOptions](./auth.md#interface-simplifiedfetchtransportoptions), [string](./remittance.md#function-string)

Argument Details

+ **baseUrl**
  + The base URL for all HTTP requests made by this transport.
+ **fetchClient**
  + A fetch implementation to use for HTTP requests (default: global fetch).

#### Method deserializeRequestPayload

Deserializes a request payload from a byte array into an HTTP request-like structure.

```ts
deserializeRequestPayload(payload: number[]): {
    method: string;
    urlPostfix: string;
    headers: Record<string, string>;
    body: number[];
    requestId: string;
}
```
See also: [string](./remittance.md#function-string)

Returns

An object representing the deserialized request, including the method,
URL postfix (path and query string), headers, body, and request ID.

Argument Details

+ **payload**
  + The serialized payload to deserialize.

#### Method onData

Registers a callback to handle incoming messages.
This must be called before sending any messages to ensure responses can be processed.

```ts
async onData(callback: (message: AuthMessage) => Promise<void>): Promise<void>
```
See also: [AuthMessage](./auth.md#interface-authmessage)

Returns

A promise that resolves once the callback is set.

Argument Details

+ **callback**
  + A function to invoke when an incoming AuthMessage is received.

#### Method send

Sends a message to an HTTP server using the transport mechanism.
Handles both general and authenticated message types. For general messages,
the payload is deserialized and sent as an HTTP request. For other message types,
the message is sent as a POST request to the `/auth` endpoint.

```ts
async send(message: AuthMessage): Promise<void>
```
See also: [AuthMessage](./auth.md#interface-authmessage)

Returns

A promise that resolves when the message is successfully sent.

Argument Details

+ **message**
  + The AuthMessage to send.

Throws

Will throw an error if no listener has been registered via `onData`.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: VerifiableCertificate

VerifiableCertificate extends the Certificate class, adding functionality to manage a verifier-specific keyring.
This keyring allows selective decryption of certificate fields for authorized verifiers.

```ts
export class VerifiableCertificate extends Certificate {
    declare type: Base64String;
    declare serialNumber: Base64String;
    declare subject: PubKeyHex;
    declare certifier: PubKeyHex;
    declare revocationOutpoint: OutpointString;
    declare fields: Record<CertificateFieldNameUnder50Bytes, string>;
    declare signature?: HexString;
    keyring: Record<CertificateFieldNameUnder50Bytes, string>;
    decryptedFields?: Record<CertificateFieldNameUnder50Bytes, Base64String>;
    constructor(...[type, serialNumber, subject, certifier, revocationOutpoint, fields, keyring, signature, decryptedFields]: [
        type: Base64String,
        serialNumber: Base64String,
        subject: PubKeyHex,
        certifier: PubKeyHex,
        revocationOutpoint: OutpointString,
        fields: Record<CertificateFieldNameUnder50Bytes, string>,
        keyring: Record<CertificateFieldNameUnder50Bytes, string>,
        signature?: HexString,
        decryptedFields?: Record<CertificateFieldNameUnder50Bytes, Base64String>
    ])
    static fromCertificate(certificate: WalletCertificate, keyring: Record<CertificateFieldNameUnder50Bytes, string>): VerifiableCertificate
    async decryptFields(verifierWallet: ProtoWallet, privileged?: boolean, privilegedReason?: string, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<Record<CertificateFieldNameUnder50Bytes, string>>
}
```

See also: [Base64String](./wallet.md#type-base64string), [Certificate](./auth.md#class-certificate), [CertificateFieldNameUnder50Bytes](./wallet.md#type-certificatefieldnameunder50bytes), [HexString](./wallet.md#type-hexstring), [OriginatorDomainNameStringUnder250Bytes](./wallet.md#type-originatordomainnamestringunder250bytes), [OutpointString](./wallet.md#type-outpointstring), [ProtoWallet](./wallet.md#class-protowallet), [PubKeyHex](./wallet.md#type-pubkeyhex), [WalletCertificate](./wallet.md#interface-walletcertificate), [string](./remittance.md#function-string)

#### Method decryptFields

Decrypts selectively revealed certificate fields using the provided keyring and verifier wallet

```ts
async decryptFields(verifierWallet: ProtoWallet, privileged?: boolean, privilegedReason?: string, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<Record<CertificateFieldNameUnder50Bytes, string>>
```
See also: [CertificateFieldNameUnder50Bytes](./wallet.md#type-certificatefieldnameunder50bytes), [OriginatorDomainNameStringUnder250Bytes](./wallet.md#type-originatordomainnamestringunder250bytes), [ProtoWallet](./wallet.md#class-protowallet), [string](./remittance.md#function-string)

Returns

- A promise that resolves to an object where each key is a field name and each value is the decrypted field value as a string.

Argument Details

+ **verifierWallet**
  + The wallet instance of the certificate's verifier, used to decrypt field keys.
+ **privileged**
  + Whether this is a privileged request.
+ **privilegedReason**
  + Reason provided for privileged access, required if this is a privileged operation.

Throws

Throws an error if any of the decryption operations fail, with a message indicating the failure context.

#### Method fromCertificate

```ts
static fromCertificate(certificate: WalletCertificate, keyring: Record<CertificateFieldNameUnder50Bytes, string>): VerifiableCertificate
```
See also: [CertificateFieldNameUnder50Bytes](./wallet.md#type-certificatefieldnameunder50bytes), [VerifiableCertificate](./auth.md#class-verifiablecertificate), [WalletCertificate](./wallet.md#interface-walletcertificate), [string](./remittance.md#function-string)

Returns

– A fully-formed instance containing the
original certificate data plus the supplied keyring.

Argument Details

+ **certificate**
  + – The source certificate that was issued and signed by the certifier.
+ **keyring**
  + – A allows the verifier to decrypt selected certificate fields.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
## Functions

| |
| --- |
| [assertAuthByteArray](#function-assertauthbytearray) |
| [assertAuthIdentityKey](#function-assertauthidentitykey) |
| [assertAuthPeerTarget](#function-assertauthpeertarget) |
| [assertBoundedAuthData](#function-assertboundedauthdata) |
| [assertRequestedCertificateSet](#function-assertrequestedcertificateset) |
| [assertValidAuthMessage](#function-assertvalidauthmessage) |
| [copyAuthByteArray](#function-copyauthbytearray) |
| [createNonce](#function-createnonce) |
| [parseKnownTxidsHeader](#function-parseknowntxidsheader) |
| [snapshotAuthMessage](#function-snapshotauthmessage) |
| [snapshotBoundedAuthData](#function-snapshotboundedauthdata) |
| [verifyNonce](#function-verifynonce) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Function: assertAuthByteArray

```ts
export function assertAuthByteArray(value: unknown, name: string, maxBytes: number, allowEmpty = false): asserts value is number[]
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: assertAuthIdentityKey

```ts
export function assertAuthIdentityKey(value: unknown): asserts value is string
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: assertAuthPeerTarget

```ts
export function assertAuthPeerTarget(value: unknown): asserts value is string
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: assertBoundedAuthData

```ts
export function assertBoundedAuthData(value: unknown): void
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: assertRequestedCertificateSet

```ts
export function assertRequestedCertificateSet(value: unknown): asserts value is RequestedCertificateSet
```

See also: [RequestedCertificateSet](./auth.md#interface-requestedcertificateset)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: assertValidAuthMessage

Validate an untrusted BRC-103 message before any wallet or session work.

```ts
export function assertValidAuthMessage(value: unknown): asserts value is AuthMessage
```

See also: [AuthMessage](./auth.md#interface-authmessage)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: copyAuthByteArray

Validate and copy a byte array before retaining it across an asynchronous trust boundary.

```ts
export function copyAuthByteArray(value: unknown, name: string, maxBytes: number, allowEmpty = false): number[]
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: createNonce

Creates a wallet-authenticated challenge token.

Despite the historical name, this value has no expiry and is not single-use
by itself. Do not use it as a standalone login or replay-prevention token.
Authentication flows must bind the challenge to a signature and track
freshness, as BRC-103 `Peer` does.

```ts
export async function createNonce(wallet: WalletInterface, counterparty: WalletCounterparty = "self", originator?: OriginatorDomainNameStringUnder250Bytes): Promise<Base64String>
```

See also: [Base64String](./wallet.md#type-base64string), [OriginatorDomainNameStringUnder250Bytes](./wallet.md#type-originatordomainnamestringunder250bytes), [WalletCounterparty](./wallet.md#type-walletcounterparty), [WalletInterface](./wallet.md#interface-walletinterface)

Returns

A random nonce derived with a wallet

Argument Details

+ **counterparty**
  + The counterparty to the nonce creation. Defaults to 'self'.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: parseKnownTxidsHeader

Parse the known-txids header into a validated list.

Deliberately lenient about the header being absent, empty or partly malformed: this is an
optimisation, and a bad entry should cost bytes, never a failed payment. Anything that is not
a well-formed txid is dropped rather than throwing.

```ts
export function parseKnownTxidsHeader(headerValue: string | null): string[] | undefined
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: snapshotAuthMessage

Validate and own an untrusted BRC-103 message for asynchronous processing.

```ts
export function snapshotAuthMessage(value: unknown): AuthMessage
```

See also: [AuthMessage](./auth.md#interface-authmessage)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: snapshotBoundedAuthData

Validate and copy authentication data into owned arrays and null-prototype records.
Descriptor-driven copying ensures only values validated during this traversal are retained.

```ts
export function snapshotBoundedAuthData<T>(value: T): T
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: verifyNonce

Verifies that a challenge token was derived from the wallet.

A successful result does not establish freshness, expiry, single use, or
asymmetric proof of key ownership. Use the complete BRC-103 handshake or a
signed, expiring payload for authentication.

```ts
export async function verifyNonce(nonce: Base64String, wallet: WalletInterface, counterparty: WalletCounterparty = "self", originator?: OriginatorDomainNameStringUnder250Bytes): Promise<boolean>
```

See also: [Base64String](./wallet.md#type-base64string), [OriginatorDomainNameStringUnder250Bytes](./wallet.md#type-originatordomainnamestringunder250bytes), [WalletCounterparty](./wallet.md#type-walletcounterparty), [WalletInterface](./wallet.md#interface-walletinterface)

Returns

`true` when the wallet accepts the HMAC, otherwise `false`. An HMAC mismatch is a failed validation: wallets that reject with `ERR_INVALID_HMAC` or the message `HMAC is not valid` return `false` instead of propagating that rejection. Other wallet failures still reject.

Argument Details

+ **nonce**
  + A nonce to verify as a base64 string.
+ **counterparty**
  + The counterparty to the nonce creation. Defaults to 'self'.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
## Types

## Enums

## Variables

| | |
| --- | --- |
| [DEFAULT_AUTH_SESSION_IDLE_MS](#variable-default_auth_session_idle_ms) | [DEFAULT_SIMPLIFIED_FETCH_REQUEST_TIMEOUT_MS](#variable-default_simplified_fetch_request_timeout_ms) |
| [DEFAULT_MAX_AUTH_SESSIONS](#variable-default_max_auth_sessions) | [MAX_AUTH_MESSAGE_BYTES](#variable-max_auth_message_bytes) |
| [DEFAULT_MAX_INITIAL_REQUEST_NONCES](#variable-default_max_initial_request_nonces) | [MAX_AUTH_MESSAGE_DEPTH](#variable-max_auth_message_depth) |
| [DEFAULT_MAX_INITIAL_REQUEST_NONCES_PER_IDENTITY](#variable-default_max_initial_request_nonces_per_identity) | [MAX_AUTH_MESSAGE_NODES](#variable-max_auth_message_nodes) |
| [DEFAULT_MAX_MESSAGE_NONCES_PER_SESSION](#variable-default_max_message_nonces_per_session) | [getVerifiableCertificates](#variable-getverifiablecertificates) |
| [DEFAULT_SIMPLIFIED_FETCH_MAX_HANDSHAKE_RESPONSE_BYTES](#variable-default_simplified_fetch_max_handshake_response_bytes) | [validateCertificates](#variable-validatecertificates) |
| [DEFAULT_SIMPLIFIED_FETCH_MAX_RESPONSE_BYTES](#variable-default_simplified_fetch_max_response_bytes) |  |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Variable: DEFAULT_AUTH_SESSION_IDLE_MS

```ts
DEFAULT_AUTH_SESSION_IDLE_MS = 30 * 60 * 1000
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Variable: DEFAULT_MAX_AUTH_SESSIONS

```ts
DEFAULT_MAX_AUTH_SESSIONS = 10000
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Variable: DEFAULT_MAX_INITIAL_REQUEST_NONCES

```ts
DEFAULT_MAX_INITIAL_REQUEST_NONCES = 100000
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Variable: DEFAULT_MAX_INITIAL_REQUEST_NONCES_PER_IDENTITY

```ts
DEFAULT_MAX_INITIAL_REQUEST_NONCES_PER_IDENTITY = 256
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Variable: DEFAULT_MAX_MESSAGE_NONCES_PER_SESSION

```ts
DEFAULT_MAX_MESSAGE_NONCES_PER_SESSION = 100000
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Variable: DEFAULT_SIMPLIFIED_FETCH_MAX_HANDSHAKE_RESPONSE_BYTES

```ts
DEFAULT_SIMPLIFIED_FETCH_MAX_HANDSHAKE_RESPONSE_BYTES = 1024 * 1024
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Variable: DEFAULT_SIMPLIFIED_FETCH_MAX_RESPONSE_BYTES

```ts
DEFAULT_SIMPLIFIED_FETCH_MAX_RESPONSE_BYTES = 16 * 1024 * 1024
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Variable: DEFAULT_SIMPLIFIED_FETCH_REQUEST_TIMEOUT_MS

```ts
DEFAULT_SIMPLIFIED_FETCH_REQUEST_TIMEOUT_MS = 30000
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Variable: MAX_AUTH_MESSAGE_BYTES

```ts
MAX_AUTH_MESSAGE_BYTES = 16 * 1024 * 1024
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Variable: MAX_AUTH_MESSAGE_DEPTH

```ts
MAX_AUTH_MESSAGE_DEPTH = 64
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Variable: MAX_AUTH_MESSAGE_NODES

```ts
MAX_AUTH_MESSAGE_NODES = 100000
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Variable: getVerifiableCertificates

```ts
getVerifiableCertificates = async (wallet: WalletInterface, requestedCertificates: RequestedCertificateSet, verifierIdentityKey: string, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<VerifiableCertificate[]> => {
    requestedCertificates = snapshotBoundedAuthData(requestedCertificates);
    const matchingCertificates = snapshotBoundedAuthData(await wallet.listCertificates({
        certifiers: requestedCertificates.certifiers,
        types: Object.keys(requestedCertificates.types)
    }, originator));
    if (matchingCertificates == null ||
        !Array.isArray(matchingCertificates.certificates) ||
        matchingCertificates.certificates.length > MAX_CERTIFICATES) {
        throw new Error(`Wallet cannot return more than ${MAX_CERTIFICATES} matching certificates`);
    }
    return await Promise.all(matchingCertificates.certificates.map(async (certificate) => {
        const requestedFields = requestedCertificates.types[certificate.type];
        if (!requestedCertificates.certifiers.includes(certificate.certifier) ||
            !Array.isArray(requestedFields)) {
            throw new Error("Wallet returned a certificate outside the requested certifier/type set");
        }
        const proof = snapshotBoundedAuthData(await wallet.proveCertificate({
            certificate,
            fieldsToReveal: requestedFields,
            verifier: verifierIdentityKey
        }, originator));
        const keyringForVerifier = snapshotRequestedKeyring(proof.keyringForVerifier, requestedFields);
        return new VerifiableCertificate(certificate.type, certificate.serialNumber, certificate.subject, certificate.certifier, certificate.revocationOutpoint, certificate.fields, keyringForVerifier, certificate.signature);
    }));
}
```

See also: [OriginatorDomainNameStringUnder250Bytes](./wallet.md#type-originatordomainnamestringunder250bytes), [RequestedCertificateSet](./auth.md#interface-requestedcertificateset), [VerifiableCertificate](./auth.md#class-verifiablecertificate), [WalletInterface](./wallet.md#interface-walletinterface), [snapshotBoundedAuthData](./auth.md#function-snapshotboundedauthdata), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Variable: validateCertificates

```ts
validateCertificates = async (verifierWallet: WalletInterface, message: AuthMessage, certificatesRequested?: RequestedCertificateSet, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<void> => {
    message = snapshotBoundedAuthData(message);
    certificatesRequested =
        certificatesRequested === undefined ? undefined : snapshotBoundedAuthData(certificatesRequested);
    if (message.certificates == null || message.certificates.length === 0) {
        throw new Error("No certificates were provided in the AuthMessage.");
    }
    if (!Array.isArray(message.certificates) || message.certificates.length > MAX_CERTIFICATES) {
        throw new Error(`AuthMessage cannot contain more than ${MAX_CERTIFICATES} certificates.`);
    }
    await Promise.all(message.certificates.map(async (incomingCert: VerifiableCertificate) => {
        if (incomingCert.subject !== message.identityKey) {
            throw new Error(`The subject of one of your certificates ("${incomingCert.subject}") is not the same as the request sender ("${message.identityKey}").`);
        }
        const certToVerify = new VerifiableCertificate(incomingCert.type, incomingCert.serialNumber, incomingCert.subject, incomingCert.certifier, incomingCert.revocationOutpoint, incomingCert.fields, incomingCert.keyring, incomingCert.signature);
        const isValidCert = await certToVerify.verify();
        if (isValidCert !== true) {
            throw new Error(`The signature for the certificate with serial number ${certToVerify.serialNumber} is invalid!`);
        }
        let requestedFields: string[] | undefined;
        if (certificatesRequested != null) {
            const { certifiers, types } = certificatesRequested;
            if (!certifiers.includes(certToVerify.certifier)) {
                throw new Error(`Certificate with serial number ${certToVerify.serialNumber} has an unrequested certifier: ${certToVerify.certifier}`);
            }
            requestedFields = types[certToVerify.type];
            if (requestedFields == null) {
                throw new Error(`Certificate with type ${certToVerify.type} was not requested`);
            }
        }
        const decryptedFields = await certToVerify.decryptFields(verifierWallet, undefined, undefined, originator);
        if (requestedFields != null) {
            assertRequestedDisclosedFields(decryptedFields, requestedFields, certToVerify.serialNumber);
        }
    }));
}
```

See also: [AuthMessage](./auth.md#interface-authmessage), [Certificate](./auth.md#class-certificate), [OriginatorDomainNameStringUnder250Bytes](./wallet.md#type-originatordomainnamestringunder250bytes), [RequestedCertificateSet](./auth.md#interface-requestedcertificateset), [VerifiableCertificate](./auth.md#class-verifiablecertificate), [WalletInterface](./wallet.md#interface-walletinterface), [snapshotBoundedAuthData](./auth.md#function-snapshotboundedauthdata), [string](./remittance.md#function-string), [verify](./compat.md#variable-verify)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
