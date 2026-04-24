
Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes)

# Interfaces

| |
| --- |
| [DNSResolverOptions](#interface-dnsresolveroptions) |
| [DnsResponse](#interface-dnsresponse) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes)

---

## Interface: DnsResponse

```ts
export interface DnsResponse {
    domain: string;
    port: number;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes)

---
## Interface: DNSResolverOptions

```ts
export interface DNSResolverOptions {
    dns?: any;
    dohServerBaseUrl?: string;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes)

---
# Classes

| |
| --- |
| [HttpClient](#class-httpclient) |
| [PaymailClient](#class-paymailclient) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes)

---

## Class: HttpClient

```ts
export default class HttpClient {
    constructor(fetch: Fetch, defaultTimeout = 30000) 
    async request(url: string, options: (FetchOptions & {
        method: "GET" | "POST";
        body?: any;
    }) = {
        method: "GET"
    }): Promise<Response> 
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes)

---
## Class: PaymailClient

PaymailClient provides functionality to interact with BSV Paymail services.
It offers methods to retrieve public profiles, verify public keys, send transactions, etc.

```ts
export default class PaymailClient {
    constructor(httpClient?: HttpClient, dnsOptions?: DNSResolverOptions, localhostPort?: number) 
    public ensureCapabilityFor = async (aDomain, aCapability) => {
        const capabilities = await this.getDomainCapabilities(aDomain);
        if (!capabilities[aCapability]) {
            throw new PaymailServerResponseError(`Domain "${aDomain}" does not support capability "${aCapability}"`);
        }
        return capabilities[aCapability];
    };
    public request = async (aDomain: string, capability: Capability, body?: any) => {
        const [name, domain] = aDomain.split("@");
        const url = await this.ensureCapabilityFor(domain, capability.getCode());
        const requestUrl = url.replace("{alias}", name).replace("{domain.tld}", domain);
        const response = await this.httpClient.request(requestUrl, {
            method: capability.getMethod(),
            body
        });
        const responseBody = await response.json();
        return responseBody;
    };
    public getPublicProfile = async (paymail) => {
        const response = await this.request(paymail, PublicProfileCapability);
        const schema = Joi.object({
            name: Joi.string().required(),
            avatar: Joi.string().uri().required()
        }).options({ stripUnknown: true });
        const { error, value } = schema.validate(response);
        if (error) {
            throw new PaymailServerResponseError(`Validation error: ${error.message}`);
        }
        return value;
    };
    public getPki = async (paymail) => {
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
        return value;
    };
    public getP2pPaymentDestination = async (paymail: string, satoshis: number): Promise<any> => {
        const response = await this.request(paymail, P2pPaymentDestinationCapability, {
            satoshis
        });
        const schema = Joi.object({
            outputs: Joi.array().items(Joi.object({
                script: Joi.string().required(),
                satoshis: Joi.number().required()
            }).required().min(1)),
            reference: Joi.string().required()
        }).options({ stripUnknown: true });
        const { error } = schema.validate(response);
        if (error) {
            throw new PaymailServerResponseError(`Validation error: ${error.message}`);
        }
        if (satoshis !== response.outputs.reduce((acc, output) => acc + output.satoshis, 0)) {
            throw new PaymailServerResponseError("The server did not return the expected amount of satoshis");
        }
        return response;
    };
    public getP2pOrdinalDestinations = async (paymail: string, ordinals: number): Promise<any> => {
        const response = await this.request(paymail, SimpleP2pOrdinalDestinationsCapability, {
            ordinals
        });
        const schema = Joi.object({
            outputs: Joi.array().items(Joi.object({
                script: Joi.string().required()
            }).required().min(1)),
            reference: Joi.string().required()
        }).options({ stripUnknown: true });
        const { error } = schema.validate(response);
        if (error) {
            throw new PaymailServerResponseError(`Validation error: ${error.message}`);
        }
        return response;
    };
    public sendTransactionP2P = async (paymail: string, hex: string, reference: string, metadata?: {
        sender: string;
        pubkey: string;
        signature: string;
        note: string;
    }) => {
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
        return value;
    };
    public sendOrdinalTransactionP2P = async (paymail: string, hex: string, reference: string, metadata?: {
        sender: string;
        pubkey: string;
        signature: string;
        note: string;
    }) => {
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
        return value;
    };
    public createP2PSignature = (txid: string, privKey: PrivateKey): string => {
        const msg = Utils.toArray(txid, "utf8");
        const msgHash = BSM.magicHash(msg);
        const sig = BSM.sign(msg, privKey);
        const recovery = sig.CalculateRecoveryFactor(privKey.toPublicKey(), new BigNumber(msgHash));
        return sig.toCompact(recovery, true, "base64") as string;
    };
    public verifyPublicKey = async (paymail, pubkey) => {
        const [name, domain] = paymail.split("@");
        const url = await this.ensureCapabilityFor(domain, VerifyPublicKeyOwnerCapability.getCode());
        const requestUrl = url.replace("{alias}", name).replace("{domain.tld}", domain).replace("{pubkey}", pubkey);
        const response = await this.httpClient.request(requestUrl);
        const responseBody = await response.json();
        const schema = Joi.object({
            bsvalias: Joi.string().optional().allow("1.0"),
            handle: Joi.string().required(),
            pubkey: Joi.string().required(),
            match: Joi.boolean().required()
        }).options({ stripUnknown: true });
        const { error } = schema.validate(responseBody);
        if (error) {
            throw new PaymailServerResponseError(`Validation error: ${error.message}`);
        }
        return responseBody;
    };
    public sendBeefTransactionP2P = async (paymail: string, beef: string, reference: string, metadata?: {
        sender: string;
        pubkey: string;
        signature: string;
        note: string;
    }) => {
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
        return value;
    };
    public getTransactionNegotiationCapabilities = async (paymail: string) => {
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
        return value;
    };
    public sendTransactionNegotiation = async (paymail: string, body: TransactionNegotiationBody) => {
        const response = await this.request(paymail, TransactionNegotiationCapabilities, body);
        return response;
    };
}
```

<details>

<summary>Class PaymailClient Details</summary>

### Constructor

Constructs a new PaymailClient.

```ts
constructor(httpClient?: HttpClient, dnsOptions?: DNSResolverOptions, localhostPort?: number) 
```

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
public createP2PSignature = (txid: string, privKey: PrivateKey): string => {
    const msg = Utils.toArray(txid, "utf8");
    const msgHash = BSM.magicHash(msg);
    const sig = BSM.sign(msg, privKey);
    const recovery = sig.CalculateRecoveryFactor(privKey.toPublicKey(), new BigNumber(msgHash));
    return sig.toCompact(recovery, true, "base64") as string;
}
```

### Property ensureCapabilityFor

Ensures that a specified domain supports a given capability.

```ts
public ensureCapabilityFor = async (aDomain, aCapability) => {
    const capabilities = await this.getDomainCapabilities(aDomain);
    if (!capabilities[aCapability]) {
        throw new PaymailServerResponseError(`Domain "${aDomain}" does not support capability "${aCapability}"`);
    }
    return capabilities[aCapability];
}
```

### Property getP2pOrdinalDestinations

Requests a P2P ordinal destination for a given Paymail.

```ts
public getP2pOrdinalDestinations = async (paymail: string, ordinals: number): Promise<any> => {
    const response = await this.request(paymail, SimpleP2pOrdinalDestinationsCapability, {
        ordinals
    });
    const schema = Joi.object({
        outputs: Joi.array().items(Joi.object({
            script: Joi.string().required()
        }).required().min(1)),
        reference: Joi.string().required()
    }).options({ stripUnknown: true });
    const { error } = schema.validate(response);
    if (error) {
        throw new PaymailServerResponseError(`Validation error: ${error.message}`);
    }
    return response;
}
```

### Property getP2pPaymentDestination

Requests a P2P payment destination for a given Paymail.

```ts
public getP2pPaymentDestination = async (paymail: string, satoshis: number): Promise<any> => {
    const response = await this.request(paymail, P2pPaymentDestinationCapability, {
        satoshis
    });
    const schema = Joi.object({
        outputs: Joi.array().items(Joi.object({
            script: Joi.string().required(),
            satoshis: Joi.number().required()
        }).required().min(1)),
        reference: Joi.string().required()
    }).options({ stripUnknown: true });
    const { error } = schema.validate(response);
    if (error) {
        throw new PaymailServerResponseError(`Validation error: ${error.message}`);
    }
    if (satoshis !== response.outputs.reduce((acc, output) => acc + output.satoshis, 0)) {
        throw new PaymailServerResponseError("The server did not return the expected amount of satoshis");
    }
    return response;
}
```

### Property getPki

Retrieves the public key infrastructure (PKI) data for a given Paymail address.

```ts
public getPki = async (paymail) => {
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
    return value;
}
```

### Property getPublicProfile

Retrieves the public profile associated with a Paymail address.

```ts
public getPublicProfile = async (paymail) => {
    const response = await this.request(paymail, PublicProfileCapability);
    const schema = Joi.object({
        name: Joi.string().required(),
        avatar: Joi.string().uri().required()
    }).options({ stripUnknown: true });
    const { error, value } = schema.validate(response);
    if (error) {
        throw new PaymailServerResponseError(`Validation error: ${error.message}`);
    }
    return value;
}
```

### Property getTransactionNegotiationCapabilities

Retrieves the transaction negotiation capabilities for a given Paymail.

```ts
public getTransactionNegotiationCapabilities = async (paymail: string) => {
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
    return value;
}
```

### Property request

Makes a generic request to a Paymail service.

```ts
public request = async (aDomain: string, capability: Capability, body?: any) => {
    const [name, domain] = aDomain.split("@");
    const url = await this.ensureCapabilityFor(domain, capability.getCode());
    const requestUrl = url.replace("{alias}", name).replace("{domain.tld}", domain);
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
public sendBeefTransactionP2P = async (paymail: string, beef: string, reference: string, metadata?: {
    sender: string;
    pubkey: string;
    signature: string;
    note: string;
}) => {
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
    return value;
}
```

### Property sendOrdinalTransactionP2P

Sends a transaction using the Pay-to-Peer (P2P) protocol.
This method is used to send a transaction to a Paymail address.

```ts
public sendOrdinalTransactionP2P = async (paymail: string, hex: string, reference: string, metadata?: {
    sender: string;
    pubkey: string;
    signature: string;
    note: string;
}) => {
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
    return value;
}
```

### Property sendTransactionNegotiation

Sends a transaction negotiation request to a Paymail address.

```ts
public sendTransactionNegotiation = async (paymail: string, body: TransactionNegotiationBody) => {
    const response = await this.request(paymail, TransactionNegotiationCapabilities, body);
    return response;
}
```

### Property sendTransactionP2P

Sends a transaction using the Pay-to-Peer (P2P) protocol.
This method is used to send a transaction to a Paymail address.

```ts
public sendTransactionP2P = async (paymail: string, hex: string, reference: string, metadata?: {
    sender: string;
    pubkey: string;
    signature: string;
    note: string;
}) => {
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
    return value;
}
```

### Property verifyPublicKey

Verifies the ownership of a public key for a given Paymail address.

```ts
public verifyPublicKey = async (paymail, pubkey) => {
    const [name, domain] = paymail.split("@");
    const url = await this.ensureCapabilityFor(domain, VerifyPublicKeyOwnerCapability.getCode());
    const requestUrl = url.replace("{alias}", name).replace("{domain.tld}", domain).replace("{pubkey}", pubkey);
    const response = await this.httpClient.request(requestUrl);
    const responseBody = await response.json();
    const schema = Joi.object({
        bsvalias: Joi.string().optional().allow("1.0"),
        handle: Joi.string().required(),
        pubkey: Joi.string().required(),
        match: Joi.boolean().required()
    }).options({ stripUnknown: true });
    const { error } = schema.validate(responseBody);
    if (error) {
        throw new PaymailServerResponseError(`Validation error: ${error.message}`);
    }
    return responseBody;
}
```

</details>

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes)

---
