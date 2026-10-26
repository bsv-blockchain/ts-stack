# API

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

## Interfaces

| | | |
| --- | --- | --- |
| [Amount](#interface-amount) | [IdentityVerificationResponse](#interface-identityverificationresponse) | [RemittanceEnvelope](#interface-remittanceenvelope) |
| [Brc29OptionTerms](#interface-brc29optionterms) | [InstrumentBase](#interface-instrumentbase) | [RemittanceEventHandlers](#interface-remittanceeventhandlers) |
| [Brc29ReceiptData](#interface-brc29receiptdata) | [Invoice](#interface-invoice) | [RemittanceManagerConfig](#interface-remittancemanagerconfig) |
| [Brc29RemittanceModuleConfig](#interface-brc29remittancemoduleconfig) | [LineItem](#interface-lineitem) | [RemittanceManagerRuntimeOptions](#interface-remittancemanagerruntimeoptions) |
| [Brc29SettlementArtifact](#interface-brc29settlementartifact) | [LockingScriptProvider](#interface-lockingscriptprovider) | [RemittanceManagerState](#interface-remittancemanagerstate) |
| [CommsLayer](#interface-commslayer) | [LoggerLike](#interface-loggerlike) | [RemittanceModule](#interface-remittancemodule) |
| [ComposeInvoiceInput](#interface-composeinvoiceinput) | [ModuleContext](#interface-modulecontext) | [Settlement](#interface-settlement) |
| [IdentityLayer](#interface-identitylayer) | [NonceProvider](#interface-nonceprovider) | [Termination](#interface-termination) |
| [IdentityVerificationAcknowledgment](#interface-identityverificationacknowledgment) | [PeerMessage](#interface-peermessage) | [Thread](#interface-thread) |
| [IdentityVerificationRequest](#interface-identityverificationrequest) | [Receipt](#interface-receipt) | [Unit](#interface-unit) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Interface: Amount

```ts
export interface Amount {
    value: string;
    unit: Unit;
}
```

See also: [Unit](./remittance.md#interface-unit), [string](./remittance.md#function-string)

#### Property value

Decimal string. Avoid floats at the protocol layer.

```ts
value: string
```
See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: Brc29OptionTerms

BRC-29-like payment option terms.

This module intentionally keeps option terms minimal:
- Amount is taken from the invoice total (and validated as satoshis)
- The payer derives the payee's per-payment public key using wallet.getPublicKey with a stable protocolID

```ts
export interface Brc29OptionTerms {
    amountSatoshis: number;
    payee: PubKeyHex;
    outputIndex?: number;
    protocolID?: WalletProtocol;
    labels?: string[];
    description?: string;
}
```

See also: [PubKeyHex](./wallet.md#type-pubkeyhex), [WalletProtocol](./wallet.md#type-walletprotocol), [string](./remittance.md#function-string)

#### Property amountSatoshis

Payment amount in satoshis.

```ts
amountSatoshis: number
```

#### Property description

Optional description for createAction.

```ts
description?: string
```
See also: [string](./remittance.md#function-string)

#### Property labels

Optional labels for createAction.

```ts
labels?: string[]
```
See also: [string](./remittance.md#function-string)

#### Property outputIndex

Which output index to internalize, default 0.

```ts
outputIndex?: number
```

#### Property payee

The recipient of the payment

```ts
payee: PubKeyHex
```
See also: [PubKeyHex](./wallet.md#type-pubkeyhex)

#### Property protocolID

Optionally override the protocolID used in getPublicKey.

```ts
protocolID?: WalletProtocol
```
See also: [WalletProtocol](./wallet.md#type-walletprotocol)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: Brc29ReceiptData

Receipt data for BRC-29 settlements.

```ts
export interface Brc29ReceiptData {
    internalizeResult?: unknown;
    rejectedReason?: string;
    refund?: {
        token: Brc29SettlementArtifact;
        feeSatoshis: number;
    };
}
```

See also: [Brc29SettlementArtifact](./remittance.md#interface-brc29settlementartifact), [string](./remittance.md#function-string)

#### Property internalizeResult

Result returned from wallet.internalizeAction, if accepted.

```ts
internalizeResult?: unknown
```

#### Property refund

If rejected with refund, contains the refund payment token.

```ts
refund?: {
    token: Brc29SettlementArtifact;
    feeSatoshis: number;
}
```
See also: [Brc29SettlementArtifact](./remittance.md#interface-brc29settlementartifact)

#### Property rejectedReason

Human-readable rejection reason, if rejected.

```ts
rejectedReason?: string
```
See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: Brc29RemittanceModuleConfig

```ts
export interface Brc29RemittanceModuleConfig {
    protocolID?: WalletProtocol;
    labels?: string[];
    description?: string;
    outputDescription?: string;
    refundFeeSatoshis?: number;
    minRefundSatoshis?: number;
    internalizeProtocol?: "wallet payment" | "basket insertion";
    nonceProvider?: NonceProvider;
    lockingScriptProvider?: LockingScriptProvider;
}
```

See also: [LockingScriptProvider](./remittance.md#interface-lockingscriptprovider), [NonceProvider](./remittance.md#interface-nonceprovider), [WalletProtocol](./wallet.md#type-walletprotocol), [string](./remittance.md#function-string)

#### Property description

Description applied to created actions.

```ts
description?: string
```
See also: [string](./remittance.md#function-string)

#### Property labels

Labels applied to created actions.

```ts
labels?: string[]
```
See also: [string](./remittance.md#function-string)

#### Property minRefundSatoshis

Minimum refund to issue. If refund would be smaller, module will reject without refund.

```ts
minRefundSatoshis?: number
```

#### Property outputDescription

Output description for created actions.

```ts
outputDescription?: string
```
See also: [string](./remittance.md#function-string)

#### Property protocolID

Default protocolID to use with wallet.getPublicKey.

```ts
protocolID?: WalletProtocol
```
See also: [WalletProtocol](./wallet.md#type-walletprotocol)

#### Property refundFeeSatoshis

Fee charged on refunds, in satoshis.

```ts
refundFeeSatoshis?: number
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: Brc29SettlementArtifact

Settlement artifact carried in the settlement message.

```ts
export interface Brc29SettlementArtifact {
    customInstructions: {
        derivationPrefix: string;
        derivationSuffix: string;
        protocolID?: WalletProtocol;
    };
    transaction: number[];
    amountSatoshis: number;
    outputIndex?: number;
}
```

See also: [WalletProtocol](./wallet.md#type-walletprotocol), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: CommsLayer

Abstract communications layer.

This intentionally mirrors the essential subset of message-box-client / MessageBoxClient.
RemittanceManager never talks directly to HTTP/WebSockets – it only uses this interface.

This is a security boundary. Implementations MUST authenticate the peer identity represented
by `PeerMessage.sender`, bind message integrity to that identity, and return only messages whose
authenticated recipient and message-box name match the request. `RemittanceManager` checks
those bindings and thread roles but cannot manufacture transport authentication from an
untrusted sender string.

```ts
export interface CommsLayer {
    sendMessage: (args: {
        recipient: PubKeyHex;
        messageBox: string;
        body: string;
    }, hostOverride?: string) => Promise<string>;
    sendLiveMessage?: (args: {
        recipient: PubKeyHex;
        messageBox: string;
        body: string;
    }, hostOverride?: string) => Promise<string>;
    listMessages: (args: {
        messageBox: string;
        host?: string;
    }) => Promise<PeerMessage[]>;
    acknowledgeMessage: (args: {
        messageIds: string[];
    }) => Promise<void>;
    listenForLiveMessages?: (args: {
        messageBox: string;
        overrideHost?: string;
        onMessage: (msg: PeerMessage) => void;
    }) => Promise<void>;
}
```

See also: [PeerMessage](./remittance.md#interface-peermessage), [PubKeyHex](./wallet.md#type-pubkeyhex), [string](./remittance.md#function-string)

#### Property acknowledgeMessage

Acknowledges messages (deletes them from the server / inbox).

```ts
acknowledgeMessage: (args: {
    messageIds: string[];
}) => Promise<void>
```
See also: [string](./remittance.md#function-string)

#### Property listMessages

Lists pending authenticated messages for a message box.

```ts
listMessages: (args: {
    messageBox: string;
    host?: string;
}) => Promise<PeerMessage[]>
```
See also: [PeerMessage](./remittance.md#interface-peermessage), [string](./remittance.md#function-string)

#### Property listenForLiveMessages

Optional live listener.

```ts
listenForLiveMessages?: (args: {
    messageBox: string;
    overrideHost?: string;
    onMessage: (msg: PeerMessage) => void;
}) => Promise<void>
```
See also: [PeerMessage](./remittance.md#interface-peermessage), [string](./remittance.md#function-string)

#### Property sendLiveMessage

Sends a message over the live channel (e.g. WebSocket). Returns the transport messageId.
Implementers may throw if live sending is not possible.
RemittanceManager will fall back to sendMessage where appropriate.

```ts
sendLiveMessage?: (args: {
    recipient: PubKeyHex;
    messageBox: string;
    body: string;
}, hostOverride?: string) => Promise<string>
```
See also: [PubKeyHex](./wallet.md#type-pubkeyhex), [string](./remittance.md#function-string)

#### Property sendMessage

Sends a message over the store-and-forward channel. Returns the transport messageId.

```ts
sendMessage: (args: {
    recipient: PubKeyHex;
    messageBox: string;
    body: string;
}, hostOverride?: string) => Promise<string>
```
See also: [PubKeyHex](./wallet.md#type-pubkeyhex), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: ComposeInvoiceInput

```ts
export interface ComposeInvoiceInput {
    note?: string;
    lineItems: Invoice["lineItems"];
    total: Invoice["total"];
    invoiceNumber?: string;
    arbitrary?: Record<string, unknown>;
}
```

See also: [Invoice](./remittance.md#interface-invoice), [string](./remittance.md#function-string)

#### Property lineItems

Line items.

```ts
lineItems: Invoice["lineItems"]
```
See also: [Invoice](./remittance.md#interface-invoice)

#### Property note

Human note/memo.

```ts
note?: string
```
See also: [string](./remittance.md#function-string)

#### Property total

Total amount.

```ts
total: Invoice["total"]
```
See also: [Invoice](./remittance.md#interface-invoice)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: IdentityLayer

The Identity Layer handles identity certificate exchange and verification.
It is optional and pluggable.
Modules can use it to request/verify identity before accepting settlements.

The runtime configuration can be used to determine whether and at what point identity
exchange occurs: before invoicing, before settlement, etc.

Makers and takers can both implement this layer as needed, and request/respond to
identity verification at different points in the protocol.

```ts
export interface IdentityLayer {
    determineCertificatesToRequest: (args: {
        counterparty: PubKeyHex;
        threadId: ThreadId;
    }, ctx: ModuleContext) => Promise<IdentityVerificationRequest>;
    respondToRequest: (args: {
        counterparty: PubKeyHex;
        threadId: ThreadId;
        request: IdentityVerificationRequest;
    }, ctx: ModuleContext) => Promise<{
        action: "respond";
        response: IdentityVerificationResponse;
    } | {
        action: "terminate";
        termination: Termination;
    }>;
    assessReceivedCertificateSufficiency: (counterparty: PubKeyHex, received: IdentityVerificationResponse, threadId: ThreadId) => Promise<IdentityVerificationAcknowledgment | Termination>;
}
```

See also: [IdentityVerificationAcknowledgment](./remittance.md#interface-identityverificationacknowledgment), [IdentityVerificationRequest](./remittance.md#interface-identityverificationrequest), [IdentityVerificationResponse](./remittance.md#interface-identityverificationresponse), [ModuleContext](./remittance.md#interface-modulecontext), [PubKeyHex](./wallet.md#type-pubkeyhex), [Termination](./remittance.md#interface-termination), [ThreadId](./remittance.md#type-threadid)

#### Property assessReceivedCertificateSufficiency

Assess whether received certificates satisfy the requirements for transaction settlement.

This is an authorization callback. Before returning an acknowledgment, implementations must
verify certificate signatures and revocation/freshness, bind each subject to `counterparty`,
and enforce the locally requested types, fields, and acceptable certifiers. The manager
validates transport identity and protocol shape but does not duplicate certificate policy.

```ts
assessReceivedCertificateSufficiency: (counterparty: PubKeyHex, received: IdentityVerificationResponse, threadId: ThreadId) => Promise<IdentityVerificationAcknowledgment | Termination>
```
See also: [IdentityVerificationAcknowledgment](./remittance.md#interface-identityverificationacknowledgment), [IdentityVerificationResponse](./remittance.md#interface-identityverificationresponse), [PubKeyHex](./wallet.md#type-pubkeyhex), [Termination](./remittance.md#interface-termination), [ThreadId](./remittance.md#type-threadid)

#### Property determineCertificatesToRequest

Determine which certificates to request from a counterparty.

```ts
determineCertificatesToRequest: (args: {
    counterparty: PubKeyHex;
    threadId: ThreadId;
}, ctx: ModuleContext) => Promise<IdentityVerificationRequest>
```
See also: [IdentityVerificationRequest](./remittance.md#interface-identityverificationrequest), [ModuleContext](./remittance.md#interface-modulecontext), [PubKeyHex](./wallet.md#type-pubkeyhex), [ThreadId](./remittance.md#type-threadid)

#### Property respondToRequest

Respond to an incoming identity verification request.

```ts
respondToRequest: (args: {
    counterparty: PubKeyHex;
    threadId: ThreadId;
    request: IdentityVerificationRequest;
}, ctx: ModuleContext) => Promise<{
    action: "respond";
    response: IdentityVerificationResponse;
} | {
    action: "terminate";
    termination: Termination;
}>
```
See also: [IdentityVerificationRequest](./remittance.md#interface-identityverificationrequest), [IdentityVerificationResponse](./remittance.md#interface-identityverificationresponse), [ModuleContext](./remittance.md#interface-modulecontext), [PubKeyHex](./wallet.md#type-pubkeyhex), [Termination](./remittance.md#interface-termination), [ThreadId](./remittance.md#type-threadid)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: IdentityVerificationAcknowledgment

An identity verification acknowledgment.

A simple ack message indicating that a requested identity verification has been completed successfully.

```ts
export interface IdentityVerificationAcknowledgment {
    kind: "identityVerificationAcknowledgment";
    threadId: ThreadId;
}
```

See also: [ThreadId](./remittance.md#type-threadid)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: IdentityVerificationRequest

An identity certificate request.

Contains a list of requested certificate types, fields from each, plus acceptable certifiers.

```ts
export interface IdentityVerificationRequest {
    kind: "identityVerificationRequest";
    threadId: ThreadId;
    request: {
        types: Record<string, string[]>;
        certifiers: PubKeyHex[];
    };
}
```

See also: [PubKeyHex](./wallet.md#type-pubkeyhex), [ThreadId](./remittance.md#type-threadid), [string](./remittance.md#function-string)

#### Property request

Details of the requested certificates.

```ts
request: {
    types: Record<string, string[]>;
    certifiers: PubKeyHex[];
}
```
See also: [PubKeyHex](./wallet.md#type-pubkeyhex), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: IdentityVerificationResponse

An identity certificate response.

Contains certificates issued by the certifiers named in the corresponding request, with fields revealed to the counterparty.

```ts
export interface IdentityVerificationResponse {
    kind: "identityVerificationResponse";
    threadId: ThreadId;
    certificates: Array<{
        type: Base64String;
        certifier: PubKeyHex;
        subject: PubKeyHex;
        fields: Record<string, Base64String>;
        signature: HexString;
        serialNumber: Base64String;
        revocationOutpoint: OutpointString;
        keyringForVerifier: Record<string, Base64String>;
    }>;
}
```

See also: [Base64String](./wallet.md#type-base64string), [HexString](./wallet.md#type-hexstring), [OutpointString](./wallet.md#type-outpointstring), [PubKeyHex](./wallet.md#type-pubkeyhex), [ThreadId](./remittance.md#type-threadid), [string](./remittance.md#function-string)

#### Property certificates

List of certificates issued by the certifiers named in the corresponding request, with fields revealed to the counterparty.

```ts
certificates: Array<{
    type: Base64String;
    certifier: PubKeyHex;
    subject: PubKeyHex;
    fields: Record<string, Base64String>;
    signature: HexString;
    serialNumber: Base64String;
    revocationOutpoint: OutpointString;
    keyringForVerifier: Record<string, Base64String>;
}>
```
See also: [Base64String](./wallet.md#type-base64string), [HexString](./wallet.md#type-hexstring), [OutpointString](./wallet.md#type-outpointstring), [PubKeyHex](./wallet.md#type-pubkeyhex), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: InstrumentBase

Shared commercial/metadata fields for invoice and receipt-like instruments.

NOTE: "payee" and "payer" are identity keys, not addresses.
Payment addresses / scripts are settlement-module concerns.

```ts
export interface InstrumentBase {
    threadId: ThreadId;
    payee: PubKeyHex;
    payer: PubKeyHex;
    note?: string;
    lineItems: LineItem[];
    total: Amount;
    invoiceNumber: string;
    createdAt: UnixMillis;
    arbitrary?: Record<string, unknown>;
}
```

See also: [Amount](./remittance.md#interface-amount), [LineItem](./remittance.md#interface-lineitem), [PubKeyHex](./wallet.md#type-pubkeyhex), [ThreadId](./remittance.md#type-threadid), [UnixMillis](./remittance.md#type-unixmillis), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: Invoice

Invoice (solicitation) that contains N remittance options.

Each remittance option is keyed by a module id.
The payload for each option is module-defined and opaque to the core.

This is where “UTXO offers” live: a module option payload can include a partial tx template,
UTXO references, scripts, overlay anchors, SPV, etc. The manager does not interpret them.

```ts
export interface Invoice extends InstrumentBase {
    kind: "invoice";
    expiresAt?: UnixMillis;
    options: Record<RemittanceOptionId, unknown>;
}
```

See also: [InstrumentBase](./remittance.md#interface-instrumentbase), [RemittanceOptionId](./remittance.md#type-remittanceoptionid), [UnixMillis](./remittance.md#type-unixmillis)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: LineItem

```ts
export interface LineItem {
    id?: string;
    description: string;
    quantity?: string;
    unitPrice?: Amount;
    amount?: Amount;
    metadata?: Record<string, unknown>;
}
```

See also: [Amount](./remittance.md#interface-amount), [string](./remittance.md#function-string)

#### Property amount

Total amount for the line (optional if derivable).

```ts
amount?: Amount
```
See also: [Amount](./remittance.md#interface-amount)

#### Property quantity

Decimal string, e.g. '1', '2', '0.5'.

```ts
quantity?: string
```
See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: LockingScriptProvider

```ts
export interface LockingScriptProvider {
    pubKeyToP2PKHLockingScript: (publicKey: string) => Promise<string> | string;
}
```

See also: [string](./remittance.md#function-string)

#### Property pubKeyToP2PKHLockingScript

Converts a public key string to a P2PKH locking script hex.

```ts
pubKeyToP2PKHLockingScript: (publicKey: string) => Promise<string> | string
```
See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: LoggerLike

Simple logger interface.

```ts
export interface LoggerLike {
    log: (...args: any[]) => void;
    warn: (...args: any[]) => void;
    error: (...args: any[]) => void;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: ModuleContext

Context object passed to module methods.

```ts
export interface ModuleContext {
    wallet: WalletInterface;
    originator?: unknown;
    now: () => number;
    logger?: LoggerLike;
}
```

See also: [LoggerLike](./remittance.md#interface-loggerlike), [WalletInterface](./wallet.md#interface-walletinterface)

#### Property originator

Optional originator domain forwarded to wallet methods.

```ts
originator?: unknown
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: NonceProvider

```ts
export interface NonceProvider {
    createNonce: (wallet: WalletInterface, scope: WalletCounterparty, originator?: unknown) => Promise<string>;
}
```

See also: [WalletCounterparty](./wallet.md#type-walletcounterparty), [WalletInterface](./wallet.md#interface-walletinterface), [createNonce](./auth.md#function-createnonce), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: PeerMessage

Transport message format expected from the CommsLayer.

It closely matches the message-box-client shapes:
messageId, sender, body, etc.
`sender` and `recipient` are authenticated transport facts, not untrusted
application claims. A CommsLayer that cannot provide that guarantee is not
safe for authorization or financial use.

```ts
export interface PeerMessage {
    messageId: string;
    sender: PubKeyHex;
    recipient: PubKeyHex;
    messageBox: string;
    body: string;
}
```

See also: [PubKeyHex](./wallet.md#type-pubkeyhex), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: Receipt

Receipt issued by the payee (or service provider).

A receipt could be a PDF, a photo/oroof-of-delivery, a copy of the payment transaction, etc.

A receipt should NOT be issued when a settlement is rejected/failed. Use a Termination instead.

```ts
export interface Receipt {
    kind: "receipt";
    threadId: ThreadId;
    moduleId: RemittanceOptionId;
    optionId: RemittanceOptionId;
    payee: PubKeyHex;
    payer: PubKeyHex;
    createdAt: UnixMillis;
    receiptData: unknown;
}
```

See also: [PubKeyHex](./wallet.md#type-pubkeyhex), [RemittanceOptionId](./remittance.md#type-remittanceoptionid), [ThreadId](./remittance.md#type-threadid), [UnixMillis](./remittance.md#type-unixmillis)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: RemittanceEnvelope

Protocol envelope.

This is what RemittanceManager serializes into the CommsLayer message body.

```ts
export interface RemittanceEnvelope<K extends RemittanceKind = RemittanceKind, P = unknown> {
    v: 1;
    id: string;
    kind: K;
    threadId: ThreadId;
    createdAt: UnixMillis;
    payload: P;
}
```

See also: [RemittanceKind](./remittance.md#type-remittancekind), [ThreadId](./remittance.md#type-threadid), [UnixMillis](./remittance.md#type-unixmillis), [string](./remittance.md#function-string)

#### Property id

Sender-scoped envelope id (idempotency key). Not the transport messageId.

```ts
id: string
```
See also: [string](./remittance.md#function-string)

#### Property v

Protocol version.

```ts
v: 1
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: RemittanceEventHandlers

```ts
export interface RemittanceEventHandlers {
    onThreadCreated?: (event: Extract<RemittanceEvent, {
        type: "threadCreated";
    }>) => void;
    onStateChanged?: (event: Extract<RemittanceEvent, {
        type: "stateChanged";
    }>) => void;
    onEnvelopeSent?: (event: Extract<RemittanceEvent, {
        type: "envelopeSent";
    }>) => void;
    onEnvelopeReceived?: (event: Extract<RemittanceEvent, {
        type: "envelopeReceived";
    }>) => void;
    onIdentityRequested?: (event: Extract<RemittanceEvent, {
        type: "identityRequested";
    }>) => void;
    onIdentityResponded?: (event: Extract<RemittanceEvent, {
        type: "identityResponded";
    }>) => void;
    onIdentityAcknowledged?: (event: Extract<RemittanceEvent, {
        type: "identityAcknowledged";
    }>) => void;
    onInvoiceSent?: (event: Extract<RemittanceEvent, {
        type: "invoiceSent";
    }>) => void;
    onInvoiceReceived?: (event: Extract<RemittanceEvent, {
        type: "invoiceReceived";
    }>) => void;
    onSettlementSent?: (event: Extract<RemittanceEvent, {
        type: "settlementSent";
    }>) => void;
    onSettlementReceived?: (event: Extract<RemittanceEvent, {
        type: "settlementReceived";
    }>) => void;
    onReceiptSent?: (event: Extract<RemittanceEvent, {
        type: "receiptSent";
    }>) => void;
    onReceiptReceived?: (event: Extract<RemittanceEvent, {
        type: "receiptReceived";
    }>) => void;
    onTerminationSent?: (event: Extract<RemittanceEvent, {
        type: "terminationSent";
    }>) => void;
    onTerminationReceived?: (event: Extract<RemittanceEvent, {
        type: "terminationReceived";
    }>) => void;
    onError?: (event: Extract<RemittanceEvent, {
        type: "error";
    }>) => void;
}
```

See also: [RemittanceEvent](./remittance.md#type-remittanceevent)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: RemittanceManagerConfig

```ts
export interface RemittanceManagerConfig {
    messageBox?: string;
    originator?: OriginatorDomainNameStringUnder250Bytes;
    logger?: LoggerLike;
    options?: Partial<RemittanceManagerRuntimeOptions>;
    remittanceModules: Array<RemittanceModule<any, any, any>>;
    identityLayer?: IdentityLayer;
    onEvent?: (event: RemittanceEvent) => void;
    events?: RemittanceEventHandlers;
    stateSaver?: (state: RemittanceManagerState) => Promise<void> | void;
    stateLoader?: () => Promise<RemittanceManagerState | undefined> | RemittanceManagerState | undefined;
    now?: () => UnixMillis;
    threadIdFactory?: () => ThreadId;
}
```

See also: [IdentityLayer](./remittance.md#interface-identitylayer), [LoggerLike](./remittance.md#interface-loggerlike), [OriginatorDomainNameStringUnder250Bytes](./wallet.md#type-originatordomainnamestringunder250bytes), [RemittanceEvent](./remittance.md#type-remittanceevent), [RemittanceEventHandlers](./remittance.md#interface-remittanceeventhandlers), [RemittanceManagerRuntimeOptions](./remittance.md#interface-remittancemanagerruntimeoptions), [RemittanceManagerState](./remittance.md#interface-remittancemanagerstate), [RemittanceModule](./remittance.md#interface-remittancemodule), [ThreadId](./remittance.md#type-threadid), [UnixMillis](./remittance.md#type-unixmillis), [string](./remittance.md#function-string)

#### Property events

Optional event callbacks keyed by process.

```ts
events?: RemittanceEventHandlers
```
See also: [RemittanceEventHandlers](./remittance.md#interface-remittanceeventhandlers)

#### Property identityLayer

Optional identity layer for exchanging certificates before transacting.

```ts
identityLayer?: IdentityLayer
```
See also: [IdentityLayer](./remittance.md#interface-identitylayer)

#### Property logger

Provide a logger. If omitted, RemittanceManager stays quiet.

Malformed inbound messages are rejected without mutating a thread. Transport and persistence
failures can still reject the calling operation.

```ts
logger?: LoggerLike
```
See also: [LoggerLike](./remittance.md#interface-loggerlike)

#### Property messageBox

Optional message box name to use for communication.

```ts
messageBox?: string
```
See also: [string](./remittance.md#function-string)

#### Property now

Injectable clock for tests.

```ts
now?: () => UnixMillis
```
See also: [UnixMillis](./remittance.md#type-unixmillis)

#### Property onEvent

Optional event callback for remittance lifecycle events.

```ts
onEvent?: (event: RemittanceEvent) => void
```
See also: [RemittanceEvent](./remittance.md#type-remittanceevent)

#### Property options

Runtime options that influence core behavior.

```ts
options?: Partial<RemittanceManagerRuntimeOptions>
```
See also: [RemittanceManagerRuntimeOptions](./remittance.md#interface-remittancemanagerruntimeoptions)

#### Property originator

Optional originator forwarded to wallet APIs.

```ts
originator?: OriginatorDomainNameStringUnder250Bytes
```
See also: [OriginatorDomainNameStringUnder250Bytes](./wallet.md#type-originatordomainnamestringunder250bytes)

#### Property remittanceModules

Modules (remittance options) available to this manager.

```ts
remittanceModules: Array<RemittanceModule<any, any, any>>
```
See also: [RemittanceModule](./remittance.md#interface-remittancemodule)

#### Property stateLoader

Load manager state. Never return state from an unauthenticated or shared attacker-writable
store.

```ts
stateLoader?: () => Promise<RemittanceManagerState | undefined> | RemittanceManagerState | undefined
```
See also: [RemittanceManagerState](./remittance.md#interface-remittancemanagerstate)

#### Property stateSaver

Persist manager state. This callback is part of the trusted local boundary and must durably
integrity-protect each supplied checkpoint before reporting success.

```ts
stateSaver?: (state: RemittanceManagerState) => Promise<void> | void
```
See also: [RemittanceManagerState](./remittance.md#interface-remittancemanagerstate)

#### Property threadIdFactory

Injectable thread id factory for tests.

```ts
threadIdFactory?: () => ThreadId
```
See also: [ThreadId](./remittance.md#type-threadid)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: RemittanceManagerRuntimeOptions

```ts
export interface RemittanceManagerRuntimeOptions {
    identityOptions?: {
        makerRequestIdentity?: "never" | "beforeInvoicing" | "beforeSettlement";
        takerRequestIdentity?: "never" | "beforeInvoicing" | "beforeSettlement";
    };
    receiptProvided: boolean;
    autoIssueReceipt: boolean;
    invoiceExpirySeconds: number;
    identityTimeoutMs: number;
    identityPollIntervalMs: number;
}
```

#### Property autoIssueReceipt

If true, manager auto-sends receipts as soon as a settlement is processed.

```ts
autoIssueReceipt: boolean
```

#### Property identityOptions

Identity verification options.

```ts
identityOptions?: {
    makerRequestIdentity?: "never" | "beforeInvoicing" | "beforeSettlement";
    takerRequestIdentity?: "never" | "beforeInvoicing" | "beforeSettlement";
}
```

#### Property identityPollIntervalMs

Identity verification poll interval in milliseconds.

```ts
identityPollIntervalMs: number
```

#### Property identityTimeoutMs

Identity verification timeout in milliseconds.

```ts
identityTimeoutMs: number
```

#### Property invoiceExpirySeconds

Invoice expiry in seconds, or -1 for no expiry.

```ts
invoiceExpirySeconds: number
```

#### Property receiptProvided

If true, payees are expected to send receipts.

```ts
receiptProvided: boolean
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: RemittanceManagerState

```ts
export interface RemittanceManagerState {
    v: 1;
    threads: Thread[];
    defaultPaymentOptionId?: string;
}
```

See also: [Thread](./remittance.md#interface-thread), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: RemittanceModule

A remittance module implements a specific settlement system.

The RemittanceManager core uses module ids as the only “capability mechanism”:
if an invoice contains an option with module id X, a payer can only satisfy it
if they are configured with module X.

Modules are trusted financial adapters. They must independently bind every accepted artifact
to the authenticated sender, invoice parties, selected option, amount, recipient, and concrete
settlement evidence. Returning `accept` is an authorization decision, not a parsing hint.

```ts
export interface RemittanceModule<TOptionTerms = unknown, TSettlementArtifact = unknown, TReceiptData = unknown> {
    id: RemittanceOptionId;
    name: string;
    allowUnsolicitedSettlements: boolean;
    createOption?: (args: {
        threadId: ThreadId;
        invoice: Invoice;
    }, ctx: ModuleContext) => Promise<TOptionTerms>;
    buildSettlement: (args: {
        threadId: ThreadId;
        invoice?: Invoice;
        option: TOptionTerms;
        note?: string;
    }, ctx: ModuleContext) => Promise<{
        action: "settle";
        artifact: TSettlementArtifact;
    } | {
        action: "terminate";
        termination: Termination;
    }>;
    acceptSettlement: (args: {
        threadId: ThreadId;
        invoice?: Invoice;
        settlement: TSettlementArtifact;
        sender: PubKeyHex;
    }, ctx: ModuleContext) => Promise<{
        action: "accept";
        receiptData?: TReceiptData;
    } | {
        action: "terminate";
        termination: Termination;
    }>;
    processReceipt?: (args: {
        threadId: ThreadId;
        invoice?: Invoice;
        receiptData: TReceiptData;
        sender: PubKeyHex;
    }, ctx: ModuleContext) => Promise<void>;
    processTermination?: (args: {
        threadId: ThreadId;
        invoice?: Invoice;
        settlement?: Settlement;
        termination: Termination;
        sender: PubKeyHex;
    }, ctx: ModuleContext) => Promise<void>;
}
```

See also: [Invoice](./remittance.md#interface-invoice), [ModuleContext](./remittance.md#interface-modulecontext), [PubKeyHex](./wallet.md#type-pubkeyhex), [RemittanceOptionId](./remittance.md#type-remittanceoptionid), [Settlement](./remittance.md#interface-settlement), [Termination](./remittance.md#interface-termination), [ThreadId](./remittance.md#type-threadid), [string](./remittance.md#function-string)

#### Property acceptSettlement

Accepts a settlement artifact on the payee side.

The module should validate and internalize/store whatever it needs.
The manager will wrap the returned value as receipt.receiptData.

If the settlement is invalid, the module should return either a termination or receiptData (possibly with a refund or indicating the failure), depending how the module chooses to handle it.
Implementations must durably associate each `threadId` with every accepted
transaction ID or other settlement identifier. Reject an identifier already
used for another thread and do not accept a different identifier for an
unreconciled thread. The manager cannot atomically commit an external
financial side effect with inbox acknowledgment, so callers must reconcile
ambiguous outcomes before retrying and must not rely on process memory for
replay protection.

```ts
acceptSettlement: (args: {
    threadId: ThreadId;
    invoice?: Invoice;
    settlement: TSettlementArtifact;
    sender: PubKeyHex;
}, ctx: ModuleContext) => Promise<{
    action: "accept";
    receiptData?: TReceiptData;
} | {
    action: "terminate";
    termination: Termination;
}>
```
See also: [Invoice](./remittance.md#interface-invoice), [ModuleContext](./remittance.md#interface-modulecontext), [PubKeyHex](./wallet.md#type-pubkeyhex), [Termination](./remittance.md#interface-termination), [ThreadId](./remittance.md#type-threadid)

#### Property allowUnsolicitedSettlements

Whether this module allows unsolicited settlements (i.e. settlement without an invoice).

If true, the payer can build a settlement without an invoice being provided by the payee.
In this case, the option terms provided to `buildSettlement` may be used in lieu of an invoice.

If false, an invoice must always be provided to `buildSettlement`.

```ts
allowUnsolicitedSettlements: boolean
```

#### Property buildSettlement

Builds the settlement artifact for a chosen option.

For UTXO settlement systems, this is usually a transaction (or partially-signed tx) to be broadcast.

For unsolicited settlements, an invoice may not always be provided and the option terms may be used in lieu of an invoice to settle against.

For example, the option terms may include a tx template with outputs to fulfill the settlement.

When `allowUnsolicitedSettlements` is false, an invoice will always be provided.

Termination can be returned to abort the protocol with a reason.

A module that creates or broadcasts a transaction must durably associate
its transaction ID with `threadId` before permitting a retry. It must not
reuse one transaction ID for distinct threads or substitute a second
transaction while the first outcome is uncertain. Reconcile ambiguous
wallet or transport outcomes before building again.

```ts
buildSettlement: (args: {
    threadId: ThreadId;
    invoice?: Invoice;
    option: TOptionTerms;
    note?: string;
}, ctx: ModuleContext) => Promise<{
    action: "settle";
    artifact: TSettlementArtifact;
} | {
    action: "terminate";
    termination: Termination;
}>
```
See also: [Invoice](./remittance.md#interface-invoice), [ModuleContext](./remittance.md#interface-modulecontext), [Termination](./remittance.md#interface-termination), [ThreadId](./remittance.md#type-threadid), [string](./remittance.md#function-string)

#### Property createOption

Creates module-defined option terms that will be embedded into the invoice.

In UTXO-ish offers, these option terms may include a partially-signed transaction template.

Optional because some modules may not require any option data, or may only support unsolicited settlements.

However, a module MAY still create option terms/invoices even if it can sometimes support unsolicited settlements.

```ts
createOption?: (args: {
    threadId: ThreadId;
    invoice: Invoice;
}, ctx: ModuleContext) => Promise<TOptionTerms>
```
See also: [Invoice](./remittance.md#interface-invoice), [ModuleContext](./remittance.md#interface-modulecontext), [ThreadId](./remittance.md#type-threadid)

#### Property id

Unique id used as the invoice.options key and as settlement.moduleId.

```ts
id: RemittanceOptionId
```
See also: [RemittanceOptionId](./remittance.md#type-remittanceoptionid)

#### Property name

Human-readable name for UIs.

```ts
name: string
```
See also: [string](./remittance.md#function-string)

#### Property processReceipt

Processes a receipt on the payer side.

This is where a module can automatically internalize a refund, mark a local order fulfilled, receive goods and services, etc.

```ts
processReceipt?: (args: {
    threadId: ThreadId;
    invoice?: Invoice;
    receiptData: TReceiptData;
    sender: PubKeyHex;
}, ctx: ModuleContext) => Promise<void>
```
See also: [Invoice](./remittance.md#interface-invoice), [ModuleContext](./remittance.md#interface-modulecontext), [PubKeyHex](./wallet.md#type-pubkeyhex), [ThreadId](./remittance.md#type-threadid)

#### Property processTermination

Processes a termination on either side.

This is where a module can clean up any internal state, reverse provisional actions, take refunds, etc.

```ts
processTermination?: (args: {
    threadId: ThreadId;
    invoice?: Invoice;
    settlement?: Settlement;
    termination: Termination;
    sender: PubKeyHex;
}, ctx: ModuleContext) => Promise<void>
```
See also: [Invoice](./remittance.md#interface-invoice), [ModuleContext](./remittance.md#interface-modulecontext), [PubKeyHex](./wallet.md#type-pubkeyhex), [Settlement](./remittance.md#interface-settlement), [Termination](./remittance.md#interface-termination), [ThreadId](./remittance.md#type-threadid)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: Settlement

A settlement attempt.

This is module-agnostic: "artifact" can be a transaction, a partial transaction,
a stablecoin transfer result, even a fiat card-payment approval code, etc.

```ts
export interface Settlement {
    kind: "settlement";
    threadId: ThreadId;
    moduleId: RemittanceOptionId;
    optionId: RemittanceOptionId;
    sender: PubKeyHex;
    createdAt: UnixMillis;
    artifact: unknown;
    note?: string;
}
```

See also: [PubKeyHex](./wallet.md#type-pubkeyhex), [RemittanceOptionId](./remittance.md#type-remittanceoptionid), [ThreadId](./remittance.md#type-threadid), [UnixMillis](./remittance.md#type-unixmillis), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: Termination

Termination details for failed operations.

```ts
export interface Termination {
    code: string;
    message: string;
    details?: unknown;
}
```

See also: [string](./remittance.md#function-string)

#### Property code

Reason code (module-specific).

```ts
code: string
```
See also: [string](./remittance.md#function-string)

#### Property details

Optional module-specific details or refund information.

```ts
details?: unknown
```

#### Property message

Human-readable message.

```ts
message: string
```
See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: Thread

```ts
export interface Thread {
    threadId: ThreadId;
    counterparty: PubKeyHex;
    myRole: "maker" | "taker";
    theirRole: "maker" | "taker";
    createdAt: UnixMillis;
    updatedAt: UnixMillis;
    state: RemittanceThreadState;
    stateLog: Array<{
        at: UnixMillis;
        from: RemittanceThreadState;
        to: RemittanceThreadState;
        reason?: string;
    }>;
    processedMessageIds: string[];
    protocolLog: Array<{
        direction: "in" | "out";
        envelope: RemittanceEnvelope;
        transportMessageId: string;
    }>;
    identity: {
        certsSent: IdentityVerificationResponse["certificates"];
        certsReceived: IdentityVerificationResponse["certificates"];
        requestSent: boolean;
        responseSent: boolean;
        acknowledgmentSent: boolean;
        acknowledgmentReceived: boolean;
    };
    invoice?: Invoice;
    settlement?: Settlement;
    receipt?: Receipt;
    termination?: Termination;
    flags: {
        hasIdentified: boolean;
        hasInvoiced: boolean;
        hasPaid: boolean;
        hasReceipted: boolean;
        error: boolean;
    };
    lastError?: {
        message: string;
        at: UnixMillis;
    };
}
```

See also: [IdentityVerificationResponse](./remittance.md#interface-identityverificationresponse), [Invoice](./remittance.md#interface-invoice), [PubKeyHex](./wallet.md#type-pubkeyhex), [Receipt](./remittance.md#interface-receipt), [RemittanceEnvelope](./remittance.md#interface-remittanceenvelope), [RemittanceThreadState](./remittance.md#type-remittancethreadstate), [Settlement](./remittance.md#interface-settlement), [Termination](./remittance.md#interface-termination), [ThreadId](./remittance.md#type-threadid), [UnixMillis](./remittance.md#type-unixmillis), [string](./remittance.md#function-string)

#### Property processedMessageIds

Transport messageIds processed for this thread (dedupe across retries).

```ts
processedMessageIds: string[]
```
See also: [string](./remittance.md#function-string)

#### Property protocolLog

Protocol envelopes received/sent (for debugging/audit).

```ts
protocolLog: Array<{
    direction: "in" | "out";
    envelope: RemittanceEnvelope;
    transportMessageId: string;
}>
```
See also: [RemittanceEnvelope](./remittance.md#interface-remittanceenvelope), [string](./remittance.md#function-string)

#### Property stateLog

State transition log for audit purposes.

```ts
stateLog: Array<{
    at: UnixMillis;
    from: RemittanceThreadState;
    to: RemittanceThreadState;
    reason?: string;
}>
```
See also: [RemittanceThreadState](./remittance.md#type-remittancethreadstate), [UnixMillis](./remittance.md#type-unixmillis), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Interface: Unit

```ts
export interface Unit {
    namespace: string;
    code: string;
    decimals?: number;
}
```

See also: [string](./remittance.md#function-string)

#### Property code

Unit code within the namespace, e.g. 'sat', 'USD', 'mnee'.

```ts
code: string
```
See also: [string](./remittance.md#function-string)

#### Property decimals

Optional decimal places for display/normalization.

```ts
decimals?: number
```

#### Property namespace

Namespace for disambiguation, e.g. 'bsv', 'iso4217', 'token'.

```ts
namespace: string
```
See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
## Classes

| |
| --- |
| [Brc29RemittanceModule](#class-brc29remittancemodule) |
| [InvoiceHandle](#class-invoicehandle) |
| [RemittanceManager](#class-remittancemanager) |
| [ThreadHandle](#class-threadhandle) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Class: Brc29RemittanceModule

BRC-29-based remittance module.
- payer creates a payment action to a derived P2PKH output
- payer sends { tx, derivationPrefix, derivationSuffix } as settlement artifact
- payee internalizes the tx output using wallet.internalizeAction
- optional rejection can include a refund token embedded in the termination details

Wallet-created transactions are completed through a deferred-signing boundary that verifies
the requested amount and locking script before signing. Recipients independently derive the
expected key and require the selected transaction output to pay that exact script and amount
before internalization.

```ts
export class Brc29RemittanceModule implements RemittanceModule<Brc29OptionTerms, Brc29SettlementArtifact, Brc29ReceiptData> {
    readonly id: RemittanceOptionId = "brc29.p2pkh";
    readonly name = "BSV (BRC-29 derived P2PKH)";
    readonly allowUnsolicitedSettlements = true;
    constructor(cfg: Brc29RemittanceModuleConfig = {})
    async buildSettlement(args: {
        threadId: string;
        option: Brc29OptionTerms;
        note?: string;
    }, ctx: ModuleContext): Promise<{
        action: "settle";
        artifact: Brc29SettlementArtifact;
    } | {
        action: "terminate";
        termination: Termination;
    }>
    async acceptSettlement(args: {
        threadId: string;
        invoice?: import('../types.js').Invoice;
        settlement: Brc29SettlementArtifact;
        sender: PubKeyHex;
    }, ctx: ModuleContext): Promise<{
        action: "accept";
        receiptData?: Brc29ReceiptData;
    } | {
        action: "terminate";
        termination: Termination;
    }>
}
```

See also: [Brc29OptionTerms](./remittance.md#interface-brc29optionterms), [Brc29ReceiptData](./remittance.md#interface-brc29receiptdata), [Brc29RemittanceModuleConfig](./remittance.md#interface-brc29remittancemoduleconfig), [Brc29SettlementArtifact](./remittance.md#interface-brc29settlementartifact), [Invoice](./remittance.md#interface-invoice), [ModuleContext](./remittance.md#interface-modulecontext), [PubKeyHex](./wallet.md#type-pubkeyhex), [RemittanceModule](./remittance.md#interface-remittancemodule), [RemittanceOptionId](./remittance.md#type-remittanceoptionid), [Termination](./remittance.md#interface-termination), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: InvoiceHandle

```ts
export class InvoiceHandle extends ThreadHandle {
    get invoice(): Invoice
    async pay(optionId?: string): Promise<Receipt | Termination | undefined>
}
```

See also: [Invoice](./remittance.md#interface-invoice), [Receipt](./remittance.md#interface-receipt), [Termination](./remittance.md#interface-termination), [ThreadHandle](./remittance.md#class-threadhandle), [string](./remittance.md#function-string)

#### Method pay

Pays the invoice using the selected remittance option.

```ts
async pay(optionId?: string): Promise<Receipt | Termination | undefined>
```
See also: [Receipt](./remittance.md#interface-receipt), [Termination](./remittance.md#interface-termination), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: RemittanceManager

RemittanceManager.

Responsibilities:
- message transport via CommsLayer
- thread lifecycle and persistence (via stateSaver/stateLoader)
- invoice creation and transmission (when invoices are used)
- settlement and settlement routing to the appropriate module
- receipt issuance and receipt routing to the appropriate module
- identity and identity certificate exchange (when identity layer is used)

Non-responsibilities (left to modules):
- transaction structure (whether UTXO “offer” formats, token logic, BRC-98/99 specifics, etc.)
- validation rules for settlement (e.g. partial tx templates, UTXO validity, etc.)
- on-chain broadcasting strategy or non-chain settlement specifics (like legacy payment protocols)
- Providing option terms for invoices
- Building settlement artifacts
- Accepting/rejecting settlements
- Deciding which identity certificates to request
- Deciding about sufficiency of identity certificates
- Preparing/processing specific receipt formats
- Internal business logic like order fulfillment, refunds, etc.

```ts
export class RemittanceManager {
    readonly wallet: WalletInterface;
    readonly comms: CommsLayer;
    readonly cfg: RemittanceManagerConfig;
    readonly #messageBox: string;
    readonly #now: () => UnixMillis;
    readonly #threadIdFactory: () => ThreadId;
    readonly #moduleRegistry: Map<string, RemittanceModule<any, any, any>>;
    readonly #runtime: RemittanceManagerRuntimeOptions;
    readonly #eventListeners: Set<(event: RemittanceEvent) => void>;
    readonly #stateWaiters: Map<ThreadId, Array<{
        state: RemittanceThreadState;
        resolve: () => void;
        reject: (err: Error) => void;
    }>>;
    readonly #eventHandlers?: RemittanceEventHandlers;
    readonly #inboundProcessing: Map<string, Promise<boolean>>;
    readonly #settlementOperations: Set<ThreadId>;
    readonly #issuedEnvelopeIds: Set<string>;
    readonly #processedInboundEnvelopeIds: Set<string>;
    threads: Thread[];
    #myIdentityKey?: PubKeyHex;
    constructor(cfg: RemittanceManagerConfig, wallet: WalletInterface, commsLayer: CommsLayer, threads: Thread[] = [])
    async init(): Promise<void>
    onEvent(listener: (event: RemittanceEvent) => void): () => void
    preselectPaymentOption(optionId: string): void
    saveState(): RemittanceManagerState
    loadState(state: RemittanceManagerState): void
    async persistState(): Promise<void>
    async syncThreads(hostOverride?: string): Promise<void>
    async startListening(hostOverride?: string): Promise<void>
    async sendInvoice(to: PubKeyHex, input: ComposeInvoiceInput, hostOverride?: string): Promise<InvoiceHandle>
    async sendInvoiceForThread(threadId: ThreadId, input: ComposeInvoiceInput, hostOverride?: string): Promise<InvoiceHandle>
    findInvoicesPayable(counterparty?: PubKeyHex): InvoiceHandle[]
    findReceivableInvoices(counterparty?: PubKeyHex): InvoiceHandle[]
    async pay(threadId: ThreadId, optionId?: string, hostOverride?: string): Promise<Receipt | Termination | undefined>
    async #payOnce(threadId: ThreadId, optionId?: string, hostOverride?: string): Promise<Receipt | Termination | undefined>
    async waitForReceipt(threadId: ThreadId, opts: {
        timeoutMs?: number;
        pollIntervalMs?: number;
    } = {}): Promise<Receipt | Termination>
    async waitForState(threadId: ThreadId, state: RemittanceThreadState, opts: {
        timeoutMs?: number;
        pollIntervalMs?: number;
    } = {}): Promise<Thread>
    async waitForIdentity(threadId: ThreadId, opts?: {
        timeoutMs?: number;
        pollIntervalMs?: number;
    }): Promise<Thread>
    async waitForSettlement(threadId: ThreadId, opts: {
        timeoutMs?: number;
        pollIntervalMs?: number;
    } = {}): Promise<Settlement | Termination>
    async sendUnsolicitedSettlement(to: PubKeyHex, args: {
        moduleId: RemittanceOptionId;
        option: unknown;
        optionId?: RemittanceOptionId;
        note?: string;
    }, hostOverride?: string): Promise<ThreadHandle>
    getThread(threadId: ThreadId): Thread | undefined
    getThreadHandle(threadId: ThreadId): ThreadHandle
    getThreadOrThrow(threadId: ThreadId): Thread
    #moduleContext(): ModuleContext
    #newThreadId(): ThreadId
    #rebuildIssuedEnvelopeIds(): void
    #inboundEnvelopeKey(sender: string, envelopeId: string): string
    #rebuildProcessedInboundEnvelopeIds(): void
    #makeEnvelope<K extends RemittanceKind, P>(kind: K, threadId: ThreadId, payload: P): RemittanceEnvelope<K, P>
    async #sendEnvelope(recipient: PubKeyHex, env: RemittanceEnvelope, hostOverride?: string): Promise<string>
    #inferInboundRole(kind: RemittanceKind): Thread["myRole"]
    #getOrCreateThreadFromInboundEnvelope(env: RemittanceEnvelope, msg: PeerMessage): Thread
    async #handleInboundMessage(candidate: unknown): Promise<void>
    async #processInboundMessage(parsed: RemittanceEnvelope, msg: PeerMessage): Promise<boolean>
    #validateInboundAuthority(env: RemittanceEnvelope, msg: PeerMessage): void
    async #applyIdentityVerificationRequest(thread: Thread, env: RemittanceEnvelope, msg: PeerMessage): Promise<void>
    #applyIdentityVerificationAcknowledgment(thread: Thread, env: RemittanceEnvelope): void
    #applyInvoice(thread: Thread, env: RemittanceEnvelope): void
    async #acceptInboundSettlement(thread: Thread, settlement: Settlement, msg: PeerMessage): Promise<void>
    async #applySettlement(thread: Thread, env: RemittanceEnvelope, msg: PeerMessage): Promise<void>
    async #applyReceipt(thread: Thread, env: RemittanceEnvelope, msg: PeerMessage): Promise<void>
    async #applyTermination(thread: Thread, env: RemittanceEnvelope, msg: PeerMessage): Promise<void>
    async #applyInboundEnvelope(thread: Thread, env: RemittanceEnvelope, msg: PeerMessage): Promise<void>
    async #maybeSendTermination(thread: Thread, settlement: Settlement, payer: PubKeyHex, message: string, details?: any): Promise<void>
    async #sendTermination(thread: Thread, recipient: PubKeyHex, message: string, details?: unknown, code = "error"): Promise<void>
    #shouldRequestIdentity(thread: Thread, phase: "beforeInvoicing" | "beforeSettlement"): boolean
    #shouldRequireIdentityBeforeSettlement(thread: Thread): boolean
    async #ensureIdentityExchange(thread: Thread, hostOverride?: string): Promise<void>
    async #waitForIdentityAcknowledgment(threadId: ThreadId, direction: "sent" | "received", opts: {
        timeoutMs?: number;
        pollIntervalMs?: number;
    } = {}): Promise<void>
    async #safeAck(messageIds: string[]): Promise<void>
    #markThreadError(thread: Thread, e: any): void
    #ensureThreadState(thread: Thread): Thread
    #validateThreadStateArray(value: unknown, shouldCopy = true): Thread[]
    #validateStoredThreadParties(): void
    #deriveThreadState(thread: Thread): RemittanceThreadState
    #transitionThreadState(thread: Thread, next: RemittanceThreadState, reason?: string): void
    #resolveStateWaiters(threadId: ThreadId, state: RemittanceThreadState): void
    #rejectStateWaiters(threadId: ThreadId, err: Error): void
    #emitEvent(event: RemittanceEvent): void
    async #refreshMyIdentityKey(): Promise<void>
    #requireMyIdentityKey(errMsg: string): PubKeyHex
    async #composeInvoice(threadId: ThreadId, payee: PubKeyHex, payer: PubKeyHex, input: ComposeInvoiceInput): Promise<Invoice>
}
```

See also: [CommsLayer](./remittance.md#interface-commslayer), [ComposeInvoiceInput](./remittance.md#interface-composeinvoiceinput), [Invoice](./remittance.md#interface-invoice), [InvoiceHandle](./remittance.md#class-invoicehandle), [ModuleContext](./remittance.md#interface-modulecontext), [PeerMessage](./remittance.md#interface-peermessage), [PubKeyHex](./wallet.md#type-pubkeyhex), [Receipt](./remittance.md#interface-receipt), [RemittanceEnvelope](./remittance.md#interface-remittanceenvelope), [RemittanceEvent](./remittance.md#type-remittanceevent), [RemittanceEventHandlers](./remittance.md#interface-remittanceeventhandlers), [RemittanceKind](./remittance.md#type-remittancekind), [RemittanceManagerConfig](./remittance.md#interface-remittancemanagerconfig), [RemittanceManagerRuntimeOptions](./remittance.md#interface-remittancemanagerruntimeoptions), [RemittanceManagerState](./remittance.md#interface-remittancemanagerstate), [RemittanceModule](./remittance.md#interface-remittancemodule), [RemittanceOptionId](./remittance.md#type-remittanceoptionid), [RemittanceThreadState](./remittance.md#type-remittancethreadstate), [Settlement](./remittance.md#interface-settlement), [Termination](./remittance.md#interface-termination), [Thread](./remittance.md#interface-thread), [ThreadHandle](./remittance.md#class-threadhandle), [ThreadId](./remittance.md#type-threadid), [UnixMillis](./remittance.md#type-unixmillis), [WalletInterface](./wallet.md#interface-walletinterface), [string](./remittance.md#function-string)

#### Property

Cached identity key if wallet provides it.

```ts
#myIdentityKey?: PubKeyHex
```
See also: [PubKeyHex](./wallet.md#type-pubkeyhex)

#### Property threads

Mutable local administrative state (persisted via stateSaver). Code with this reference is
trusted at the same level as the state store and must not mutate financial or identity facts.

```ts
threads: Thread[]
```
See also: [Thread](./remittance.md#interface-thread)

#### Method findInvoicesPayable

Returns invoice handles that this manager can pay (we are the taker/payer).

```ts
findInvoicesPayable(counterparty?: PubKeyHex): InvoiceHandle[]
```
See also: [InvoiceHandle](./remittance.md#class-invoicehandle), [PubKeyHex](./wallet.md#type-pubkeyhex)

#### Method findReceivableInvoices

Returns invoice handles that we issued and are waiting to receive settlement for.

```ts
findReceivableInvoices(counterparty?: PubKeyHex): InvoiceHandle[]
```
See also: [InvoiceHandle](./remittance.md#class-invoicehandle), [PubKeyHex](./wallet.md#type-pubkeyhex)

#### Method getThread

Returns a thread by id (if present).

```ts
getThread(threadId: ThreadId): Thread | undefined
```
See also: [Thread](./remittance.md#interface-thread), [ThreadId](./remittance.md#type-threadid)

#### Method getThreadHandle

Returns a thread handle by id, or throws if the thread does not exist.

```ts
getThreadHandle(threadId: ThreadId): ThreadHandle
```
See also: [ThreadHandle](./remittance.md#class-threadhandle), [ThreadId](./remittance.md#type-threadid)

#### Method getThreadOrThrow

Returns a thread by id or throws.

Public so helper handles (e.g. InvoiceHandle) can call it.

```ts
getThreadOrThrow(threadId: ThreadId): Thread
```
See also: [Thread](./remittance.md#interface-thread), [ThreadId](./remittance.md#type-threadid)

#### Method init

Loads persisted state from cfg.stateLoader (if provided).

Safe to call multiple times.

```ts
async init(): Promise<void>
```

#### Method loadState

Loads state from an object previously produced by saveState().

```ts
loadState(state: RemittanceManagerState): void
```
See also: [RemittanceManagerState](./remittance.md#interface-remittancemanagerstate)

#### Method onEvent

Registers a remittance event listener.

```ts
onEvent(listener: (event: RemittanceEvent) => void): () => void
```
See also: [RemittanceEvent](./remittance.md#type-remittanceevent)

#### Method pay

Pays an invoice by selecting a remittance option and sending a settlement message.

If receipts are enabled (receiptProvided), this method will optionally wait for a receipt.

```ts
async pay(threadId: ThreadId, optionId?: string, hostOverride?: string): Promise<Receipt | Termination | undefined>
```
See also: [Receipt](./remittance.md#interface-receipt), [Termination](./remittance.md#interface-termination), [ThreadId](./remittance.md#type-threadid), [string](./remittance.md#function-string)

#### Method persistState

Persists current state via cfg.stateSaver (if provided).

```ts
async persistState(): Promise<void>
```

#### Method preselectPaymentOption

Sets a default payment option (module id) to use when paying invoices.

```ts
preselectPaymentOption(optionId: string): void
```
See also: [string](./remittance.md#function-string)

#### Method saveState

Returns an immutable snapshot of current manager state suitable for persistence.

```ts
saveState(): RemittanceManagerState
```
See also: [RemittanceManagerState](./remittance.md#interface-remittancemanagerstate)

#### Method sendInvoice

Creates, records, and sends an invoice to a counterparty.

Returns a handle you can use to wait for payment/receipt.

```ts
async sendInvoice(to: PubKeyHex, input: ComposeInvoiceInput, hostOverride?: string): Promise<InvoiceHandle>
```
See also: [ComposeInvoiceInput](./remittance.md#interface-composeinvoiceinput), [InvoiceHandle](./remittance.md#class-invoicehandle), [PubKeyHex](./wallet.md#type-pubkeyhex), [string](./remittance.md#function-string)

#### Method sendInvoiceForThread

Sends an invoice for an existing thread, e.g. after an identity request was received.

```ts
async sendInvoiceForThread(threadId: ThreadId, input: ComposeInvoiceInput, hostOverride?: string): Promise<InvoiceHandle>
```
See also: [ComposeInvoiceInput](./remittance.md#interface-composeinvoiceinput), [InvoiceHandle](./remittance.md#class-invoicehandle), [ThreadId](./remittance.md#type-threadid), [string](./remittance.md#function-string)

#### Method sendUnsolicitedSettlement

Sends an unsolicited settlement to a counterparty.

```ts
async sendUnsolicitedSettlement(to: PubKeyHex, args: {
    moduleId: RemittanceOptionId;
    option: unknown;
    optionId?: RemittanceOptionId;
    note?: string;
}, hostOverride?: string): Promise<ThreadHandle>
```
See also: [PubKeyHex](./wallet.md#type-pubkeyhex), [RemittanceOptionId](./remittance.md#type-remittanceoptionid), [ThreadHandle](./remittance.md#class-threadhandle), [string](./remittance.md#function-string)

#### Method startListening

Starts listening for live messages (if the CommsLayer supports it).

```ts
async startListening(hostOverride?: string): Promise<void>
```
See also: [string](./remittance.md#function-string)

#### Method syncThreads

Syncs threads by fetching pending messages from the comms layer and processing them.

Processing is idempotent using transport messageIds tracked per thread.
Messages are acknowledged after they are successfully applied to local state.

```ts
async syncThreads(hostOverride?: string): Promise<void>
```
See also: [string](./remittance.md#function-string)

#### Method waitForIdentity

Waits for identity exchange to complete for a thread.

```ts
async waitForIdentity(threadId: ThreadId, opts?: {
    timeoutMs?: number;
    pollIntervalMs?: number;
}): Promise<Thread>
```
See also: [Thread](./remittance.md#interface-thread), [ThreadId](./remittance.md#type-threadid)

#### Method waitForReceipt

Waits for a receipt to arrive for a thread.

Uses polling via syncThreads because live listeners are optional.

```ts
async waitForReceipt(threadId: ThreadId, opts: {
    timeoutMs?: number;
    pollIntervalMs?: number;
} = {}): Promise<Receipt | Termination>
```
See also: [Receipt](./remittance.md#interface-receipt), [Termination](./remittance.md#interface-termination), [ThreadId](./remittance.md#type-threadid)

#### Method waitForSettlement

Waits for a settlement to arrive for a thread.

```ts
async waitForSettlement(threadId: ThreadId, opts: {
    timeoutMs?: number;
    pollIntervalMs?: number;
} = {}): Promise<Settlement | Termination>
```
See also: [Settlement](./remittance.md#interface-settlement), [Termination](./remittance.md#interface-termination), [ThreadId](./remittance.md#type-threadid)

#### Method waitForState

Waits for a thread to reach a specific state.

```ts
async waitForState(threadId: ThreadId, state: RemittanceThreadState, opts: {
    timeoutMs?: number;
    pollIntervalMs?: number;
} = {}): Promise<Thread>
```
See also: [RemittanceThreadState](./remittance.md#type-remittancethreadstate), [Thread](./remittance.md#interface-thread), [ThreadId](./remittance.md#type-threadid)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Class: ThreadHandle

A lightweight wrapper around a thread's invoice, with convenience methods.

```ts
export class ThreadHandle {
    constructor(protected readonly manager: RemittanceManager, public readonly threadId: ThreadId)
    get thread(): Thread
    async waitForState(state: RemittanceThreadState, opts?: {
        timeoutMs?: number;
        pollIntervalMs?: number;
    }): Promise<Thread>
    async waitForIdentity(opts?: {
        timeoutMs?: number;
        pollIntervalMs?: number;
    }): Promise<Thread>
    async waitForSettlement(opts?: {
        timeoutMs?: number;
        pollIntervalMs?: number;
    }): Promise<Settlement | Termination>
    async waitForReceipt(opts?: {
        timeoutMs?: number;
        pollIntervalMs?: number;
    }): Promise<Receipt | Termination>
}
```

See also: [Receipt](./remittance.md#interface-receipt), [RemittanceManager](./remittance.md#class-remittancemanager), [RemittanceThreadState](./remittance.md#type-remittancethreadstate), [Settlement](./remittance.md#interface-settlement), [Termination](./remittance.md#interface-termination), [Thread](./remittance.md#interface-thread), [ThreadId](./remittance.md#type-threadid)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
## Functions

| |
| --- |
| [copyRemittanceData](#function-copyremittancedata) |
| [decimal](#function-decimal) |
| [denseArray](#function-densearray) |
| [parseRemittanceEnvelope](#function-parseremittanceenvelope) |
| [record](#function-record) |
| [string](#function-string) |
| [timestamp](#function-timestamp) |
| [validatePeerMessage](#function-validatepeermessage) |
| [validatePeerMessageList](#function-validatepeermessagelist) |
| [validateRemittancePayload](#function-validateremittancepayload) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Function: copyRemittanceData

Safely copy persisted remittance data without invoking accessors or retaining external aliases.

```ts
export function copyRemittanceData<T>(value: T): T
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: decimal

```ts
export function decimal(value: unknown, label: string): string
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: denseArray

```ts
export function denseArray(value: unknown, label: string, maxLength = MAX_LINE_ITEMS): unknown[]
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: parseRemittanceEnvelope

Parse and structurally validate an untrusted remittance envelope.

```ts
export function parseRemittanceEnvelope(body: unknown): RemittanceEnvelope | undefined
```

See also: [RemittanceEnvelope](./remittance.md#interface-remittanceenvelope)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: record

```ts
export function record(value: unknown, label: string): DataRecord
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: string

```ts
export function string(value: unknown, label: string, maxLength = MAX_IDENTIFIER_LENGTH): string
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: timestamp

```ts
export function timestamp(value: unknown, label: string): number
```

See also: [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: validatePeerMessage

Copy and bind a transport message before any protocol state is consulted.

```ts
export function validatePeerMessage(value: unknown, expectedRecipient: string, expectedMessageBox: string): PeerMessage
```

See also: [PeerMessage](./remittance.md#interface-peermessage), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: validatePeerMessageList

Snapshot an untrusted list result without invoking element accessors.

```ts
export function validatePeerMessageList(value: unknown): unknown[]
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Function: validateRemittancePayload

Structurally validate a copied remittance payload against its declared kind and thread.

```ts
export function validateRemittancePayload(kind: RemittanceKind, threadId: string, rawPayload: unknown): RemittanceEnvelope["payload"]
```

See also: [RemittanceEnvelope](./remittance.md#interface-remittanceenvelope), [RemittanceKind](./remittance.md#type-remittancekind), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
## Types

| |
| --- |
| [RemittanceEvent](#type-remittanceevent) |
| [RemittanceKind](#type-remittancekind) |
| [RemittanceOptionId](#type-remittanceoptionid) |
| [RemittanceThreadState](#type-remittancethreadstate) |
| [ThreadId](#type-threadid) |
| [UnixMillis](#type-unixmillis) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Type: RemittanceEvent

```ts
export type RemittanceEvent = {
    type: "threadCreated";
    threadId: ThreadId;
    thread: Thread;
} | {
    type: "stateChanged";
    threadId: ThreadId;
    previous: RemittanceThreadState;
    next: RemittanceThreadState;
    reason?: string;
} | {
    type: "envelopeSent";
    threadId: ThreadId;
    envelope: RemittanceEnvelope;
    transportMessageId: string;
} | {
    type: "envelopeReceived";
    threadId: ThreadId;
    envelope: RemittanceEnvelope;
    transportMessageId: string;
} | {
    type: "identityRequested";
    threadId: ThreadId;
    direction: "in" | "out";
    request: IdentityVerificationRequest;
} | {
    type: "identityResponded";
    threadId: ThreadId;
    direction: "in" | "out";
    response: IdentityVerificationResponse;
} | {
    type: "identityAcknowledged";
    threadId: ThreadId;
    direction: "in" | "out";
    acknowledgment: IdentityVerificationAcknowledgment;
} | {
    type: "invoiceSent";
    threadId: ThreadId;
    invoice: Invoice;
} | {
    type: "invoiceReceived";
    threadId: ThreadId;
    invoice: Invoice;
} | {
    type: "settlementSent";
    threadId: ThreadId;
    settlement: Settlement;
} | {
    type: "settlementReceived";
    threadId: ThreadId;
    settlement: Settlement;
} | {
    type: "receiptSent";
    threadId: ThreadId;
    receipt: Receipt;
} | {
    type: "receiptReceived";
    threadId: ThreadId;
    receipt: Receipt;
} | {
    type: "terminationSent";
    threadId: ThreadId;
    termination: Termination;
} | {
    type: "terminationReceived";
    threadId: ThreadId;
    termination: Termination;
} | {
    type: "error";
    threadId: ThreadId;
    error: string;
}
```

See also: [IdentityVerificationAcknowledgment](./remittance.md#interface-identityverificationacknowledgment), [IdentityVerificationRequest](./remittance.md#interface-identityverificationrequest), [IdentityVerificationResponse](./remittance.md#interface-identityverificationresponse), [Invoice](./remittance.md#interface-invoice), [Receipt](./remittance.md#interface-receipt), [RemittanceEnvelope](./remittance.md#interface-remittanceenvelope), [RemittanceThreadState](./remittance.md#type-remittancethreadstate), [Settlement](./remittance.md#interface-settlement), [Termination](./remittance.md#interface-termination), [Thread](./remittance.md#interface-thread), [ThreadId](./remittance.md#type-threadid), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: RemittanceKind

Protocol envelope kinds.
Everything runs in “threads” and carries a threadId.

```ts
export type RemittanceKind = "invoice" | "identityVerificationRequest" | "identityVerificationResponse" | "identityVerificationAcknowledgment" | "settlement" | "receipt" | "termination"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: RemittanceOptionId

```ts
export type RemittanceOptionId = Base64String
```

See also: [Base64String](./wallet.md#type-base64string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: RemittanceThreadState

Remittance thread state machine.

States:
- new: thread exists but no identity/invoice/settlement activity yet.
- identityRequested: identity request sent or received.
- identityResponded: identity response sent or received.
- identityAcknowledged: identity response acknowledged (required before proceeding).
- invoiced: invoice sent or received.
- settled: settlement sent or received.
- receipted: receipt issued or received.
- terminated: thread terminated with a reason.
- errored: unexpected error occurred while processing the thread.

```ts
export type RemittanceThreadState = "new" | "identityRequested" | "identityResponded" | "identityAcknowledged" | "invoiced" | "settled" | "receipted" | "terminated" | "errored"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: ThreadId

Types for core Remittance protocol.

The goal is to keep the core protocol:
- UTXO-friendly (transactions and partial transactions can be carried as artifacts)
- Denomination-agnostic (amounts are typed, not forced to satoshis)
- Module-oriented (remittance option payloads are opaque to the core)

```ts
export type ThreadId = Base64String
```

See also: [Base64String](./wallet.md#type-base64string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Type: UnixMillis

```ts
export type UnixMillis = number
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
## Enums

## Variables

| |
| --- |
| [DEFAULT_REMITTANCE_MESSAGEBOX](#variable-default_remittance_messagebox) |
| [DefaultLockingScriptProvider](#variable-defaultlockingscriptprovider) |
| [DefaultNonceProvider](#variable-defaultnonceprovider) |
| [REMITTANCE_STATE_TRANSITIONS](#variable-remittance_state_transitions) |
| [SAT_UNIT](#variable-sat_unit) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---

### Variable: DEFAULT_REMITTANCE_MESSAGEBOX

```ts
DEFAULT_REMITTANCE_MESSAGEBOX = "remittance_inbox"
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Variable: DefaultLockingScriptProvider

```ts
DefaultLockingScriptProvider: LockingScriptProvider = {
    async pubKeyToP2PKHLockingScript(publicKey: string) {
        const address = PublicKey.fromString(publicKey).toAddress();
        return new P2PKH().lock(address).toHex();
    }
}
```

See also: [LockingScriptProvider](./remittance.md#interface-lockingscriptprovider), [P2PKH](./script.md#class-p2pkh), [PublicKey](./primitives.md#class-publickey), [string](./remittance.md#function-string), [toHex](./primitives.md#variable-tohex)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Variable: DefaultNonceProvider

```ts
DefaultNonceProvider: NonceProvider = {
    async createNonce(wallet, scope, originator) {
        const origin = originator as OriginatorDomainNameStringUnder250Bytes | undefined;
        return await createNonce(wallet, scope, origin);
    }
}
```

See also: [NonceProvider](./remittance.md#interface-nonceprovider), [OriginatorDomainNameStringUnder250Bytes](./wallet.md#type-originatordomainnamestringunder250bytes), [createNonce](./auth.md#function-createnonce)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Variable: REMITTANCE_STATE_TRANSITIONS

```ts
REMITTANCE_STATE_TRANSITIONS: Record<RemittanceThreadState, RemittanceThreadState[]> = {
    new: ["identityRequested", "invoiced", "settled", "terminated", "errored"],
    identityRequested: [
        "identityResponded",
        "identityAcknowledged",
        "invoiced",
        "settled",
        "terminated",
        "errored"
    ],
    identityResponded: ["identityAcknowledged", "invoiced", "settled", "terminated", "errored"],
    identityAcknowledged: ["invoiced", "settled", "terminated", "errored"],
    invoiced: [
        "identityRequested",
        "identityResponded",
        "identityAcknowledged",
        "settled",
        "terminated",
        "errored"
    ],
    settled: ["receipted", "terminated", "errored"],
    receipted: ["terminated", "errored"],
    terminated: ["errored"],
    errored: []
}
```

See also: [RemittanceThreadState](./remittance.md#type-remittancethreadstate)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
### Variable: SAT_UNIT

```ts
SAT_UNIT: Unit = { namespace: "bsv", code: "sat", decimals: 0 }
```

See also: [Unit](./remittance.md#interface-unit)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types), [Enums](#enums), [Variables](#variables)

---
