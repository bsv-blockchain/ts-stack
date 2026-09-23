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

The five public BASM JSON POST routes validate nonnegative safe-integer heights
(including existing numeric strings), 32-byte hexadecimal hashes/txids, and
request count limits. Empty raw-transaction requests remain valid; compound
proof requests require txids. The raw-transaction route does not require
`x-bsv-topic`. Missing engine/storage BASM capabilities retain HTTP 400 with
`{ status: 'error', message, code: 'BASM_UNSUPPORTED' }`. CORS, access rules,
configured limits, and automatic synchronization defaults are unchanged.

An injected topic-anchor header resolver may additionally return
`blockTransactionCount` obtained independently for the same canonical block
hash. Existing Chaintracks/provider adapters remain header-only; they do not
claim this stronger position evidence. See the core engine's
[BASM validation and recovery limits](../overlay/README.md#basm-peer-validation-and-current-recovery-limits).

GASP route failures use the configured logger and serialize thrown values into a
single escaped field, preserving diagnostic context without allowing request
content to forge additional log records. HTTP error responses remain unchanged.

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
  // as a fallback. A callback token is required before /arc-ingest is enabled.
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

  // TerraTestNet nodes additionally select TTN. WhatsOnChain does not serve
  // this network, so configureChaintracks() (or an explicit ChainTracker) is
  // required before engine initialization.
  // server.configureNetwork('ttn')

  // Lastly, configure the engine and start the server!
  await server.configureEngine()
  await server.start()

  // Stop accepting work, stop background synchronization, and close the SQL
  // and MongoDB clients during process or embedding-runtime shutdown.
  const shutdown = async () => {
    await server.close()
  }
  process.once('SIGTERM', () => void shutdown())
  process.once('SIGINT', () => void shutdown())
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

Call `await server.close()` during shutdown. It is idempotent and closes the
HTTP listener, BASM maintenance timers, the reorg stream, Knex, and MongoDB.

Janitor, Arcade, Chaintracks, reorg-stream, and monitor outbound connections
accept credential-free public HTTPS, pin resolved public addresses to the exact
origin, and do not follow redirects by default. Response headers and streamed
bodies are bounded under deadlines. `allowPrivateHosts: true` permits HTTP and
private targets only for explicit isolated local development; never combine it
with production credentials. The opt-in must be the literal boolean `true` in
both `OverlayExpress` configuration and direct exported provider constructors;
provider credentials and custom headers are copied and validated at
construction, so later caller mutation cannot change network authority.

The reorg SSE stream is only an acceleration hint. Every reported orphaned
block that would demote admitted state is checked against the configured
canonical header resolver before mutation, and a missing or still-matching
canonical header fails closed. The stream reconnects after a bounded idle
interval and on every reconnect runs the normal revalidation sweep, since the
upstream stream has no replay cursor.

The administrative page is a bearer-token UI. It uses a per-response nonce CSP,
sanitizes rendered service documentation, and loads only exact-version
integrity-pinned display libraries. It does not download a wallet SDK at
runtime. A supplied administrative bearer token must be an independently
generated random secret of at least 32 UTF-8 bytes; when omitted, OverlayExpress
generates one. Wallet mutual authentication remains supported for direct admin API
clients configured with the server admin identity key.

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
- `configureArcCallbackToken` is required to enable `/arc-ingest`; inbound
  callbacks must present the expected token as `Authorization: Bearer ...` or
  `x-callback-token`. Use an independent high-entropy secret of at least 32
  UTF-8 bytes (prefer 256 random bits), keep it out of URLs and logs, and rotate
  it as a credential. Short, control-containing, or whitespace-padded values are
  rejected.
- `configureChaintracks` configures a go-chaintracks compatible service for block
  header lookup, BASM anchor header resolution, and optional reorg SSE.

Provider callbacks posted to `/arc-ingest` are classified as successful proof,
terminal invalidation, double spend, or transient status. Double-spend and other
terminal invalid statuses remove the affected transaction from the admitted
overlay state so the lookup layer does not keep serving data that the network has
rejected. Proof callbacks are accepted only when the Merkle path contains the
claimed transaction, agrees with the claimed height, and verifies affirmatively
against the configured chain tracker.

The reorg SSE adapter treats each event as state-critical: a malformed event or
handler failure closes the stream, reconnects, and runs catch-up revalidation
before later events are consumed. It bounds frames and orphan sets and rejects
duplicate or malformed hashes rather than skipping part of an event.

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
`server.getAdminToken()`. Authenticated and rejected administrative responses
are emitted with `Cache-Control: no-store` and `Pragma: no-cache`; preserve that
policy at any reverse proxy. SHIP/SLAP record search is a bounded literal search,
not a caller-supplied MongoDB regular expression, and pagination accepts only
exact positive integers (plus the documented `-1`/`unlimited` limit form).

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
  // Details and context are public only when deliberately enabled.
  includeDetails: true,
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

Health details and context are disabled by default because the endpoints are
public and component details may disclose deployment topology. Explicitly
enabled detail/context objects are JSON-serializable, size-bounded, and subject
to the configured 1–60,000 ms check deadline. All health responses are marked
`no-store`. The janitor service also understands the richer `/health` response
format, so existing SHIP/SLAP health validation remains compatible.

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
      maintenance: {
        adminToken: process.env.OVERLAY_ADMIN_TOKEN,
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
on failed maintenance separately from lookup/proof-shape warnings. A monitor
analyzes at most 100 returned BEEF outputs per probe by default and accepts at
most 64 MiB per response; tune `maxAnalyzedOutputs` and `maxResponseBytes`
deliberately when a deployment needs different ceilings. `maxOutputs` can set a
smaller per-probe analysis cap.

## Development

From the repository root:

```bash
pnpm --filter @bsv/overlay-express format:check
pnpm --filter @bsv/overlay-express lint
pnpm --filter @bsv/overlay-express typecheck
pnpm --filter @bsv/overlay-express test
pnpm --filter @bsv/overlay-express test:coverage
pnpm --filter @bsv/overlay-express test:live
pnpm --filter @bsv/overlay-express pack:check
```

The package check builds locally packed release candidates for Overlay Express
and its workspace Overlay dependencies, then verifies the npm tarball with
publint, strict type resolution, and clean ESM/CommonJS consumer projects.
`test:live` separately verifies public Arcade/Chaintracks endpoints without a
private credential; it is scheduled/release evidence, not deterministic PR
coverage.

## License

Current TS Stack changes are licensed under the Open BSV License Version 6; see
[LICENSE.txt](./LICENSE.txt). This package also retains pre-uniformization code
under the Open BSV License Version 4. Redistributors must preserve
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) and the applicable text in
[`LICENSES/`](./LICENSES/).

Thank you for being a part of the BSV Blockchain Overlay Express Project. Let's build the future of BSV Blockchain together!
