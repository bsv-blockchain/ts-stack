# Nonce Verification (Proof of Key Ownership)

> **Related:** [Verifying BSV Certificates](./certificate-verify.md) — nonce verification and certificate verification work together to form a complete auth security model. Certificate verification proves a credential was legitimately issued; nonce verification proves the requester currently holds the private key behind it.

## Background

Verifying a certificate's signature proves the certificate was legitimately issued by a trusted certifier. It does *not* prove that the person making the current request actually holds the private key associated with the certificate. An attacker who obtained a copy of someone's certificate object (e.g. via a network intercept) could replay it and be issued a session token for that user.

Nonce verification closes this gap by requiring a cryptographic proof-of-key-ownership at request time.

## How BSV Nonces Work

`createNonce(wallet, counterpartyPublicKey)` asks the user's wallet to derive a shared secret from their private key and the server's public key (ECDH), then produce a short nonce token from it.

`verifyNonce(nonce, serverWallet, claimedSubjectKey)` on the server performs the same ECDH derivation in reverse — using the server's private key and the claimed identity key — and checks that the token matches. Because the derivation requires the user's actual private key, a valid nonce can only be produced by someone who controls the private key for the claimed identity.

```
User's private key    ──┐
                         ├── ECDH ──► shared secret ──► nonce token
Server's public key  ──┘

Server's private key  ──┐
                         ├── ECDH ──► shared secret ──► verify token matches
User's public key    ──┘
```

## SDK API

```ts
// WalletCounterparty = PubKeyHex | 'self' | 'anyone'

createNonce(
  wallet: WalletInterface,           // the user's wallet (e.g. WalletClient)
  counterparty?: WalletCounterparty  // server's compressed public key hex
): Promise<Base64String>

verifyNonce(
  nonce: Base64String,               // the token produced by createNonce
  wallet: WalletInterface,           // the server's ProtoWallet
  counterparty?: WalletCounterparty  // user's compressed public key hex
): Promise<boolean>

// ProtoWallet — lightweight wallet for ECDH without transaction support
new ProtoWallet(PrivateKey.fromString(hexString))
```

## Implementation

### Frontend

```ts
import { createNonce } from '@bsv/sdk';

// SERVER_PUBLIC_KEY is the server's compressed public key hex
// Safe to expose to the client — it is not a secret
const nonce = await createNonce(userWallet, SERVER_PUBLIC_KEY);

// Include nonce in your API request body
await api.request({ identityKey, certificate, nonce });
```

### Backend — Server Wallet Setup

Create a module-level `ProtoWallet` from your server's private key:

```ts
import { ProtoWallet, PrivateKey } from '@bsv/sdk';

const serverWallet = new ProtoWallet(
    PrivateKey.fromString(process.env.SERVER_PRIVATE_KEY!)
);
export default serverWallet;
```

Instantiating at module load time (rather than per-request) ensures a missing key causes an immediate startup failure rather than a silent auth bypass at runtime.

### Backend — Verification

Run nonce verification *before* any database logic:

```ts
import { verifyNonce } from '@bsv/sdk';
import serverWallet from './serverWallet';

// nonce and identityKey come from the request body
const nonceValid = await verifyNonce(nonce, serverWallet, identityKey);
if (!nonceValid) {
    return 401; // Proof of key ownership failed
}
```

## Environment Variables

| Variable | Side | Purpose |
|---|---|---|
| `SERVER_PRIVATE_KEY` | Server only | Hex private key for the server's `ProtoWallet`; used as the wallet arg to `verifyNonce` |
| `SERVER_PUBLIC_KEY` | Client | Corresponding compressed public key hex; passed as the `counterparty` arg to `createNonce` |

These must form a matching key pair. The public key is safe to expose to clients — it is not a secret. The private key must never leave the server.

## Security Properties

| Threat | Without nonce | With nonce |
|---|---|---|
| Replay a stolen certificate | Authenticated successfully | Rejected (nonce invalid) |
| Present a certificate for a different identity key | Authenticated as cert owner | Rejected by subject check, then nonce |
| Forge a certificate | Rejected by `cert.verify()` | Same |
| Impersonate a known identity key without the private key | Not checked | Rejected by nonce |
