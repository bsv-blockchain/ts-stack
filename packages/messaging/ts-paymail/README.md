# BSV Paymail

`@bsv/paymail` provides a typed Paymail client and an Express router for
capability discovery, public profiles, PKI, P2P transaction delivery,
transaction negotiation, and simple ordinal flows.

## Requirements and installation

The package supports Node.js 22 or newer. Install the package and its required
SDK and Express peers:

```sh
npm install @bsv/paymail @bsv/sdk
npm install express @types/express
```

The router uses the host application's Express runtime and type graph and
supports Express 4.18 or newer, including Express 5. Browser bundles still
exclude the server router and its Express implementation.

The package publishes native ESM and CommonJS entry points with
module-specific declarations. The root browser condition contains only the
client, capability, and error APIs; Express router code is excluded from
browser bundles.

Supported public entry points are:

- `@bsv/paymail`
- `@bsv/paymail/client`
- `@bsv/paymail/capability`
- `@bsv/paymail/router`
- `@bsv/paymail/errors`

## Client

```ts
import { PaymailClient } from '@bsv/paymail'

const client = new PaymailClient()
const profile = await client.getPublicProfile('satoshi@example.com')
const capabilities = await client.getCapabilities('example.com')

console.log(profile.name, profile.avatar)
console.log(capabilities)
```

The default HTTP client enforces a 30-second timeout. Capability documents are
cached per client instance. Supply a custom `HttpClient`, DNS resolver options,
or localhost port to the constructor when testing or integrating a different
transport.

## Server router

Domain handlers receive the Express route-parameter object followed by the
validated request body. Use `getNameAndDomain` rather than parsing the handle
again:

```ts
import express from 'express'
import { PaymailRouter, PublicKeyInfrastructureRoute, PublicProfileRoute } from '@bsv/paymail'

const app = express()

const profileRoute = new PublicProfileRoute({
  domainLogicHandler: async params => {
    const { name, domain } = PublicProfileRoute.getNameAndDomain(params)
    const user = await fetchUser(name, domain)
    return {
      name: user.alias,
      avatar: user.avatarUrl
    }
  }
})

const pkiRoute = new PublicKeyInfrastructureRoute({
  domainLogicHandler: async params => {
    const { name, domain } = PublicKeyInfrastructureRoute.getNameAndDomain(params)
    const user = await fetchUser(name, domain)
    return {
      bsvalias: '1.0',
      handle: `${name}@${domain}`,
      pubkey: user.identityKey
    }
  }
})

const paymail = new PaymailRouter({
  baseUrl: 'https://paymail.example.com',
  routes: [profileRoute, pkiRoute]
})

app.use(paymail.getRouter())
app.listen(3000)
```

`baseUrl` is the externally reachable origin advertised in the
`/.well-known/bsvalias` capability document. `basePath` can be supplied when
the router is mounted below the origin root.

### Cross-origin deployment

The library does not impose CORS or CSP policy. Paymail capability endpoints
are public protocol surfaces and commonly need to remain callable by deployed
applications across unrelated domains, webviews, and future clients. Configure
CORS at the host application or edge:

- keep credential-free public APIs broadly accessible by default when the
  service contract requires it;
- make exact-origin allowlists and credentialed origin handling explicit
  operator choices;
- never combine wildcard origins with credentialed requests; and
- treat CSP as a document/UI policy, not as API authorization.

Authentication and authorization must be enforced by the protocol or route
logic rather than by assuming browser-origin headers are an access-control
boundary.

## Signing compatibility

`createP2PSignature` produces the compact Base64 Bitcoin Signed Message form
accepted by the raw, BEEF, and ordinal receive routes when signature
verification is enabled. The receiver verifies the transaction-ID signature
locally before performing the Paymail ownership lookup for the declared public
key, so malformed signatures cannot trigger outbound discovery work.

## Development and verification

From the repository root:

```sh
pnpm --filter @bsv/paymail format:check
pnpm --filter @bsv/paymail lint
pnpm --filter @bsv/paymail typecheck
pnpm --filter @bsv/paymail test:coverage
pnpm --filter @bsv/paymail pack:check
pnpm --filter @bsv/paymail test:browser
pnpm --filter example-paymail test
```

Tests are deterministic and must not depend on public Paymail or DNS services.
The private examples under `docs/examples` are compiled fixtures for explicit
manual use; their external-service credentials and example private keys are
supplied through environment variables and must never be committed.

`pack:check` installs the exact dry-packed tarball into clean ESM and CommonJS
consumers and validates declarations, export maps, publint, and payload
hygiene. `test:browser` installs that same tarball and measures Vite and
esbuild bundles against the checked-in browser budget.

Package publishing is performed only by the repository release workflow. Do
not publish from a developer workstation.

Additional API and protocol material is available in [`docs`](./docs).
Please report defects through the
[ts-stack issue tracker](https://github.com/bsv-blockchain/ts-stack/issues).

## License

Open BSV License Version 6. See [`LICENSE.txt`](./LICENSE.txt).
