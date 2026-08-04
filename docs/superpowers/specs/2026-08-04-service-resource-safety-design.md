---
id: service-resource-safety-design
title: Service Resource Safety, Scaling, and Monetization — Design
kind: spec
domain: infra
version: 1.0.0
last_updated: '2026-08-04'
last_verified: '2026-08-04'
status: experimental
tags:
  - resource-safety
  - containers
  - autoscaling
  - message-box
  - payments
---

# Service Resource Safety, Scaling, and Monetization — Design

**Date:** 2026-08-04

**Status:** Implemented on the draft service-resource-hardening change set

**Scope:** The seven official TS Stack service images: Chaintracks, Message Box, Overlay, UHRP Basic, UHRP Cloud Bucket, WAB, and Wallet Infrastructure.

## Context

An input-size limit is not, by itself, an out-of-memory guarantee. A small request can select a large result, trigger expensive authenticated-response encoding, reserve durable storage, fan out to external systems, or start enough concurrent work to exhaust a process. Pagination can still be unsafe when a page is bounded by item count but not by encoded bytes.

The official images need a consistent resource-safety contract with service-specific defaults. Operators must be able to tune that contract without rebuilding an image. The same contract must cover the client side when a convenience API can aggregate multiple bounded server responses into an unbounded in-memory result.

This document records the architecture implemented by the remediation change set. Dependency-advisory work and downstream deployment are intentionally outside this change set.

## Goals

