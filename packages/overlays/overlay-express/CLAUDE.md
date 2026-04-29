# CLAUDE.md — @bsv/overlay-express

## Purpose

Opinionated Express.js HTTP server wrapper for @bsv/overlay. Simplifies deployment of overlay services with built-in configuration methods for Knex (SQL), MongoDB, topic managers, lookup services, GASP sync, Arc callbacks, and a responsive web UI.

## Public API surface

From `mod.ts`:

- **`OverlayExpress`** (default export) — Main server class
  - Constructor: `new OverlayExpress(name, privateKey, advertisableFQDN, adminToken?)`
  - Config methods:
    - `configurePort(port)` — Set HTTP listening port (default 3000)
    - `configureKnex(knexUrl)` — Connect to SQL database
    - `configureMongo(mongoUrl)` — Connect to MongoDB
    - `configureNetwork(network)` — Set blockchain network ('main' | 'test', default 'main')
    - `configureTopicManager(name, manager)` — Register a topic manager
    - `configureLookupServiceWithMongo(name, factory)` — Create lookup service with MongoDB
    - `configureLookupServiceWithKnex(name, factory)` — Create lookup service with Knex
    - `configureEngine()` — Build underlying Engine
    - `configureEnableGASPSync(enabled)` — Enable/disable GASP sync (default true)
    - `configureEngineParams(config)` — Pass advanced Engine options
    - `configureWebUI(config)` — Set web UI styling
    - `configureJanitor(config)` — Configure health check janitor
    - `configureHealth(config)` — Set health endpoint context
    - `registerHealthCheck(check)` — Register custom health checks
  - Lifecycle: `start()` → starts Express server
  - Admin: `getAdminToken()` — retrieve auto-generated or custom admin token

- **`BanService`** — Manages blocked/banned outputs
  - Constructor: `new BanService(mongoDb)`
  - Methods: `ban(txid, outputIndex)`, `unban()`, `isBanned()`, `list()`

- **`BanAwareLookupWrapper`** — Wraps lookup service to filter banned outputs

- **`JanitorService`** — Health checks for SHIP/SLAP host availability
  - Validates remote overlay hosts and revokes failing ones

- **Types**: `EngineConfig`, `HealthCheckDefinition`, `HealthCheckHandler`, `HealthCheckResult`, `HealthConfig`, `HealthReport`, `HealthStatus`

## Real usage patterns

From README and tests:

```typescript
// 1. Basic setup
const server = new OverlayExpress(
  'testnode',
  process.env.SERVER_PRIVATE_KEY,
  'https://example.com'
)

server.configurePort(8080)
await server.configureKnex(process.env.KNEX_URL)
await server.configureMongo(process.env.MONGO_URL)

// 2. Register topic managers and lookup services
server.configureTopicManager('tm_hello', new HelloWorldTopicManager())
await server.configureLookupServiceWithMongo('ls_hello', mongoDb => 
  createHelloWorldLookupService(mongoDb)
)

// 3. Configure GASP and Arc
server.configureEnableGASPSync(true)
server.configureEngineParams({
  logTime: true,
  throwOnBroadcastFailure: true
})

// 4. Configure web UI
server.configureWebUI({
  host: 'https://example.com',
  primaryColor: '#ff0000'
})

// 5. Configure health endpoints with custom checks
server.configureHealth({
  contextProvider: async () => ({
    deployment: 'my-overlay',
    network: 'main'
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

// 6. Start the server
await server.configureEngine()
await server.start()

// 7. Admin token usage
const token = server.getAdminToken()
// Use as Bearer token: Authorization: Bearer <token>
// For /admin/syncAdvertisements, /admin/startGASPSync endpoints
```

## Key concepts

- **OverlayExpress**: One-stop configuration object; builds and starts an Express app with all overlay routes
- **Private key**: Identifies the overlay node; used for signing advertisements and transactions
- **Advertising FQDN**: Domain where this node is hosted; advertised in SHIP/SLAP for peer discovery
- **Admin token**: Bearer token for protected endpoints (/admin/syncAdvertisements, /admin/startGASPSync)
- **Knex vs MongoDB**: Knex for SQL (application-wide global storage), MongoDB for per-service indices
- **Health endpoints**:
  - `/health/live` — Liveness (process running)
  - `/health/ready` — Readiness (dependencies ready)
  - `/health` — Full report with metadata and custom checks
- **JanitorService**: Periodically validates SHIP/SLAP hosts; revokes entries if health checks fail
- **BanService**: Optional banning of specific outputs (txid.outputIndex)
- **Web UI**: Auto-serves documentation and lets users explore overlay services

## Dependencies

**Runtime:**
- `@bsv/overlay` — Core engine and interfaces
- `@bsv/overlay-discovery-services` — SHIP/SLAP implementation
- `@bsv/sdk` — Transaction and wallet types
- `@bsv/auth-express-middleware` — Authentication for admin endpoints
- `@bsv/wallet-toolbox-client` — Wallet integration
- `express` — HTTP server
- `body-parser` — Request body parsing
- `mongodb` — MongoDB driver
- `knex` — SQL query builder
- `uuid` — ID generation
- `chalk` — Colored console output

**Dev:**
- jest, ts-jest, typescript, ts-standard

## Common pitfalls / gotchas

1. **Initialization order**: `configureKnex` and `configureMongo` must complete before `configureEngine()`
2. **Private key format**: Must be valid BSV private key; used for signing, not storing secrets
3. **Admin token**: Auto-generated if not provided; store securely for production
4. **Health check criticality**: Mark as `critical: true` only for mandatory dependencies; failures block /health/ready
5. **Janitor timeout**: `requestTimeoutMs` must be reasonable; too short causes false revocations
6. **GASP sync overhead**: Disabling GASP sync (`configureEnableGASPSync(false)`) useful for local dev but loses peer sync
7. **Web UI paths**: Static assets served from `public/` directory if present; overlay service docs auto-generated
8. **BanService indexing**: Bans not persisted if underlying MongoDB goes down; transient storage only

## Spec conformance

- Implements BSV Overlay protocol with SHIP/SLAP peer discovery
- Supports Graph Aware Sync Protocol (GASP) for historical sync
- Optional Arc callback integration for proof-of-inclusion on mainnet
- Health endpoints follow Kubernetes liveness/readiness probe patterns

## File map

```
src/
├── OverlayExpress.ts         — Main server configuration class
├── BanService.ts             — Output banning logic
├── BanAwareLookupWrapper.ts  — Lookup service wrapper that filters bans
├── JanitorService.ts         — Health check and host revocation service
├── makeUserInterface.ts      — Web UI generation
└── __tests__/                — Test files
```

## Integration points

- **@bsv/overlay**: Provides Engine, TopicManager, LookupService interfaces
- **@bsv/overlay-topics**: Pre-built managers/services registered via configureTopicManager/configureLookupServiceWithMongo
- **@bsv/overlay-discovery-services**: SHIP/SLAP host discovery and peer advertisement
- **@bsv/gasp**: Optional Graph Aware Sync; configurable in engine params
- **Express**: All HTTP routing delegated to instance.app
- **Knex**: SQL database abstraction; migrations auto-applied
- **MongoDB**: Per-service lookup indices; optional but recommended for scalability
