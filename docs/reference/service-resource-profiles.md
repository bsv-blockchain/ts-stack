---
id: service-resource-profiles
title: 'Service Resource Profiles, Scaling, and Message Box Economics'
kind: reference
version: '1.0.0'
last_updated: '2026-08-04'
last_verified: '2026-08-04'
review_cadence_days: 30
status: stable
tags: [reference, infrastructure, resource-safety, scaling, message-box, brc-105]
---

# Service Resource Profiles, Scaling, and Message Box Economics

The official TS Stack service images reject remotely controlled work before it
can grow without a configured bound. The default `standard` profile targets a
pod with at least 1 GiB of memory. Operators can tune every cardinality, body,
response, connection, concurrency, retained-state, and maintenance ceiling at
runtime without rebuilding an image.

These controls reduce known OOM paths; they do not make an “OOM-proof” promise.
Database drivers, telemetry, native libraries, custom lookup services, and the
kernel still require headroom and production load testing.

## Configuration precedence and unlimited mode

Set `RESOURCE_PROFILE` globally or `<PREFIX>_RESOURCE_PROFILE` for one service.
Valid profiles are `small`, `standard`, and `high-throughput`; the prefixed
setting wins. A granular environment value wins over its profile.

Resource ceilings accept a positive safe integer. Set a ceiling to `-1` or
`unlimited` only to make an explicit operator opt-out. Omission never means
unlimited. Finite protocol timeouts and database pool sizes remain positive
integers because disabling them can strand sockets or database waiters.

The common service prefixes are `CHAINTRACKS`, `MESSAGE_BOX`, `OVERLAY`,
`UHRP`, `WAB`, and `WALLET_STORAGE`.

| Common control | Meaning |
| --- | --- |
| `<PREFIX>_MAX_BODY_BYTES` | Default materialized request body ceiling. JSON or binary routes may use a more specific prefix such as `UHRP_JSON` or `WALLET_STORAGE_BINARY`. |
| `<PREFIX>_MAX_RESPONSE_BYTES` | Materialized response ceiling; a response above it receives `413 ERR_RESPONSE_TOO_LARGE`. |
| `<PREFIX>_MAX_CONCURRENT_REQUESTS` | In-flight application requests per process; saturation receives `503 ERR_SERVER_BUSY`. |
| `<PREFIX>_MAX_CONNECTIONS` | Open TCP/WebSocket connections per process. |
| `<PREFIX>_REQUEST_TIMEOUT_MS` | Complete-request timeout. |
| `<PREFIX>_HEADERS_TIMEOUT_MS` | Header receive timeout. |
| `<PREFIX>_KEEP_ALIVE_TIMEOUT_MS` | Idle keep-alive timeout. |
| `<PREFIX>_SOCKET_TIMEOUT_MS` | Socket inactivity timeout. |
| `<PREFIX>_MAX_REQUESTS_PER_SOCKET` | Requests accepted before connection recycling. |
| `<RATE_PREFIX>_MAX` / `_WINDOW_MS` | Route-class rate limit and window. Rate maxima accept `-1`/`unlimited`; windows remain finite. |

Every API role exposes `/healthz` in addition to its existing health/readiness
contract. Two or more initial slashes are normalized for compatibility, so
`//healthz` continues to work without changing interior path semantics.

## Profile defaults

The table shows the dominant list/range maximum, response ceiling, and
per-process request concurrency. Route-specific defaults follow in the next
section.

| Service | Small | Standard | High-throughput |
| --- | --- | --- | --- |
| Chaintracks | 500 headers, 1 MiB, 32 | 1,000 headers, 4 MiB, 64 | 5,000 headers, 32 MiB, 256 |
| Message Box | 500 messages, 4 MiB, 8 | 1,000 messages, 8 MiB, 24 | 5,000 messages, 32 MiB, 96 |
| Overlay Express | 500 lookup results, 4 MiB, 8 | 1,000 results, 8 MiB, 24 | 5,000 results, 32 MiB, 96 |
| UHRP Basic / Cloud | 500 records, 1 MiB, 16 | 1,000 records, 4 MiB, 64 | 5,000 records, 16 MiB, 250 |
| WAB | single-record APIs, 1 MiB, 64 | single-record APIs, 2 MiB, 128 | single-record APIs, 8 MiB, 256 |
| Wallet Storage API | 500 RPC rows, 4 MiB, 8 | 1,000 rows, 8 MiB, 24 | 5,000 rows, 32 MiB, 96 |

