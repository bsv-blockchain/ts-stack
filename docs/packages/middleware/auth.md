---
id: pkg-auth
title: '@bsv/auth'
kind: package
domain: middleware
version: '0.1.1'
last_updated: '2026-07-27'
last_verified: '2026-07-27'
review_cadence_days: 30
npm: 'https://www.npmjs.com/package/@bsv/auth'
repo: 'https://github.com/bsv-blockchain/ts-stack/tree/main/packages/middleware/auth'
status: beta
tags: [middleware, authentication, wallet, replay]
---

# @bsv/auth

`@bsv/auth` provides framework-neutral, expiry-bound, single-use wallet
authentication proofs. It separates proof creation and verification from HTTP,
Express, and database choices.

## Install

Install the SDK peer dependency with the package:

```bash
npm install @bsv/auth @bsv/sdk
```

## Public API

- `AuthProofClient` and `createAuthProof` create an action-bound proof with a
  wallet.
- `AuthProofServer` and `verifyAuthProof` verify the signature, identity,
  action, expiry, and nonce.
- `checkAuthSigData`, `createAuthSigData`, and `serializeAuthSigData` expose
  the lower-level proof data contract.

```ts
import { AuthProofClient, AuthProofServer } from '@bsv/auth'

const options = { protocol: [2, 'example auth'] as [2, string] }
const client = new AuthProofClient(options)
const server = new AuthProofServer(options)
```

Client and server must use the same protocol. Production verification must
inject an atomic `consumeNonce` implementation. A process-local map is suitable
only for one process; replicated or restarting services need a shared store
with uniqueness and expiry.

The package publishes strict ESM and CommonJS entry points and supports Node.js
22 or newer. See the
[package README](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/middleware/auth#readme)
for a complete client/server example and store guidance.

## License

Open BSV License Version 6. See the
[package license](https://github.com/bsv-blockchain/ts-stack/blob/main/packages/middleware/auth/LICENSE.txt).
