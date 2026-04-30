---
id: spec-brc-29-peer-payment
title: BRC-29 Simple Authenticated P2P Payment Protocol
kind: spec
version: "1.0.0"
last_updated: "2026-04-30"
last_verified: "2026-04-30"
status: stable
tags: ["spec", "payments", "brc-29"]
---

# BRC-29 Simple Authenticated P2P Payment Protocol

> BRC-29 defines how to send a peer-to-peer payment: derive a unique payment address from sender and recipient identity keys (using BRC-42 key derivation), construct a transaction with one or more P2PKH outputs to those addresses, and transmit the transaction via any transport (HTTP, WebSocket, message box). The receiver then internalizes the transaction into their wallet.

## Interactive spec

<AsyncApiEmbed slug="brc29" />

## At a glance

| Field | Value |
|---|---|
| Format | AsyncAPI 3.0 |
| Version | 1.0.0 |
| Status | stable |
| Implementations | @bsv/ts-paymail, @bsv/message-box-client |

## What problem this solves

**Deriving unique payment addresses per payer without revealing the recipient's private key**. With BRC-42/43 key derivation, a recipient can issue a new address to every payer (avoiding address reuse) without managing thousands of keys. The address is derived deterministically from sender+recipient keys, so only the recipient can receive to that address.

**Authenticated peer payments without a central service**. Traditional P2P payment requires a service to map paymail addresses to payment outputs. BRC-29 enables peer-to-peer: sender and recipient negotiate payment parameters directly (no intermediary), then sender constructs and transmits the transaction.

**Transmit flexibility**. BRC-29 specifies the transaction format (Atomic BEEF + BRC-100 envelope) but not how to send it. Payments can travel via HTTP POST, WebSocket message, message box, Paymail, or any transport layer.

## Protocol overview

**Three-step flow**:

1. **Sender → Recipient** (capability discovery) — Sender queries recipient's Paymail domain for supported capabilities (BRC-121). Learns recipient's public key and payment output derivation instructions.

2. **Sender → Recipient** (payment message) — Sender derives payment address using BRC-42:
   - `invoiceNumber = "2-3241645161d8-<prefix> <suffix>"`
   - `prefix` = server-provided nonce (BRC-29 format)
   - `suffix` = derivation suffix (e.g., base64-encoded timestamp or counter)
   - Derives address and creates P2PKH output(s) to that address
   - Wraps in Atomic BEEF (BRC-95) format
   - Sends transaction via HTTP/WebSocket/message box

3. **Recipient → Sender** (acknowledgment) — Recipient calls `wallet.internalizeAction()` to import transaction outputs. If the wallet accepts the payment, the recipient responds with acknowledgment (ACCEPTED or REJECTED).

## Key types / channels

| Channel | Direction | Message | Purpose |
|---------|-----------|---------|---------|
| `payment/send` | Send | `PaymentMessage` | Sender delivers Atomic BEEF transaction to recipient |
| `payment/acknowledge` | Receive | `PaymentAck` | Recipient confirms acceptance or rejection |

**PaymentMessage schema**:
- `tx: AtomicBEEF` — Transaction in BRC-95 Atomic BEEF format
- `amount: number` — Total satoshis in outputs (metadata)
- `derivationPrefix: string` — Server-provided nonce (BRC-29 format)
- `derivationSuffix: string` — Client-provided derivation suffix
- `metadata: object` — Optional sender metadata (memo, reference ID, etc.)

**PaymentAck schema**:
- `status: "ACCEPTED" | "REJECTED"` — Whether recipient accepted the transaction
- `txid: string` — Transaction ID (if accepted)
- `reason?: string` — Explanation if rejected

## Example: Send peer-to-peer payment via message box

