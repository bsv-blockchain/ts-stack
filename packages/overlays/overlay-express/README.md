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

Built-in discovery overflow probes use deterministic pages of at most 1000 rows. The configured engine result ceiling and extra-row overflow error remain enforced, including standard and high-throughput profiles.

The release candidate advances the packed Overlay dependency to support optional retained admission history. This package keeps its existing behavior and does not enable history retention automatically. No consumer or database migration is required.

The optional `@bsv/overlay-express/private-publication` entry exposes verified
private publication and publisher status through the shared BRC-103/104
authentication instance. Supply the same durable service and disclosure owner;
mount before generic parsers and response transformations. It checks original
selection and current record authority again after signing, sends only bounded
public projections and fixed errors, and preserves credential-free CORS by
default. It never mounts automatically or installs a payment handler. See the
[private publication guide](../../../docs/guides/verified-private-publication.md).

## Requirements and installation

The unpublished 2.8.0 candidate also provides the optional
`@bsv/overlay-express/root-eviction-response` companion. With middleware 2.3.0,
SDK 3.3.0 and a shared root journal, `guardRootAdvertisementResponse` checks current
access and every disclosed advertisement after signing and queues the native HTTP
response under the journal's gate. Stale responses are replaced in full by a
separately authorized signed reset. Capture the revision before hydration and
supply the complete target inventory and safe control-response headers. The
[root coordination guide](../../../docs/guides/root-eviction-coordination.md)
explains storage, policy and all-path integration obligations. Existing routes
remain unchanged; importing this companion does not enable the BRC-199 profile.

The optional `@bsv/overlay-express/root-eviction` entry composes a shared
`RootEvictionService` with exact authenticated request/status routes. It preserves
received UTF-8 byte limits and checks the observed revision and current access
again at native enqueue after packet and HTTP signing. Mount before generic
parsers with the same origin authentication middleware and durable journal.
Credential-free wildcard CORS is the default; exact origins are opt-in. It does
not publish capabilities or install a decision scheduler or serving adapters.
Call `configureRootEviction` before `start()` for native host integration. The
configured root identity must match the server wallet; root, authenticated lookup
and admin routes share authentication and host request capacity. Omitted root
origins inherit the host's edge policy, and byte limits cannot exceed host limits.
The injected journal and workers retain application ownership. See the root
coordination guide for installation and remaining obligations.

The optional lookup router and `configureOutputLookup` accept a structural
`disclosure` companion for a final current-session check after HTTP signing.
`LookupResponseDisclosure` from `@bsv/output-knowledge/lookup` composes that port
with durable SQLite sessions. It can replace an ineligible data response once
with a freshly authorized signed error, or close without a body when control
access is denied. Omitting the option preserves existing behavior. See the
[durable lookup guide](../../../docs/guides/durable-live-lookup.md#check-again-after-signing)
for the shared writer gate, current policy, physical work and callback obligations.

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

## Optional progressive and live lookup

Call `configureOutputLookup` before `start`, or import `createOutputLookupRouter`
from `@bsv/overlay-express/output-lookup` for standalone Express composition. The
new adapter requires SDK 3.3.0, a durable provider companion, a signed matching
capability manifest, current authorization and explicit browser origins. The
legacy root loads this adapter only when enabled. Existing finite lookup routes
and default startup remain unchanged.

The host shares its authentication instance, verifies the serving wallet identity
and clamps advertised byte budgets to its existing edge limits. Provider storage
lifecycle remains with the caller. See the [provider guide](../../../docs/guides/durable-live-lookup.md)
for initialization, exact retry recovery, disclosure guards, multi-process wakeups,
retention and standalone router ordering. The candidate is unpublished and the
complete BRC-192–199 integration remains under qualification.

## Optional authenticated proposals

`configureProposals` before `start` or the separate
`@bsv/overlay-express/proposals` router composes the durable proposal service,
service-owned disclosure validator and shared journal/native-enqueue gate.
This entry requires SDK 3.3.0 and auth middleware 2.3; legacy root peer floors and
routes remain unchanged. A current channel read differs from recovery of a
retained publication ACK. Both require current authorization and original
contract bounds after response signing. One sanitized replacement error may be
signed, with independently checked control permission before native enqueue.

The host shares authentication and handshake ownership with lookup/root companions,
keeps physical service work counted through settlement, clamps byte limits and
inherits host CORS policy unless explicitly overridden. Storage, capability
publication, verified recovery, expiry and admission workers remain host-owned.
See the [proposal guide](../../../docs/guides/non-final-proposals.md) for composition and recovery contracts.

### Private acquisition and publication

Explicit `configurePrivateAcquisition` and `configurePrivatePublication` methods
compose the installed private services with the host's single authenticated
wallet/session. Private acquisition routes precede publication's namespace
fallback and ordinary body parsers. The default public CORS policy remains
credential-free; explicit origins and host byte ceilings are preserved.
Acquisition-configured listeners alone select a bounded 128-KiB HTTP header
allowance for BRC-105 payment evidence. Standalone applications can import
`createPrivateAcquisitionRouter` from `@bsv/overlay-express/private-acquisition`.
The application owns durable custody, permissions, wallet recovery and worker
shutdown. See [acquisition and recovery](../../../docs/guides/private-acquisition-recovery.md)
for composition, original-obligation semantics, payment/recovery requests and
proxy limits. These opt-in profiles need the new SDK output APIs; legacy startup
retains its supported SDK floor.

### Covenant purchase companions

`configurePrivatePurchase` or the optional
`@bsv/overlay-express/private-purchase` router adds the proposed BRC-196
`/overlay/v1/purchases/prepare`, `/submit` and `/recover` operations under the
configured base path. These use the shared host authentication wallet, exact
selected capability and native physical disclosure owner. Covenant payment
occurs in the independently validated transaction; these routes reject HTTP
payment headers and do not introduce a second BRC-105 charge.

Purchase, acquisition and publication share one handshake owner and preserve
ordinary `/submit`/lookup behavior, request ceilings and credential-free CORS.
The application owns original protected custody, full domain/release validation
and stopping/draining the coordinator before closing its native domain. See
[purchase custody](../../../docs/guides/private-purchase-custody.md) for the
component boundaries and remaining end-to-end qualification requirements.
