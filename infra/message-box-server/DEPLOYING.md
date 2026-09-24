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
MESSAGE_BOX_DB_DEADLOCK_RETRIES=5
MESSAGE_BOX_DB_DEADLOCK_RETRY_BASE_MS=10
MESSAGE_BOX_DB_DEADLOCK_RETRY_MAX_MS=250
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

For paid sends, a periodic snapshot alone is not a sufficient recovery source:
the wallet mutation is external to the database transaction. Retain continuous
point-in-time/binlog history and independent wallet transaction/audit evidence
from each snapshot through the present. After any restore, keep paid sends
disabled until every post-snapshot wallet action, replay claim, and
`prepared`, `wallet_accepted`, or `completed` intent has been reconstructed and
reconciled. The paid-send recovery objective is zero silent loss of replay or
intent evidence; an unresolved window is an availability event, not permission
to retry or request another spend.

The payment migrations create both `payment_replays` and
`message_payment_intents`; preserve both tables across every rollout. Custom
embedded deployments must upgrade their replay-store adapter before deploying:
it must implement `TransactionalPaymentReplayStore.claimInTransaction` and
write `payment_replays` through the supplied Knex transaction. Keep `claim` for
route-level payment middleware. Do not emulate rollback by deleting a claim
after an error, because a concurrent request may already own the same
transaction ID. The standard server uses `KnexPaymentReplayStore` and needs no
adapter migration. Transactional body-payment claims must store
`expires_at = NULL` and remain non-expiring: recipient-only payments have no
server-wallet freshness verdict, so pruning such a claim would make the old
transaction reusable for a different message.
`MESSAGE_BOX_PAYMENT_REPLAY_TTL_DAYS` applies only to ordinary route-level
BRC-105 claims.

`message_payment_intents` is the durable cross-boundary recovery protocol. A
`prepared` row binds the transaction ID to the exact canonical request before
wallet mutation, and its attempt token prevents concurrent requests from taking
ownership. `wallet_accepted` records an accepted wallet result after a
non-retryable message transaction failure so an exact retry can finish without
internalizing twice. `completed` means the message and non-expiring replay claim
committed. A process termination after wallet acceptance but before the
`wallet_accepted` update leaves an intentionally ambiguous `prepared` row;
reconcile that wallet transaction and row manually before allowing another
attempt or asking the payer to spend again. Never delete or reassign
`prepared` or `wallet_accepted` rows as a retry mechanism, and retain intent
rows unless a future reviewed retention policy proves that their replay and
recovery obligations have ended.

An application rollback cannot be image-only, and mixed-version replicas are
unsupported once paid-send traffic begins. An older image neither implements
this recovery protocol nor contains the new migration file, so migration-list
validation may refuse to start it against the migrated database. Prefer a
roll-forward. If rollback is unavoidable, stop and drain every replica,
reconcile every intent, and restore the prior image together with a verified
pre-migration database backup before restoring traffic. The down migration
intentionally refuses to drop `message_payment_intents` while any row exists;
never delete recovery rows merely to bypass that guard. Fresh body-payment
requests with a server delivery output still require a newly accepted wallet
result, and `isMerge: true` without a matching accepted intent fails closed.

The September 24 authentication migration creates `auth_message_nonces` for
`KnexSessionManager`. The service owns this table because it does not run the
Toolbox wallet database migrations. Both HTTP initial-request replay claims and
signed-message replay claims must be shared by every HTTP replica. An older
service database with only `auth_sessions` cannot complete a new HTTP handshake;
a healthy WebSocket handshake does not prove HTTP authentication works.

Apply the additive migration with the standard migration runner before accepting
HTTP traffic. It does not rewrite messages, permissions, sessions or payment
recovery state. Keep its migration file available to the ledger on every replica;
an older image lacking that file may refuse startup. Retain the replay table
across application rollbacks. Its down migration refuses to discard any existing
claim. Never disable replay checks or delete claims to restore availability.

## Probes

- `GET /healthz` — liveness; does not authenticate or disclose dependencies
- `GET /ready` — database readiness; returns 503 while unavailable

Gate traffic on readiness. Also complete an authenticated HTTP initial handshake
and signed request using a synthetic identity, and verify that replaying the
same signed request against another replica is rejected. Add an authenticated
WebSocket handshake probe when live messaging is required; it exercises a
separate session manager and cannot substitute for the durable HTTP check.

## Ingress and timeouts

For multiple replicas, preserve Engine.IO polling session affinity: every
request for one transport session must reach its originating process. Use a
load-balancer policy that works with existing credential-free cross-domain
clients, such as source-IP affinity; requiring a new third-party routing cookie
would force a client migration. Test authenticated polling and WebSocket
connections separately. Affinity is transport routing, not authentication or
durable session failover; clients reconnect after endpoint withdrawal.

Configure the proxy's idle upstream HTTP connection lifetime below the server's
five-second keep-alive timeout (for example, four seconds). Otherwise a proxy
can reuse a connection at the server's close boundary and return an intermittent
503 before an application response. Keep active-request and WebSocket stream
timeouts separate and sufficiently long. Do not add automatic payment-request
retries as a substitute for correct connection lifecycle settings.

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

Message writes create missing quota-lock rows in a short autocommit, then lock
the existing rows in stable order inside the message transaction. MySQL and
PXC serialization conflicts are retried with bounded exponential backoff.
Alert on sustained `message.store.retry` warnings: occasional retries are an
expected database concurrency signal, while exhausted retries indicate
database contention or capacity pressure. Set `MESSAGE_BOX_DB_DEADLOCK_RETRIES`
to `0` only when the database layer already provides equivalent retry handling.

`SIGTERM` and `SIGINT` first disconnect authenticated WebSockets, then drain
HTTP, close the database pool, and flush telemetry. Set a termination grace
period that includes ingress withdrawal and active-request drain time; the
service lifecycle is idempotent. Scale or permit voluntary disruption only
after the deployment supplies shared BRC-103 session, rate-limit, and
WebSocket-routing behavior.

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
3. Confirm `/healthz` and `/ready`.
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
