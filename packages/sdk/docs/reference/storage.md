# API

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

## Interfaces

| |
| --- |
| [DownloadResult](#interface-downloadresult) |
| [DownloaderConfig](#interface-downloaderconfig) |
| [EstimateCostResult](#interface-estimatecostresult) |
| [FindFileData](#interface-findfiledata) |
| [HostScopeOptions](#interface-hostscopeoptions) |
| [RenewFileResult](#interface-renewfileresult) |
| [RenewPerHostResult](#interface-renewperhostresult) |
| [UploadFileResult](#interface-uploadfileresult) |
| [UploadableFile](#interface-uploadablefile) |
| [UploaderConfig](#interface-uploaderconfig) |
| [VerifiedUHRPAdvertisement](#interface-verifieduhrpadvertisement) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Interface: DownloadResult

```ts
export interface DownloadResult {
    data: Uint8Array;
    mimeType: string | null;
}
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: DownloaderConfig

```ts
export interface DownloaderConfig {
    networkPreset?: LookupNetworkPreset;
    maxDownloadBytes?: number;
    fetchClient?: typeof fetch;
}
```

See also: [LookupNetworkPreset](./overlay-tools.md#type-lookupnetworkpreset)

#### Property fetchClient

Explicit transport injection for controlled/test environments.

```ts
fetchClient?: typeof fetch
```

#### Property maxDownloadBytes

Maximum file bytes materialized in memory. Defaults to 256 MiB.

```ts
maxDownloadBytes?: number
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: EstimateCostResult

```ts
export interface EstimateCostResult {
    quotes: Array<{
        host: string;
        amount: number;
    }>;
    resilienceLevel: number;
    totalForResilience: number;
    meetsResilienceThreshold: boolean;
}
```

See also: [string](./remittance.md#function-string)

#### Property meetsResilienceThreshold

False when `publishFile` would throw without uploading.

```ts
meetsResilienceThreshold: boolean
```

#### Property quotes

Cheapest-first quotes from configured providers.

```ts
quotes: Array<{
    host: string;
    amount: number;
}>
```
See also: [string](./remittance.md#function-string)

#### Property totalForResilience

Sum of the cheapest `resilienceLevel` amounts (or all collected, if below threshold).

```ts
totalForResilience: number
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: FindFileData

```ts
export interface FindFileData {
    name: string;
    size: string;
    mimeType: string;
    expiryTime: number;
    hostedBy?: string[];
}
```

See also: [string](./remittance.md#function-string)

#### Property hostedBy

Providers that reported this UHRP URL. Omitted in single-host mode.

```ts
hostedBy?: string[]
```
See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: HostScopeOptions

```ts
export interface HostScopeOptions {
    hostedBy?: string[];
}
```

See also: [string](./remittance.md#function-string)

#### Property hostedBy

Restrict the operation to this subset of configured providers.

```ts
hostedBy?: string[]
```
See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: RenewFileResult

```ts
export interface RenewFileResult {
    status: string;
    prevExpiryTime?: number;
    newExpiryTime?: number;
    amount?: number;
    results?: RenewPerHostResult[];
}
```

See also: [RenewPerHostResult](./storage.md#interface-renewperhostresult), [string](./remittance.md#function-string)

#### Property amount

Total satoshis paid across every host that renewed.

```ts
amount?: number
```

#### Property results

Per-host outcomes. Omitted in single-host mode.

```ts
results?: RenewPerHostResult[]
```
See also: [RenewPerHostResult](./storage.md#interface-renewperhostresult)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: RenewPerHostResult

```ts
export interface RenewPerHostResult {
    host: string;
    status: "success" | "error";
    prevExpiryTime?: number;
    newExpiryTime?: number;
    amount?: number;
    error?: string;
}
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: UploadFileResult

```ts
export interface UploadFileResult {
    published: boolean;
    uhrpURL: string;
    hostedBy: string[];
}
```

See also: [string](./remittance.md#function-string)

#### Property hostedBy

Providers that successfully hosted the file.

```ts
hostedBy: string[]
```
See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: UploadableFile

```ts
export interface UploadableFile {
    data: Uint8Array | number[];
    type: string;
}
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: UploaderConfig

```ts
export interface UploaderConfig {
    storageURL?: string;
    storageURLs?: string[];
    resilienceLevel?: number;
    wallet: WalletInterface;
    fetchClient?: typeof fetch;
}
```

See also: [WalletInterface](./wallet.md#interface-walletinterface), [string](./remittance.md#function-string)

#### Property fetchClient

Explicit transport injection for controlled/test environments.

```ts
fetchClient?: typeof fetch
```

#### Property resilienceLevel

Minimum replicas to store the file on. Defaults to 1.

```ts
resilienceLevel?: number
```

#### Property storageURL

Legacy single-host URL. Mutually exclusive with `storageURLs`.

```ts
storageURL?: string
```
See also: [string](./remittance.md#function-string)

#### Property storageURLs

Explicit provider list. Takes precedence over `storageURL`.

```ts
storageURLs?: string[]
```
See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: VerifiedUHRPAdvertisement

```ts
export interface VerifiedUHRPAdvertisement {
    hostIdentityKey: string;
    hash: number[];
    hostedFileLocation: string;
    expiryTime: number;
    fileSize: number;
    lockingPublicKey: PublicKey;
    signature: number[];
}
```

See also: [PublicKey](./primitives.md#class-publickey), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
## Classes

| |
| --- |
| [RenewResiliencyError](#class-renewresiliencyerror) |
| [StorageDownloader](#class-storagedownloader) |
| [StorageUploader](#class-storageuploader) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Class: RenewResiliencyError

Thrown by `renewFile` when successful renewals fall below the resilience
threshold. Per-host outcomes are attached so callers can reconcile which
providers were billed.

```ts
export class RenewResiliencyError extends Error {
    readonly results: RenewPerHostResult[];
    readonly requiredSuccesses: number;
    readonly successCount: number;
    constructor(message: string, results: RenewPerHostResult[], requiredSuccesses: number, successCount: number)
}
```

See also: [RenewPerHostResult](./storage.md#interface-renewperhostresult), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: StorageDownloader

```ts
export class StorageDownloader {
    readonly #networkPreset?: LookupNetworkPreset = "mainnet";
    readonly #lookupResolver: LookupResolver;
    readonly #maxDownloadBytes: number;
    readonly #fetchClient: typeof fetch;
    constructor(config?: DownloaderConfig)
    public async resolve(uhrpUrl: string): Promise<string[]>
    public async download(uhrpUrl: string): Promise<DownloadResult>
    async #tryDownload(url: string, expected: string): Promise<DownloadResult | undefined>
    async #readAndValidateBody(reader: ReadableStreamDefaultReader<Uint8Array>, expected: string, maximum: number): Promise<Uint8Array>
}
```

See also: [DownloadResult](./storage.md#interface-downloadresult), [DownloaderConfig](./storage.md#interface-downloaderconfig), [LookupNetworkPreset](./overlay-tools.md#type-lookupnetworkpreset), [LookupResolver](./overlay-tools.md#class-lookupresolver), [string](./remittance.md#function-string)

#### Method download

Downloads the content from the UHRP URL after validating the hash for integrity.

```ts
public async download(uhrpUrl: string): Promise<DownloadResult>
```
See also: [DownloadResult](./storage.md#interface-downloadresult), [string](./remittance.md#function-string)

Returns

A promise that resolves to the downloaded content.

Argument Details

+ **uhrpUrl**
  + The UHRP URL to download.

#### Method resolve

Resolves the UHRP URL to a list of HTTP URLs where content can be downloaded.

```ts
public async resolve(uhrpUrl: string): Promise<string[]>
```
See also: [string](./remittance.md#function-string)

Returns

A promise that resolves to an array of HTTP URLs.

Argument Details

+ **uhrpUrl**
  + The UHRP URL to resolve.

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: StorageUploader

Client for publishing, finding, listing, and renewing UHRP-hosted files
across one or more storage providers.

```ts
export class StorageUploader {
    constructor(config: UploaderConfig)
    async #getQuote(host: string, fileSize: number, retentionPeriod: number): Promise<ProviderQuote | null>
    async #getUploadURL(host: string, fileSize: number, retentionPeriod: number): Promise<{
        uploadURL: string;
        requiredHeaders: Record<string, string>;
        amount?: number;
    }>
    async #putFile(uploadURL: string, data: Uint8Array, contentType: string, requiredHeaders: Record<string, string>): Promise<void>
    async #collectQuotes(fileSize: number, retentionPeriod: number, maxNeeded: number): Promise<ProviderQuote[]>
    public async estimateCost(params: {
        fileSize: number;
        retentionPeriod: number;
    }): Promise<EstimateCostResult>
    public async publishFile(params: {
        file: UploadableFile;
        retentionPeriod: number;
    }): Promise<UploadFileResult>
    async #findFileAtHost(host: string, uhrpUrl: string): Promise<FindFileData>
    async #renewFileAtHost(host: string, uhrpUrl: string, additionalMinutes: number): Promise<{
        status: string;
        prevExpiryTime?: number;
        newExpiryTime?: number;
        amount?: number;
    }>
    #resolveTargets(hostedBy?: string[]): string[]
    public async findFile(uhrpUrl: string, options: HostScopeOptions = {}): Promise<FindFileData>
    async #listUploadsAtTargets(targets: string[]): Promise<ListUploadsOutcome[]>
    #requireListUploadSuccesses(outcomes: ListUploadsOutcome[], targetCount: number): ListUploadsSuccess[]
    #mergeUploadListings(successes: ListUploadsSuccess[]): Array<{
        uhrpUrl: string;
        expiryTime: number;
        hostedBy: string[];
    }>
    #mergeUploadEntry(merged: Map<string, {
        uhrpUrl: string;
        expiryTime: number;
        hostedBy: string[];
    }>, host: string, entry: any): void
    public async listUploads(options: HostScopeOptions = {}): Promise<any>
    async #listUploadsAtHost(host: string): Promise<any>
    public async renewFile(uhrpUrl: string, additionalMinutes: number, options: HostScopeOptions = {}): Promise<RenewFileResult>
}
```

See also: [EstimateCostResult](./storage.md#interface-estimatecostresult), [FindFileData](./storage.md#interface-findfiledata), [HostScopeOptions](./storage.md#interface-hostscopeoptions), [RenewFileResult](./storage.md#interface-renewfileresult), [UploadFileResult](./storage.md#interface-uploadfileresult), [UploadableFile](./storage.md#interface-uploadablefile), [UploaderConfig](./storage.md#interface-uploaderconfig), [string](./remittance.md#function-string)

#### Method

Returns `null` when the provider is unreachable or errors out.

```ts
async #getQuote(host: string, fileSize: number, retentionPeriod: number): Promise<ProviderQuote | null>
```
See also: [string](./remittance.md#function-string)

#### Method

Drives the authenticated `/upload` route; `AuthFetch` handles the 402 payment flow.

```ts
async #getUploadURL(host: string, fileSize: number, retentionPeriod: number): Promise<{
    uploadURL: string;
    requiredHeaders: Record<string, string>;
    amount?: number;
}>
```
See also: [string](./remittance.md#function-string)

#### Method

Collects quotes in parallel batches, shrinking each batch to only the
remaining quotes still needed so we never over-query once the quote
budget is satisfied.

```ts
async #collectQuotes(fileSize: number, retentionPeriod: number, maxNeeded: number): Promise<ProviderQuote[]>
```

#### Method

Intersects `hostedBy` with the configured host set; throws when empty.

```ts
#resolveTargets(hostedBy?: string[]): string[]
```
See also: [string](./remittance.md#function-string)

#### Method estimateCost

Queries the unauthenticated `/quote` endpoint on up to `2 * resilienceLevel`
providers and returns the cheapest-first quote list plus the aggregate
cost `publishFile` would pay. No provider is billed.

```ts
public async estimateCost(params: {
    fileSize: number;
    retentionPeriod: number;
}): Promise<EstimateCostResult>
```
See also: [EstimateCostResult](./storage.md#interface-estimatecostresult)

#### Method findFile

Fans `/find` out across configured hosts (UHRP storage is host-local,
so any one host may not know the file) and returns the record with the
longest remaining expiry. Single-host configurations preserve the
legacy error-message contract verbatim.

```ts
public async findFile(uhrpUrl: string, options: HostScopeOptions = {}): Promise<FindFileData>
```
See also: [FindFileData](./storage.md#interface-findfiledata), [HostScopeOptions](./storage.md#interface-hostscopeoptions), [string](./remittance.md#function-string)

#### Method listUploads

Unions `/list` output across configured hosts, merging duplicate UHRP
URLs by the longest expiry observed. One failing host does not hide
the rest. Single-host configurations preserve the legacy error contract.

```ts
public async listUploads(options: HostScopeOptions = {}): Promise<any>
```
See also: [HostScopeOptions](./storage.md#interface-hostscopeoptions)

#### Method publishFile

Publishes a file across the cheapest configured providers, falling
through to the next-cheapest quote if a paid upload fails. Throws when
the resilience threshold cannot be met.

```ts
public async publishFile(params: {
    file: UploadableFile;
    retentionPeriod: number;
}): Promise<UploadFileResult>
```
See also: [UploadFileResult](./storage.md#interface-uploadfileresult), [UploadableFile](./storage.md#interface-uploadablefile)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
## Functions

| |
| --- |
| [createPublicHTTPSFetch](#function-createpublichttpsfetch) |
| [createPublicNetworkFetch](#function-createpublicnetworkfetch) |
| [decodeAndVerifyUHRPAdvertisement](#function-decodeandverifyuhrpadvertisement) |
| [isPublicNetworkAddress](#function-ispublicnetworkaddress) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Function: createPublicHTTPSFetch

```ts
export function createPublicHTTPSFetch(expectedOrigin?: string, resolver: AddressResolver = defaultAddressResolver): typeof fetch
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: createPublicNetworkFetch

Build a fetch implementation that resolves and approves every address, then
pins the approved DNS answer into the TLS connection. This closes both
direct private-address SSRF and resolve/check/connect DNS-rebinding races.

```ts
export function createPublicNetworkFetch(options: {
    expectedOrigin?: string;
    allowHTTP?: boolean;
} = {}, resolver: AddressResolver = defaultAddressResolver): typeof fetch
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: decodeAndVerifyUHRPAdvertisement

Decode and cryptographically authenticate one canonical UHRP advertisement.

```ts
export async function decodeAndVerifyUHRPAdvertisement(lockingScript: LockingScript): Promise<VerifiedUHRPAdvertisement>
```

See also: [LockingScript](./script.md#class-lockingscript), [VerifiedUHRPAdvertisement](./storage.md#interface-verifieduhrpadvertisement)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: isPublicNetworkAddress

```ts
export function isPublicNetworkAddress(address: string): boolean
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
## Types

## Enums

## Variables

| |
| --- |
| [DEFAULT_STORAGE_DOWNLOAD_MAX_BYTES](#variable-default_storage_download_max_bytes) |
| [DEFAULT_UHRP_SERVERS](#variable-default_uhrp_servers) |
| [MAX_UHRP_ADVERTISEMENT_URL_BYTES](#variable-max_uhrp_advertisement_url_bytes) |
| [UHRP_ADVERTISEMENT_KEY_ID](#variable-uhrp_advertisement_key_id) |
| [UHRP_ADVERTISEMENT_PROTOCOL](#variable-uhrp_advertisement_protocol) |
| [getHashFromURL](#variable-gethashfromurl) |
| [getURLForFile](#variable-geturlforfile) |
| [getURLForHash](#variable-geturlforhash) |
| [isValidURL](#variable-isvalidurl) |
| [normalizeURL](#variable-normalizeurl) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Variable: DEFAULT_STORAGE_DOWNLOAD_MAX_BYTES

```ts
DEFAULT_STORAGE_DOWNLOAD_MAX_BYTES = 256 * 1024 * 1024
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Variable: DEFAULT_UHRP_SERVERS

```ts
DEFAULT_UHRP_SERVERS: string[] = [
    "https://nanostore.babbage.systems",
    "https://bsv-storage-cloudflare.dev-a3e.workers.dev"
]
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Variable: MAX_UHRP_ADVERTISEMENT_URL_BYTES

```ts
MAX_UHRP_ADVERTISEMENT_URL_BYTES = 2048
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Variable: UHRP_ADVERTISEMENT_KEY_ID

```ts
UHRP_ADVERTISEMENT_KEY_ID = "1"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Variable: UHRP_ADVERTISEMENT_PROTOCOL

```ts
UHRP_ADVERTISEMENT_PROTOCOL: WalletProtocol = [2, "uhrp advertisement"]
```

See also: [WalletProtocol](./wallet.md#type-walletprotocol)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Variable: getHashFromURL

```ts
getHashFromURL = (URL: string): number[] => {
    URL = normalizeURL(URL);
    const { data, prefix } = fromBase58Check(URL, undefined, 2);
    if (data.length !== 32) {
        throw new Error("Invalid length!");
    }
    if (toHex(prefix as number[]) !== "ce00") {
        throw new Error("Bad prefix");
    }
    return data as number[];
}
```

See also: [fromBase58Check](./primitives.md#variable-frombase58check), [normalizeURL](./storage.md#variable-normalizeurl), [string](./remittance.md#function-string), [toHex](./primitives.md#variable-tohex)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Variable: getURLForFile

```ts
getURLForFile = (file: Uint8Array | number[]): string => {
    const data = file instanceof Uint8Array ? file : Uint8Array.from(file);
    const hasher = new SHA256();
    const chunkSize = 1024 * 1024;
    for (let i = 0; i < data.length; i += chunkSize) {
        const chunk = data.subarray(i, i + chunkSize);
        hasher.update(Array.from(chunk));
    }
    const hash = hasher.digest();
    return getURLForHash(hash);
}
```

See also: [SHA256](./primitives.md#class-sha256), [getURLForHash](./storage.md#variable-geturlforhash), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Variable: getURLForHash

```ts
getURLForHash = (hash: number[]): string => {
    if (hash.length !== 32) {
        throw new Error("Hash length must be 32 bytes (sha256)");
    }
    return toBase58Check(hash, toArray("ce00", "hex"));
}
```

See also: [string](./remittance.md#function-string), [toArray](./primitives.md#variable-toarray), [toBase58Check](./primitives.md#variable-tobase58check)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Variable: isValidURL

```ts
isValidURL = (URL: string): boolean => {
    try {
        getHashFromURL(URL);
        return true;
    }
    catch {
        return false;
    }
}
```

See also: [getHashFromURL](./storage.md#variable-gethashfromurl), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Variable: normalizeURL

```ts
normalizeURL = (URL: string): string => {
    if (URL.toLowerCase().startsWith("uhrp:"))
        URL = URL.slice(5);
    if (URL.startsWith("//"))
        URL = URL.slice(2);
    return URL;
}
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
