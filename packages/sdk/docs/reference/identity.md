# API

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

## Interfaces

|                                                                       |
| --------------------------------------------------------------------- |
| [DisplayableIdentity](#interface-displayableidentity)                 |
| [IdentityClientOptions](#interface-identityclientoptions)             |
| [ResolveByAttributesOptions](#interface-resolvebyattributesoptions)   |
| [ResolveByIdentityKeyOptions](#interface-resolvebyidentitykeyoptions) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Interface: DisplayableIdentity

```ts
export interface DisplayableIdentity {
  name: string
  avatarURL: string
  abbreviatedKey: string
  identityKey: string
  badgeIconURL: string
  badgeLabel: string
  badgeClickURL: string
}
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Interface: IdentityClientOptions

```ts
export interface IdentityClientOptions {
  protocolID: WalletProtocol
  keyID: string
  tokenAmount: number
  outputIndex: number
  networkPreset?: LookupNetworkPreset
}
```

See also: [LookupNetworkPreset](./overlay-tools.md#type-lookupnetworkpreset), [WalletProtocol](./wallet.md#type-walletprotocol), [string](./remittance.md#function-string)

#### Property networkPreset

Override wallet-reported testnet routing for overlays such as TerraTestNet.

```ts
networkPreset?: LookupNetworkPreset
```

See also: [LookupNetworkPreset](./overlay-tools.md#type-lookupnetworkpreset)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Interface: ResolveByAttributesOptions

```ts
export interface ResolveByAttributesOptions {
  useContacts?: boolean
  overrideWithContacts?: boolean
  parallel?: boolean
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Interface: ResolveByIdentityKeyOptions

```ts
export interface ResolveByIdentityKeyOptions {
  useContacts?: boolean
  overrideWithContacts?: boolean
  parallel?: boolean
}
```

#### Property useContacts

Opt-in to consulting personal contacts before/alongside the overlay. Default `false`.

Most callers (including any client without a populated contacts basket) pay no benefit
from the contacts path and incur its setup cost. Set `true` only in UI contexts where
the user has likely saved contacts and a local cache hit is preferable to a fresh overlay
answer. A matching saved contact is a locally authoritative personal assertion—equivalent
to a user-installed trust anchor or accepted self-signed certificate—and may override the
overlay result. “Authoritative” is scoped to this user's saved association:
it is not evidence of a third-party certifier's attestation and does not
transfer as a trust claim to another wallet or user.

```ts
useContacts?: boolean
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

## Classes

|                                           |
| ----------------------------------------- |
| [ContactsManager](#class-contactsmanager) |
| [IdentityClient](#class-identityclient)   |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Class: ContactsManager

Manages the wallet user's local identity trust anchors.

Authenticating the encrypted contact output proves that this wallet stored
the record; the act of saving it is what records the user's independent
validation of the identity-key association. Reads therefore return the
saved record as locally authoritative rather than re-adjudicating it against
an overlay. Network-imported data must never be placed in this basket until
the user or application has validated and deliberately accepted it.

```ts
export class ContactsManager {
  readonly #wallet: WalletInterface
  readonly #cache = new MemoryCache()
  readonly #CONTACTS_CACHE_KEY = 'metanet-contacts'
  readonly #originator?: string
  #inFlightLoad: Promise<Contact[]> | null = null
  #knownEmpty = false
  constructor(wallet?: WalletInterface, originator?: string)
  async getContacts(
    identityKey?: PubKeyHex,
    forceRefresh = false,
    limit = MAX_CONTACTS
  ): Promise<Contact[]>
  #invalidate(): void
  async #loadContactsFromWallet(): Promise<Contact[]>
  #loadCachedContacts(identityKey?: PubKeyHex): Contact[] | null
  async #buildIdentityKeyTags(identityKey?: PubKeyHex): Promise<string[]>
  #readKeyID(customInstructions: unknown): string
  async #authenticateContactScript(lockingScript: LockingScript, keyID: string): Promise<number[]>
  #parseContactPlaintext(value: unknown): Contact
  async #decryptContactOutputs(
    rawOutputs: Awaited<ReturnType<WalletInterface['listOutputs']>>['outputs']
  ): Promise<Contact[]>
  async saveContact(contact: DisplayableIdentity, metadata?: Record<string, any>): Promise<void>
  async #hashIdentityKey(identityKey: string): Promise<number[]>
  async #findExistingOutput(
    outputs: Awaited<ReturnType<WalletInterface['listOutputs']>>,
    identityKey: string
  ): Promise<{
    existingOutput: WalletOutput | null
    keyID: string
  }>
  #readListedSource(
    output: WalletOutput,
    outputs: Awaited<ReturnType<WalletInterface['listOutputs']>>
  ): {
    outpoint: `${string}.${number}`
    lockingScript: LockingScript
    satoshis: number
  }
  #parseAtomicTransaction(value: unknown, field: string): Transaction
  #inputOutpoint(transaction: Transaction, inputIndex: number): string
  #findBoundInput(transaction: Transaction, outpoint: string): number
  #assertTransactionTemplate(signable: Transaction, signed: Transaction): void
  #requireContactOutput(transaction: Transaction, lockingScript: LockingScript): void
  async #abortPartialAction(reference: string): Promise<void>
  async #encryptAndLock(contactData: Contact, keyID: string): Promise<LockingScript>
  async #updateContactOutput(
    outputs: Awaited<ReturnType<WalletInterface['listOutputs']>>,
    existingOutput: WalletOutput,
    lockingScript: LockingScript,
    keyID: string,
    hashedIdentityKey: number[],
    contact: DisplayableIdentity
  ): Promise<void>
  async #createContactOutput(
    lockingScript: LockingScript,
    keyID: string,
    hashedIdentityKey: number[],
    contact: DisplayableIdentity
  ): Promise<void>
  async removeContact(identityKey: string): Promise<void>
  #commitCachedRemoval(identityKey: string): void
  async #trySpendContactOutput(
    output: Awaited<ReturnType<WalletInterface['listOutputs']>>['outputs'][number],
    outputs: Awaited<ReturnType<WalletInterface['listOutputs']>>,
    identityKey: string
  ): Promise<boolean>
}
```

See also: [Contact](./identity.md#type-contact), [DisplayableIdentity](./identity.md#interface-displayableidentity), [LockingScript](./script.md#class-lockingscript), [PubKeyHex](./wallet.md#type-pubkeyhex), [Transaction](./transaction.md#class-transaction), [WalletInterface](./wallet.md#interface-walletinterface), [WalletOutput](./wallet.md#interface-walletoutput), [string](./remittance.md#function-string)

#### Method

Reset cached state. Call after writes.

```ts
#invalidate(): void
```

#### Method

Underlying wallet load — invoked at most once concurrently via `inFlightLoad`.

```ts
async #loadContactsFromWallet(): Promise<Contact[]>
```

See also: [Contact](./identity.md#type-contact)

#### Method

Returns cached contacts (optionally filtered) or null if cache is missing/invalid.

```ts
#loadCachedContacts(identityKey?: PubKeyHex): Contact[] | null
```

See also: [Contact](./identity.md#type-contact), [PubKeyHex](./wallet.md#type-pubkeyhex)

#### Method

Builds the HMAC-based identity-key tag array; empty array if no identity key is given.

```ts
async #buildIdentityKeyTags(identityKey?: PubKeyHex): Promise<string[]>
```

See also: [PubKeyHex](./wallet.md#type-pubkeyhex), [string](./remittance.md#function-string)

#### Method

Decodes and decrypts all contact outputs in parallel, returning valid Contact objects.

```ts
async #decryptContactOutputs(rawOutputs: Awaited<ReturnType<WalletInterface["listOutputs"]>>["outputs"]): Promise<Contact[]>
```

See also: [Contact](./identity.md#type-contact), [WalletInterface](./wallet.md#interface-walletinterface)

#### Method

Computes the HMAC-based hash of an identity key for tag indexing.

```ts
async #hashIdentityKey(identityKey: string): Promise<number[]>
```

See also: [string](./remittance.md#function-string)

#### Method

Scans existing outputs to find the one matching the given identity key; returns output + keyID.

```ts
async #findExistingOutput(outputs: Awaited<ReturnType<WalletInterface["listOutputs"]>>, identityKey: string): Promise<{
    existingOutput: WalletOutput | null;
    keyID: string;
}>
```

See also: [WalletInterface](./wallet.md#interface-walletinterface), [WalletOutput](./wallet.md#interface-walletoutput), [string](./remittance.md#function-string)

#### Method

Encrypts a contact and produces its PushDrop locking script.

```ts
async #encryptAndLock(contactData: Contact, keyID: string): Promise<LockingScript>
```

See also: [Contact](./identity.md#type-contact), [LockingScript](./script.md#class-lockingscript), [string](./remittance.md#function-string)

#### Method

Spends an existing contact output and creates a replacement with updated data.

```ts
async #updateContactOutput(outputs: Awaited<ReturnType<WalletInterface["listOutputs"]>>, existingOutput: WalletOutput, lockingScript: LockingScript, keyID: string, hashedIdentityKey: number[], contact: DisplayableIdentity): Promise<void>
```

See also: [DisplayableIdentity](./identity.md#interface-displayableidentity), [LockingScript](./script.md#class-lockingscript), [WalletInterface](./wallet.md#interface-walletinterface), [WalletOutput](./wallet.md#interface-walletoutput), [string](./remittance.md#function-string)

#### Method

Creates a new on-chain contact output.

```ts
async #createContactOutput(lockingScript: LockingScript, keyID: string, hashedIdentityKey: number[], contact: DisplayableIdentity): Promise<void>
```

See also: [DisplayableIdentity](./identity.md#interface-displayableidentity), [LockingScript](./script.md#class-lockingscript), [string](./remittance.md#function-string)

#### Method

Commits the derived cache change only after the on-chain removal succeeds or is absent.

```ts
#commitCachedRemoval(identityKey: string): void
```

See also: [string](./remittance.md#function-string)

#### Method

Attempts to decrypt and spend a single output if it matches the given identity key. Returns true if spent.

```ts
async #trySpendContactOutput(output: Awaited<ReturnType<WalletInterface["listOutputs"]>>["outputs"][number], outputs: Awaited<ReturnType<WalletInterface["listOutputs"]>>, identityKey: string): Promise<boolean>
```

See also: [WalletInterface](./wallet.md#interface-walletinterface), [string](./remittance.md#function-string)

#### Method getContacts

Load all records from the contacts basket.

Returned records are authoritative local assertions selected and stored by
this wallet's user. The authority covers the saved identity-key association
and its local labels/metadata within this wallet. Callers must not
reinterpret it as fresh overlay evidence, a third-party certificate, or a
trust decision made for another user.

Concurrent calls share a single in-flight load (no thundering herd). After
the basket has been observed empty once, subsequent calls return `[]`
synchronously without hitting the wallet — until `forceRefresh` is passed
or a contact is saved/removed.

```ts
async getContacts(identityKey?: PubKeyHex, forceRefresh = false, limit = MAX_CONTACTS): Promise<Contact[]>
```

See also: [Contact](./identity.md#type-contact), [PubKeyHex](./wallet.md#type-pubkeyhex)

Argument Details

- **identityKey**
  - Optional specific identity key to fetch
- **forceRefresh**
  - Whether to force a check for new contact data
- **limit**
  - Maximum number of contacts to return

#### Method removeContact

Remove a contact from the contacts basket

```ts
async removeContact(identityKey: string): Promise<void>
```

See also: [string](./remittance.md#function-string)

Argument Details

- **identityKey**
  - The identity key of the contact to remove

#### Method saveContact

Save or update a Metanet contact. This installs or replaces a local trust
anchor: the wallet will treat the saved identity-key association as the
user's authoritative personal decision. Only save identities independently
validated by the user or application; do not auto-import untrusted network
discovery results into this method.

```ts
async saveContact(contact: DisplayableIdentity, metadata?: Record<string, any>): Promise<void>
```

See also: [DisplayableIdentity](./identity.md#interface-displayableidentity), [string](./remittance.md#function-string)

Argument Details

- **contact**
  - The displayable identity information for the contact
- **metadata**
  - Optional metadata to store with the contact (ex. notes, aliases, etc)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Class: IdentityClient

IdentityClient lets you discover who others are, and let the world know who you are.

```ts
export class IdentityClient {
  readonly #wallet: WalletInterface
  readonly #originator?: OriginatorDomainNameStringUnder250Bytes
  constructor(
    wallet?: WalletInterface,
    options: Partial<IdentityClientOptions> = {},
    originator?: OriginatorDomainNameStringUnder250Bytes
  )
  async publiclyRevealAttributes(
    certificate: WalletCertificate,
    fieldsToReveal: CertificateFieldNameUnder50Bytes[]
  ): Promise<BroadcastResponse | BroadcastFailure>
  async resolveByIdentityKey(
    args: DiscoverByIdentityKeyArgs,
    opts: boolean | ResolveByIdentityKeyOptions = false
  ): Promise<DisplayableIdentity[]>
  async resolveByAttributes(
    args: DiscoverByAttributesArgs,
    opts: boolean | ResolveByAttributesOptions = false
  ): Promise<DisplayableIdentity[]>
  #matchContactsByAttributes(contacts: Contact[], args: DiscoverByAttributesArgs): Contact[]
  async revokeCertificateRevelation(serialNumber: Base64String): Promise<void>
  public async getContacts(
    identityKey?: PubKeyHex,
    forceRefresh = false,
    limit = 1000
  ): Promise<Contact[]>
  public async saveContact(
    contact: DisplayableIdentity,
    metadata?: Record<string, any>
  ): Promise<void>
  public async removeContact(identityKey: PubKeyHex): Promise<void>
  static async parseIdentities(certs: IdentityCertificate[]): Promise<DisplayableIdentity[]>
  static async parseIdentitiesWithOverrides(
    certs: IdentityCertificate[],
    contactByKey: Map<PubKeyHex, Contact>
  ): Promise<DisplayableIdentity[]>
  static parseIdentity(identityToParse: IdentityCertificate): DisplayableIdentity
  static #hasValue(value: unknown): value is string
  static #genericIdentityName(decryptedFields: Record<string, unknown>): string
  static #genericIdentityAvatar(decryptedFields: Record<string, unknown>): string
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
  }
}
```

See also: [Base64String](./wallet.md#type-base64string), [BroadcastFailure](./transaction.md#interface-broadcastfailure), [BroadcastResponse](./transaction.md#interface-broadcastresponse), [CertificateFieldNameUnder50Bytes](./wallet.md#type-certificatefieldnameunder50bytes), [Contact](./identity.md#type-contact), [DiscoverByAttributesArgs](./wallet.md#interface-discoverbyattributesargs), [DiscoverByIdentityKeyArgs](./wallet.md#interface-discoverbyidentitykeyargs), [DisplayableIdentity](./identity.md#interface-displayableidentity), [IdentityCertificate](./wallet.md#interface-identitycertificate), [IdentityClientOptions](./identity.md#interface-identityclientoptions), [OriginatorDomainNameStringUnder250Bytes](./wallet.md#type-originatordomainnamestringunder250bytes), [PubKeyHex](./wallet.md#type-pubkeyhex), [ResolveByAttributesOptions](./identity.md#interface-resolvebyattributesoptions), [ResolveByIdentityKeyOptions](./identity.md#interface-resolvebyidentitykeyoptions), [WalletCertificate](./wallet.md#interface-walletcertificate), [WalletInterface](./wallet.md#interface-walletinterface), [string](./remittance.md#function-string)

#### Method

Helper to check if a value is a non-empty string

```ts
static #hasValue(value: unknown): value is string
```

See also: [string](./remittance.md#function-string)

#### Method

Try to parse identity information from unknown certificate types
by checking common field names

```ts
static #tryToParseGenericIdentity(type: string, decryptedFields: Record<string, unknown>, certifierInfo: Record<string, unknown>): {
    name: string;
    avatarURL: string;
    badgeLabel: string;
    badgeIconURL: string;
    badgeClickURL: string;
}
```

See also: [string](./remittance.md#function-string)

#### Method getContacts

Load all records from the contacts basket

```ts
public async getContacts(identityKey?: PubKeyHex, forceRefresh = false, limit = 1000): Promise<Contact[]>
```

See also: [Contact](./identity.md#type-contact), [PubKeyHex](./wallet.md#type-pubkeyhex)

Returns

A promise that resolves with an array of contacts

Argument Details

- **identityKey**
  - Optional specific identity key to fetch
- **forceRefresh**
  - Whether to force a check for new contact data
- **limit**
  - Optional limit on number of contacts to fetch

#### Method parseIdentity

Parse out identity and certifier attributes to display from an IdentityCertificate

```ts
static parseIdentity(identityToParse: IdentityCertificate): DisplayableIdentity
```

See also: [DisplayableIdentity](./identity.md#interface-displayableidentity), [IdentityCertificate](./wallet.md#interface-identitycertificate)

Returns

- IdentityToDisplay

Argument Details

- **identityToParse**
  - The Identity Certificate to parse

#### Method publiclyRevealAttributes

Publicly reveals selected fields from a given certificate by creating a publicly verifiable certificate.
The publicly revealed certificate is included in a blockchain transaction and broadcast to a federated overlay node.

```ts
async publiclyRevealAttributes(certificate: WalletCertificate, fieldsToReveal: CertificateFieldNameUnder50Bytes[]): Promise<BroadcastResponse | BroadcastFailure>
```

See also: [BroadcastFailure](./transaction.md#interface-broadcastfailure), [BroadcastResponse](./transaction.md#interface-broadcastresponse), [CertificateFieldNameUnder50Bytes](./wallet.md#type-certificatefieldnameunder50bytes), [WalletCertificate](./wallet.md#interface-walletcertificate)

Returns

A promise that resolves with the broadcast result from the overlay network.

Argument Details

- **certificate**
  - The master certificate to selectively reveal.
- **fieldsToReveal**
  - An array of certificate field names to reveal. Only these fields will be included in the public certificate.

Throws

Throws an error if the certificate is invalid, the fields cannot be revealed, or if the broadcast fails.

#### Method removeContact

Remove a contact from the contacts basket

```ts
public async removeContact(identityKey: PubKeyHex): Promise<void>
```

See also: [PubKeyHex](./wallet.md#type-pubkeyhex)

Argument Details

- **identityKey**
  - The identity key of the contact to remove

#### Method resolveByAttributes

```ts
async resolveByAttributes(args: DiscoverByAttributesArgs, opts: boolean | ResolveByAttributesOptions = false): Promise<DisplayableIdentity[]>
```

See also: [DiscoverByAttributesArgs](./wallet.md#interface-discoverbyattributesargs), [DisplayableIdentity](./identity.md#interface-displayableidentity), [ResolveByAttributesOptions](./identity.md#interface-resolvebyattributesoptions)

Argument Details

- **args**
  - Attributes and optional parameters used to discover certificates.
- **opts**
  - Boolean (legacy) or options object. Boolean `true` ≡ `{ useContacts: true }`.

#### Method resolveByIdentityKey

Resolves displayable identity certificates issued to a given identity key.

**Default behavior (changed): contacts are NOT consulted.** Most clients have no
contacts saved locally, so the previous "contacts-first" default paid setup cost for no
gain. Pass `{ useContacts: true }` to opt in — appropriate when you know the user has
saved contacts and prefers a local hit over a fresh overlay answer.

When `useContacts: true`:

- Default short-circuits: if a contact matches, the overlay is skipped entirely. This treats
  the saved contact as a locally authoritative personal assertion, analogous to a local trust
  anchor or self-signed certificate, not as an independent third-party attestation.
  The contact's authority comes from the user's prior independent validation;
  contact-output authentication proves local storage, not the real-world identity.
- `{ parallel: true }` fires contacts and overlay in parallel; contact wins on hit.

```ts
async resolveByIdentityKey(args: DiscoverByIdentityKeyArgs, opts: boolean | ResolveByIdentityKeyOptions = false): Promise<DisplayableIdentity[]>
```

See also: [DiscoverByIdentityKeyArgs](./wallet.md#interface-discoverbyidentitykeyargs), [DisplayableIdentity](./identity.md#interface-displayableidentity), [ResolveByIdentityKeyOptions](./identity.md#interface-resolvebyidentitykeyoptions)

Argument Details

- **args**
  - Arguments for requesting the discovery based on the identity key.
- **opts**
  - Boolean (legacy) or options object. Boolean `true` ≡ `{ useContacts: true }`.

#### Method revokeCertificateRevelation

Remove public certificate revelation from overlay services by spending the identity token

```ts
async revokeCertificateRevelation(serialNumber: Base64String): Promise<void>
```

See also: [Base64String](./wallet.md#type-base64string)

Argument Details

- **serialNumber**
  - Unique serial number of the certificate to revoke revelation

#### Method saveContact

Save or update a Metanet contact. Saving installs a wallet-local trust anchor for the
identity-key association. Validate it through the user or another independent channel before
recording it; the resulting authority is local and is not a third-party certification.

```ts
public async saveContact(contact: DisplayableIdentity, metadata?: Record<string, any>): Promise<void>
```

See also: [DisplayableIdentity](./identity.md#interface-displayableidentity), [string](./remittance.md#function-string)

Argument Details

- **contact**
  - The displayable identity information for the contact
- **metadata**
  - Optional metadata to store with the contact (ex. notes, aliases, etc)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

## Functions

## Types

### Type: Contact

```ts
export type Contact = DisplayableIdentity & {
  metadata?: Record<string, any>
}
```

See also: [DisplayableIdentity](./identity.md#interface-displayableidentity), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

## Enums

## Variables

|                                                                              |
| ---------------------------------------------------------------------------- |
| [DEFAULT_IDENTITY_CLIENT_OPTIONS](#variable-default_identity_client_options) |
| [KNOWN_IDENTITY_TYPES](#variable-known_identity_types)                       |
| [defaultIdentity](#variable-defaultidentity)                                 |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Variable: DEFAULT_IDENTITY_CLIENT_OPTIONS

```ts
DEFAULT_IDENTITY_CLIENT_OPTIONS: IdentityClientOptions = {
  protocolID: [1, 'identity'],
  keyID: '1',
  tokenAmount: 1,
  outputIndex: 0
}
```

See also: [IdentityClientOptions](./identity.md#interface-identityclientoptions)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Variable: KNOWN_IDENTITY_TYPES

```ts
KNOWN_IDENTITY_TYPES = {
  identiCert: 'z40BOInXkI8m7f/wBrv4MJ09bZfzZbTj2fJqCtONqCY=',
  discordCert: '2TgqRC35B1zehGmB21xveZNc7i5iqHc0uxMb+1NMPW4=',
  phoneCert: 'mffUklUzxbHr65xLohn0hRL0Tq2GjW1GYF/OPfzqJ6A=',
  xCert: 'vdDWvftf1H+5+ZprUw123kjHlywH+v20aPQTuXgMpNc=',
  registrant: 'YoPsbfR6YQczjzPdHCoGC7nJsOdPQR50+SYqcWpJ0y0=',
  emailCert: 'exOl3KM0dIJ04EW5pZgbZmPag6MdJXd3/a1enmUU/BA=',
  anyone: 'mfkOMfLDQmrr3SBxBQ5WeE+6Hy3VJRFq6w4A5Ljtlis=',
  self: 'Hkge6X5JRxt1cWXtHLCrSTg6dCVTxjQJJ48iOYd7n3g=',
  coolCert: 'AGfk/WrT1eBDXpz3mcw386Zww2HmqcIn3uY6x4Af1eo='
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Variable: defaultIdentity

```ts
defaultIdentity: DisplayableIdentity = {
  name: 'Unknown Identity',
  avatarURL: 'XUUB8bbn9fEthk15Ge3zTQXypUShfC94vFjp65v7u5CQ8qkpxzst',
  identityKey: '',
  abbreviatedKey: '',
  badgeIconURL: 'XUUV39HVPkpmMzYNTx7rpKzJvXfeiVyQWg2vfSpjBAuhunTCA9uG',
  badgeLabel: 'Not verified by anyone you trust.',
  badgeClickURL: 'https://bsv-blockchain.github.io/ts-sdk/reference/identity/'
}
```

See also: [DisplayableIdentity](./identity.md#interface-displayableidentity)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