Start with 512 MiB for `small`, 1 GiB for `standard`, and 8 GiB for
`high-throughput`. High-throughput is not a promise that every configured
maximum can run concurrently; measure the real record distribution and reduce
concurrency when response sizes approach their byte ceiling.

## Service-specific controls

| Service | Controls and defaults in `standard` |
| --- | --- |
| Chaintracks | `CHAINTRACKS_HEADERS_DEFAULT_LIMIT=1000`, `CHAINTRACKS_HEADERS_MAX_LIMIT=1000`; the static CDN streams files and has its own `CHAINTRACKS_CDN_*` connection policy. |
| Message Box | `MAX_MESSAGE_BODY_BYTES=1048576`, `MAX_RECIPIENTS=100`, `LIST_DEFAULT_LIMIT=1000`, `LIST_MAX_LIMIT=1000`, `LIST_MAX_OFFSET=100000`, `LIST_MAX_RESPONSE_BYTES=8388608`, inbox/sender quotas of 10,000 messages and 1 GiB, `MAX_ACKNOWLEDGMENT_IDS=1000`, device/permission page maximum 100, notification fan-out 100, and `RETENTION_DAYS=30`. `MESSAGE_LIST_BATCH_SIZE` remains a compatibility fallback. |
| Message Box maintenance/state | `AUTH_SESSION_TTL_MS=86400000`, `PAYMENT_REPLAY_TTL_DAYS=365`, `RETENTION_CLEANUP_INTERVAL_MS=900000`, `RETENTION_CLEANUP_BATCH_SIZE=1000`, `DB_POOL_MIN=0`, `DB_POOL_MAX=7`, and `DB_IDLE_TIMEOUT_MS=15000`. Auth sessions, quota locks, and payment replay records are shared in MySQL. |
| Overlay Express | `OVERLAY_MAX_LOOKUP_RESULTS=1000`, `MAX_BASM_TXIDS=1000`, `MAX_BASM_ANCHOR_RANGE=1000`, admin default/max pages 50/200, `JANITOR_BATCH_SIZE=250`, and `JANITOR_MAX_REPORT_RESULTS=1000`. Janitor scans every record through a cursor while retaining only the configured report detail. |
| UHRP Basic / Cloud | list default/max 200/1,000 and max offset 100,000; `MAX_FILE_BYTES=11000000000`, `MAX_RETENTION_MINUTES=525600`, JSON body 256 KiB, and upload body 64 MiB. Basic also bounds its MIME LRU at 10,000 entries. Downloads and uploads remain streamed. |
| WAB | 256 KiB JSON, 2 MiB response, MySQL pool min/max 2/10, and separate pre-auth, authentication, user, deletion, faucet, and share rate policies. Account-deletion state is database-backed. |
| Wallet Storage | RPC default/max rows 1,000/1,000, max request array items 1,000,000, 8 MiB RPC response, 8 MiB JSON, 8 MiB binary, and MySQL pool min/max 2/10 with configurable create/acquire/idle/reap/retry timeouts. Use `WALLET_INFRA_ROLE=api` for HTTP replicas and one `monitor` replica for background work. |

All names above are appended to the service prefix where it is omitted in the
table. For example, Message Box `MAX_RECIPIENTS` means
`MESSAGE_BOX_MAX_RECIPIENTS`.

Custom Overlay lookup services must also apply a database query limit. The
engine rejects a result formula above `OVERLAY_MAX_LOOKUP_RESULTS` before proof
hydration, but it cannot prevent custom service code from first materializing
an unsafe query internally.

## Evidence and memory interpretation

`governance/service-resource-profiles.json` is the machine-readable profile
contract. `pnpm resource-profiles:check` launches each of its 21 scenarios in a
fresh Node 24.18 process with a profile-constrained V8 heap. It constructs the
maximum representative page, retains an object graph, JSON text, and transport
bytes, and fails if that page exceeds the configured response cap or if the
three-copy concurrency model consumes more than 80% of profile memory.

The 2026-08-04 Apple arm64 run produced these `standard` results:

