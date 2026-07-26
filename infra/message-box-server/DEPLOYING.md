# Message Box Server deployment

This service is released from the ts-stack repository as a Node.js 24
container. Prefer the repository CI/CD release path so the deployed image is
traceable to reviewed source, scanned, signed, and addressed by an immutable
tag or digest.

## Dependencies

- MySQL 8
- a dedicated 256-bit `SERVER_PRIVATE_KEY`
- wallet storage when required by the chosen wallet configuration
- optional Firebase credentials
- optional OTLP/HTTP collector

Do not copy secrets into the image, source repository, build arguments, or
logs. Supply them through the deployment platform's secret mechanism and
rotate them through the owning operations process.

## Build and validate

CI builds Linux/amd64 images. For a local functional check:

```bash
npm ci --ignore-scripts
npm rebuild better-sqlite3
npm run typecheck
npm run lint
npm test
npm run build
docker build -t message-box-server:local .
```

The Dockerfile uses a digest-pinned Node 24 Alpine base, performs a
deny-by-default dependency install, rebuilds only the required native module,
and runs the final service as the unprivileged `node` user.

## Required runtime configuration

```env
NODE_ENV=production
SERVER_PRIVATE_KEY=<dedicated-secret>
KNEX_DB_CLIENT=mysql2
KNEX_DB_CONNECTION={"host":"mysql","port":3306,"user":"messagebox","password":"<secret>","database":"messagebox"}
ENABLE_WEBSOCKETS=true
```

Typical deployment options:

```env
PORT=8080
ROUTING_PREFIX=
BSV_NETWORK=mainnet
WALLET_STORAGE_URL=https://storage.example.com
MESSAGE_BOX_CORS_MODE=public
TRUST_PROXY_HOPS=1
OTEL_EXPORTER_OTLP_ENDPOINT=https://otel.example.com
```

Use `TRUST_PROXY_HOPS` only when the exact proxy topology is known. The service
ignores forwarded addresses by default.

## Browser access

Message Box is a public protocol service. Keep `MESSAGE_BOX_CORS_MODE=public`
for arbitrary deployed apps, wallet UIs, mobile webviews, native shells, and
unknown future domains. This mode is credential-free wildcard CORS and
supports opaque `Origin: null`.

Operators with a closed deployment may choose:

```env
MESSAGE_BOX_CORS_MODE=allowlist
MESSAGE_BOX_CORS_ALLOWED_ORIGINS=https://app.example.com,https://wallet.example.com
```

or disable CORS entirely with `MESSAGE_BOX_CORS_MODE=disabled`. Never combine
wildcard origins with credentials. CSP governs served documents such as
Swagger UI; it is not API authentication.

## Database migrations

Migrations run automatically during server startup. They can be applied
explicitly from a built release:

```bash
npx --no-install knex --knexfile out/knexfile.js migrate:latest --env production
```

Back up the database before schema changes and retain the prior immutable image
for application rollback. A rollback must consider whether a migration is
backward-compatible with the prior application version.

## Probes

- `GET /health` — liveness; does not authenticate or disclose dependencies
- `GET /ready` — database readiness; returns 503 while unavailable

Gate traffic on readiness. Add an authenticated WebSocket handshake probe when
live messaging is a required deployment capability.

## Ingress and timeouts

The image serves HTTP and WebSocket traffic directly on `PORT` (8080 by
default). Put the platform ingress or load balancer in front of the container
and keep its ceilings aligned with the application:

- HTTP JSON default: 4 MiB
- WebSocket signed-event default: 1 MiB
- bounded header, request, keep-alive, socket, and upstream timeouts
- bounded pre-auth and authenticated rates
- bounded concurrent application work

At multiple replicas, the default in-memory rate-limit store is per process.
Enforce an aggregate policy at the trusted ingress or configure a shared store.
WebSocket routing is also process-local; use sticky sessions or an
authenticated shared broker.

## Firebase

Firebase is off unless `ENABLE_FIREBASE=true`. Prefer workload identity or a
secret-mounted service-account file. If inline JSON is unavoidable, inject it
as a secret and ensure the platform does not expose environment values in logs
or diagnostic UIs.

## Observability

Set an OTLP endpoint and resource attributes for production. Logs and traces
must not include private keys, complete device tokens, auth signatures,
payment payloads, or plaintext message content.

## Rollout

1. Deploy the immutable image to a canary or staging environment.
2. Confirm migrations completed.
3. Confirm `/health` and `/ready`.
4. Exercise authenticated send, list, and acknowledge.
5. Exercise an authenticated WebSocket send when enabled.
6. Verify public/default or allowlisted browser access as configured.
7. Verify rate-limit, body-limit, and timeout telemetry.
8. Roll out gradually and monitor error, latency, database, and connection
   metrics.

Rollback to the prior image digest when the database remains compatible.
Record the deployed source revision, image digest, migration state, validation
evidence, and rollback result in the owning operations system.

## License

See [LICENSE.txt](./LICENSE.txt).
