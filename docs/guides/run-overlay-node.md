---
id: guide-overlay-node
title: "Run an Overlay Node"
kind: guide
version: "1.0.0"
last_updated: "2026-04-28"
last_verified: "2026-04-28"
review_cadence_days: 30
status: stable
tags: [guide, overlay, node, topics, typescript]
---

# Run an Overlay Node

> Deploy a BSV overlay service that indexes and queries PushDrop data. You'll set up topic managers, configure storage, and advertise your node to peers via SHIP/SLAP.

**Time:** ~30 minutes
**Prerequisites:** Node.js ≥ 20, basic understanding of Express.js, MongoDB or SQLite

## What you'll build

A production-ready overlay node that:
- Registers multiple topic managers (e.g., HelloWorld, KVStore, BTMS tokens)
- Indexes data in MongoDB
- Exposes HTTP endpoints for lookups
- Participates in peer discovery (SHIP/SLAP)
- Includes health checks and monitoring

By the end, you'll have a running overlay service that other nodes can discover and query.

## Prerequisites

- Node.js 20+ installed
- npm or pnpm
- MongoDB or SQLite (we'll use MongoDB in this guide; SQLite is simpler for local dev)
- A private key for the node identity
- A domain name or hostname for peer discovery (e.g., `https://example.com` or local IP)

## Step 1 — Create Express app and install packages

Initialize a new project with overlay dependencies:

```bash
mkdir my-overlay-node && cd my-overlay-node
npm init -y
npm install @bsv/overlay-express @bsv/overlay-topics @bsv/overlay @bsv/sdk \
  express mongodb knex sqlite3 dotenv
npm install -D typescript ts-node @types/node @types/express
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "strict": true,
    "esModuleInterop": true,
    "lib": ["ES2020"]
  }
}
```

## Step 2 — Set up environment and configuration

Create `.env`:

```bash
SERVER_PRIVATE_KEY=<your-32-byte-hex-private-key>
MONGO_URL=mongodb://localhost:27017/overlay-db
FQDN=http://localhost:8080
PORT=8080
NETWORK=test
```

Generate a private key for local testing:

```bash
node -e "console.log(require('@bsv/sdk').PrivateKey.fromRandom().toHex())"
```

## Step 3 — Initialize OverlayExpress with basic configuration

Create `server.ts`:

```typescript
import OverlayExpress from '@bsv/overlay-express'
import { MongoClient } from 'mongodb'
import dotenv from 'dotenv'

dotenv.config()

async function setupServer() {
  // 1. Create server instance
  const server = new OverlayExpress(
    'my-overlay-node',           // Name
    process.env.SERVER_PRIVATE_KEY!,  // Private key for signing
    process.env.FQDN || 'http://localhost:8080',  // Advertised domain
    process.env.ADMIN_TOKEN      // Optional admin token
  )
  
  // 2. Configure port
  server.configurePort(parseInt(process.env.PORT || '8080'))
  
  // 3. Configure MongoDB connection
  await server.configureMongo(process.env.MONGO_URL!)
  
  // 4. Configure network
  server.configureNetwork(process.env.NETWORK as 'main' | 'test' || 'test')
  
  console.log('Server configured: port, MongoDB, network')
  
  return server
}

export { setupServer }
```

The `OverlayExpress` constructor takes:
- `name`: Unique identifier for this node
- `privateKey`: Used to sign advertisements and transactions
- `advertisableFQDN`: Domain advertised to peers (for discovery)
- `adminToken`: Optional; auto-generated if not provided

## Step 4 — Register topic managers

Add topic registration to your server initialization:

```typescript
import {
  HelloWorldTopicManager,
  createHelloWorldLookupService,
  KVStoreTopicManager,
  createKVStoreLookupService,
  BTMSTopicManager,
  createBTMSLookupService
} from '@bsv/overlay-topics'

async function registerTopics(server: OverlayExpress) {
  // Register HelloWorld topic (demo)
  server.configureTopicManager('tm_hello', new HelloWorldTopicManager())
  await server.configureLookupServiceWithMongo('ls_hello', mongoDb =>
    createHelloWorldLookupService(mongoDb)
  )
  
  // Register KVStore topic (key-value protocol-agnostic)
  server.configureTopicManager('tm_kvstore', new KVStoreTopicManager())
  await server.configureLookupServiceWithMongo('ls_kvstore', mongoDb =>
    createKVStoreLookupService(mongoDb)
  )
  
  // Register BTMS topic (Basic Token Management System)
  server.configureTopicManager('tm_btms', new BTMSTopicManager())
  await server.configureLookupServiceWithMongo('ls_btms', mongoDb =>
    createBTMSLookupService(mongoDb)
  )
  
  console.log('Topics registered: hello, kvstore, btms')
}

export { registerTopics }
```

Each topic has:
- **TopicManager**: Validates which outputs are protocol-compliant
- **LookupService**: Indexes data in MongoDB for efficient queries

Registering multiple topics allows your node to index different protocols simultaneously.

## Step 5 — Configure GASP sync and health checks

Add advanced configuration:

```typescript
async function configureAdvanced(server: OverlayExpress) {
  // Enable GASP (Graph Aware Sync Protocol) for historical sync with peers
  server.configureEnableGASPSync(true)
  
  // Configure engine parameters
  server.configureEngineParams({
    logTime: true,
    throwOnBroadcastFailure: false  // Log but don't crash on broadcast failures
  })
  
  // Configure web UI
  server.configureWebUI({
    host: process.env.FQDN,
    primaryColor: '#0066cc'
  })
  
  // Set up health checks
  server.configureHealth({
    contextProvider: async () => ({
      deployment: 'my-overlay-node',
      network: process.env.NETWORK,
      nodeVersion: process.version
    })
  })
  
  // Register custom health check
  server.registerHealthCheck({
    name: 'database-connection',
    critical: true,  // Failures block /health/ready
    handler: async () => {
      try {
        // Verify MongoDB is responding
        const adminDb = server.mongoDb.db('admin')
        await adminDb.command({ ping: 1 })
        return {
          status: 'ok',
          details: { connected: true }
        }
      } catch (e) {
        return {
          status: 'down',
          details: { error: String(e) }
        }
      }
    }
  })
  
  console.log('Advanced configuration complete')
}

export { configureAdvanced }
```

This configuration:
- **GASP**: Enables peer-to-peer history synchronization
- **Health checks**: Kubernetes-style liveness/readiness probes
- **Web UI**: Auto-generates documentation for your topics
- **Logging**: Structured output for debugging

## Step 6 — Build engine and start the server

Create the main startup:

```typescript
async function main() {
  try {
    const server = await setupServer()
    await registerTopics(server)
    await configureAdvanced(server)
    
    // Build the underlying Engine (topic managers + lookup services)
    console.log('Building overlay engine...')
    await server.configureEngine()
    
    // Start the Express server
    console.log('Starting overlay node server...')
    await server.start()
    
    // Retrieve admin token for protected endpoints
    const adminToken = server.getAdminToken()
    console.log(`Admin token: ${adminToken}`)
    console.log(`\nServer running at ${process.env.FQDN}`)
    console.log(`Health check: ${process.env.FQDN}/health`)
    console.log(`API docs: ${process.env.FQDN}/`)
    
  } catch (error) {
    console.error('Failed to start overlay node:', error)
    process.exit(1)
  }
}

main()
```

The workflow is:
1. Create `OverlayExpress` instance
2. Register topic managers and lookup services
3. Call `configureEngine()` to build the overlay engine
4. Call `start()` to begin listening for HTTP requests

## Step 7 — Advertise via SHIP/SLAP (optional)

Once your node is running, advertise it to the overlay network:

```bash
# Using curl to trigger advertisement sync (requires admin token)
curl -X POST http://localhost:8080/admin/syncAdvertisements \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json"
```

Your node will now be discoverable by other overlay nodes via SHIP/SLAP protocol.

## Putting it all together

Create `server.ts` with complete initialization:

```typescript
import OverlayExpress from '@bsv/overlay-express'
import {
  HelloWorldTopicManager,
  createHelloWorldLookupService,
  KVStoreTopicManager,
  createKVStoreLookupService,
  BTMSTopicManager,
  createBTMSLookupService
} from '@bsv/overlay-topics'
import dotenv from 'dotenv'

dotenv.config()

async function main() {
  // Initialize server
  const server = new OverlayExpress(
    'my-overlay-node',
    process.env.SERVER_PRIVATE_KEY!,
    process.env.FQDN || 'http://localhost:8080'
  )
  
  // Configure basics
  server.configurePort(parseInt(process.env.PORT || '8080'))
  await server.configureMongo(process.env.MONGO_URL!)
  server.configureNetwork(process.env.NETWORK as 'main' | 'test' || 'test')
  
  // Register topics
  server.configureTopicManager('tm_hello', new HelloWorldTopicManager())
  await server.configureLookupServiceWithMongo('ls_hello', mongoDb =>
    createHelloWorldLookupService(mongoDb)
  )
  
  server.configureTopicManager('tm_kvstore', new KVStoreTopicManager())
  await server.configureLookupServiceWithMongo('ls_kvstore', mongoDb =>
    createKVStoreLookupService(mongoDb)
  )
  
  server.configureTopicManager('tm_btms', new BTMSTopicManager())
  await server.configureLookupServiceWithMongo('ls_btms', mongoDb =>
    createBTMSLookupService(mongoDb)
  )
  
  // Advanced config
  server.configureEnableGASPSync(true)
  server.configureWebUI({
    host: process.env.FQDN,
    primaryColor: '#0066cc'
  })
  
  server.configureHealth({
    contextProvider: async () => ({
      deployment: 'my-overlay-node',
      network: process.env.NETWORK
    })
  })
  
  // Build and start
  await server.configureEngine()
  await server.start()
  
  const adminToken = server.getAdminToken()
  console.log(`Overlay node running at ${process.env.FQDN}`)
  console.log(`Admin token: ${adminToken}`)
  console.log(`Topics: hello, kvstore, btms`)
  console.log(`Health: ${process.env.FQDN}/health`)
}

main().catch(console.error)
```

Run with:

```bash
npm install
npx ts-node server.ts
```

Visit `http://localhost:8080` to see the auto-generated web UI documenting your topics.

## Troubleshooting

**"MONGO_URL required" error**
→ Ensure MongoDB is running and `MONGO_URL` is set in `.env`. For local testing, use `mongodb://localhost:27017/overlay-db`

**"Initialization order" error**
→ `configureKnex()` and `configureMongo()` must complete before `configureEngine()`. Ensure these run sequentially (not in parallel)

**Health check always failing**
→ Custom health checks should handle errors gracefully. Return `{ status: 'down', details: {...} }` on failure

**GASP sync not working**
→ Ensure `configureEnableGASPSync(true)` is called and the node is advertised via SHIP/SLAP. GASP syncs with discovered peers only

**"Admin token" not generated**
→ If not provided at construction, the token is auto-generated. Retrieve it with `server.getAdminToken()` before `start()` completes

**Janitor revokes healthy hosts**
→ The health check timeout (`requestTimeoutMs`) may be too short. Increase it if false revocations occur

## What to read next

- **[Overlay Topics Reference](../packages/overlays/overlay-topics.md)** — Full list of pre-built topic managers
- **[Overlay-Express API](../packages/overlays/overlay-express.md)** — Complete configuration reference
- **[SHIP/SLAP Discovery](../specs/overlay-http.md)** — Peer discovery protocol
- **[GASP Sync Protocol](../specs/gasp-sync.md)** — Historical data synchronization
- **Creating Custom Topics** — Build your own topic managers
