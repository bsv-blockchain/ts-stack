# Overlay Express

BSV BLOCKCHAIN | Overlay Express

An opinionated but configurable Overlay Services deployment system:

- Uses express for HTTP on a given local port
- Easy setup with just a private key and a hosting URL
- Import and configure your topic managers the way you want
- Add lookup services, with easy factories for Mongo and Knex
- Implements a configurable web UI to show your custom overlay service docs to the world
- Uses common Knex/SQL and Mongo databases across all services for efficiency
- Supports SHIP, SLAP, and GASP sync out of the box (or it can be disabled)
- Supports Arc callbacks natively for production (or disable it for simplicity during local development)
- Supports Arcade-first broadcast/proof lookup, Arc fallback broadcast,
  Chaintracks header validation, BASM reorg streaming, and active
  monitor-driven maintenance

## Requirements and installation

Overlay Express requires Node.js 22 or newer and a separately installed
`@bsv/sdk` peer dependency.

```bash
npm install @bsv/overlay-express @bsv/sdk
```

The package provides matching ESM and CommonJS entry points with
condition-specific declarations:

```ts
import OverlayExpress, { OverlayMonitor } from '@bsv/overlay-express'
```

```js
const { default: OverlayExpress, OverlayMonitor } = require('@bsv/overlay-express')
```

## Example Usage

Here's a quick example:

```typescript
import OverlayExpress from '@bsv/overlay-express'
import dotenv from 'dotenv'
dotenv.config()

// Hi there! Let's configure Overlay Express!
const main = async () => {
  // We'll make a new server for our overlay node.
  const server = new OverlayExpress(
    // Name your overlay node with a one-word lowercase string
    `testnode`,

    // Provide the private key that gives your node its identity
    process.env.SERVER_PRIVATE_KEY!,

    // Provide the public FQDN without a scheme (for example, overlay.example)
    process.env.HOSTING_FQDN!
  )

  // Decide what port you want the server to listen on.
  server.configurePort(8080)

  // Public CORS is the default so wallet UIs and mobile-backed web apps can
  // call the protocol from previously unknown domains. Deployments with a
  // closed caller set can opt into exact origins and customize the UI CSP.
  server.configureEdgePolicy({
    allowedOrigins: process.env.OVERLAY_CORS_ALLOWED_ORIGINS?.split(','),
    securityHeaders: {
      contentSecurityPolicy: process.env.OVERLAY_CONTENT_SECURITY_POLICY
    }
  })

  // Connect to your SQL database with Knex
  await server.configureKnex(process.env.KNEX_URL!)

  // Also, be sure to connect to MongoDB
  await server.configureMongo(process.env.MONGO_URL!)

  // Here, you will configure the overlay topic managers and lookup services you want.
  // - Topic managers decide what outputs can go in your overlay
  // - Lookup services help people find things in your overlay
  // - Make use of functions like `configureTopicManager` and `configureLookupServiceWithMongo`
  // ADD YOUR OVERLAY SERVICES HERE

  // For simple local deployments, sync can be disabled.
  server.configureEnableGASPSync(false)

  // Production deployments should configure at least one transaction
  // propagation provider. Arcade can be used as the primary provider with Arc
  // as a fallback. The callback token is optional, but recommended when
  // exposing /arc-ingest publicly.
  server.configureArcade(process.env.ARCADE_URL!, {
    apiKey: process.env.ARCADE_API_KEY,
    deploymentId: process.env.ARCADE_DEPLOYMENT_ID,
    chaintracksApiPrefix: '/chaintracks/v2'
  })
  if (process.env.ARC_API_KEY) {
    server.configureArcApiKey(process.env.ARC_API_KEY)
  }
  if (process.env.ARC_CALLBACK_TOKEN) {
    server.configureArcCallbackToken(process.env.ARC_CALLBACK_TOKEN)
  }

  // Chaintracks-compatible services provide block headers for BASM and can
  // stream reorg notifications. Arcade exposes go-chaintracks under
  // /chaintracks/v2.
  server.configureChaintracks(process.env.CHAINTRACKS_URL ?? process.env.ARCADE_URL!, {
    apiPrefix: '/chaintracks/v2',
    reorgStream: true,
    scanDepth: 3
  })

  // Lastly, configure the engine and start the server!
  await server.configureEngine()
  await server.start()
}

// Happy hacking :)
main()
```

