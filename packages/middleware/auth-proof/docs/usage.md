# Using `@bsv/auth-proof`

A signed, expiry-bound, single-use proof that a request comes from the holder of
a wallet's identity key.

## The shape of the flow

1. **Client** asks its wallet to sign `{ action, identityKey, expiresAt, nonce }`
   and sends `{ proof }` (plus whatever your endpoint needs) to the server.
2. **Server** verifies the signature against the claimed identity key, checks the
   proof is fresh (not expired, not minted too far in the future), and consumes
   the nonce once. If all pass, the caller provably controls that key.

```
client wallet ──createAuthProof──▶  { data: {action, identityKey, expiresAt, nonce}, signature }
                                          │  POST
                                          ▼
server wallet ──verifyAuthProof──▶  signature ✓ + fresh ✓ + nonce unused ✓ → identityKey
```

## Configure once (same options on both sides)

`protocol` drives key derivation, so it **must match** on client and server.

```ts
// shared.ts (or just inline the same options in both places)
import type { WalletProtocol } from '@bsv/sdk'

export const AUTH_OPTIONS = {
  protocol: [2, 'myapp auth'] as WalletProtocol
  // windowMs?    default 120000 (2 min)
  // clockSkewMs? default 30000
}
```

## Client

```ts
import { AuthProofClient } from '@bsv/auth-proof'
import { AUTH_OPTIONS } from './shared'

const authClient = new AuthProofClient(AUTH_OPTIONS)

// `wallet` is any BRC-100 wallet (e.g. WalletClient); `backendPublicKey` is the
// server's identity public key.
const proof = await authClient.createAuthProof(wallet, backendPublicKey, 'login')

await fetch('/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ walletPubKey, proof })
})
```

## Server

`verifyAuthProof` needs your single-use store via `consumeNonce`. Always check
that the proof's `identityKey` matches the identity the request claims to act on.

```ts
import { AuthProofServer } from '@bsv/auth-proof'
import { AUTH_OPTIONS } from './shared'

const authServer = new AuthProofServer(AUTH_OPTIONS)

const result = await authServer.verifyAuthProof(serverWallet, proof, 'login', {
  consumeNonce
})
if (!result.valid || result.identityKey !== walletPubKey) {
  return new Response('Unauthorized', { status: 401 })
}
// result.identityKey is the authenticated wallet — proceed (issue session, etc.)
```

### `consumeNonce` — your single-use store

It records a nonce and returns `false` if it was already used (a replay). Keep
records only until `expiresAt`, so storage stays bounded.

**MongoDB (serverless / multi-instance)** — a TTL collection:

```ts
// indexes (once): { nonce: 1 } unique, { expiresAt: 1 } expireAfterSeconds: 0
import type { ConsumeNonce } from '@bsv/auth-proof'

export const consumeNonce: ConsumeNonce = async (nonce, expiresAt) => {
  try {
    await authNoncesCollection.insertOne({ nonce, expiresAt })
    return true
  } catch (e: any) {
    if (e?.code === 11000) return false // duplicate key → replay
    throw e
  }
}
```

**In-memory (single, long-lived server)** — a `Map` with a periodic sweep. Only
safe when the process is single-instance; a restart re-opens at most one
`windowMs` of replay, since the expiry lives in the signed payload:

```ts
const used = new Map<string, number>() // nonce -> expiresAt (ms)

export const consumeNonce = (nonce: string, expiresAt: Date): boolean => {
  const now = Date.now()
  for (const [n, exp] of used) if (exp <= now) used.delete(n) // cheap sweep
  if ((used.get(nonce) ?? 0) > now) return false              // replay
  used.set(nonce, expiresAt.getTime())
  return true
}
```

## Distinct actions

Pass a different `action` per endpoint (`'login'`, `'create-user'`, `'delete'`,
…) and verify with the matching one. A proof minted for `'login'` is rejected by
a `'delete'` endpoint, so proofs can't be replayed across operations.

## Standalone functions

The classes are thin wrappers. If you prefer not to instantiate, the same
operations are exported as functions taking a trailing `options` argument:
`createAuthProof`, `verifyAuthProof`, `checkAuthSigData`, `createAuthSigData`,
`serializeAuthSigData`.

## Why use this?

- **Signature verification.** A signature can only be produced by the identity
  key's private key (asymmetric), so it genuinely proves ownership.
- **Carries an expiry.** Replay is bounded to a short window without storing
  anything forever; the single-use store only needs to remember nonces until
  they expire.
- **Bound to an action.** The signed payload names the operation, so a proof
  can't be reused for a different endpoint.