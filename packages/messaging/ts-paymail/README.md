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

The default HTTP client requires HTTPS outside exact `localhost` development,
rejects redirects and private-network destinations, pins the complete approved
DNS result set for Node requests, and applies its 30-second deadline while
streaming at most 1 MiB of response data. Capability documents are coalesced,
cached for five minutes, and held under a 256-domain LRU ceiling per client.
`HttpClient` exposes explicit response-size, private-network, and resolver
options for controlled integration and testing; private-network access is
never enabled implicitly.

The DNS pinning guarantee applies to Node, where the client controls lookup
and the transport connection. Browser builds cannot replace the browser's DNS
resolution or socket selection; use them only for ordinary user-initiated
Paymail origins. Applications that accept attacker-selected Paymail domains or
need an SSRF boundary must proxy requests through the Node client (or an
equivalent server-side egress policy).

Discovery accepts only the exact `bsvalias: "1.0"` document shape with a
bounded own-data map of string or boolean capabilities. DNS-over-HTTPS SRV
answers must belong to the exact queried owner name even when DNSSEC reports
the response authenticated; an authenticated but unrelated RRset is not a
delegation for the requested Paymail domain.

Public-profile avatar values are restricted to credential-free public HTTPS
URLs without fragments or literal/local hosts. They remain untrusted media
locations: the package does not fetch or authenticate the referenced bytes.
Use them only in a non-navigating image context, never as HTML/iframe/script
input, and use a DNS-pinned media proxy with MIME and size enforcement when the
application needs stronger content isolation.

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
the router is mounted below the origin root. Production origins must use
HTTPS; plain HTTP is accepted only for exact `localhost` development. The
router validates every Paymail handle before domain logic, returns 400 for
malformed JSON, and rejects conflicting sender-validation configuration.
The router snapshots its validated origin, path, route descriptors, capability
codes, handlers, and sender-validation mode during construction. Mutating the
legacy public configuration fields or caller-owned route arrays afterwards
does not rewrite the mounted routes or discovery authority. Capability codes
must be unique, and capability metadata is copied before a derived BFRC is
computed.

Payment-destination handlers must return canonical hexadecimal scripts and
non-negative integer outputs whose total exactly equals the requested amount.
Ordinal-destination handlers must return exactly the requested number of
scripts. The router snapshots request amounts, transaction encodings, and
identity parameters before invoking application code, so handler mutation
cannot move a response check away from the wire request.
Transaction-receive handlers must return the txid of the raw or BEEF
transaction passed to them; an unrelated acknowledgement is treated as an
internal handler failure rather than sent to the client.

The router cannot determine an application's reference-token semantics or
crediting policy. Before broadcasting, crediting, or acknowledging a
transaction, domain logic must validate that its outputs satisfy the exact
recipient and reference, apply application-specific transaction policy, and
claim the txid/outpoints idempotently in durable state.

Transaction-negotiation requests are public, untrusted protocol input. The
route validates their structural fields and transaction framing, not sender
identity, thread authorization, freshness, supported embedded protocols,
Merkle/miner evidence, or callback-token ownership. Domain logic must validate
those policies before storing, notifying, signing, broadcasting, or using a
`reply_to` destination; a public-looking HTTPS peer-channel URL is not an
authentication verdict.

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
verification is enabled. `verifySignature` defaults to `false` for legacy
compatibility; in that mode metadata is untrusted and must never authorize a
sender. The receiver verifies the transaction-ID signature
locally before performing the Paymail ownership lookup for the declared public
key, so malformed signatures cannot trigger outbound discovery work. The
router historically derives its `requestSenderValidation` advertisement from
these receive routes; an explicit value must agree with them.

That historical advertisement reuses BRFC `6745385c3fc0`, which the upstream
Paymail specification defines for signed, timestamped Basic Address Resolution
requests—not for P2P transaction metadata. Treat it only as this package's
legacy statement about its configured receive routes. It does not prove
standards-compliant payer validation, timestamp checking, or replay defense.
Correcting the meaning requires a coordinated capability-document migration;
silently removing or reinterpreting the deployed code would break wire
discovery behavior.

The legacy Paymail signature preimage contains only the transaction ID. It
does not cryptographically bind the route recipient, reference, sender handle,
or endpoint authority. Treat it only as proof that the resolved key signed
that transaction ID, and independently enforce recipient/output/reference and
replay checks in domain logic. Full contextual sender authorization requires a
new versioned signature preimage and coordinated protocol migration; silently
changing the existing preimage would break deployed signatures.

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

Current TS Stack changes are licensed under the Open BSV License Version 6; see
[`LICENSE.txt`](./LICENSE.txt). This package also retains pre-uniformization
code under its package-specific Open BSV License Version 4 grant.
Redistributors must preserve
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) and the applicable text in
[`LICENSES/`](./LICENSES/).