1. Make remotely initiated work, memory, and retained-state growth explicitly bounded in every official service image.
2. Provide conservative, service-specific defaults and documented environment/configuration overrides without requiring custom images.
3. Preserve existing deployments by making new controls additive, supporting established variable names, and providing explicit migration warnings before tightening behavior that callers may observe.
4. Give operators capacity-planning and horizontal-scaling guidance based on each service's actual state, leadership, CPU, memory, database, and connection behavior.
5. Expose Message Box operator monetization through the authenticated [BRC-105 HTTP service monetization flow](https://github.com/bsv-blockchain/BRCs/blob/master/payments/0105.md), using AuthFetch's existing BRC-100 permission path without a second client approval layer.
6. Make the official images capable of replacing known custom Message Box, WAB, and Wallet Storage images without embedding deployment-specific infrastructure in upstream.
7. Establish evidence strong enough to support a resource-safety claim: route inventory, constrained-heap tests, adversarial boundary tests, load/soak evidence, and release gates.

## Non-goals

- Shipping a single universal numeric limit across services with different work profiles.
- Automatically enabling horizontal scaling for a workload that still has process-local coordination or singleton responsibilities.
- Moving deployment-specific DNS, secrets, Kubernetes resources, or provider credentials into TS Stack.
- Dependency advisory, package-upgrade, or downstream rollout work.
- Changing payment protocol semantics from BRC-105 to BRC-121 or another 402 profile without an explicit compatibility decision.

## Resource-safety contract

Every remotely reachable operation and background loop must declare and enforce budgets in the following layers.

| Layer              | Required controls                                                                              | Why request-byte limits are insufficient                                       |
| ------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Transport          | Header, JSON, binary, timeout, connection, and concurrent-request limits                       | Many small requests can exhaust a process even when each body is small.        |
| Cardinality        | Maximum items, ranges, recipients, identifiers, pages, and recursive work                      | A short query can select or generate a very large result.                      |
| Response           | Encoded and authenticated response-byte ceiling, with streaming where the protocol permits     | Serialization, signing, and transport can hold multiple copies of a response.  |
| Retained state     | Per-principal item and byte quotas, retention/expiry, and reservation accounting               | An attacker can grow a victim's inbox or an operator's storage over time.      |
| Dependencies       | Database pool/queue limits, external-call concurrency, timeouts, retries, and circuit breaking | Fan-out transfers pressure to shared databases and providers.                  |
| Background work    | Batch size, concurrency, schedule, backlog ceiling, and leader ownership                       | Maintenance and synchronization can compete with request traffic.              |
| Client aggregation | Page, item, byte, host, and payment ceilings; lazy iteration for large collections             | A client can recreate an unbounded result by accumulating safe pages.          |
| Runtime            | Container memory contract, V8 heap budget, graceful rejection, and overload telemetry          | The process needs native-memory and serialization headroom beyond the JS heap. |

Limits must be checked before expensive work. Where an exact response size cannot be known before querying, the implementation must use a database byte estimate, bounded chunks, a byte-counting encoder/stream, or a lower item ceiling backed by a tested maximum record size. A post-serialization check is defense in depth, not the only guard.

### Configuration model

Each image exposes:

- a conservative service-specific default profile;
- optional named profiles such as `small`, `standard`, and `high-throughput`;
- granular environment overrides for every public limit;
- parser hard ceilings for accidental overflow, with explicit `-1`/`unlimited` operator opt-out for resource limits;
- startup validation that rejects internally inconsistent or unsafe settings;
- structured startup output containing effective non-secret limits and the selected profile;
- stable rejection codes and existing telemetry hooks for overload visibility.

Existing variables remain valid. New variables use a consistent `<SERVICE>_<RESOURCE>_<UNIT>` pattern and are normalized through a shared typed configuration package. Examples include `MAX_JSON_BODY_BYTES`, `MAX_AUTHENTICATED_RESPONSE_BYTES`, `MAX_CONCURRENT_REQUESTS`, `REQUEST_TIMEOUT_MS`, `DB_POOL_MAX`, and route-specific item/byte/work limits under the established service prefix.

Named profiles are convenience bundles, not substitutes for service-specific controls. Granular overrides win over the profile. The default profile must be safe inside the documented minimum container memory with tested headroom for native allocations, authentication, telemetry, and shutdown.

Numeric defaults are recorded in `governance/service-resource-profiles.json` and exercised by `pnpm resource-profiles:check` so documentation and the capacity model can be reviewed together.

## Service work and scaling model

| Service               | Dominant resource characteristics                                                                     | Safe horizontal-scaling boundary                                                                                                             | Required budget work                                                                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chaintracks           | Header ingestion, range reads, encoding, disk/database I/O                                            | Keep one ingest leader. Scale readers only with shared immutable/read-safe storage and explicit freshness behavior.                          | Bound ranges and encoded output; stream bulk formats; configure sync batches, retained files, pools, and reader concurrency.                                  |
| Message Box           | Authenticated encoding/signing, database rows and payload bytes, WebSockets, notification fan-out     | Scale HTTP replicas only with shared auth sessions, shared rate/payment replay state, and a WebSocket routing or pub/sub strategy.           | Bound pages by items and bytes; add inbox/sender quotas and retention; configure payload, fan-out, pools, notification concurrency, and signed-response size. |
| Overlay               | Lookup-dependent result expansion, transaction proof material, GASP/BASM synchronization, maintenance | Keep stateful background roles single-owner until leader election or role separation exists. Query APIs can scale against safe shared state. | Bound lookup/proof/range work and responses; configure enabled services, background batches/concurrency, pools, and verbose diagnostics.                      |
| UHRP Basic            | Streaming upload/download, filesystem capacity, metadata listing, MIME inspection                     | A single writer is the default. Multiple replicas require a concurrency-safe shared filesystem and shared quotas/rate state.                 | Bound list/search results, retention, account/object bytes, upload reservations, file inspection, and filesystem concurrency.                                 |
| UHRP Cloud Bucket     | Presigned object transfer, metadata/database work, cloud-provider calls                               | API replicas can scale when rate/quota/replay state is shared and the object provider supports concurrent operation.                         | Bound list/search results, retention, reservations, provider concurrency/retries, and durable account/object quotas.                                          |
| WAB                   | Small auth requests, database/session work, abuse-sensitive account state                             | Scale when rate limits, sessions, and account-state guards are shared and database capacity is measured.                                     | Configure shared rate stores, pools, request concurrency, account entity quotas, and stable readiness behavior.                                               |
| Wallet Infrastructure | Authenticated RPC, transaction/proof expansion, database work, monitor/background jobs                | Split a singleton monitor/worker role from scalable API replicas, with shared sessions, replay/rate state, and storage.                      | Validate every RPC at the transport boundary; add method-specific work/response budgets, pool controls, provider concurrency, and monitor leadership.         |

HPA examples are provided only for Message Box, WAB, and the Wallet Storage API role. CPU alone is not a sufficient scaling signal. Guidance includes memory working set, request saturation, database pool capacity, WebSocket state, and background-role ownership as applicable. Every example has a bounded replica range, stabilization policy, and stated shared-state prerequisite; deployment-owned manifests retain termination and disruption settings.

## Message Box server and client

### Server invariants

Message listing is bounded simultaneously by item count and encoded bytes. Stored message payloads have a configurable per-message ceiling, while each sender and recipient has configurable outstanding-item, outstanding-byte, and retention ceilings. Writes reserve quota atomically before committing so concurrent requests cannot oversubscribe the account.

Authenticated response middleware enforces a response budget early enough to avoid repeated full-size copies during JSON encoding and signing. The same reusable defense applies to other BRC-103 HTTP services. Database pool sizing, query timeout, notification fan-out, WebSocket connection limits, session storage, rate limiting, and payment replay storage are operator-configurable.

The standalone image exposes the shared session and abuse-control adapters already supported by the composable packages. A database-backed baseline avoids requiring a second datastore; an optional shared low-latency adapter may be provided for larger installations.

### Client invariants

The Message Box client preserves the historical fetch-all convenience API by following server pagination. Callers can set `offset`/`skip`, a total `limit`, `pageSize`, or `maxPages`; omission preserves fetch-all compatibility. Decryption, payment internalization, and host fan-out retain bounded concurrency while every server response is independently capped.

## BRC-105 monetization

The standalone Message Box image currently has the components needed for authenticated payment middleware, but operator pricing must be a supported runtime configuration rather than application code. Monetization is off by default for backward compatibility.

The implemented configuration surface supports:

- BRC-105 enablement and an AuthFetch-compatible 402 challenge;
- operator base price per protected request;
- per-recipient and per-KiB delivery components;
- optional storage/retention tiers or prepaid quota;
- route-specific free tiers and prices;
- quote lifetime, price floor/ceiling, and payment replay persistence;
- AuthFetch's existing BRC-105 payment exchange without a duplicate Message Box approval mechanism;
- separate operator pricing and recipient-configured delivery fees.

Operator request pricing and recipient delivery fees are distinct ledgers. The implementation must define one canonical calculation and presentation path so enabling BRC-105 cannot accidentally double-charge the send operation. Payments are validated before costly message fan-out and quota is reserved before payment is finalized. Failure and refund semantics must be documented for partial downstream failure.

### Economic model

The reference calculator uses operator-supplied costs and a replaceable planning exchange rate rather than a runtime price feed:

```text
monthly_required_revenue =
  fixed_compute
  + fixed_database
  + high_availability_overhead
  + observability_and_backups
  + variable_storage
  + variable_egress
  + variable_provider_calls
  + wallet_and_payment_processing
  + operating_reserve

marginal_message_cost =
  authentication_and_signing
  + database_writes_and_expected_reads
  + payload_bytes * retention_duration * replicated_storage_rate
  + expected_egress
  + notification_fanout
  + payment_internalization
  + observability

price_satoshis = ceil((allocated_cost_fiat * 100_000_000) / reference_bsv_price_fiat)
                  + margin_satoshis
```

`scripts/message-box-economics.mjs` models payload size, recipient count, retention, send/list mix, request volume, fixed cost, and operating margin. Deployed prices remain satoshi-native with no exchange-rate dependency.

## Official-image parity for downstream migration

Runtime behavior that is generally useful belongs upstream; environment-specific deployment wiring remains downstream.

| Workload       | Generic upstream capabilities needed before migration                                                                                                                                                    | Remains downstream                                                                           |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Message Box    | Shared database-backed BRC-103 sessions, configurable list/byte/retention quotas, health/readiness contract, WebSocket and notification settings, payment/replay settings, pool and concurrency controls | DNS, certificates, Kubernetes manifests, secrets, provider-specific notification credentials |
| WAB            | Shared rate/session stores, deletion/account-state protections, request correlation, stable health/readiness, database pool controls, narrowly scoped compatibility for currently released clients       | Cluster topology, disruption policy, ingress, secrets                                        |
| Wallet Storage | Shared BRC-103 sessions, monitor/API role separation, provider URL/key settings, admin identities, logging controls, health/readiness, RPC budgets, database/provider pools                              | Provider secret values, cluster workloads, monitor scheduling, DNS, certificates             |

Migration validation must compare effective configuration and behavior, not merely environment variable names. Staging should exercise the official image with production-shaped limits before a canary or production cutover. Rollback remains the previous digest and configuration until the retention window closes.

## Verification and confidence gates

A high-confidence resource-safety claim requires all of the following:

1. A machine-readable inventory of every public route, authenticated RPC method, WebSocket path, scheduled loop, and worker, with its budgets and state ownership.
2. Schema validation and boundary tests for every item/range/byte/duration/concurrency input, including direct RPC calls that bypass SDK convenience validators.
3. Constrained-heap tests that exercise maximum legal records, response encoding, authenticated signing, fan-out, and concurrent boundary traffic. Tests must assert bounded resident memory and graceful rejection above the budget.
4. Fuzz/property tests for numeric overflow, negative/NaN values, array cardinality, nested JSON, compression expansion, and retention arithmetic.
5. Load and soak tests for each documented resource profile, recording p95/p99 latency, peak RSS, heap, GC, event-loop lag, database saturation, response bytes, backlog, and rejection rate.
6. Client tests across multiple hosts proving that page accumulation, decryption, and payment processing honor aggregate budgets.
7. Deployment tests with container memory limits and a V8 heap budget that leaves measured native headroom.
8. CI checks that fail when a route or RPC is added without a resource contract, or when generated operations documentation drifts.
9. Maintainer review of the complete remediation and coordinated release notes before merge.

No service should be described as OOM-proof. The supported claim is that all known remotely controllable resource dimensions are bounded, tested under the documented envelope, observable, and rejected safely when exhausted.

## Delivery sequence

1. Land reusable response-budget/authentication defenses.
2. Add the machine-readable operation/resource schema, shared parsing, profiles, startup validation, and generated docs.
3. Harden Message Box server and client, including retained-state quotas and bounded client iteration.
4. Expose BRC-105 pricing/replay configuration and add server/client payment tests.
5. Apply route/RPC/background-work budgets to Chaintracks, Overlay, UHRP, WAB, and Wallet Infrastructure on the same coordinated branch.
6. Add role separation and shared-state adapters needed for replica safety, then publish service-specific HPA guidance and examples.
7. Produce the economics worksheet and profile benchmark reports.
8. Validate official images in downstream staging, migrate Message Box, then WAB, then Wallet Storage, and record evidence before retiring custom images.

The coordinated implementation remains one draft pull request. Image release and downstream migration remain separate, deliberate actions after review and merge.

## Resolved decisions

- Server pages default to and cap at 1,000 Message Box messages; the client preserves fetch-all pagination.
- Operators may explicitly set resource limits to `-1`/`unlimited`; omission always uses a bounded profile default.
- MySQL is the shared-state baseline. Optional stores remain injectable at package boundaries where already supported; a mandatory Redis dependency is not introduced.
- The default profile targets at least 1 GiB, with small and high-throughput profiles backed by the checked-in model.
- Message Box pricing is satoshi-native, disabled by default, and uses AuthFetch without a second approval layer.
- `/healthz` and leading-double-slash compatibility are permanent additive behavior.
- Wallet Infrastructure uses scalable `api` roles and one `monitor` role.
