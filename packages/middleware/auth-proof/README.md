# @bsv/auth-proof

Simple, secure wallet login for BSV apps. A client wallet signs a short-lived
proof that it controls an identity key; the server verifies the signature,
checks freshness, and consumes the proof once. The single-use store is injected,
so the library is framework- and database-agnostic.

- **Signature-based** — proves control of the wallet's identity key (asymmetric;
  the server cannot forge it).
- **Expiry-bound** — each proof is valid for a short window (default 2 minutes).
- **Single-use** — an injected store rejects replays.

A client signs `{ action, identityKey, expiresAt, nonce }` and sends the proof;
the server verifies the signature, that the proof is fresh, and that its nonce
has not been seen before.

## Install

```bash
npm install @bsv/auth-proof
```

Requires `@bsv/sdk` (>= 2.0).

## Usage

Construct a client (frontend) and server (backend) instance with the **same
options** — `protocol` must match on both sides:

```ts
// options: { protocol?, windowMs? = 120000, clockSkewMs? = 30000 }
const OPTIONS = { protocol: [2, 'myapp auth'] }
```

### Client

```ts
import { AuthProofClient } from '@bsv/auth-proof'

const authClient = new AuthProofClient(OPTIONS)
const proof = await authClient.createAuthProof(wallet, backendPublicKey, 'login')
// POST { walletPubKey, proof } to your login endpoint
```

### Server

```ts
import { AuthProofServer } from '@bsv/auth-proof'

const authServer = new AuthProofServer(OPTIONS)
const result = await authServer.verifyAuthProof(serverWallet, proof, 'login', {
  consumeNonce // your single-use store
})
if (!result.valid || result.identityKey !== walletPubKey) {
  // 401
}
```

The classes are thin wrappers; the same operations are also exported as
standalone functions (`createAuthProof`, `verifyAuthProof`, `checkAuthSigData`,
`createAuthSigData`, `serializeAuthSigData`), each taking a trailing `options`
argument, if you prefer not to instantiate.

`consumeNonce` records a proof's nonce and returns `false` if it has already been
used (a replay):

```ts
// Mongo (TTL collection: unique `nonce`, TTL index on `expiresAt` expireAfterSeconds:0)
const consumeNonce = async (nonce: string, expiresAt: Date) => {
  try { await col.insertOne({ nonce, expiresAt }); return true }
  catch (e: any) { if (e?.code === 11000) return false; throw e }
}

// In-memory (single-instance servers): a Map<nonce, expiresAtMs> with a periodic sweep.
```

See [`docs/usage.md`](./docs/usage.md) for fuller examples.

## Notes

- `protocol` must match on client and server (it drives key derivation). Names
  may only contain letters, numbers, and spaces.
- Replay is bounded to the validity window by the expiry, and fully closed by
  `consumeNonce` — keep records only until `expiresAt`.
