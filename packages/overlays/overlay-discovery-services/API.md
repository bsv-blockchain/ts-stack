# API

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Variables](#variables)

## Interfaces

| |
| --- |
| [SHIPQuery](#interface-shipquery) |
| [SHIPRecord](#interface-shiprecord) |
| [SLAPQuery](#interface-slapquery) |
| [SLAPRecord](#interface-slaprecord) |
| [UTXOReference](#interface-utxoreference) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Variables](#variables)

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

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Variables](#variables)

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

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Variables](#variables)

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

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Variables](#variables)

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

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Variables](#variables)

---
### Interface: UTXOReference

```ts
export interface UTXOReference {
    txid: string;
    outputIndex: number;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Variables](#variables)

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

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Variables](#variables)

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

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Variables](#variables)

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

Checks if a duplicate SHIP record exists with the same field values

```ts
async hasDuplicateRecord(identityKey: string, domain: string, topic: string): Promise<boolean> 
```

Returns

true if a duplicate exists

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

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Variables](#variables)

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

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Variables](#variables)

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

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Variables](#variables)

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

Checks if a duplicate SLAP record exists with the same field values

```ts
async hasDuplicateRecord(identityKey: string, domain: string, service: string): Promise<boolean> 
```

Returns

true if a duplicate exists

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

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Variables](#variables)

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

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Variables](#variables)

---
### Class: WalletAdvertiser

Implements the Advertiser interface for managing SHIP and SLAP advertisements using a Wallet.

```ts
export class WalletAdvertiser implements Advertiser {
    constructor(public chain: "main" | "test", public privateKey: string, public storageURL: string, public advertisableURI: string, public lookupResolverConfig?: LookupResolverConfig) 
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
constructor(public chain: "main" | "test", public privateKey: string, public storageURL: string, public advertisableURI: string, public lookupResolverConfig?: LookupResolverConfig) 
```

Argument Details

+ **chain**
  + The blockchain (main or test) where this advertiser is advertising
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

Finds all SHIP or SLAP advertisements for a given topic created by this identity.

```ts
async findAllAdvertisements(protocol: "SHIP" | "SLAP"): Promise<Advertisement[]> 
```

Returns

A promise that resolves to an array of advertisements.

Argument Details

+ **topic**
  + Whether SHIP or SLAP advertisements should be returned.

#### Method init

Initializes the wallet asynchronously.

```ts
async init(): Promise<void> 
```

#### Method parseAdvertisement

Parses an advertisement from the provided output script.

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

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Variables](#variables)

---
## Variables

| |
| --- |
| [isAdvertisableURI](#variable-isadvertisableuri) |
| [isTokenSignatureCorrectlyLinked](#variable-istokensignaturecorrectlylinked) |
| [isValidTopicOrServiceName](#variable-isvalidtopicorservicename) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Variables](#variables)

---

### Variable: isAdvertisableURI

```ts
isAdvertisableURI = (uri: string): boolean => {
    if (typeof uri !== "string" || uri.trim() === "")
        return false;
    const validateCustomHttpsURI = (uri: string, prefix: string): boolean => {
        try {
            const modifiedURI = uri.replace(prefix, "https://");
            const parsed = new URL(modifiedURI);
            if (parsed.hostname.toLowerCase() === "localhost")
                return false;
            if (parsed.pathname !== "/")
                return false;
            return true;
        }
        catch (e) {
            return false;
        }
    };
    if (uri.startsWith("https://")) {
        return validateCustomHttpsURI(uri, "https://");
    }
    else if (uri.startsWith("https+bsvauth://")) {
        return validateCustomHttpsURI(uri, "https+bsvauth://");
    }
    else if (uri.startsWith("https+bsvauth+smf://")) {
        return validateCustomHttpsURI(uri, "https+bsvauth+smf://");
    }
    else if (uri.startsWith("https+bsvauth+scrypt-offchain://")) {
        return validateCustomHttpsURI(uri, "https+bsvauth+scrypt-offchain://");
    }
    else if (uri.startsWith("https+rtt://")) {
        return validateCustomHttpsURI(uri, "https+rtt://");
    }
    else if (uri.startsWith("wss://")) {
        try {
            const parsed = new URL(uri);
            if (parsed.protocol !== "wss:")
                return false;
            if (parsed.hostname.toLowerCase() === "localhost")
                return false;
            return true;
        }
        catch (e) {
            return false;
        }
    }
    else if (uri.startsWith("js8c+bsvauth+smf:")) {
        const queryIndex = uri.indexOf("?");
        if (queryIndex === -1)
            return false;
        const queryStr = uri.substring(queryIndex);
        const params = new URLSearchParams(queryStr);
        const latStr = params.get("lat");
        const longStr = params.get("long");
        const freqStr = params.get("freq");
        const radiusStr = params.get("radius");
        if (!latStr || !longStr || !freqStr || !radiusStr)
            return false;
        const lat = parseFloat(latStr);
        const lon = parseFloat(longStr);
        if (isNaN(lat) || lat < -90 || lat > 90)
            return false;
        if (isNaN(lon) || lon < -180 || lon > 180)
            return false;
        const freqMatch = freqStr.match(/(\d+(\.\d+)?)/);
        if (!freqMatch)
            return false;
        const freqVal = parseFloat(freqMatch[1]);
        if (isNaN(freqVal) || freqVal <= 0)
            return false;
        const radiusMatch = radiusStr.match(/(\d+(\.\d+)?)/);
        if (!radiusMatch)
            return false;
        const radiusVal = parseFloat(radiusMatch[1]);
        if (isNaN(radiusVal) || radiusVal <= 0)
            return false;
        return true;
    }
    return false;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Variables](#variables)

---
### Variable: isTokenSignatureCorrectlyLinked

```ts
isTokenSignatureCorrectlyLinked = async (lockingPublicKey: PublicKey, fields: number[][]): Promise<boolean> => {
    const signature = fields.pop();
    const protocolID: [
        2,
        string
    ] = [2, Utils.toUTF8(fields[0]) === "SHIP" ? "service host interconnect" : "service lookup availability"];
    const identityKey = Utils.toHex(fields[1]);
    const data = fields.reduce((a, e) => [...a, ...e], []);
    const anyoneWallet = new ProtoWallet("anyone");
    try {
        const { valid } = await anyoneWallet.verifySignature({
            data,
            signature,
            counterparty: identityKey,
            protocolID,
            keyID: "1"
        });
        if (!valid) {
            return false;
        }
    }
    catch (e) {
        return false;
    }
    const { publicKey: expectedLockingPublicKey } = await anyoneWallet.getPublicKey({
        counterparty: identityKey,
        protocolID,
        keyID: "1"
    });
    return expectedLockingPublicKey === lockingPublicKey.toString();
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Variables](#variables)

---
### Variable: isValidTopicOrServiceName

```ts
isValidTopicOrServiceName = (service: string): boolean => {
    const serviceRegex = /^(?=.{1,50}$)(?:tm_|ls_)[a-z]+(?:_[a-z]+)*$/;
    return serviceRegex.test(service);
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Variables](#variables)

---
