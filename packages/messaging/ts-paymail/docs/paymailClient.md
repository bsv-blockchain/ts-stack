Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

# Interfaces

|                                                             |
| ----------------------------------------------------------- |
| [DNSResolverOptions](#interface-dnsresolveroptions)         |
| [DnsResolver](#interface-dnsresolver)                       |
| [DnsResponse](#interface-dnsresponse)                       |
| [P2PDestination](#interface-p2pdestination)                 |
| [P2POrdinalDestination](#interface-p2pordinaldestination)   |
| [P2POrdinalDestinations](#interface-p2pordinaldestinations) |
| [P2PPaymentDestination](#interface-p2ppaymentdestination)   |
| [P2PTransactionMetadata](#interface-p2ptransactionmetadata) |
| [P2PTransactionResponse](#interface-p2ptransactionresponse) |
| [PublicKeyInformation](#interface-publickeyinformation)     |
| [PublicKeyVerification](#interface-publickeyverification)   |
| [PublicProfile](#interface-publicprofile)                   |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---

## Interface: DNSResolverOptions

```ts
export interface DNSResolverOptions {
  dns?: DnsResolver
  dohServerBaseUrl?: string
}
```

See also: [DnsResolver](#interface-dnsresolver)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---

## Interface: DnsResolver

```ts
export interface DnsResolver {
  resolveSrv(
    domain: string,
    callback: (error: DnsError | null, records?: SrvRecord[]) => void
  ): void
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---

## Interface: DnsResponse

```ts
export interface DnsResponse {
  domain: string
  port: number
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---

## Interface: P2PDestination

```ts
export interface P2PDestination {
  script: string
  satoshis: number
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---

## Interface: P2POrdinalDestination

```ts
export interface P2POrdinalDestination {
  script: string
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---

## Interface: P2POrdinalDestinations

```ts
export interface P2POrdinalDestinations {
  outputs: P2POrdinalDestination[]
  reference: string
}
```

See also: [P2POrdinalDestination](#interface-p2pordinaldestination)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---

## Interface: P2PPaymentDestination

```ts
export interface P2PPaymentDestination {
  outputs: P2PDestination[]
  reference: string
}
```

See also: [P2PDestination](#interface-p2pdestination)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---

## Interface: P2PTransactionMetadata

```ts
export interface P2PTransactionMetadata {
  sender: string
  pubkey: string
  signature: string
  note: string
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---

## Interface: P2PTransactionResponse

```ts
export interface P2PTransactionResponse {
  txid: string
  note?: string | null
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---

## Interface: PublicKeyInformation

```ts
export interface PublicKeyInformation {
  bsvalias?: string
  handle: string
  pubkey: string
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---

## Interface: PublicKeyVerification

```ts
export interface PublicKeyVerification extends PublicKeyInformation {
  match: boolean
}
```

See also: [PublicKeyInformation](#interface-publickeyinformation)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---

## Interface: PublicProfile

```ts
export interface PublicProfile {
  name: string
  avatar: string
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---

# Classes

|                                       |
| ------------------------------------- |
| [HttpClient](#class-httpclient)       |
| [PaymailClient](#class-paymailclient) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---

## Class: HttpClient

```ts
export default class HttpClient {
  constructor(defaultTimeout = 30000)
  async request(url: string, options: RequestOptions = defaultRequestOptions): Promise<Response>
}
```

See also: [RequestOptions](#type-requestoptions)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---

## Class: PaymailClient

PaymailClient provides functionality to interact with BSV Paymail services.
It offers methods to retrieve public profiles, verify public keys, send transactions, etc.

```ts
export default class PaymailClient {
  constructor(httpClient?: HttpClient, dnsOptions?: DNSResolverOptions, localhostPort?: number)
  public readonly getDomainCapabilities = async (aDomain: string): Promise<DomainCapabilities> => {
    const cached = this._domainCapabilityCache.get(aDomain)
    if (cached !== undefined) return cached
    const capabilities = await this.fetchWellKnown(aDomain)
    this._domainCapabilityCache.set(aDomain, capabilities)
    return capabilities
  }
  public readonly getCapabilities = this.getDomainCapabilities
  public ensureCapabilityFor = async (aDomain: string, aCapability: string): Promise<string> => {
    const capabilities = await this.getDomainCapabilities(aDomain)
    const endpoint = capabilities[aCapability]
    if (typeof endpoint !== 'string' || endpoint.length === 0) {
      throw new PaymailServerResponseError(
        `Domain "${aDomain}" does not support capability "${aCapability}"`
      )
    }
    return endpoint
  }
  public request = async (
    aDomain: string,
    capability: Capability,
    body?: unknown
  ): Promise<unknown> => {
    const parsed = parsePaymail(aDomain)
    if (!parsed) {
      throw new PaymailServerResponseError(`Invalid Paymail address: "${aDomain}"`)
    }
    const { name, domain } = parsed
    const url = await this.ensureCapabilityFor(domain, capability.getCode())
    const requestUrl = url
      .replaceAll('{alias}', encodeURIComponent(name))
      .replaceAll('{domain.tld}', encodeURIComponent(domain))
    const response = await this.httpClient.request(requestUrl, {
      method: capability.getMethod(),
      body
    })
    const responseBody = await response.json()
    return responseBody
  }
  public getPublicProfile = async (paymail: string): Promise<PublicProfile> => {
    const response = await this.request(paymail, PublicProfileCapability)
    const schema = Joi.object({
      name: Joi.string().required(),
      avatar: Joi.string().uri().required()
    }).options({ stripUnknown: true })
    const { error, value } = schema.validate(response)
    if (error) {
      throw new PaymailServerResponseError(`Validation error: ${error.message}`)
    }
    return value as PublicProfile
  }
  public getPki = async (paymail: string): Promise<PublicKeyInformation> => {
    const response = await this.request(paymail, PublicKeyInfrastructureCapability)
    const schema = Joi.object({
      bsvalias: Joi.string().optional().allow('1.0'),
      handle: Joi.string().required(),
      pubkey: Joi.string().required()
    }).options({ stripUnknown: true })
    const { error, value } = schema.validate(response)
    if (error) {
      throw new PaymailServerResponseError(`Validation error: ${error.message}`)
    }
    return value as PublicKeyInformation
  }
  public getP2pPaymentDestination = async (
    paymail: string,
    satoshis: number
  ): Promise<P2PPaymentDestination> => {
    const response = await this.request(paymail, P2pPaymentDestinationCapability, {
      satoshis
    })
    const schema = Joi.object({
      outputs: Joi.array()
        .items(
          Joi.object({
            script: Joi.string().required(),
            satoshis: Joi.number().required()
          }).required()
        )
        .min(1),
      reference: Joi.string().required()
    }).options({ stripUnknown: true })
    const { error, value } = schema.validate(response)
    if (error) {
      throw new PaymailServerResponseError(`Validation error: ${error.message}`)
    }
    const destination = value as P2PPaymentDestination
    if (satoshis !== destination.outputs.reduce((acc, output) => acc + output.satoshis, 0)) {
      throw new PaymailServerResponseError(
        'The server did not return the expected amount of satoshis'
      )
    }
    return destination
  }
  public getP2pOrdinalDestinations = async (
    paymail: string,
    ordinals: number
  ): Promise<P2POrdinalDestinations> => {
    const response = await this.request(paymail, SimpleP2pOrdinalDestinationsCapability, {
      ordinals
    })
    const schema = Joi.object({
      outputs: Joi.array()
        .items(
          Joi.object({
            script: Joi.string().required()
          }).required()
        )
        .min(1),
      reference: Joi.string().required()
    }).options({ stripUnknown: true })
    const { error, value } = schema.validate(response)
    if (error) {
      throw new PaymailServerResponseError(`Validation error: ${error.message}`)
    }
    return value as P2POrdinalDestinations
  }
  public sendTransactionP2P = async (
    paymail: string,
    hex: string,
    reference: string,
    metadata?: P2PTransactionMetadata
  ): Promise<P2PTransactionResponse> => {
    const response = await this.request(paymail, ReceiveTransactionCapability, {
      hex,
      reference,
      metadata
    })
    const schema = Joi.object({
      txid: Joi.string().required(),
      note: Joi.string().optional().allow('', null)
    }).options({ stripUnknown: true })
    const { error, value } = schema.validate(response)
    if (error) {
      throw new PaymailServerResponseError(`Validation error: ${error.message}`)
    }
    return value as P2PTransactionResponse
  }
  public sendOrdinalTransactionP2P = async (
    paymail: string,
    hex: string,
    reference: string,
    metadata?: P2PTransactionMetadata
  ): Promise<P2PTransactionResponse> => {
    const response = await this.request(paymail, SimpleP2pOrdinalReceiveCapability, {
      hex,
      reference,
      metadata
    })
    const schema = Joi.object({
      txid: Joi.string().required(),
      note: Joi.string().optional().allow('', null)
    }).options({ stripUnknown: true })
    const { error, value } = schema.validate(response)
    if (error) {
      throw new PaymailServerResponseError(`Validation error: ${error.message}`)
    }
    return value as P2PTransactionResponse
  }
  public createP2PSignature = (txid: string, privKey: PrivateKey): string =>
    createP2PSignature(txid, privKey)
  public verifyPublicKey = async (
    paymail: string,
    pubkey: string
  ): Promise<PublicKeyVerification> => {
    const parsed = parsePaymail(paymail)
    if (!parsed) {
      throw new PaymailServerResponseError(`Invalid Paymail address: "${paymail}"`)
    }
    const { name, domain } = parsed
    const url = await this.ensureCapabilityFor(domain, VerifyPublicKeyOwnerCapability.getCode())
    const requestUrl = url
      .replaceAll('{alias}', encodeURIComponent(name))
      .replaceAll('{domain.tld}', encodeURIComponent(domain))
      .replaceAll('{pubkey}', encodeURIComponent(pubkey))
    const response = await this.httpClient.request(requestUrl)
    const responseBody = await response.json()
    const schema = Joi.object({
      bsvalias: Joi.string().optional().allow('1.0'),
      handle: Joi.string().required(),
      pubkey: Joi.string().required(),
      match: Joi.boolean().required()
    }).options({ stripUnknown: true })
    const { error, value } = schema.validate(responseBody)
    if (error) {
      throw new PaymailServerResponseError(`Validation error: ${error.message}`)
    }
    return value as PublicKeyVerification
  }
  public sendBeefTransactionP2P = async (
    paymail: string,
    beef: string,
    reference: string,
    metadata?: P2PTransactionMetadata
  ): Promise<P2PTransactionResponse> => {
    const response = await this.request(paymail, ReceiveBeefTransactionCapability, {
      beef,
      reference,
      metadata
    })
    const schema = Joi.object({
      txid: Joi.string().required(),
      note: Joi.string().optional().allow('', null)
    }).options({ stripUnknown: true })
    const { error, value } = schema.validate(response)
    if (error) {
      throw new PaymailServerResponseError(`Validation error: ${error.message}`)
    }
    return value as P2PTransactionResponse
  }
  public getTransactionNegotiationCapabilities = async (
    paymail: string
  ): Promise<Record<string, boolean>> => {
    const response = await this.request(paymail, NegotiationCapability)
    const schema = Joi.object({
      send_disabled: Joi.boolean().default(false),
      auto_send_response: Joi.boolean().default(false),
      receive: Joi.boolean().default(false),
      three_step_exchange: Joi.boolean().default(false),
      four_step_exchange: Joi.boolean().default(false),
      auto_exchange_response: Joi.boolean().default(false)
    }).options({ stripUnknown: true })
    const { error, value } = schema.validate(response)
    if (error) {
      throw new PaymailServerResponseError(`Validation error: ${error.message}`)
    }
    return value as Record<string, boolean>
  }
  public sendTransactionNegotiation = async (
    paymail: string,
    body: TransactionNegotiationBody
  ): Promise<unknown> => {
    const response = await this.request(paymail, TransactionNegotiationCapabilities, body)
    return response
  }
}
```

See also: [DNSResolverOptions](#interface-dnsresolveroptions), [DomainCapabilities](#type-domaincapabilities), [HttpClient](#class-httpclient), [P2POrdinalDestinations](#interface-p2pordinaldestinations), [P2PPaymentDestination](#interface-p2ppaymentdestination), [P2PTransactionMetadata](#interface-p2ptransactionmetadata), [P2PTransactionResponse](#interface-p2ptransactionresponse), [PublicKeyInformation](#interface-publickeyinformation), [PublicKeyVerification](#interface-publickeyverification), [PublicProfile](#interface-publicprofile)

<details>

<summary>Class PaymailClient Details</summary>

### Constructor

Constructs a new PaymailClient.

```ts
constructor(httpClient?: HttpClient, dnsOptions?: DNSResolverOptions, localhostPort?: number)
```

See also: [DNSResolverOptions](#interface-dnsresolveroptions), [HttpClient](#class-httpclient)

Argument Details

- **httpClient**
  - HTTP client for making network requests. If not provided, a default HttpClient is used.
- **dnsOptions**
  - Configuration options for DNS resolution.
- **localhostPort**
  - The port number for localhost development. Defaults to 3000 if not specified.

### Property createP2PSignature

Creates a digital signature for a P2P transaction using a given private key.

```ts
public createP2PSignature = (txid: string, privKey: PrivateKey): string => createP2PSignature(txid, privKey)
```

### Property ensureCapabilityFor

Ensures that a specified domain supports a given capability.

```ts
public ensureCapabilityFor = async (aDomain: string, aCapability: string): Promise<string> => {
    const capabilities = await this.getDomainCapabilities(aDomain);
    const endpoint = capabilities[aCapability];
    if (typeof endpoint !== "string" || endpoint.length === 0) {
        throw new PaymailServerResponseError(`Domain "${aDomain}" does not support capability "${aCapability}"`);
    }
    return endpoint;
}
```

### Property getP2pOrdinalDestinations

Requests a P2P ordinal destination for a given Paymail.

```ts
public getP2pOrdinalDestinations = async (paymail: string, ordinals: number): Promise<P2POrdinalDestinations> => {
    const response = await this.request(paymail, SimpleP2pOrdinalDestinationsCapability, {
        ordinals
    });
    const schema = Joi.object({
        outputs: Joi.array()
            .items(Joi.object({
            script: Joi.string().required()
        }).required())
            .min(1),
        reference: Joi.string().required()
    }).options({ stripUnknown: true });
    const { error, value } = schema.validate(response);
    if (error) {
        throw new PaymailServerResponseError(`Validation error: ${error.message}`);
    }
    return value as P2POrdinalDestinations;
}
```

See also: [P2POrdinalDestinations](#interface-p2pordinaldestinations)

### Property getP2pPaymentDestination

Requests a P2P payment destination for a given Paymail.

```ts
public getP2pPaymentDestination = async (paymail: string, satoshis: number): Promise<P2PPaymentDestination> => {
    const response = await this.request(paymail, P2pPaymentDestinationCapability, {
        satoshis
    });
    const schema = Joi.object({
        outputs: Joi.array()
            .items(Joi.object({
            script: Joi.string().required(),
            satoshis: Joi.number().required()
        }).required())
            .min(1),
        reference: Joi.string().required()
    }).options({ stripUnknown: true });
    const { error, value } = schema.validate(response);
    if (error) {
        throw new PaymailServerResponseError(`Validation error: ${error.message}`);
    }
    const destination = value as P2PPaymentDestination;
    if (satoshis !== destination.outputs.reduce((acc, output) => acc + output.satoshis, 0)) {
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
    const response = await this.request(paymail, PublicKeyInfrastructureCapability);
    const schema = Joi.object({
        bsvalias: Joi.string().optional().allow("1.0"),
        handle: Joi.string().required(),
        pubkey: Joi.string().required()
    }).options({ stripUnknown: true });
    const { error, value } = schema.validate(response);
    if (error) {
        throw new PaymailServerResponseError(`Validation error: ${error.message}`);
    }
    return value as PublicKeyInformation;
}
```

See also: [PublicKeyInformation](#interface-publickeyinformation)

### Property getPublicProfile

Retrieves the public profile associated with a Paymail address.

```ts
public getPublicProfile = async (paymail: string): Promise<PublicProfile> => {
    const response = await this.request(paymail, PublicProfileCapability);
    const schema = Joi.object({
        name: Joi.string().required(),
        avatar: Joi.string().uri().required()
    }).options({ stripUnknown: true });
    const { error, value } = schema.validate(response);
    if (error) {
        throw new PaymailServerResponseError(`Validation error: ${error.message}`);
    }
    return value as PublicProfile;
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
    }).options({ stripUnknown: true });
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
    const { name, domain } = parsed;
    const url = await this.ensureCapabilityFor(domain, capability.getCode());
    const requestUrl = url
        .replaceAll("{alias}", encodeURIComponent(name))
        .replaceAll("{domain.tld}", encodeURIComponent(domain));
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
    const response = await this.request(paymail, ReceiveBeefTransactionCapability, {
        beef,
        reference,
        metadata
    });
    const schema = Joi.object({
        txid: Joi.string().required(),
        note: Joi.string().optional().allow("", null)
    }).options({ stripUnknown: true });
    const { error, value } = schema.validate(response);
    if (error) {
        throw new PaymailServerResponseError(`Validation error: ${error.message}`);
    }
    return value as P2PTransactionResponse;
}
```

See also: [P2PTransactionMetadata](#interface-p2ptransactionmetadata), [P2PTransactionResponse](#interface-p2ptransactionresponse)

### Property sendOrdinalTransactionP2P

Sends a transaction using the Pay-to-Peer (P2P) protocol.
This method is used to send a transaction to a Paymail address.

```ts
public sendOrdinalTransactionP2P = async (paymail: string, hex: string, reference: string, metadata?: P2PTransactionMetadata): Promise<P2PTransactionResponse> => {
    const response = await this.request(paymail, SimpleP2pOrdinalReceiveCapability, {
        hex,
        reference,
        metadata
    });
    const schema = Joi.object({
        txid: Joi.string().required(),
        note: Joi.string().optional().allow("", null)
    }).options({ stripUnknown: true });
    const { error, value } = schema.validate(response);
    if (error) {
        throw new PaymailServerResponseError(`Validation error: ${error.message}`);
    }
    return value as P2PTransactionResponse;
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
    const response = await this.request(paymail, ReceiveTransactionCapability, {
        hex,
        reference,
        metadata
    });
    const schema = Joi.object({
        txid: Joi.string().required(),
        note: Joi.string().optional().allow("", null)
    }).options({ stripUnknown: true });
    const { error, value } = schema.validate(response);
    if (error) {
        throw new PaymailServerResponseError(`Validation error: ${error.message}`);
    }
    return value as P2PTransactionResponse;
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
    const { name, domain } = parsed;
    const url = await this.ensureCapabilityFor(domain, VerifyPublicKeyOwnerCapability.getCode());
    const requestUrl = url
        .replaceAll("{alias}", encodeURIComponent(name))
        .replaceAll("{domain.tld}", encodeURIComponent(domain))
        .replaceAll("{pubkey}", encodeURIComponent(pubkey));
    const response = await this.httpClient.request(requestUrl);
    const responseBody = await response.json();
    const schema = Joi.object({
        bsvalias: Joi.string().optional().allow("1.0"),
        handle: Joi.string().required(),
        pubkey: Joi.string().required(),
        match: Joi.boolean().required()
    }).options({ stripUnknown: true });
    const { error, value } = schema.validate(responseBody);
    if (error) {
        throw new PaymailServerResponseError(`Validation error: ${error.message}`);
    }
    return value as PublicKeyVerification;
}
```

See also: [PublicKeyVerification](#interface-publickeyverification)

</details>

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---

# Functions

# Types

|                                                |
| ---------------------------------------------- |
| [DomainCapabilities](#type-domaincapabilities) |
| [RequestOptions](#type-requestoptions)         |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---

## Type: DomainCapabilities

```ts
export type DomainCapabilities = Record<string, string | boolean>
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---

## Type: RequestOptions

```ts
export type RequestOptions = Omit<FetchOptions, 'body' | 'method'> & {
  method?: 'GET' | 'POST'
  body?: unknown
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---
