# @bsv/auth-express-middleware

An **Express.js** middleware that implements **BRC-103** [Peer-to-Peer Mutual Authentication](https://github.com/bitcoin-sv/BRCs/blob/master/peer-to-peer/0103.md) via **BRC-104** [HTTP Transport](https://github.com/bitcoin-sv/BRCs/blob/master/peer-to-peer/0103.md). This library makes it easy to **mutually authenticate** and exchange **verifiable certificates** between clients and servers in a standardized way.

By layering **BRC-103** on top of Express, you can:

- Perform a **cryptographic handshake** between two peers (your server and an external wallet/user).  
- Request or respond with **certificates** that verify user identity or attributes.  
- Enforce mutual authentication for your APIs, ensuring that each side proves its identity, without passwords or reliance on centralized authentication providers.  
- Optionally enable **selective disclosure** of certificate fields.

---

## Table of Contents

1. [Background](#background)  
2. [Features](#features)  
3. [Installation](#installation)  
4. [Quick Start](#quick-start)  
5. [Detailed Usage](#detailed-usage)  
   - [Creating the Middleware](#creating-the-middleware)  
   - [Injecting the Middleware into Express](#injecting-the-middleware-into-express)  
   - [Handling Certificates](#handling-certificates)  
   - [Interpreting Authenticated Requests](#interpreting-authenticated-requests)  
6. [API Reference](#api-reference)  
7. [Examples](#examples)  
8. [Security Considerations](#security-considerations)  
9. [Resources & References](#resources--references)  
10. [License](#license)

---

## Background

**BRC-103** is a specification for **mutual authentication** and **certificate exchange** over a **peer-to-peer** channel. It uses nonce-based challenges, digital signatures, and an optional selective disclosure mechanism for certificates. **BRC-104** defines how to transport these messages specifically over **HTTP**, describing custom headers and the `.well-known/auth` endpoint.

**`@bsv/auth-express-middleware`** abstracts the complexities of these specs behind a typical **Express** middleware. It verifies BRC-103/104–compliant requests and properly signs responses, all while letting you continue to write normal Express code for your routes.

---

## Features

- **Seamless Integration**  
  Plug straight into your existing Express application—no need for rewriting your entire HTTP handling logic.

- **Mutual Authentication**  
  Authenticates **both** the server and the client cryptographically, preventing impersonation or MITM attacks.

- **Certificate Handling**  
  Request, receive, and verify BRC-103 identity certificates. Includes utility methods to request additional certificates from the client.

- **Selective Disclosure**  
  Supports BRC-103’s concept of revealing only certain fields in a certificate, helping to preserve privacy for you and your users while verifying necessary information.

- **Extendable**  
  Provide a custom `SessionManager` or plug in advanced logic for verifying user attributes.

---

## Installation

```bash
npm i @bsv/auth-express-middleware
```

This package depends on [Express.js](https://www.npmjs.com/package/express) (4.x or 5.x) and a BRC-100–capable wallet (e.g., the `@bsv/sdk` implementation or your own code).

---

## Quick Start

Below is the minimal setup to enable BRC-103 mutual authentication in your Express server:

```ts
import express from 'express'
import bodyParser from 'body-parser'
import { createAuthMiddleware } from '@bsv/auth-express-middleware'
import { ProtoWallet as Wallet } from '@bsv/sdk' // You need a wallet that supports BRC-100 keys & signing

// 1. Initialize your BSV wallet (manages keys and signs messages)
const wallet = new Wallet(new PrivateKey('...', 16))

// 2. Create the auth middleware
//    - Set `allowUnauthenticated` to false to require mutual auth on every route
const authMiddleware = createAuthMiddleware({
  wallet,
  allowUnauthenticated: false
})

// 3. Create and configure the Express app
const app = express()
app.use(bodyParser.json())

// 4. Apply the auth middleware globally (or to specific routes)
app.use(authMiddleware)

// 5. Define your routes as usual
app.get('/', (req, res) => {
  if (req.auth && req.auth.identityKey !== 'unknown') {
    // The request is authenticated
    res.send(`Hello, authenticated peer with public key: ${req.auth.identityKey}`)
  } else {
    // Not authenticated
    res.status(401).send('Unauthorized')
  }
})

app.listen(3000, () => {
  console.log('Server is running on port 3000')
})
```

When the server receives a **BRC-103** handshake or "general" message, `@bsv/auth-express-middleware` automatically handles the cryptographic checks. Once verified, `req.auth.identityKey` will hold the **public key** of the authenticated peer.

---

## Detailed Usage

### Creating the Middleware

Use the factory function:
```ts
createAuthMiddleware({
  wallet: myWallet, 
  allowUnauthenticated?: boolean,
  sessionManager?: SessionManager,
  certificatesToRequest?: RequestedCertificateSet,
  onCertificatesReceived?: (senderPublicKey, certs, req, res, next) => void
})
```

#### Options

- **`wallet`** *(required)*: A wallet instance that implements signing and key management, typically from `@bsv/sdk` or your own custom build.  
- **`allowUnauthenticated`** *(default: `false`)*: If `true`, requests without valid BRC-103 authentication will **not** be rejected. Instead, `req.auth.identityKey` is set to `"unknown"`.  
- **`sessionManager`** *(optional)*: Customize session management (nonce tracking, etc.). By default, an internal `SessionManager` is used.  
- **`certificatesToRequest`** *(optional)*: A specification of which certificates (by type, fields, issuer) to request automatically from the peer.  
- **`onCertificatesReceived`** *(optional)*: Callback invoked when the peer responds with **Verifiable Certificates**.

### Injecting the Middleware into Express

Simply call:

```ts
app.use(express.json()) // required before the middleware is used
app.use(createAuthMiddleware({ wallet: myWallet }))
```

You can also place the middleware at the route level:

```ts
app.post('/secure-upload', createAuthMiddleware({ wallet: myWallet }), (req, res) => {
  // ...
})
```

### Handling Certificates

If you set `certificatesToRequest`, the middleware will attempt to request certificates from the client during the handshake. When certificates arrive, the `onCertificatesReceived` callback (if provided) will fire:

```ts
function onCertificatesReceived(senderPublicKey, certs, req, res, next) {
  // You can inspect the provided certificates here
  console.log(`Received ${certs.length} certificate(s) from ${senderPublicKey}.`)
  
  // Continue to next middleware or route handler
  next()
}

const authMiddleware = createAuthMiddleware({
  wallet,
  certificatesToRequest: {
    certifiers: ['<33-byte-pubkey-of-certifier>'],
    types: {
      'age-verification': ['dateOfBirth', 'country']
    }
  },
  onCertificatesReceived
})
```

In your server logic, you can then verify or store these certificates as needed. Replace fields like `age-verification` with an actual base64 certificate type.

### Interpreting Authenticated Requests

Once a peer is authenticated, you'll have:

- `req.auth.identityKey` ⇒ the authenticated user's **33-byte compressed public key** (hex-encoded).  
- `req.body` ⇒ your normal request body (parsed by `express.json()` or similar).  
- Standard `req.headers` ⇒ includes `x-bsv-auth-*` headers with BRC-103 handshake data (for debugging).  

If `allowUnauthenticated` is **false**, any request without a valid handshake or signature is **rejected** with `401` automatically.

---

## API Reference

### `createAuthMiddleware(options: AuthMiddlewareOptions)`

Returns an Express middleware function. **Options**:

- **`wallet`**: (required) A BRC-100 object implementing your signing and verification logic.  
- **`sessionManager`**: (optional) Manage nonces & state across requests.  
- **`allowUnauthenticated`**: (optional) If true, non-authenticated requests are allowed but marked as `identityKey: 'unknown'`.  
- **`certificatesToRequest`**: (optional) Automatic certificate request data structure.  
- **`onCertificatesReceived`**: (optional) A callback triggered when certs arrive from the client.

---

## Examples

### 1. Minimal Setup

```ts
import express from 'express'
import { createAuthMiddleware } from '@bsv/auth-express-middleware'
import { Wallet } from '@your/bsv-wallet'

const app = express()
const wallet = new Wallet({ /* config for your keys */ })

app.use(express.json())
app.use(createAuthMiddleware({ wallet }))

app.get('/protected', (req, res) => {
  if (req.auth && req.auth.identityKey !== 'unknown') {
    return res.send('You are authenticated via BRC-103!')
  }
  res.status(401).send('Unauthorized')
})

app.listen(3000, () => console.log('BRC-103 server listening on port 3000!'))
```

### 2. Requesting Certificates at Handshake

```ts
import express from 'express'
import { createAuthMiddleware } from '@bsv/auth-express-middleware'
import { Wallet } from '@your/bsv-wallet'

const wallet = new Wallet()

function onCertificatesReceived(senderPublicKey, certs, req, res, next) {
  console.log(`Received certs from ${senderPublicKey}`, certs)
  next()
}

const authMiddleware = createAuthMiddleware({
  wallet,
  certificatesToRequest: {
    certifiers: ['<certifier-pubkey-hex>'],
    types: {
      'someCertificateType': ['fieldA', 'fieldB']
    }
  },
  onCertificatesReceived
})

const app = express()
app.use(express.json())
app.use(authMiddleware)

app.listen(3000, () => console.log('Server up!'))
```

---

## Security Considerations

1. **TLS Encryption**: Although BRC-103 messages are authenticated, the protocol does **not** encrypt the entire payload. It's recommended to serve your Express app over **HTTPS** to maintain confidentiality.  
2. **Nonce Replay Prevention**: This library implements a `SessionManager` that automatically rejects nonces not bound by the server's private key.  
3. **Transport-Only**: BRC-104's HTTP specification focuses on message authenticity, not on anonymizing request metadata.  
4. **Certificate Revocation**: BRC-103 allows for revocation references (`revocationOutpoint`). Ensure your app checks the blockchain or an appropriate certificate revocation overlay service if you require strict revocation handling.

---

## Resources & References

- [BRC-103 Spec](https://github.com/bitcoin-sv/BRCs/blob/master/peer-to-peer/0103.md) – Mutual authentication & certificate exchange.  
- [BRC-104 Spec](https://github.com/bitcoin-sv/BRCs/blob/master/peer-to-peer/0103.md) – HTTP Transport for BRC-103.  
- [@bsv/sdk](https://www.npmjs.com/package/@bsv/sdk) – BSV TypeScript SDK (often used for cryptographic utilities, wallet logic, etc.).  
- [Express.js](https://expressjs.com/) – Web framework for Node.js.

---

## License

[Open BSV License](./LICENSE.txt)

---

**Happy hacking!** If you have questions, suggestions, or want to contribute improvements, feel free to open an issue or PR in our repository. 