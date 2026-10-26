
Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

# Interfaces

| | |
| --- | --- |
| [DNSResolverOptions](#interface-dnsresolveroptions) | [P2PPaymentDestination](#interface-p2ppaymentdestination) |
| [DnsResolver](#interface-dnsresolver) | [P2PTransactionMetadata](#interface-p2ptransactionmetadata) |
| [DnsResponse](#interface-dnsresponse) | [P2PTransactionResponse](#interface-p2ptransactionresponse) |
| [HttpClientOptions](#interface-httpclientoptions) | [PublicKeyInformation](#interface-publickeyinformation) |
| [P2PDestination](#interface-p2pdestination) | [PublicKeyVerification](#interface-publickeyverification) |
| [P2POrdinalDestination](#interface-p2pordinaldestination) | [PublicProfile](#interface-publicprofile) |
| [P2POrdinalDestinations](#interface-p2pordinaldestinations) | [ResolvedAddress](#interface-resolvedaddress) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---

## Interface: DNSResolverOptions

```ts
export interface DNSResolverOptions {
    dns?: DnsResolver;
    dohServerBaseUrl?: string;
}
```

See also: [DnsResolver](#interface-dnsresolver)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Interface: DnsResolver

```ts
export interface DnsResolver {
    resolveSrv(domain: string, callback: (error: DnsError | null, records?: SrvRecord[]) => void): void;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Interface: DnsResponse

```ts
export interface DnsResponse {
    domain: string;
    port: number;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Interface: HttpClientOptions

```ts
export interface HttpClientOptions {
    maxResponseBytes?: number;
    allowPrivateNetwork?: boolean;
    addressResolver?: (hostname: string) => Promise<ResolvedAddress[]>;
}
```

See also: [ResolvedAddress](#interface-resolvedaddress)

<details>

<summary>Interface HttpClientOptions Details</summary>

### Property addressResolver

Injectable DNS resolver used for deterministic testing and custom runtimes.

```ts
addressResolver?: (hostname: string) => Promise<ResolvedAddress[]>
```
See also: [ResolvedAddress](#interface-resolvedaddress)

### Property allowPrivateNetwork

Explicit opt-in for private-network HTTP services. Defaults to false.

```ts
allowPrivateNetwork?: boolean
```

### Property maxResponseBytes

Maximum response bytes materialized by one request. Defaults to 1 MiB.

```ts
maxResponseBytes?: number
```

</details>

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Interface: P2PDestination

```ts
export interface P2PDestination {
    script: string;
    satoshis: number;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Interface: P2POrdinalDestination

```ts
export interface P2POrdinalDestination {
    script: string;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Interface: P2POrdinalDestinations

```ts
export interface P2POrdinalDestinations {
    outputs: P2POrdinalDestination[];
    reference: string;
}
```

See also: [P2POrdinalDestination](#interface-p2pordinaldestination)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Interface: P2PPaymentDestination

```ts
export interface P2PPaymentDestination {
    outputs: P2PDestination[];
    reference: string;
}
```

See also: [P2PDestination](#interface-p2pdestination)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Interface: P2PTransactionMetadata

```ts
export interface P2PTransactionMetadata {
    sender: string;
    pubkey: string;
    signature: string;
    note: string;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Interface: P2PTransactionResponse

```ts
export interface P2PTransactionResponse {
    txid: string;
    note?: string | null;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Interface: PublicKeyInformation

```ts
export interface PublicKeyInformation {
    bsvalias?: string;
    handle: string;
    pubkey: string;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Interface: PublicKeyVerification

```ts
export interface PublicKeyVerification extends PublicKeyInformation {
    match: boolean;
}
```

See also: [PublicKeyInformation](#interface-publickeyinformation)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Interface: PublicProfile

```ts
export interface PublicProfile {
    name: string;
    avatar: string;
}
```

<details>

<summary>Interface PublicProfile Details</summary>

### Property avatar

Untrusted public HTTPS image location; referenced bytes are not authenticated by Paymail.

```ts
avatar: string
```

</details>

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Interface: ResolvedAddress

```ts
export interface ResolvedAddress {
    address: string;
    family: number;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
# Classes

| |
| --- |
| [HttpClient](#class-httpclient) |
| [PaymailClient](#class-paymailclient) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---

## Class: HttpClient

```ts
export default class HttpClient {
    constructor(defaultTimeout = 30000, options: HttpClientOptions = {})
    async request(url: string, options: RequestOptions = defaultRequestOptions): Promise<Response>
}
```

See also: [HttpClientOptions](#interface-httpclientoptions), [RequestOptions](#type-requestoptions)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Class: PaymailClient

PaymailClient provides functionality to interact with BSV Paymail services.
It offers methods to retrieve public profiles, verify public keys, send transactions, etc.

```ts
export default class PaymailClient {
    constructor(httpClient?: HttpClient, dnsOptions?: DNSResolverOptions, localhostPort?: number)
    public readonly getDomainCapabilities = async (aDomain: string): Promise<DomainCapabilities> => {
        const domain = this.validateDomain(aDomain);
        const cached = this._domainCapabilityCache.get(domain);
        if (cached !== undefined && cached.expiresAt > Date.now()) {
            this._domainCapabilityCache.delete(domain);
            this._domainCapabilityCache.set(domain, cached);
            return copyCapabilities(cached.value);
        }
        if (cached !== undefined)
            this._domainCapabilityCache.delete(domain);
        const pending = this.pendingCapabilities.get(domain);
        if (pending != null)
            return copyCapabilities(await pending);
        const discovery = this.fetchWellKnown(domain);
        this.pendingCapabilities.set(domain, discovery);
        try {
            const capabilities = copyCapabilities(await discovery);
            this._domainCapabilityCache.set(domain, {
                value: capabilities,
                expiresAt: Date.now() + CAPABILITY_CACHE_TTL_MS
            });
            while (this._domainCapabilityCache.size > MAX_CAPABILITY_CACHE_ENTRIES) {
                const oldest = this._domainCapabilityCache.keys().next().value;
                if (oldest == null)
                    break;
                this._domainCapabilityCache.delete(oldest);
            }
            return copyCapabilities(capabilities);
        }
        finally {
            this.pendingCapabilities.delete(domain);
        }
    };
    public readonly getCapabilities = this.getDomainCapabilities;
    public ensureCapabilityFor = async (aDomain: string, aCapability: string): Promise<string> => {
        const domain = this.validateDomain(aDomain);
        const capabilities = await this.getDomainCapabilities(domain);
        const endpoint = capabilities[aCapability];
        if (typeof endpoint !== "string" || endpoint.length === 0) {
            throw new PaymailServerResponseError(`Domain "${aDomain}" does not support capability "${aCapability}"`);
        }
        return this.validateServiceUrl(endpoint, domain);
    };
    public request = async (aDomain: string, capability: Capability, body?: unknown): Promise<unknown> => {
        const parsed = parsePaymail(aDomain);
        if (!parsed) {
            throw new PaymailServerResponseError(`Invalid Paymail address: "${aDomain}"`);
        }
        const { name } = parsed;
        const domain = this.validateDomain(parsed.domain);
        const url = await this.ensureCapabilityFor(domain, capability.getCode());
        const requestUrl = url
            .replaceAll("{alias}", encodeURIComponent(name))
            .replaceAll("{domain.tld}", encodeURIComponent(domain));
        this.validateServiceUrl(requestUrl, domain);
        const response = await this.httpClient.request(requestUrl, {
            method: capability.getMethod(),
            body
        });
        const responseBody = await response.json();
        return responseBody;
    };
    public getPublicProfile = async (paymail: string): Promise<PublicProfile> => {
        const parsedPaymail = parsePaymail(paymail);
        if (parsedPaymail == null) {
            throw new PaymailServerResponseError(`Invalid Paymail address: "${paymail}"`);
        }
        const response = await this.request(paymail, PublicProfileCapability);
        const schema = Joi.object({
            name: Joi.string().required(),
            avatar: Joi.string()
                .uri({ scheme: ["https"] })
                .custom((value: string, helpers) => {
                const url = new URL(value);
                return url.username !== "" || url.password !== "" || url.hash !== ""
                    ? helpers.error("string.uri")
                    : value;
            })
                .required()
        }).options({ stripUnknown: true, convert: false });
        const { error, value } = schema.validate(response);
        if (error) {
            throw new PaymailServerResponseError(`Validation error: ${error.message}`);
        }
        const profile = value as PublicProfile;
        this.validateServiceUrl(profile.avatar, this.validateDomain(parsedPaymail.domain));
        return { name: profile.name, avatar: profile.avatar };
    };
    public getPki = async (paymail: string): Promise<PublicKeyInformation> => {
        const parsedPaymail = parsePaymail(paymail);
        if (parsedPaymail == null) {
            throw new PaymailServerResponseError(`Invalid Paymail address: "${paymail}"`);
        }
        const response = await this.request(paymail, PublicKeyInfrastructureCapability);
        const schema = Joi.object({
            bsvalias: Joi.string().valid("1.0").optional(),
            handle: Joi.string().required(),
            pubkey: Joi.string().pattern(COMPRESSED_PUBLIC_KEY).required()
        }).options({ stripUnknown: true, convert: false });
        const { error, value } = schema.validate(response);
        if (error) {
            throw new PaymailServerResponseError(`Validation error: ${error.message}`);
        }
        const information = value as PublicKeyInformation;
        if (information.handle.toLowerCase() !== paymail.toLowerCase() ||
            !isCanonicalCompressedPublicKey(information.pubkey)) {
            throw new PaymailServerResponseError("Paymail PKI response identified a different handle");
        }
        return information;
    };
    public getP2pPaymentDestination = async (paymail: string, satoshis: number): Promise<P2PPaymentDestination> => {
        requirePositiveSafeInteger(satoshis, "satoshis");
        const response = await this.request(paymail, P2pPaymentDestinationCapability, {
            satoshis
        });
        const schema = Joi.object({
            outputs: Joi.array()
                .items(Joi.object({
                script: Joi.string()
                    .pattern(/^(?:[0-9a-fA-F]{2})+$/)
                    .max(MAX_SCRIPT_HEX_CHARS)
                    .required(),
                satoshis: Joi.number().integer().min(0).max(Number.MAX_SAFE_INTEGER).required()
            }).required())
                .min(1)
                .required(),
            reference: Joi.string().required()
        }).options({ stripUnknown: true, convert: false });
        const { error, value } = schema.validate(response);
        if (error) {
            throw new PaymailServerResponseError(`Validation error: ${error.message}`);
        }
        const destination = value as P2PPaymentDestination;
        let total = 0;
        for (const output of destination.outputs) {
            total += output.satoshis;
            if (!Number.isSafeInteger(total)) {
                throw new PaymailServerResponseError("The server returned an invalid satoshi total");
            }
        }
        if (satoshis !== total) {
            throw new PaymailServerResponseError("The server did not return the expected amount of satoshis");
        }
        return destination;
    };
    public getP2pOrdinalDestinations = async (paymail: string, ordinals: number): Promise<P2POrdinalDestinations> => {
        requirePositiveSafeInteger(ordinals, "ordinals");
        const response = await this.request(paymail, SimpleP2pOrdinalDestinationsCapability, {
            ordinals
        });
        const schema = Joi.object({
            outputs: Joi.array()
                .items(Joi.object({
                script: Joi.string()
                    .pattern(/^(?:[0-9a-fA-F]{2})+$/)
                    .max(MAX_SCRIPT_HEX_CHARS)
                    .required()
            }).required())
                .min(1)
                .required(),
            reference: Joi.string().required()
        }).options({ stripUnknown: true, convert: false });
        const { error, value } = schema.validate(response);
        if (error) {
            throw new PaymailServerResponseError(`Validation error: ${error.message}`);
        }
        const destinations = value as P2POrdinalDestinations;
        if (destinations.outputs.length !== ordinals) {
            throw new PaymailServerResponseError("The server did not return the requested count of ordinal destinations");
        }
        return destinations;
    };
    public sendTransactionP2P = async (paymail: string, hex: string, reference: string, metadata?: P2PTransactionMetadata): Promise<P2PTransactionResponse> => {
        const expectedTransactionId = transactionIdFromHex(hex);
        const response = await this.request(paymail, ReceiveTransactionCapability, {
            hex,
            reference,
            metadata
        });
        return validateTransactionResponse(response, expectedTransactionId);
    };
    public sendOrdinalTransactionP2P = async (paymail: string, hex: string, reference: string, metadata?: P2PTransactionMetadata): Promise<P2PTransactionResponse> => {
        const expectedTransactionId = transactionIdFromHex(hex);
        const response = await this.request(paymail, SimpleP2pOrdinalReceiveCapability, {
            hex,
            reference,
            metadata
        });
        return validateTransactionResponse(response, expectedTransactionId);
    };
    public createP2PSignature = (txid: string, privKey: PrivateKey): string => createP2PSignature(txid, privKey);
    public verifyPublicKey = async (paymail: string, pubkey: string): Promise<PublicKeyVerification> => {
        const parsed = parsePaymail(paymail);
        if (!parsed) {
            throw new PaymailServerResponseError(`Invalid Paymail address: "${paymail}"`);
        }
        const { name } = parsed;
        if (!isCanonicalCompressedPublicKey(pubkey)) {
            throw new PaymailServerResponseError("Invalid compressed public key");
        }
        const domain = this.validateDomain(parsed.domain);
        const url = await this.ensureCapabilityFor(domain, VerifyPublicKeyOwnerCapability.getCode());
        const requestUrl = url
            .replaceAll("{alias}", encodeURIComponent(name))
            .replaceAll("{domain.tld}", encodeURIComponent(domain))
            .replaceAll("{pubkey}", encodeURIComponent(pubkey));
        this.validateServiceUrl(requestUrl, domain);
        const response = await this.httpClient.request(requestUrl);
        const responseBody = await response.json();
        const schema = Joi.object({
            bsvalias: Joi.string().valid("1.0").optional(),
            handle: Joi.string().required(),
            pubkey: Joi.string().pattern(COMPRESSED_PUBLIC_KEY).required(),
            match: Joi.boolean().required()
        }).options({ stripUnknown: true, convert: false });
        const { error, value } = schema.validate(responseBody);
        if (error) {
            throw new PaymailServerResponseError(`Validation error: ${error.message}`);
        }
        const verification = value as PublicKeyVerification;
        if (verification.handle.toLowerCase() !== paymail.toLowerCase() ||
            verification.pubkey.toLowerCase() !== pubkey.toLowerCase() ||
            !isCanonicalCompressedPublicKey(verification.pubkey)) {
            throw new PaymailServerResponseError("Paymail ownership response did not match the requested handle and public key");
        }
        return verification;
    };
    public sendBeefTransactionP2P = async (paymail: string, beef: string, reference: string, metadata?: P2PTransactionMetadata): Promise<P2PTransactionResponse> => {
        const expectedTransactionId = transactionIdFromHex(beef, true);
        const response = await this.request(paymail, ReceiveBeefTransactionCapability, {
            beef,
            reference,
            metadata
        });
        return validateTransactionResponse(response, expectedTransactionId);
    };
    public getTransactionNegotiationCapabilities = async (paymail: string): Promise<Record<string, boolean>> => {
        const response = await this.request(paymail, NegotiationCapability);
        const schema = Joi.object({
            send_disabled: Joi.boolean().default(false),
            auto_send_response: Joi.boolean().default(false),
            receive: Joi.boolean().default(false),
            three_step_exchange: Joi.boolean().default(false),
            four_step_exchange: Joi.boolean().default(false),
            auto_exchange_response: Joi.boolean().default(false)
        }).options({ stripUnknown: true, convert: false });
        const { error, value } = schema.validate(response);
        if (error) {
            throw new PaymailServerResponseError(`Validation error: ${error.message}`);
        }
        return value as Record<string, boolean>;
    };
    public sendTransactionNegotiation = async (paymail: string, body: TransactionNegotiationBody): Promise<unknown> => {
        const response = await this.request(paymail, TransactionNegotiationCapabilities, body);
        return response;
    };
}
```

See also: [CAPABILITY_CACHE_TTL_MS](#variable-capability_cache_ttl_ms), [DNSResolverOptions](#interface-dnsresolveroptions), [DomainCapabilities](#type-domaincapabilities), [HttpClient](#class-httpclient), [MAX_CAPABILITY_CACHE_ENTRIES](#variable-max_capability_cache_entries), [P2POrdinalDestinations](#interface-p2pordinaldestinations), [P2PPaymentDestination](#interface-p2ppaymentdestination), [P2PTransactionMetadata](#interface-p2ptransactionmetadata), [P2PTransactionResponse](#interface-p2ptransactionresponse), [PublicKeyInformation](#interface-publickeyinformation), [PublicKeyVerification](#interface-publickeyverification), [PublicProfile](#interface-publicprofile)

<details>

<summary>Class PaymailClient Details</summary>

### Constructor

Constructs a new PaymailClient.

```ts
constructor(httpClient?: HttpClient, dnsOptions?: DNSResolverOptions, localhostPort?: number)
```
See also: [DNSResolverOptions](#interface-dnsresolveroptions), [HttpClient](#class-httpclient)

Argument Details

+ **httpClient**
  + HTTP client for making network requests. If not provided, a default HttpClient is used.
+ **dnsOptions**
  + Configuration options for DNS resolution.
+ **localhostPort**
  + The port number for localhost development. Defaults to 3000 if not specified.

### Property createP2PSignature

Creates a digital signature for a P2P transaction using a given private key.

```ts
public createP2PSignature = (txid: string, privKey: PrivateKey): string => createP2PSignature(txid, privKey)
```

### Property ensureCapabilityFor

Ensures that a specified domain supports a given capability.

```ts
public ensureCapabilityFor = async (aDomain: string, aCapability: string): Promise<string> => {
    const domain = this.validateDomain(aDomain);
    const capabilities = await this.getDomainCapabilities(domain);
    const endpoint = capabilities[aCapability];
    if (typeof endpoint !== "string" || endpoint.length === 0) {
        throw new PaymailServerResponseError(`Domain "${aDomain}" does not support capability "${aCapability}"`);
    }
    return this.validateServiceUrl(endpoint, domain);
}
```

### Property getP2pOrdinalDestinations

Requests a P2P ordinal destination for a given Paymail.

```ts
public getP2pOrdinalDestinations = async (paymail: string, ordinals: number): Promise<P2POrdinalDestinations> => {
    requirePositiveSafeInteger(ordinals, "ordinals");
    const response = await this.request(paymail, SimpleP2pOrdinalDestinationsCapability, {
        ordinals
    });
    const schema = Joi.object({
        outputs: Joi.array()
            .items(Joi.object({
            script: Joi.string()
                .pattern(/^(?:[0-9a-fA-F]{2})+$/)
                .max(MAX_SCRIPT_HEX_CHARS)
                .required()
        }).required())
            .min(1)
            .required(),
        reference: Joi.string().required()
    }).options({ stripUnknown: true, convert: false });
    const { error, value } = schema.validate(response);
    if (error) {
        throw new PaymailServerResponseError(`Validation error: ${error.message}`);
    }
    const destinations = value as P2POrdinalDestinations;
    if (destinations.outputs.length !== ordinals) {
        throw new PaymailServerResponseError("The server did not return the requested count of ordinal destinations");
    }
    return destinations;
}
```
See also: [P2POrdinalDestinations](#interface-p2pordinaldestinations)

### Property getP2pPaymentDestination

Requests a P2P payment destination for a given Paymail.

```ts
public getP2pPaymentDestination = async (paymail: string, satoshis: number): Promise<P2PPaymentDestination> => {
    requirePositiveSafeInteger(satoshis, "satoshis");
    const response = await this.request(paymail, P2pPaymentDestinationCapability, {
        satoshis
    });
    const schema = Joi.object({
        outputs: Joi.array()
            .items(Joi.object({
            script: Joi.string()
                .pattern(/^(?:[0-9a-fA-F]{2})+$/)
                .max(MAX_SCRIPT_HEX_CHARS)
                .required(),
            satoshis: Joi.number().integer().min(0).max(Number.MAX_SAFE_INTEGER).required()
        }).required())
            .min(1)
            .required(),
        reference: Joi.string().required()
    }).options({ stripUnknown: true, convert: false });
    const { error, value } = schema.validate(response);
    if (error) {
        throw new PaymailServerResponseError(`Validation error: ${error.message}`);
    }
    const destination = value as P2PPaymentDestination;
    let total = 0;
    for (const output of destination.outputs) {
        total += output.satoshis;
        if (!Number.isSafeInteger(total)) {
            throw new PaymailServerResponseError("The server returned an invalid satoshi total");
        }
    }
    if (satoshis !== total) {
        throw new PaymailServerResponseError("The server did not return the expected amount of satoshis");
    }
    return destination;
}
```
See also: [P2PPaymentDestination](#interface-p2ppaymentdestination)

### Property getPki

Retrieves the public key infrastructure (PKI) data for a given Paymail address.

```ts
public getPki = async (paymail: string): Promise<PublicKeyInformation> => {
    const parsedPaymail = parsePaymail(paymail);
    if (parsedPaymail == null) {
        throw new PaymailServerResponseError(`Invalid Paymail address: "${paymail}"`);
    }
    const response = await this.request(paymail, PublicKeyInfrastructureCapability);
    const schema = Joi.object({
        bsvalias: Joi.string().valid("1.0").optional(),
        handle: Joi.string().required(),
        pubkey: Joi.string().pattern(COMPRESSED_PUBLIC_KEY).required()
    }).options({ stripUnknown: true, convert: false });
    const { error, value } = schema.validate(response);
    if (error) {
        throw new PaymailServerResponseError(`Validation error: ${error.message}`);
    }
    const information = value as PublicKeyInformation;
    if (information.handle.toLowerCase() !== paymail.toLowerCase() ||
        !isCanonicalCompressedPublicKey(information.pubkey)) {
        throw new PaymailServerResponseError("Paymail PKI response identified a different handle");
    }
    return information;
}
```
See also: [PublicKeyInformation](#interface-publickeyinformation)

### Property getPublicProfile

Retrieves the public profile associated with a Paymail address.

```ts
public getPublicProfile = async (paymail: string): Promise<PublicProfile> => {
    const parsedPaymail = parsePaymail(paymail);
    if (parsedPaymail == null) {
        throw new PaymailServerResponseError(`Invalid Paymail address: "${paymail}"`);
    }
    const response = await this.request(paymail, PublicProfileCapability);
    const schema = Joi.object({
        name: Joi.string().required(),
        avatar: Joi.string()
            .uri({ scheme: ["https"] })
            .custom((value: string, helpers) => {
            const url = new URL(value);
            return url.username !== "" || url.password !== "" || url.hash !== ""
                ? helpers.error("string.uri")
                : value;
        })
            .required()
    }).options({ stripUnknown: true, convert: false });
    const { error, value } = schema.validate(response);
    if (error) {
        throw new PaymailServerResponseError(`Validation error: ${error.message}`);
    }
    const profile = value as PublicProfile;
    this.validateServiceUrl(profile.avatar, this.validateDomain(parsedPaymail.domain));
    return { name: profile.name, avatar: profile.avatar };
}
```
See also: [PublicProfile](#interface-publicprofile)

### Property getTransactionNegotiationCapabilities

Retrieves the transaction negotiation capabilities for a given Paymail.

```ts
public getTransactionNegotiationCapabilities = async (paymail: string): Promise<Record<string, boolean>> => {
    const response = await this.request(paymail, NegotiationCapability);
    const schema = Joi.object({
        send_disabled: Joi.boolean().default(false),
        auto_send_response: Joi.boolean().default(false),
        receive: Joi.boolean().default(false),
        three_step_exchange: Joi.boolean().default(false),
        four_step_exchange: Joi.boolean().default(false),
        auto_exchange_response: Joi.boolean().default(false)
    }).options({ stripUnknown: true, convert: false });
    const { error, value } = schema.validate(response);
    if (error) {
        throw new PaymailServerResponseError(`Validation error: ${error.message}`);
    }
    return value as Record<string, boolean>;
}
```

### Property request

Makes a generic request to a Paymail service.

```ts
public request = async (aDomain: string, capability: Capability, body?: unknown): Promise<unknown> => {
    const parsed = parsePaymail(aDomain);
    if (!parsed) {
        throw new PaymailServerResponseError(`Invalid Paymail address: "${aDomain}"`);
    }
    const { name } = parsed;
    const domain = this.validateDomain(parsed.domain);
    const url = await this.ensureCapabilityFor(domain, capability.getCode());
    const requestUrl = url
        .replaceAll("{alias}", encodeURIComponent(name))
        .replaceAll("{domain.tld}", encodeURIComponent(domain));
    this.validateServiceUrl(requestUrl, domain);
    const response = await this.httpClient.request(requestUrl, {
        method: capability.getMethod(),
        body
    });
    const responseBody = await response.json();
    return responseBody;
}
```

### Property sendBeefTransactionP2P

Sends a beef transaction using the Pay-to-Peer (P2P) protocol.

```ts
public sendBeefTransactionP2P = async (paymail: string, beef: string, reference: string, metadata?: P2PTransactionMetadata): Promise<P2PTransactionResponse> => {
    const expectedTransactionId = transactionIdFromHex(beef, true);
    const response = await this.request(paymail, ReceiveBeefTransactionCapability, {
        beef,
        reference,
        metadata
    });
    return validateTransactionResponse(response, expectedTransactionId);
}
```
See also: [P2PTransactionMetadata](#interface-p2ptransactionmetadata), [P2PTransactionResponse](#interface-p2ptransactionresponse)

### Property sendOrdinalTransactionP2P

Sends a transaction using the Pay-to-Peer (P2P) protocol.
This method is used to send a transaction to a Paymail address.

```ts
public sendOrdinalTransactionP2P = async (paymail: string, hex: string, reference: string, metadata?: P2PTransactionMetadata): Promise<P2PTransactionResponse> => {
    const expectedTransactionId = transactionIdFromHex(hex);
    const response = await this.request(paymail, SimpleP2pOrdinalReceiveCapability, {
        hex,
        reference,
        metadata
    });
    return validateTransactionResponse(response, expectedTransactionId);
}
```
See also: [P2PTransactionMetadata](#interface-p2ptransactionmetadata), [P2PTransactionResponse](#interface-p2ptransactionresponse)

### Property sendTransactionNegotiation

Sends a transaction negotiation request to a Paymail address.

```ts
public sendTransactionNegotiation = async (paymail: string, body: TransactionNegotiationBody): Promise<unknown> => {
    const response = await this.request(paymail, TransactionNegotiationCapabilities, body);
    return response;
}
```

### Property sendTransactionP2P

Sends a transaction using the Pay-to-Peer (P2P) protocol.
This method is used to send a transaction to a Paymail address.

```ts
public sendTransactionP2P = async (paymail: string, hex: string, reference: string, metadata?: P2PTransactionMetadata): Promise<P2PTransactionResponse> => {
    const expectedTransactionId = transactionIdFromHex(hex);
    const response = await this.request(paymail, ReceiveTransactionCapability, {
        hex,
        reference,
        metadata
    });
    return validateTransactionResponse(response, expectedTransactionId);
}
```
See also: [P2PTransactionMetadata](#interface-p2ptransactionmetadata), [P2PTransactionResponse](#interface-p2ptransactionresponse)

### Property verifyPublicKey

Verifies the ownership of a public key for a given Paymail address.

```ts
public verifyPublicKey = async (paymail: string, pubkey: string): Promise<PublicKeyVerification> => {
    const parsed = parsePaymail(paymail);
    if (!parsed) {
        throw new PaymailServerResponseError(`Invalid Paymail address: "${paymail}"`);
    }
    const { name } = parsed;
    if (!isCanonicalCompressedPublicKey(pubkey)) {
        throw new PaymailServerResponseError("Invalid compressed public key");
    }
    const domain = this.validateDomain(parsed.domain);
    const url = await this.ensureCapabilityFor(domain, VerifyPublicKeyOwnerCapability.getCode());
    const requestUrl = url
        .replaceAll("{alias}", encodeURIComponent(name))
        .replaceAll("{domain.tld}", encodeURIComponent(domain))
        .replaceAll("{pubkey}", encodeURIComponent(pubkey));
    this.validateServiceUrl(requestUrl, domain);
    const response = await this.httpClient.request(requestUrl);
    const responseBody = await response.json();
    const schema = Joi.object({
        bsvalias: Joi.string().valid("1.0").optional(),
        handle: Joi.string().required(),
        pubkey: Joi.string().pattern(COMPRESSED_PUBLIC_KEY).required(),
        match: Joi.boolean().required()
    }).options({ stripUnknown: true, convert: false });
    const { error, value } = schema.validate(responseBody);
    if (error) {
        throw new PaymailServerResponseError(`Validation error: ${error.message}`);
    }
    const verification = value as PublicKeyVerification;
    if (verification.handle.toLowerCase() !== paymail.toLowerCase() ||
        verification.pubkey.toLowerCase() !== pubkey.toLowerCase() ||
        !isCanonicalCompressedPublicKey(verification.pubkey)) {
        throw new PaymailServerResponseError("Paymail ownership response did not match the requested handle and public key");
    }
    return verification;
}
```
See also: [PublicKeyVerification](#interface-publickeyverification)

</details>

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
# Functions

# Types

| |
| --- |
| [DomainCapabilities](#type-domaincapabilities) |
| [RequestOptions](#type-requestoptions) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---

## Type: DomainCapabilities

```ts
export type DomainCapabilities = Record<string, string | boolean>
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Type: RequestOptions

```ts
export type RequestOptions = Omit<FetchOptions, "body" | "method"> & {
    method?: "GET" | "POST";
    body?: unknown;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
# Variables

| |
| --- |
| [CAPABILITY_CACHE_TTL_MS](#variable-capability_cache_ttl_ms) |
| [MAX_CAPABILITY_CACHE_ENTRIES](#variable-max_capability_cache_entries) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---

## Variable: CAPABILITY_CACHE_TTL_MS

```ts
CAPABILITY_CACHE_TTL_MS = 5 * 60 * 1000
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
## Variable: MAX_CAPABILITY_CACHE_ENTRIES

```ts
MAX_CAPABILITY_CACHE_ENTRIES = 256
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Variables](#variables)

---
