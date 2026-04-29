---
id: concepts
title: Key Concepts
kind: meta
version: "n/a"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
status: stable
tags: ["concepts", "protocol"]
---

# Key Concepts

ts-stack uses several concepts from the BSV protocol and the ecosystem. Understanding them helps you choose the right packages and architecture for your app.

![Concepts overview: a transaction wrapped in BEEF (with SPV merkle proof) signed by a BRC-100 wallet flows into an Overlay Node where the Topic Manager admits it and the Lookup Service indexes it for application queries — identity keys tie everything together](../assets/diagrams/concepts-overview.svg)

## BEEF (Binary Encoded Extended Format)

BEEF is a binary format that bundles a transaction together with all the merkle proofs needed to prove it's in the chain. Instead of saying "trust me, this transaction is in the chain," you send BEEF to another system and they can verify it immediately using Simplified Payment Verification (SPV).

**Why it matters:** BEEF lets you move transactions and proof between systems without requiring a trusted intermediary. You can hand a BEEF payload to a wallet, an overlay, or another app and they can verify it themselves.

**In ts-stack:** The [SDK](../packages/sdk/index.md) has native BEEF encoding and decoding. Use it whenever you're passing transactions between systems.

```typescript
import { Transaction, Beef } from '@bsv/sdk';

const beef = Beef.fromTransaction(tx, merkleProof);
const verified = beef.verify();
```

## Overlay

An overlay is a service that indexes and serves a specific slice of on-chain data, so applications don't have to scan the entire chain to find what they need. Examples include:

- A token registry overlay that indexes all BTMS token transactions
- An identity overlay that keeps a directory of public keys and identity metadata
- A file storage overlay (UHRP) that indexes data inscriptions

**In ts-stack:** The [Overlay](../packages/overlays/overlay.md) and [Overlay Express](../packages/overlays/overlay-express.md) packages let you run your own overlay. Applications connect to overlays through the [Overlay HTTP](../specs/overlay-http.md) spec.

## Topic Manager

Inside an overlay, a topic manager validates which transactions belong to a topic and maintains that topic's state. Different topic managers implement different protocols:

- **UHRP Topic Manager** — Stores and retrieves files by hash
- **BTMS Topic Manager** — Manages token issuance and transfers
- **Custom Topic Manager** — Implement your own protocol

**In ts-stack:** The [Overlay Topics](../packages/overlays/topics.md) package provides topic manager patterns. Each topic manager is responsible for validating transactions before the overlay indexes them.

## BRC-100 (Wallet Interface)

BRC-100 is a standard interface that wallets implement. It defines the RPC surface for signing, encrypting, authenticating, and (optionally) managing keys. An app using BRC-100 can work with any BRC-100-compliant wallet.

**Why it matters:** Instead of writing wallet integration logic for each wallet provider, you implement BRC-100 once and work with all of them.

**In ts-stack:** The [Wallet Toolbox](../packages/wallet/wallet-toolbox.md) and [Wallet Relay](../packages/wallet/wallet-relay.md) packages implement BRC-100 from both the app and wallet sides.

### BRC-100 Methods

- **`sign(message)`** — Sign arbitrary data with a key
- **`encrypt(plaintext)`** — Encrypt data for a recipient's public key
- **`decrypt(ciphertext)`** — Decrypt data sent to you
- **`authenticate(payload)`** — Sign a challenge to prove you control a key
- **`getKeys()`** — List available keys (if wallet manages them)

## SPV (Simplified Payment Verification)

Proof that a transaction is in the chain without downloading the whole chain. SPV uses merkle proofs: you have a transaction, its position in a block, the merkle root, and a chain of merkle siblings all the way up to the block header.

**In ts-stack:** The [SDK](../packages/sdk/index.md) validates merkle proofs in BEEF format. Pass BEEF to `Beef.verify()` and it checks the proof without needing a full node.

## Identity Key

A long-lived public key that represents a user, service, or application across the stack. Unlike transaction keys (which rotate for privacy), identity keys are stable and reusable.

**Why it matters:**
- Apps can authenticate users with a single identity key
- Users can prove they sent a message or transaction
- Overlays can validate that submissions come from trusted sources
- Messaging systems can route encrypted messages to a recipient's identity key

**In ts-stack:** Every authenticated operation uses an identity key. The [Authsocket](../packages/messaging/authsocket.md) and [Auth Middleware](../packages/middleware/auth-express-middleware.md) packages build on identity keys.

## Transaction vs. Identity Key

| Aspect | Transaction Key | Identity Key |
|--------|-----------------|--------------|
| Lifetime | Single transaction | Long-lived (months/years) |
| Reuse | No (privacy) | Yes (authentication) |
| Discovery | Derived from inputs, not known beforehand | Published, discoverable |
| Use case | Spending UTXO control | Authentication, encryption, messaging |

## Protocol vs. Metadata

On BSV, data is stored in two places:

1. **On-chain (Bitcoin Script)** — The actual transaction outputs that can be spent
2. **Metadata (OP_RETURN)** — Non-spendable data in transaction outputs

Topic managers validate metadata to determine which transactions belong to a topic. The actual token balance or file content lives in metadata, but spending rights live in the Script outputs.

## Next Steps

- **[Choose Your Stack](./choose-your-stack.md)** — See which packages implement these concepts
- **[Specs](../specs/index.md)** — Deep dive into BRC standards
- **[Guides](../guides/index.md)** — See concepts in action