## Full API Docs

Check out [API.md](./API.md) for the API docs.

## Additional Features

### Public HTTP edge policy

Overlay nodes are public protocol services. With no CORS configuration,
OverlayExpress returns `Access-Control-Allow-Origin: *` and never enables
cookie credentials. Set `OVERLAY_CORS_MODE=allowlist` with exact
`OVERLAY_CORS_ALLOWED_ORIGINS`, pass `allowedOrigins` to
`configureEdgePolicy`, or use `OVERLAY_CORS_MODE=disabled` for a deliberately
closed browser surface.

`configureEdgePolicy` also controls JSON/binary body limits, per-process
concurrency, Node HTTP timeouts, CSP, and other security headers. Environment
overrides are listed in `.env.example`. Protocol authentication, admin
authentication, callback tokens, and input validation remain required
regardless of CORS mode.

CSP applies to documents served by this process; it does not grant or deny API
callers. Configure UI CSP and API CORS independently. Credentialed cross-origin
requests require exact allowed origins and must never be combined with a
wildcard origin.

Janitor outbound checks accept only public HTTPS targets on the standard port
and do not follow redirects by default. `allowPrivateHosts: true` exists only
for isolated local development.

### Advanced Engine Configuration

We've introduced a new method, `configureEngineParams`, that allows you to pass advanced configuration options to the underlying Overlay Engine. Here's an example usage:

```typescript
server.configureEngineParams({
  logTime: true,
  throwOnBroadcastFailure: true,
  overlayBroadcastFacilitator: new MyCustomFacilitator()
})
```

`throwOnBroadcastFailure` should remain `true` for most production overlays. With
provider-chain broadcast configured, this means a transaction is not committed to
overlay state unless at least one provider accepts it or returns an already-known
success. Set it to `false` only for deliberate offline/dev workflows where local
overlay admission may proceed without current network propagation.

### Transaction Propagation Providers

Overlay Express can compose multiple transaction propagation and proof sources:

```typescript
server.configureArcade('https://arcade-v2-us-1.bsvblockchain.tech', {
  apiKey: process.env.ARCADE_API_KEY,
  deploymentId: 'my-overlay-node',
  chaintracksApiPrefix: '/chaintracks/v2'
})

server.configureArcApiKey(process.env.ARC_API_KEY!)
server.configureArcCallbackToken(process.env.ARC_CALLBACK_TOKEN!)

server.configureChaintracks('https://arcade-v2-us-1.bsvblockchain.tech', {
  apiPrefix: '/chaintracks/v2',
  reorgStream: true,
  scanDepth: 3
})
```

- `configureArcade` registers Arcade as the first-choice broadcaster and proof
  lookup provider.
- `configureArcApiKey` registers the standard Arc broadcaster as fallback.
- `configureArcCallbackToken` requires inbound `/arc-ingest` callbacks to present
  the expected token.
- `configureChaintracks` configures a go-chaintracks compatible service for block
  header lookup, BASM anchor header resolution, and optional reorg SSE.

Provider callbacks posted to `/arc-ingest` are classified as successful proof,
terminal invalidation, double spend, or transient status. Double-spend and other
terminal invalid statuses remove the affected transaction from the admitted
overlay state so the lookup layer does not keep serving data that the network has
rejected.

### BASM And Unproven Maintenance

BASM is opt-in because it requires direct proofs and block header resolution:

```typescript
server.configureEnableBASMSync(true)
server.configureBASMBlockPollInterval(10 * 60 * 1000)
server.configureUnprovenMaintenance({
  intervalMs: 60 * 60 * 1000,
  thresholdBlocks: 144
})
```

