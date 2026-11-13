# API

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

## Interfaces

| |
| --- |
| [PaginationQuery](#interface-paginationquery) |
| [SHIPQuery](#interface-shipquery) |
| [SHIPRecord](#interface-shiprecord) |
| [SLAPQuery](#interface-slapquery) |
| [SLAPRecord](#interface-slaprecord) |
| [UTXOReference](#interface-utxoreference) |
| [ValidatedPagination](#interface-validatedpagination) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---

### Interface: PaginationQuery

```ts
export interface PaginationQuery {
    limit?: number;
    skip?: number;
    sortOrder?: "asc" | "desc";
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
### Interface: SHIPQuery

```ts
export interface SHIPQuery {
    findAll?: boolean;
    domain?: string;
    topics?: string[];
    identityKey?: string;
    limit?: number;
    skip?: number;
    sortOrder?: "asc" | "desc";
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
### Interface: SHIPRecord

```ts
export interface SHIPRecord {
    txid: string;
    outputIndex: number;
    identityKey: string;
    domain: string;
    topic: string;
    createdAt: Date;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
### Interface: SLAPQuery

```ts
export interface SLAPQuery {
    findAll?: boolean;
    domain?: string;
    service?: string;
    identityKey?: string;
    limit?: number;
    skip?: number;
    sortOrder?: "asc" | "desc";
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
### Interface: SLAPRecord

```ts
export interface SLAPRecord {
    txid: string;
    outputIndex: number;
    identityKey: string;
    domain: string;
    service: string;
    createdAt: Date;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
### Interface: UTXOReference

```ts
export interface UTXOReference {
    txid: string;
    outputIndex: number;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
### Interface: ValidatedPagination

```ts
export interface ValidatedPagination {
    limit: number;
    skip: number;
    sortOrder: "asc" | "desc";
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Classes

| |
| --- |
| [SHIPLookupService](#class-shiplookupservice) |
| [SHIPStorage](#class-shipstorage) |
| [SHIPTopicManager](#class-shiptopicmanager) |
| [SLAPLookupService](#class-slaplookupservice) |
| [SLAPStorage](#class-slapstorage) |
| [SLAPTopicManager](#class-slaptopicmanager) |
| [WalletAdvertiser](#class-walletadvertiser) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---

### Class: SHIPLookupService

Implements the SHIP lookup service

The SHIP lookup service allows querying for overlay services hosting specific topics
within the overlay network.

```ts
export class SHIPLookupService implements LookupService {
    admissionMode: AdmissionMode = "locking-script";
    spendNotificationMode: SpendNotificationMode = "none";
    constructor(public storage: SHIPStorage)
    async outputAdmittedByTopic(payload: OutputAdmittedByTopic): Promise<void>
    async outputSpent(payload: OutputSpent): Promise<void>
    async outputEvicted(txid: string, outputIndex: number): Promise<void>
    async lookup(question: LookupQuestion): Promise<LookupFormula>
    async getDocumentation(): Promise<string>
    async getMetaData(): Promise<{
        name: string;
        shortDescription: string;
        iconURL?: string;
        version?: string;
        informationURL?: string;
    }>
}
```

See also: [SHIPStorage](#class-shipstorage)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
### Class: SHIPStorage

Implements a storage engine for SHIP protocol

```ts
export class SHIPStorage {
    constructor(private readonly db: Db)
    async ensureIndexes(): Promise<void>
    async hasDuplicateRecord(identityKey: string, domain: string, topic: string): Promise<boolean>
    async storeSHIPRecord(txid: string, outputIndex: number, identityKey: string, domain: string, topic: string): Promise<void>
    async deleteSHIPRecord(txid: string, outputIndex: number): Promise<void>
    async findRecord(query: SHIPQuery): Promise<UTXOReference[]>
    async findAll(limit?: number, skip?: number, sortOrder?: "asc" | "desc"): Promise<UTXOReference[]>
}
```

See also: [SHIPQuery](#interface-shipquery), [UTXOReference](#interface-utxoreference)

<details>

<summary>Class SHIPStorage Details</summary>

#### Constructor

Constructs a new SHIPStorage instance

```ts
constructor(private readonly db: Db)
```

Argument Details

+ **db**
  + connected mongo database instance

#### Method deleteSHIPRecord

Deletes a SHIP record

```ts
async deleteSHIPRecord(txid: string, outputIndex: number): Promise<void>
```

Argument Details

+ **txid**
  + transaction id
+ **outputIndex**
  + index of the UTXO

#### Method ensureIndexes

Ensures the necessary indexes are created for the collections.

```ts
async ensureIndexes(): Promise<void>
```

#### Method findAll

Returns all results tracked by the overlay

```ts
async findAll(limit?: number, skip?: number, sortOrder?: "asc" | "desc"): Promise<UTXOReference[]>
```
See also: [UTXOReference](#interface-utxoreference)

Returns

returns matching UTXO references

Argument Details

+ **limit**
  + Optional limit for pagination
+ **skip**
  + Optional skip for pagination
+ **sortOrder**
  + Optional sort order

#### Method findRecord

Finds SHIP records based on a given query object.

```ts
async findRecord(query: SHIPQuery): Promise<UTXOReference[]>
```
See also: [SHIPQuery](#interface-shipquery), [UTXOReference](#interface-utxoreference)

Returns

Returns matching UTXO references.

Argument Details

+ **query**
  + The query object which may contain properties for domain, topics, identityKey, limit, and skip.

#### Method hasDuplicateRecord

Checks if a SHIP record exists for the same provider and topic.

```ts
async hasDuplicateRecord(identityKey: string, domain: string, topic: string): Promise<boolean>
```

Returns

true if a matching record exists

Argument Details

+ **identityKey**
  + identity key
+ **domain**
  + domain name
+ **topic**
  + topic name

#### Method storeSHIPRecord

Stores a SHIP record

```ts
async storeSHIPRecord(txid: string, outputIndex: number, identityKey: string, domain: string, topic: string): Promise<void>
```

Argument Details

+ **txid**
  + transaction id
+ **outputIndex**
  + index of the UTXO
+ **identityKey**
  + identity key
+ **domain**
  + domain name
+ **topic**
  + topic name

</details>

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
### Class: SHIPTopicManager

🚢 SHIP Topic Manager
Implements the TopicManager interface for SHIP (Service Host Interconnect Protocol) tokens.

The SHIP Topic Manager identifies admissible outputs based on SHIP protocol requirements.
SHIP tokens facilitate the advertisement of nodes hosting specific topics within the overlay network.

```ts
export class SHIPTopicManager implements TopicManager {
    async identifyAdmissibleOutputs(beef: number[], previousCoins: number[]): Promise<AdmittanceInstructions>
    async getDocumentation(): Promise<string>
    async getMetaData(): Promise<{
        name: string;
        shortDescription: string;
        iconURL?: string;
        version?: string;
        informationURL?: string;
    }>
}
```

<details>

<summary>Class SHIPTopicManager Details</summary>

#### Method getDocumentation

Returns documentation specific to the SHIP topic manager.

```ts
async getDocumentation(): Promise<string>
```

Returns

A promise that resolves to the documentation string.

#### Method getMetaData

Returns metadata associated with this topic manager.

```ts
async getMetaData(): Promise<{
    name: string;
    shortDescription: string;
    iconURL?: string;
    version?: string;
    informationURL?: string;
}>
```

Returns

A promise that resolves to an object containing metadata.

#### Method identifyAdmissibleOutputs

Identifies admissible outputs for SHIP tokens.

```ts
async identifyAdmissibleOutputs(beef: number[], previousCoins: number[]): Promise<AdmittanceInstructions>
```

Returns

A promise that resolves with the admittance instructions.

Argument Details

+ **beef**
  + The transaction data in BEEF format.
+ **previousCoins**
  + The previous coins to consider.

</details>

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
### Class: SLAPLookupService

Implements the SLAP lookup service

The SLAP lookup service allows querying for service availability within the
overlay network. This service listens for SLAP-related UTXOs and stores relevant
records for lookup purposes.

```ts
export class SLAPLookupService implements LookupService {
    admissionMode: AdmissionMode = "locking-script";
    spendNotificationMode: SpendNotificationMode = "none";
    constructor(public storage: SLAPStorage)
    async outputAdmittedByTopic(payload: OutputAdmittedByTopic): Promise<void>
    async outputSpent(payload: OutputSpent): Promise<void>
    async outputEvicted(txid: string, outputIndex: number): Promise<void>
    async lookup(question: LookupQuestion): Promise<LookupFormula>
    async getDocumentation(): Promise<string>
    async getMetaData(): Promise<{
        name: string;
        shortDescription: string;
        iconURL?: string;
        version?: string;
        informationURL?: string;
    }>
}
```

See also: [SLAPStorage](#class-slapstorage)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
### Class: SLAPStorage

Implements a storage engine for SLAP protocol

```ts
export class SLAPStorage {
    constructor(private readonly db: Db)
    async ensureIndexes(): Promise<void>
    async hasDuplicateRecord(identityKey: string, domain: string, service: string): Promise<boolean>
    async storeSLAPRecord(txid: string, outputIndex: number, identityKey: string, domain: string, service: string): Promise<void>
    async deleteSLAPRecord(txid: string, outputIndex: number): Promise<void>
    async findRecord(query: SLAPQuery): Promise<UTXOReference[]>
    async findAll(limit?: number, skip?: number, sortOrder?: "asc" | "desc"): Promise<UTXOReference[]>
}
```

See also: [SLAPQuery](#interface-slapquery), [UTXOReference](#interface-utxoreference)

<details>

<summary>Class SLAPStorage Details</summary>

#### Constructor

Constructs a new SLAPStorage instance

```ts
constructor(private readonly db: Db)
```

Argument Details

+ **db**
  + connected mongo database instance

#### Method deleteSLAPRecord

Deletes a SLAP record

```ts
async deleteSLAPRecord(txid: string, outputIndex: number): Promise<void>
```

Argument Details

+ **txid**
  + transaction id
+ **outputIndex**
  + index of the UTXO

#### Method ensureIndexes

Ensures the necessary indexes are created for the collections.

```ts
async ensureIndexes(): Promise<void>
```

#### Method findAll

Returns all results tracked by the overlay

```ts
async findAll(limit?: number, skip?: number, sortOrder?: "asc" | "desc"): Promise<UTXOReference[]>
```
See also: [UTXOReference](#interface-utxoreference)

Returns

returns matching UTXO references

Argument Details

+ **limit**
  + Optional limit for pagination
+ **skip**
  + Optional skip for pagination
+ **sortOrder**
  + Optional sort order

#### Method findRecord

Finds SLAP records based on a given query object.

```ts
async findRecord(query: SLAPQuery): Promise<UTXOReference[]>
```
See also: [SLAPQuery](#interface-slapquery), [UTXOReference](#interface-utxoreference)

Returns

returns matching UTXO references

Argument Details

+ **query**
  + The query object which may contain properties for domain, service, and/or identityKey.

#### Method hasDuplicateRecord

Checks if a SLAP record exists for the same provider and service.

```ts
async hasDuplicateRecord(identityKey: string, domain: string, service: string): Promise<boolean>
```

Returns

true if a matching record exists

Argument Details

+ **identityKey**
  + identity key
+ **domain**
  + domain name
+ **service**
  + service name

#### Method storeSLAPRecord

Stores a SLAP record

```ts
async storeSLAPRecord(txid: string, outputIndex: number, identityKey: string, domain: string, service: string): Promise<void>
```

Argument Details

+ **txid**
  + transaction id
+ **outputIndex**
  + index of the UTXO
+ **identityKey**
  + identity key
+ **domain**
  + domain name
+ **service**
  + service name

</details>

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
### Class: SLAPTopicManager

🤚 SLAP Topic Manager
Implements the TopicManager interface for SLAP (Service Lookup Availability Protocol) tokens.

The SLAP Topic Manager identifies admissible outputs based on SLAP protocol requirements.
SLAP tokens facilitate the advertisement of lookup services availability within the overlay network.

```ts
export class SLAPTopicManager implements TopicManager {
    async identifyAdmissibleOutputs(beef: number[], previousCoins: number[]): Promise<AdmittanceInstructions>
    async getDocumentation(): Promise<string>
    async getMetaData(): Promise<{
        name: string;
        shortDescription: string;
        iconURL?: string;
        version?: string;
        informationURL?: string;
    }>
}
```

<details>

<summary>Class SLAPTopicManager Details</summary>

#### Method getDocumentation

Returns documentation specific to the SLAP topic manager.

```ts
async getDocumentation(): Promise<string>
```

Returns

A promise that resolves to the documentation string.

#### Method getMetaData

Returns metadata associated with this topic manager.

```ts
async getMetaData(): Promise<{
    name: string;
    shortDescription: string;
    iconURL?: string;
    version?: string;
    informationURL?: string;
}>
```

Returns

A promise that resolves to an object containing metadata.

#### Method identifyAdmissibleOutputs

Identifies admissible outputs for SLAP tokens.

```ts
async identifyAdmissibleOutputs(beef: number[], previousCoins: number[]): Promise<AdmittanceInstructions>
```

Returns

A promise that resolves with the admittance instructions.

Argument Details

+ **beef**
  + The transaction data in BEEF format.
+ **previousCoins**
  + The previous coins to consider.

</details>

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
### Class: WalletAdvertiser

Implements the Advertiser interface for managing SHIP and SLAP advertisements using a Wallet.

```ts
export class WalletAdvertiser implements Advertiser {
    constructor(public chain: "main" | "test" | "ttn", public privateKey: string, public storageURL: string, public advertisableURI: string, public lookupResolverConfig?: LookupResolverConfig)
    async init(): Promise<void>
    async createAdvertisements(adsData: AdvertisementData[]): Promise<TaggedBEEF>
    async findAllAdvertisements(protocol: "SHIP" | "SLAP"): Promise<Advertisement[]>
    async revokeAdvertisements(advertisements: Advertisement[]): Promise<TaggedBEEF>
    parseAdvertisement(outputScript: Script): Advertisement
}
```

<details>

<summary>Class WalletAdvertiser Details</summary>

#### Constructor

Constructs a new WalletAdvertiser instance.

```ts
constructor(public chain: "main" | "test" | "ttn", public privateKey: string, public storageURL: string, public advertisableURI: string, public lookupResolverConfig?: LookupResolverConfig)
```

Argument Details

+ **chain**
  + The blockchain (main, test, or TTN) where this advertiser is advertising
+ **privateKey**
  + The private key used for signing transactions.
+ **storageURL**
  + The URL of the UTXO storage server for the Wallet.
+ **advertisableURI**
  + The advertisable URI where services are made available.
+ **lookupResolverConfig**
  + — If provided, overrides the resolver config used for lookups. Otherwise defaults to the network preset associated with the wallet's network.

#### Method createAdvertisements

Utility function to create multiple advertisements in a single transaction.

```ts
async createAdvertisements(adsData: AdvertisementData[]): Promise<TaggedBEEF>
```

Returns

The Tagged BEEF for the created advertisement

Argument Details

+ **adsData**
  + Array of advertisement details.

Throws

Will throw an error if the locking key is invalid.

#### Method findAllAdvertisements

Finds this wallet identity's authenticated SHIP or SLAP advertisements.
Lookup results owned by another identity, carrying a forged signature, or
not bound to their returned transaction output are ignored.

```ts
async findAllAdvertisements(protocol: "SHIP" | "SLAP"): Promise<Advertisement[]>
```

Returns

A promise that resolves to an array of advertisements.

Argument Details

+ **protocol**
  + Whether SHIP or SLAP advertisements should be returned.

#### Method init

Initializes the wallet asynchronously.

```ts
async init(): Promise<void>
```

#### Method parseAdvertisement

Structurally parses a canonical advertisement from the provided output script.
This synchronous compatibility method does not verify the token signature;
security-sensitive callers must use a trusted admission result. This class's
create, find, and revoke flows perform cryptographic verification internally.

```ts
parseAdvertisement(outputScript: Script): Advertisement
```

Returns

An Advertisement object if the script matches the expected format, otherwise throws an error.

Argument Details

+ **outputScript**
  + The output script to parse.

#### Method revokeAdvertisements

Revokes an existing advertisement.

```ts
async revokeAdvertisements(advertisements: Advertisement[]): Promise<TaggedBEEF>
```

Returns

A promise that resolves to the revoked advertisement as TaggedBEEF.

Argument Details

+ **advertisements**
  + The advertisements to revoke, either SHIP or SLAP.

</details>

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Functions

| |
| --- |
| [definedProperties](#function-definedproperties) |
| [hasPreviousCoins](#function-haspreviouscoins) |
| [isAdmissibleDiscoveryOutput](#function-isadmissiblediscoveryoutput) |
| [logDiscoveryIdentificationError](#function-logdiscoveryidentificationerror) |
| [logDiscoverySummary](#function-logdiscoverysummary) |
| [parseDiscoveryTransaction](#function-parsediscoverytransaction) |
| [requireLookupQuery](#function-requirelookupquery) |
| [validateOptionalBoolean](#function-validateoptionalboolean) |
| [validateOptionalPublicKey](#function-validateoptionalpublickey) |
| [validateOptionalString](#function-validateoptionalstring) |
| [validateOptionalStringArray](#function-validateoptionalstringarray) |
| [validatePaginationQuery](#function-validatepaginationquery) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---

### Function: definedProperties

```ts
export function definedProperties<T extends object>(value: T): Partial<T>
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
### Function: hasPreviousCoins

```ts
export function hasPreviousCoins(previousCoins: number[] | undefined): boolean
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
### Function: isAdmissibleDiscoveryOutput

Validates the shared SHIP/SLAP advertisement envelope while retaining each
protocol's topic-or-service prefix requirement.

```ts
export async function isAdmissibleDiscoveryOutput(lockingScript: LockingScript, protocol: DiscoveryProtocol): Promise<boolean>
```

See also: [DiscoveryProtocol](#type-discoveryprotocol)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
### Function: logDiscoveryIdentificationError

Logs a parse failure only when nothing was admitted and no previous coin
was consumed, matching the prior per-protocol behavior.

```ts
export function logDiscoveryIdentificationError(protocol: DiscoveryProtocol, outputsToAdmit: number[], previousCoins: number[], error: unknown): void
```

See also: [DiscoveryProtocol](#type-discoveryprotocol)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
### Function: logDiscoverySummary

Emits the shared SHIP/SLAP admittance summary while preserving each
protocol's existing wording and emoji.

```ts
export function logDiscoverySummary(protocol: DiscoveryProtocol, outputsToAdmit: number[], previousCoins: number[]): void
```

See also: [DiscoveryProtocol](#type-discoveryprotocol)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
### Function: parseDiscoveryTransaction

Parses one strictly framed, resource-bounded discovery transaction.

```ts
export function parseDiscoveryTransaction(value: unknown): Transaction
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
### Function: requireLookupQuery

Reads a lookup question without invoking accessors and returns either the
legacy `findAll` query or an allowlisted plain-data query record.

```ts
export function requireLookupQuery(question: unknown, expectedService: string, allowedKeys: readonly string[]): "findAll" | LookupQueryRecord
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
### Function: validateOptionalBoolean

```ts
export function validateOptionalBoolean(value: unknown, path: string): boolean
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
### Function: validateOptionalPublicKey

```ts
export function validateOptionalPublicKey(value: unknown, path: string): string | undefined
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
### Function: validateOptionalString

```ts
export function validateOptionalString(value: unknown, path: string, maximumBytes = MAX_QUERY_STRING_BYTES): string | undefined
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
### Function: validateOptionalStringArray

```ts
export function validateOptionalStringArray(value: unknown, path: string): string[] | undefined
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
### Function: validatePaginationQuery

```ts
export function validatePaginationQuery(query: PaginationQuery): ValidatedPagination
```

See also: [PaginationQuery](#interface-paginationquery), [ValidatedPagination](#interface-validatedpagination)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Types

### Type: DiscoveryProtocol

```ts
export type DiscoveryProtocol = "SHIP" | "SLAP"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Variables

| |
| --- |
| [MAX_DISCOVERY_LOOKUP_RESULTS](#variable-max_discovery_lookup_results) |
| [MAX_DISCOVERY_LOOKUP_SKIP](#variable-max_discovery_lookup_skip) |
| [MAX_QUERY_NAME_BYTES](#variable-max_query_name_bytes) |
| [isAdvertisableURI](#variable-isadvertisableuri) |
| [isTokenSignatureCorrectlyLinked](#variable-istokensignaturecorrectlylinked) |
| [isValidTopicOrServiceName](#variable-isvalidtopicorservicename) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---

### Variable: MAX_DISCOVERY_LOOKUP_RESULTS

```ts
MAX_DISCOVERY_LOOKUP_RESULTS = 1000
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
### Variable: MAX_DISCOVERY_LOOKUP_SKIP

```ts
MAX_DISCOVERY_LOOKUP_SKIP = 1000000
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
### Variable: MAX_QUERY_NAME_BYTES

```ts
MAX_QUERY_NAME_BYTES = 256
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
### Variable: isAdvertisableURI

```ts
isAdvertisableURI = (uri: string): boolean => {
    if (typeof uri !== "string" || uri.trim() === "")
        return false;
    if (new TextEncoder().encode(uri).length > MAX_ADVERTISABLE_URI_BYTES)
        return false;
    const httpsPrefix = HTTPS_URI_PREFIXES.find(prefix => uri.startsWith(prefix));
    if (httpsPrefix !== undefined)
        return validateCustomHttpsURI(uri, httpsPrefix);
    if (uri.startsWith("wss://"))
        return validateWssURI(uri);
    if (uri.startsWith("js8c+bsvauth+smf:"))
        return validateJs8URI(uri);
    return false;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
### Variable: isTokenSignatureCorrectlyLinked

```ts
isTokenSignatureCorrectlyLinked = async (lockingPublicKey: PublicKey, fields: number[][]): Promise<boolean> => {
    try {
        if (!Array.isArray(fields) || fields.length !== 5)
            return false;
        for (let index = 0; index < fields.length; index++) {
            if (!Object.prototype.hasOwnProperty.call(fields, index) || !Array.isArray(fields[index])) {
                return false;
            }
        }
        const dataFields = fields.slice(0, -1);
        const signature = fields.at(-1)!;
        const protocol = Utils.toUTF8Strict(dataFields[0]);
        if (protocol !== "SHIP" && protocol !== "SLAP")
            return false;
        const protocolID: [
            2,
            string
        ] = [
            2,
            protocol === "SHIP"
                ? "service host interconnect"
                : "service lookup availability"
        ];
        const identityKey = Utils.toHex(dataFields[1]);
        if (PublicKey.fromString(identityKey).toString() !== identityKey)
            return false;
        const anyoneWallet = new ProtoWallet("anyone");
        const { valid } = await anyoneWallet.verifySignature({
            data: dataFields.flat(),
            signature,
            counterparty: identityKey,
            protocolID,
            keyID: "1"
        });
        if (valid !== true) {
            return false;
        }
        const { publicKey: expectedLockingPublicKey } = await anyoneWallet.getPublicKey({
            counterparty: identityKey,
            protocolID,
            keyID: "1"
        });
        return expectedLockingPublicKey === lockingPublicKey.toString();
    }
    catch {
        return false;
    }
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
### Variable: isValidTopicOrServiceName

```ts
isValidTopicOrServiceName = (service: string): boolean => {
    const serviceRegex = /^(?=.{1,256}$)(?:tm_|ls_)[a-z0-9]+(?:_[a-z0-9]+)*$/;
    return serviceRegex.test(service);
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