| Service | Representative maximum page | Measured RSS increase | Three-copy concurrency model |
| --- | ---: | ---: | ---: |
| Chaintracks | 157 KiB | 1.2 MiB | 29 MiB |
| Message Box | 2,001 KiB | 11.9 MiB | 141 MiB |
| Overlay Express | 4,001 KiB | 22.3 MiB | 281 MiB |
| UHRP Basic / Cloud | 1,001 KiB | 5.7 MiB | 188 MiB |
| WAB | 2 KiB | 0.1 MiB | 0.8 MiB |
| Wallet Storage | 4,001 KiB | 21.9 MiB | 281 MiB |

The model uses fixed representative record sizes (160 B headers, 2 KiB
messages, 4 KiB overlay/wallet rows, and 1 KiB UHRP metadata). Real records,
authentication envelopes, database drivers, and telemetry differ. Before
raising a limit, replay production-shaped records under the intended cgroup
memory limit and preserve at least 20% RSS headroom.

The incident-shaped validation also covered a 1,005-message inbox and confirms
that an omitted `limit` now returns at most 1,000 messages per server response.
Pagination metadata allows the Message Box client to retain historical
fetch-all behavior. Applications that do not want aggregate growth should set
`limit`, `pageSize`, and/or `maxPages`.

Overlay Engine applies its lookup ceiling before hydration. Overlay Express
also pushes the same ceiling into its built-in SHIP and SLAP MongoDB queries,
using one overflow-probe row so a legacy `findAll` request fails clearly rather
than materializing an unbounded set or returning a silently incomplete answer.

## Horizontal scaling

Only Message Box, WAB, and Wallet Storage API have HPA examples in
`docs/examples/kubernetes/resource-profiles/`. CPU and memory targets are
starting signals, not capacity proof.

Before scaling:

- Message Box uses MySQL-backed auth sessions, payment replay protection, and
  quota locks. Keep WebSockets disabled, use sticky sessions, or add an
  operator-managed Socket.IO pub/sub adapter before serving a room from
  multiple replicas. Enforce a shared gateway rate limit because the built-in
  limiter is process-local.
- WAB account-deletion state and application state are shared in MySQL. Enforce
  authentication/SMS abuse limits at a shared gateway so replica count does not
  multiply the effective allowance.
- Run Wallet Storage HTTP pods with `WALLET_INFRA_ROLE=api`. Run exactly one
  `WALLET_INFRA_ROLE=monitor` pod; never point an HPA at it. API sessions and
  payment replay state use MySQL, while gateway rate limiting remains a
  deployment responsibility.

For all three, set CPU and memory requests, keep database pool maximum × maximum
replicas within database capacity, use readiness probes, and scale on request
saturation or queue/event-loop signals when the metrics platform supports
them. A memory target can add replicas for traffic growth but cannot repair a
leak; alert on monotonic per-pod RSS after traffic normalizes.

## Message Box BRC-105 monetization

Monetization is disabled by default. Set
`MESSAGE_BOX_MONETIZATION_ENABLED=true` to apply BRC-105 payment middleware on
authenticated routes. AuthFetch already implements the BRC-100 permissions and
BRC-105 exchange, so the Message Box client does not add a second cost-approval
layer.

Legacy WebSocket sends remain available when monetization is disabled. On a
monetized server they receive `ERR_PAYMENT_REQUIRES_AUTHFETCH`, which makes the
Message Box Client immediately use its existing AuthFetch HTTP fallback. Live
sends are independently bounded by
`MESSAGE_BOX_WEBSOCKET_MAX_CONCURRENT_SENDS`,
`MESSAGE_BOX_WEBSOCKET_SEND_RATE_LIMIT` (per minute, per socket), and
`MESSAGE_BOX_WEBSOCKET_MAX_RECIPIENT_CONNECTIONS`.
HTTP sends also bound push work with
`MESSAGE_BOX_NOTIFICATION_RECIPIENT_CONCURRENCY` and
`MESSAGE_BOX_FCM_SEND_CONCURRENCY`; this prevents a valid multi-recipient send
from multiplying recipient and device fan-out into an unbounded promise set.

