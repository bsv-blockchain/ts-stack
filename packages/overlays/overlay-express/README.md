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

        // Provide the HTTPS URL where your node is available on the internet
        process.env.HOSTING_URL!
    )

    // Decide what port you want the server to listen on.
    server.configurePort(8080)

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

### Advanced Engine Configuration

We've introduced a new method, `configureEngineParams`, that allows you to pass advanced configuration options to the underlying Overlay Engine. Here's an example usage:

```typescript
server.configureEngineParams({
  logTime: true,
  throwOnBroadcastFailure: true,
  overlayBroadcastFacilitator: new MyCustomFacilitator()
})
```

### Admin-Protected Endpoints

We also now provide admin-protected endpoints for certain advanced operations like manually syncing advertisements or triggering GASP sync. These endpoints require a Bearer token. You can supply a custom token in the constructor of `OverlayExpress`, or retrieve the auto-generated token by calling `server.getAdminToken()`. You can then include this token as a Bearer token in the `Authorization` header of requests to the `/admin/syncAdvertisements` and `/admin/startGASPSync` endpoints.

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

## License

The license for the code in this repository is the Open BSV License. Refer to [LICENSE.txt](./LICENSE.txt) for the license text.

Thank you for being a part of the BSV Blockchain Overlay Express Project. Let's build the future of BSV Blockchain together!
