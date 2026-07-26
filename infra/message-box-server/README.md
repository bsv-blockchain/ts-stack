# Message Box Server

Private deployable service for authenticated, optionally encrypted
store-and-forward messaging. It provides HTTP polling, live authenticated
WebSockets, recipient permissions and fees, wallet-payment handling, and
optional Firebase push notifications.

The maintained source lives in
[`bsv-blockchain/ts-stack`](https://github.com/bsv-blockchain/ts-stack/tree/main/infra/message-box-server).
The service is distributed as a container; it is not a public npm package.

## Runtime model

- Node.js 24
- Express 5
- MySQL 8 through Knex
- BRC-103 authentication over HTTP and WebSocket transports
- `@bsv/wallet-toolbox` for the service wallet
- optional Firebase Admin push delivery
- optional OpenTelemetry OTLP export

Clients normally use
[`@bsv/message-box-client`](../../packages/messaging/message-box-client).
Message bodies are encrypted by the client unless plaintext is explicitly
requested. The server authenticates identities and routes the stored payload;
it does not hold recipient decryption keys.

## Routes

Public routes:

| Method | Path            | Purpose                  |
| ------ | --------------- | ------------------------ |
| GET    | `/health`       | Process liveness         |
| GET    | `/ready`        | Database readiness       |
| GET    | `/docs`         | Swagger UI               |
| GET    | `/openapi.json` | Runtime OpenAPI document |

BRC-103-authenticated routes:

| Method | Path                  | Purpose                                      |
| ------ | --------------------- | -------------------------------------------- |
| POST   | `/sendMessage`        | Send to one or up to 100 recipients          |
| POST   | `/listMessages`       | Read an identity-owned message box           |
| POST   | `/acknowledgeMessage` | Delete acknowledged identity-owned messages  |
| POST   | `/registerDevice`     | Register a Firebase push token               |
| GET    | `/devices`            | List registered devices with redacted tokens |
| POST   | `/permissions/set`    | Set a sender-specific or box-wide permission |
| GET    | `/permissions/get`    | Get a permission                             |
| GET    | `/permissions/list`   | List permissions                             |
| GET    | `/permissions/quote`  | Quote one or up to 100 recipients            |

`ROUTING_PREFIX` prefixes HTTP routes in deployments that mount the service
below a path.

## Public-service edge policy

Message Box is intended for deployed applications, wallet UIs, mobile
webviews, native shells, and callers on unknown domains.

`MESSAGE_BOX_CORS_MODE` controls browser access:

- `public` — default credential-free wildcard access, including `Origin: null`
- `allowlist` — exact origins from `MESSAGE_BOX_CORS_ALLOWED_ORIGINS`
- `disabled` — emit no CORS policy

Wildcard origin is never combined with credentials. CORS is not
authentication, and CSP is not API authorization. BRC-103 identity, box
ownership, permissions, payments, rate limits, body limits, and end-to-end
encryption remain the security boundaries.

HTTP and WebSocket payloads, concurrency, request rates, timeouts, proxy trust,
and security headers are bounded and environment-configurable. Invalid or
unbounded numeric settings fail startup.

## Required configuration

| Variable             | Purpose                             |
| -------------------- | ----------------------------------- |
| `SERVER_PRIVATE_KEY` | Dedicated 256-bit service root key  |
| `KNEX_DB_CONNECTION` | JSON MySQL connection configuration |

Important optional configuration:

| Variable                                   | Default / purpose                       |
| ------------------------------------------ | --------------------------------------- |
| `NODE_ENV`                                 | `development`                           |
| `PORT` / `HTTP_PORT`                       | `8080`; `PORT` takes precedence         |
| `ROUTING_PREFIX`                           | Empty                                   |
| `ENABLE_WEBSOCKETS`                        | `true`                                  |
| `WALLET_STORAGE_URL`                       | Wallet storage service URL              |
| `BSV_NETWORK`                              | `mainnet`; use `testnet` for test chain |
| `ENABLE_FIREBASE`                          | Firebase disabled unless `true`         |
| `LOGGING_ENABLED`                          | Verbose logs when `true`                |
| `TRUST_PROXY_HOPS`                         | Exact trusted proxy hops, 0–10          |
| `MESSAGE_BOX_CORS_MODE`                    | `public`                                |
| `MESSAGE_BOX_CORS_ALLOWED_ORIGINS`         | Exact origins for allowlist mode        |
| `MESSAGE_BOX_MAX_BODY_BYTES`               | 4 MiB                                   |
| `MESSAGE_BOX_WEBSOCKET_MAX_BODY_BYTES`     | 1 MiB                                   |
| `MESSAGE_BOX_PRE_AUTH_RATE_LIMIT_MAX`      | 300 per minute per IP                   |
| `MESSAGE_BOX_AUTHENTICATED_RATE_LIMIT_MAX` | 1,000 per minute per identity           |

See
[`docs/infrastructure/service-edge-security.md`](../../docs/infrastructure/service-edge-security.md)
for the complete shared edge policy.

## Local development

From this directory:

```bash
cp .env.example .env
npm ci --ignore-scripts
npm rebuild better-sqlite3
docker compose up -d backend-mysql
npm run dev
```

Use a dedicated local-only `SERVER_PRIVATE_KEY`; never reuse a production key.
The Compose stack expects that value from the environment.

Run checks:

```bash
npm run typecheck
npm run lint
npm test
npm run test:coverage
npm run build
npm audit --audit-level=high
```

The separate client integration suite requires configured wallet, server,
database, WebSocket, and overlay services and is intentionally opt-in.

## Database and readiness

Migrations in `src/migrations/` run at startup. `/health` reports only process
liveness. `/ready` verifies database connectivity and returns 503 without
exposing dependency details while the service is unavailable.

After a production build, migrations can also be run explicitly:

```bash
npx --no-install knex --knexfile out/knexfile.js migrate:latest --env production
```

## WebSockets

The service uses `@bsv/authsocket`. The peer identity comes from the signed
BRC-103 transport, never solely from a payload claim. A claim must match that
identity; connections may join only identity-owned rooms; delivery
notifications target only connections authenticated as the recipient.
WebSocket sends reuse the HTTP handler's validation, fee, permission,
deduplication, and persistence behavior.

The in-memory connection map is process-local. Horizontally scaled deployments
need sticky routing or an authenticated shared broker.

## Container

The multi-stage Dockerfile uses a digest-pinned Node 24 Alpine base, installs
dependencies without unrestricted lifecycle scripts, explicitly rebuilds the
allowlisted native module, and runs the HTTP/WebSocket service directly as the
unprivileged `node` user.

```bash
docker build -t message-box-server:local .
```

For production deployment, use the repository release workflow and immutable
image evidence rather than a local `latest` tag. See [DEPLOYING.md](./DEPLOYING.md).

## API specification

The reviewed source artifact is
[`specs/messaging/message-box-http.yaml`](../../specs/messaging/message-box-http.yaml).
Runtime Swagger is useful for inspection; the repository OpenAPI artifact and
implementation tests are the contract evidence.

## License

See [LICENSE.txt](./LICENSE.txt).