| Variable | Default satoshis | Meaning |
| --- | ---: | --- |
| `MESSAGE_BOX_PRICE_BASE_SATOSHIS` | 50 | Fixed authenticated request component. |
| `MESSAGE_BOX_PRICE_PER_RECIPIENT_SATOSHIS` | 5 | Send fan-out component per recipient. |
| `MESSAGE_BOX_PRICE_PER_KIB_SATOSHIS` | 5 | UTF-8 message body component, rounded up by KiB. |
| `MESSAGE_BOX_PRICE_STORAGE_MIB_MONTH_SATOSHIS` | 1,000 | Retained payload component. |
| `MESSAGE_BOX_PRICE_LIST_PAGE_SATOSHIS` | 5 | Listing page component in addition to the base. |
| `MESSAGE_BOX_PRICE_UNLIMITED_RETENTION_MONTHS` | 12 | Up-front storage horizon when an operator explicitly configures unlimited retention. |
| `MESSAGE_BOX_ROUTE_PRICES_JSON` | `{}` | Absolute route-to-satoshi overrides; `0` makes a protected route free. |

Recipient-configured delivery fees remain separate from the operator charge.
The operator price is paid and replay-checked before message fan-out; the send
transaction still preserves recipient remittance behavior.

The defaults model a shared 1 vCPU / 2 GiB service and database allocation at
about USD 110/month, 10 million monthly protected requests, a 25% operating
reserve, equal send/list traffic, 1 KiB single-recipient sends retained for one
month, and a planning exchange rate of USD 25/BSV. That scenario recommends a
48-satoshi base; the rounded 50-satoshi default projects about USD 145/month.
It is a planning example, not a price feed or cloud quote. AWS bills Fargate by
allocated vCPU and memory and RDS by instance, storage, backup, I/O, and data
transfer; operators should replace every input with their bill and region:
[Fargate pricing](https://aws.amazon.com/fargate/pricing/),
[RDS for MySQL pricing](https://aws.amazon.com/rds/mysql/pricing/), and
[S3 pricing](https://aws.amazon.com/s3/pricing/).

Run `node scripts/message-box-economics.mjs` and override its `MB_ECON_*`
variables to model traffic, margin, fixed costs, and a planning BSV/USD value.
The deployed pricing remains satoshi-native and never depends on that exchange
rate. Fee-model terminology follows the BSV documentation’s satoshi-per-KiB
convention: [BSV fee concepts](https://hub.bsvblockchain.org/bsv-skills-center/guides/sdks/concepts/fee).

## Official-image downstream parity

The official images now accept the generic runtime settings needed to replace
custom Babbage-derived images:

| Workload | Upstream configuration now available |
| --- | --- |
| Message Box | Shared MySQL sessions/replay/quota locks, list/body/inbox/sender/retention limits, DB pool, Firebase and WebSocket controls, BRC-105 pricing, `/healthz`, and legacy `MESSAGE_LIST_BATCH_SIZE`. |
| WAB | DB pool, granular rate/resource policy, shared database deletion flow, `/healthz`, and leading-double-slash compatibility. |
| Wallet Storage | Raw or base64 JSON for `KNEX_DB_CONNECTION` and `FEE_MODEL`; raw or base64 admin keys; API/monitor role split; TAAL, WhatsOnChain, Bitails, Arcade, GorillaPool, and exchange-rate provider settings under `WALLET_STORAGE_*` with legacy aliases; logger level; DB/RPC/resource/payment controls. |

Secrets, DNS, certificates, ingress, replica counts, provider credentials, and
cluster-specific shared rate limiting remain downstream. Migration should
compare the effective configuration in staging, then pin the official image by
digest and retain the previous custom digest for rollback.

## Coordinated release order

This pull request intentionally keeps the package and official-image changes in
one review unit, but release order still matters because standalone image lock
files cannot resolve package versions that have not yet been published:

1. Merge the reviewed source revision and publish the public packages listed in
   the coordinated release notes.
2. Refresh each standalone image lock from that same revision after the new
   packages are available, and run its build, tests, resource-profile check, and
   image smoke test.
3. Tag official images only after their resolved dependency tree contains the
   coordinated package versions. Record the source commit and immutable image
   digest together.
4. Exercise the standard profile in downstream staging, then canary Message
   Box, WAB, and Wallet Storage in that order. Keep the previous image digest
   and configuration available until the rollback window closes.

Do not publish an image from this branch merely because its local standalone
tests pass: until the public packages exist, an unchanged lock can still select
the previous package implementation. Lock refresh and downstream rollout are
release/deployment steps after review, not additional functional PRs.