```typescript
import { MessageBoxClient } from '@bsv/message-box-client'
import { P2PKH, PublicKey, Utils, WalletClient } from '@bsv/sdk'
import { brc29ProtocolID } from '@bsv/wallet-toolbox-client'

const wallet = new WalletClient('auto', 'example.com')
const msgBox = new MessageBoxClient({
  walletClient: wallet,
  host: 'https://message-box-us-1.bsvb.tech'
})

// 1. Get recipient's identity key (from Paymail or direct exchange)
const recipientKey = '025706528f0f6894b2ba505007267ccff1133e004452a1f6b72ac716f246216366'
const derivationPrefix = 'server-provided-prefix'
const derivationSuffix = 'client-created-suffix'
const keyID = `${derivationPrefix} ${derivationSuffix}`
const { publicKey: paymentPublicKey } = await wallet.getPublicKey({
  protocolID: brc29ProtocolID,
  keyID,
  counterparty: recipientKey
})
const lockingScript = new P2PKH()
  .lock(PublicKey.fromString(paymentPublicKey).toAddress())
  .toHex()

// 2. Create and process the payment action
const action = await wallet.createAction({
  description: 'P2P payment to alice',
  outputs: [
    {
      satoshis: 10000,
      lockingScript,
      outputDescription: 'payment to alice',
      customInstructions: JSON.stringify({
        derivationPrefix,
        derivationSuffix,
        recipientKey
      })
    }
  ]
})

// 3. Send the AtomicBEEF via message box
await msgBox.sendMessage({
  recipient: recipientKey,
  messageBox: 'payment_inbox',
  body: JSON.stringify({
    type: 'payment',
    beef: Utils.toBase64(action.tx!),
    amount: 10000,
    derivationPrefix,
    derivationSuffix,
    outputIndex: 0,
    memo: 'Thanks for the coffee!'
  })
})
```

Recipient receives and internalizes:

```typescript
// Recipient listens for messages
const messages = await msgBox.listMessages({ messageBox: 'payment_inbox' })

for (const msg of messages) {
  const payment = JSON.parse(msg.body)
  
  // Internalize the BEEF transaction
  const result = await wallet.internalizeAction({
    tx: Utils.toArray(payment.beef, 'base64'),
    outputs: [{
      outputIndex: payment.outputIndex,
      protocol: 'wallet payment',
      paymentRemittance: {
        derivationPrefix: payment.derivationPrefix,
        derivationSuffix: payment.derivationSuffix,
        senderIdentityKey: msg.sender
      }
    }],
    description: `Received from sender: ${payment.memo}`
  })
  
  console.log('Payment accepted:', result.accepted)
}
```

## Conformance vectors

BRC-29 conformance is tested in `conformance/vectors/wallet/brc29/payment-derivation.json`:

- Key derivation with BRC-42 (prefix/suffix parsing)
- Correct P2PKH output generation
- Deterministic payment public keys

## Implementations in ts-stack

| Package | Notes |
|---------|-------|
| @bsv/ts-paymail | Paymail client/server for capability discovery and payment routing |
| @bsv/message-box-client | Message box transport for peer-to-peer payments |
| @bsv/wallet-toolbox | `internalizeAction()` method for receiving transactions |

## Related specs

- [BRC-42/43](https://github.com/bitcoin-sv/BRCs/blob/master/wallet/0042.md) — Key derivation (used to derive payment addresses)
- [BRC-95 / BRC-62](https://github.com/bitcoin-sv/BRCs/blob/master/transactions/0095.md) — Atomic BEEF transaction format
- [BRC-100 Wallet](./brc-100-wallet.md) — `internalizeAction()` for receiving payments
- [BRC-121 Paymail](https://github.com/bitcoin-sv/BRCs/blob/master/payments/0121.md) — Service discovery for payment endpoints
- [Message Box HTTP](./message-box-http.md) — Transport layer for peer-to-peer messages

## Spec artifact

[brc29-payment-protocol.yaml](https://github.com/bsv-blockchain/ts-stack/blob/main/specs/payments/brc29-payment-protocol.yaml)