When configured, unproven maintenance first tries the configured proof providers
for transactions that remain unproven past the threshold. Only transactions that
still cannot be proven are evicted. Operators can also run this manually through
the admin endpoints documented below.

### Admin-Protected Endpoints

We also provide admin-protected endpoints for advanced operations like manually
syncing advertisements, triggering GASP/BASM sync, running unproven maintenance,
evicting specific outpoints, and running the janitor. These endpoints require a
Bearer token. You can supply a custom token in the constructor of
`OverlayExpress`, or retrieve the auto-generated token by calling
`server.getAdminToken()`.

Common admin endpoints:

- `POST /admin/syncAdvertisements`
- `POST /admin/startGASPSync`
- `POST /admin/startBASMSync`
- `POST /admin/refreshUnprovenProofs`
- `POST /admin/evictUnproven`
- `POST /admin/maintainUnproven`
- `POST /admin/evictOutpoint`
- `POST /admin/janitor`

### Health Endpoints

Overlay Express now exposes three health endpoints:

- `GET /health/live`: liveness-only status for process-level checks.
- `GET /health/ready`: readiness status for critical dependencies such as the Overlay engine, Knex, and MongoDB.
- `GET /health`: full component report combining liveness, readiness, service metadata, and any registered custom checks.

You can attach additional application-aware checks and context:

```typescript
server.configureHealth({
  contextProvider: async () => ({
    deployment: 'cars-project-backend',
    network: process.env.NETWORK
  })
})

server.registerHealthCheck({
  name: 'custom-cache',
  critical: false,
  handler: async () => ({
    status: 'ok',
    details: { warmed: true }
  })
})
```

The janitor service also understands the richer `/health` response format, so existing SHIP/SLAP health validation remains compatible.

### Overlay Monitor

`OverlayMonitor` provides a reusable worker for monitoring Overlay Express lookup
behavior and, when configured with an admin token, running maintenance actions.
It posts configured `/lookup` probes to any Overlay Express deployment, measures
response size, parses returned BEEF, and reports whether responsive output
transactions have direct Merkle proofs or are being served with deeper proof
ancestry.

This is intended to be run by deployments as a long-running monitor process or by cluster scheduling. It is not tied to a specific deployment platform.

```typescript
import { OverlayMonitor } from '@bsv/overlay-express'

const monitor = new OverlayMonitor({
  intervalMs: 24 * 60 * 60 * 1000,
  targets: [
    {
      name: 'example-overlay',
      baseUrl: 'https://overlay.example',
      probes: [
        {
          name: 'example-topic',
          service: 'ls_example',
          query: { topic: 'tm_example' },
          maxOutputs: 20
        }
      ],
      adminToken: process.env.OVERLAY_ADMIN_TOKEN,
      maintenance: {
        startBASMSync: true,
        maintainUnproven: {
          thresholdBlocks: 144
        },
        janitor: true
      }
    }
  ],
  onReport: async report => {
    console.log(JSON.stringify(report.summary))
  }
})

monitor.start()
```

Maintenance requests are reported alongside lookup probes so operators can alert
on failed maintenance separately from lookup/proof-shape warnings.

## Development

From the repository root:

```bash
pnpm --filter @bsv/overlay-express format:check
pnpm --filter @bsv/overlay-express lint
pnpm --filter @bsv/overlay-express typecheck
pnpm --filter @bsv/overlay-express test
pnpm --filter @bsv/overlay-express test:coverage
pnpm --filter @bsv/overlay-express pack:check
```

The package check builds locally packed release candidates for Overlay Express
and its workspace Overlay dependencies, then verifies the npm tarball with
publint, strict type resolution, and clean ESM/CommonJS consumer projects.

## License

The license for the code in this repository is the Open BSV License. Refer to [LICENSE.txt](./LICENSE.txt) for the license text.

Thank you for being a part of the BSV Blockchain Overlay Express Project. Let's build the future of BSV Blockchain together!
