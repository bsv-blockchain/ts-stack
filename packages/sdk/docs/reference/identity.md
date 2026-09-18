# API

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

## Interfaces

| |
| --- |
| [DisplayableIdentity](#interface-displayableidentity) |
| [IdentityClientOptions](#interface-identityclientoptions) |
| [ResolveByAttributesOptions](#interface-resolvebyattributesoptions) |
| [ResolveByIdentityKeyOptions](#interface-resolvebyidentitykeyoptions) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Interface: DisplayableIdentity

```ts
export interface DisplayableIdentity {
    name: string;
    avatarURL: string;
    abbreviatedKey: string;
    identityKey: string;
    badgeIconURL: string;
    badgeLabel: string;
    badgeClickURL: string;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: IdentityClientOptions

```ts
export interface IdentityClientOptions {
    protocolID: WalletProtocol;
    keyID: string;
    tokenAmount: number;
    outputIndex: number;
    networkPreset?: LookupNetworkPreset;
}
```

See also: [LookupNetworkPreset](./overlay-tools.md#type-lookupnetworkpreset), [WalletProtocol](./wallet.md#type-walletprotocol)

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
    useContacts?: boolean;
    overrideWithContacts?: boolean;
    parallel?: boolean;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: ResolveByIdentityKeyOptions

```ts
export interface ResolveByIdentityKeyOptions {
    useContacts?: boolean;
    overrideWithContacts?: boolean;
    parallel?: boolean;
}
```

#### Property useContacts

Opt-in to consulting personal contacts before/alongside the overlay. Default `false`.

Most callers (including any client without a populated contacts basket) pay no benefit
from the contacts path and incur its setup cost. Set `true` only in UI contexts where
the user has likely saved contacts and a local cache hit is preferable to a fresh overlay
answer.

```ts
useContacts?: boolean
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
## Classes

| |
| --- |
| [ContactsManager](#class-contactsmanager) |
| [IdentityClient](#class-identityclient) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Class: ContactsManager

```ts
export class ContactsManager {
    constructor(wallet?: WalletInterface, originator?: string) 
    async getContacts(identityKey?: PubKeyHex, forceRefresh = false, limit = 1000): Promise<Contact[]> 
    async saveContact(contact: DisplayableIdentity, metadata?: Record<string, any>): Promise<void> 
    async removeContact(identityKey: string): Promise<void> 
}
```

See also: [Contact](./identity.md#type-contact), [DisplayableIdentity](./identity.md#interface-displayableidentity), [PubKeyHex](./wallet.md#type-pubkeyhex), [WalletInterface](./wallet.md#interface-walletinterface)

#### Method getContacts

Load all records from the contacts basket.

Concurrent calls share a single in-flight load (no thundering herd). After
the basket has been observed empty once, subsequent calls return `[]`
synchronously without hitting the wallet — until `forceRefresh` is passed
or a contact is saved/removed.

```ts
async getContacts(identityKey?: PubKeyHex, forceRefresh = false, limit = 1000): Promise<Contact[]> 
```
See also: [Contact](./identity.md#type-contact), [PubKeyHex](./wallet.md#type-pubkeyhex)

Argument Details

+ **identityKey**
  + Optional specific identity key to fetch
+ **forceRefresh**
  + Whether to force a check for new contact data
+ **limit**
  + Maximum number of contacts to return

#### Method removeContact

Remove a contact from the contacts basket

```ts
async removeContact(identityKey: string): Promise<void> 
```

Argument Details

+ **identityKey**
  + The identity key of the contact to remove

#### Method saveContact

Save or update a Metanet contact

```ts
async saveContact(contact: DisplayableIdentity, metadata?: Record<string, any>): Promise<void> 
```
See also: [DisplayableIdentity](./identity.md#interface-displayableidentity)

Argument Details

+ **contact**
  + The displayable identity information for the contact
+ **metadata**
  + Optional metadata to store with the contact (ex. notes, aliases, etc)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: IdentityClient

IdentityClient lets you discover who others are, and let the world know who you are.

```ts
export class IdentityClient {
    constructor(wallet?: WalletInterface, options: Partial<IdentityClientOptions> = {}, private readonly originator?: OriginatorDomainNameStringUnder250Bytes) 
    async publiclyRevealAttributes(certificate: WalletCertificate, fieldsToReveal: CertificateFieldNameUnder50Bytes[]): Promise<BroadcastResponse | BroadcastFailure> 
    async resolveByIdentityKey(args: DiscoverByIdentityKeyArgs, opts: boolean | ResolveByIdentityKeyOptions = false): Promise<DisplayableIdentity[]> 
    async resolveByAttributes(args: DiscoverByAttributesArgs, opts: boolean | ResolveByAttributesOptions = false): Promise<DisplayableIdentity[]> 
    async revokeCertificateRevelation(serialNumber: Base64String): Promise<void> 
    public async getContacts(identityKey?: PubKeyHex, forceRefresh = false, limit = 1000): Promise<Contact[]> 
    public async saveContact(contact: DisplayableIdentity, metadata?: Record<string, any>): Promise<void> 
    public async removeContact(identityKey: PubKeyHex): Promise<void> 
    static async parseIdentities(certs: IdentityCertificate[]): Promise<DisplayableIdentity[]> 
    static async parseIdentitiesWithOverrides(certs: IdentityCertificate[], contactByKey: Map<PubKeyHex, Contact>): Promise<DisplayableIdentity[]> 
    static parseIdentity(identityToParse: IdentityCertificate): DisplayableIdentity 
}
```

See also: [Base64String](./wallet.md#type-base64string), [BroadcastFailure](./transaction.md#interface-broadcastfailure), [BroadcastResponse](./transaction.md#interface-broadcastresponse), [CertificateFieldNameUnder50Bytes](./wallet.md#type-certificatefieldnameunder50bytes), [Contact](./identity.md#type-contact), [DiscoverByAttributesArgs](./wallet.md#interface-discoverbyattributesargs), [DiscoverByIdentityKeyArgs](./wallet.md#interface-discoverbyidentitykeyargs), [DisplayableIdentity](./identity.md#interface-displayableidentity), [IdentityCertificate](./wallet.md#interface-identitycertificate), [IdentityClientOptions](./identity.md#interface-identityclientoptions), [OriginatorDomainNameStringUnder250Bytes](./wallet.md#type-originatordomainnamestringunder250bytes), [PubKeyHex](./wallet.md#type-pubkeyhex), [ResolveByAttributesOptions](./identity.md#interface-resolvebyattributesoptions), [ResolveByIdentityKeyOptions](./identity.md#interface-resolvebyidentitykeyoptions), [WalletCertificate](./wallet.md#interface-walletcertificate), [WalletInterface](./wallet.md#interface-walletinterface)

#### Method getContacts

Load all records from the contacts basket

```ts
public async getContacts(identityKey?: PubKeyHex, forceRefresh = false, limit = 1000): Promise<Contact[]> 
```
See also: [Contact](./identity.md#type-contact), [PubKeyHex](./wallet.md#type-pubkeyhex)

Returns

A promise that resolves with an array of contacts

Argument Details

+ **identityKey**
  + Optional specific identity key to fetch
+ **forceRefresh**
  + Whether to force a check for new contact data
+ **limit**
  + Optional limit on number of contacts to fetch

#### Method parseIdentity

Parse out identity and certifier attributes to display from an IdentityCertificate

```ts
static parseIdentity(identityToParse: IdentityCertificate): DisplayableIdentity 
```
See also: [DisplayableIdentity](./identity.md#interface-displayableidentity), [IdentityCertificate](./wallet.md#interface-identitycertificate)

Returns

- IdentityToDisplay

Argument Details

+ **identityToParse**
  + The Identity Certificate to parse

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

+ **certificate**
  + The master certificate to selectively reveal.
+ **fieldsToReveal**
  + An array of certificate field names to reveal. Only these fields will be included in the public certificate.

Throws

Throws an error if the certificate is invalid, the fields cannot be revealed, or if the broadcast fails.

#### Method removeContact

Remove a contact from the contacts basket

```ts
public async removeContact(identityKey: PubKeyHex): Promise<void> 
```
See also: [PubKeyHex](./wallet.md#type-pubkeyhex)

Argument Details

+ **identityKey**
  + The identity key of the contact to remove

#### Method resolveByAttributes

```ts
async resolveByAttributes(args: DiscoverByAttributesArgs, opts: boolean | ResolveByAttributesOptions = false): Promise<DisplayableIdentity[]> 
```
See also: [DiscoverByAttributesArgs](./wallet.md#interface-discoverbyattributesargs), [DisplayableIdentity](./identity.md#interface-displayableidentity), [ResolveByAttributesOptions](./identity.md#interface-resolvebyattributesoptions)

Argument Details

+ **args**
  + Attributes and optional parameters used to discover certificates.
+ **opts**
  + Boolean (legacy) or options object. Boolean `true` ≡ `{ useContacts: true }`.

#### Method resolveByIdentityKey

Resolves displayable identity certificates issued to a given identity key.

**Default behavior (changed): contacts are NOT consulted.** Most clients have no
contacts saved locally, so the previous "contacts-first" default paid setup cost for no
gain. Pass `{ useContacts: true }` to opt in — appropriate when you know the user has
saved contacts and prefers a local hit over a fresh overlay answer.

When `useContacts: true`:
 - Default short-circuits: if a contact matches, the overlay is skipped entirely.
 - `{ parallel: true }` fires contacts and overlay in parallel; contact wins on hit.

```ts
async resolveByIdentityKey(args: DiscoverByIdentityKeyArgs, opts: boolean | ResolveByIdentityKeyOptions = false): Promise<DisplayableIdentity[]> 
```
See also: [DiscoverByIdentityKeyArgs](./wallet.md#interface-discoverbyidentitykeyargs), [DisplayableIdentity](./identity.md#interface-displayableidentity), [ResolveByIdentityKeyOptions](./identity.md#interface-resolvebyidentitykeyoptions)

Argument Details

+ **args**
  + Arguments for requesting the discovery based on the identity key.
+ **opts**
  + Boolean (legacy) or options object. Boolean `true` ≡ `{ useContacts: true }`.

#### Method revokeCertificateRevelation

Remove public certificate revelation from overlay services by spending the identity token

```ts
async revokeCertificateRevelation(serialNumber: Base64String): Promise<void> 
```
See also: [Base64String](./wallet.md#type-base64string)

Argument Details

+ **serialNumber**
  + Unique serial number of the certificate to revoke revelation

#### Method saveContact

Save or update a Metanet contact

```ts
public async saveContact(contact: DisplayableIdentity, metadata?: Record<string, any>): Promise<void> 
```
See also: [DisplayableIdentity](./identity.md#interface-displayableidentity)

Argument Details

+ **contact**
  + The displayable identity information for the contact
+ **metadata**
  + Optional metadata to store with the contact (ex. notes, aliases, etc)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
## Functions

## Types

### Type: Contact

```ts
export type Contact = DisplayableIdentity & {
    metadata?: Record<string, any>;
}
```

See also: [DisplayableIdentity](./identity.md#interface-displayableidentity)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
## Enums

## Variables

| |
| --- |
| [DEFAULT_IDENTITY_CLIENT_OPTIONS](#variable-default_identity_client_options) |
| [KNOWN_IDENTITY_TYPES](#variable-known_identity_types) |
| [defaultIdentity](#variable-defaultidentity) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Variable: DEFAULT_IDENTITY_CLIENT_OPTIONS

```ts
DEFAULT_IDENTITY_CLIENT_OPTIONS: IdentityClientOptions = {
    protocolID: [1, "identity"],
    keyID: "1",
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
    identiCert: "z40BOInXkI8m7f/wBrv4MJ09bZfzZbTj2fJqCtONqCY=",
    discordCert: "2TgqRC35B1zehGmB21xveZNc7i5iqHc0uxMb+1NMPW4=",
    phoneCert: "mffUklUzxbHr65xLohn0hRL0Tq2GjW1GYF/OPfzqJ6A=",
    xCert: "vdDWvftf1H+5+ZprUw123kjHlywH+v20aPQTuXgMpNc=",
    registrant: "YoPsbfR6YQczjzPdHCoGC7nJsOdPQR50+SYqcWpJ0y0=",
    emailCert: "exOl3KM0dIJ04EW5pZgbZmPag6MdJXd3/a1enmUU/BA=",
    anyone: "mfkOMfLDQmrr3SBxBQ5WeE+6Hy3VJRFq6w4A5Ljtlis=",
    self: "Hkge6X5JRxt1cWXtHLCrSTg6dCVTxjQJJ48iOYd7n3g=",
    coolCert: "AGfk/WrT1eBDXpz3mcw386Zww2HmqcIn3uY6x4Af1eo="
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Variable: defaultIdentity

```ts
defaultIdentity: DisplayableIdentity = {
    name: "Unknown Identity",
    avatarURL: "XUUB8bbn9fEthk15Ge3zTQXypUShfC94vFjp65v7u5CQ8qkpxzst",
    identityKey: "",
    abbreviatedKey: "",
    badgeIconURL: "XUUV39HVPkpmMzYNTx7rpKzJvXfeiVyQWg2vfSpjBAuhunTCA9uG",
    badgeLabel: "Not verified by anyone you trust.",
    badgeClickURL: "https://bsv-blockchain.github.io/ts-sdk/reference/identity/"
}
```

See also: [DisplayableIdentity](./identity.md#interface-displayableidentity)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
