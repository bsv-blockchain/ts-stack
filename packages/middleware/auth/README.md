# @bsv/auth

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
npm install @bsv/auth
```

Requires `@bsv/sdk` (`^2.1.6 || ^3.0.0`).

## Usage

Construct a client (frontend) and server (backend) instance with the **same
options** — `protocol` must match on both sides:

```ts
// options: { protocol?, windowMs? = 120000, clockSkewMs? = 30000,
//            maxBodyBytes? = 8 * 1024 * 1024 }
const OPTIONS = { protocol: [2, 'myapp auth'] }
```

### Client

```ts
import { AuthProofClient } from '@bsv/auth'

const authClient = new AuthProofClient(OPTIONS)
const proof = await authClient.createAuthProof({
  wallet,
  counterparty: backendPublicKey,
  action: 'login'
})
// POST { walletPubKey, proof } to your login endpoint
```

### Server

```ts
import { AuthProofServer } from '@bsv/auth'

const authServer = new AuthProofServer(OPTIONS)
const result = await authServer.verifyAuthProof({
  wallet: serverWallet,
  proof,
  action: 'login',
  consumeNonce
})
if (!result.valid || result.identityKey !== walletPubKey) {
  // 401
}
```

The classes are thin wrappers; the same operations are also exported as
standalone functions (`createAuthProof`, `verifyAuthProof`, `checkAuthSigData`,
`createAuthSigData`, `serializeAuthSigData`) if you prefer not to instantiate.
The proof creation and verification functions accept the same object-shaped
arguments as the wrappers.

`consumeNonce` records a proof's nonce and returns `false` if it has already been
used (a replay):

```ts
// Mongo (TTL collection: unique `nonce`, TTL index on `expiresAt` expireAfterSeconds:0)
const consumeNonce = async (nonce: string, expiresAt: Date) => {
  try {
    await col.insertOne({ nonce, expiresAt })
    return true
  } catch (e: any) {
    if (e?.code === 11000) return false
    throw e
  }
}

// In-memory (single-instance servers): a Map<nonce, expiresAtMs> with a periodic sweep.
```

See [`docs/usage.md`](./docs/usage.md) for fuller examples.

## Notes

- `protocol` must match on client and server. The explicit counterparty remains
  part of cryptographic derivation at every security level; the level controls
  wallet approval policy (`0` silent, `1` per app, `2` per counterparty). Use
  the least silent policy appropriate to the application. Names may contain
  only ASCII letters, numbers, and spaces.
- Actions are nonempty, control-free UTF-8 strings of at most 256 bytes;
  identity keys must be curve-valid canonical compressed keys; nonces must be
  canonical base64 encodings of exactly 32 random bytes; and signature arrays
  are byte-exact and bounded.
- `maxBodyBytes` defaults to 8 MiB and must match the service's request limits.
- Proof data, signatures, and wallet verdicts are copied once from exact own
  data properties before asynchronous work. Inherited, accessor-backed,
  sparse, or later-mutated authority is rejected or cannot change the verdict.
  Structured bodies reject non-finite numbers and negative zero rather than
  accepting JSON representations that collapse to `null` or `0`.
- Replay is bounded to the validity window by the expiry, and fully closed by
  `consumeNonce` — keep records only until `expiresAt` and return the exact
  boolean `true` only when the atomic insert succeeds.

## License

Open BSV License Version 6. See [LICENSE.txt](./LICENSE.txt).
