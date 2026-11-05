---
id: infra-webrtpay-relay
title: 'WebRTPay Signalling Relay'
kind: infra
version: '0.2.0'
last_updated: '2026-10-19'
last_verified: '2026-10-19'
review_cadence_days: 30
status: beta
tags: [webrtpay, webrtc, signalling, payments, relay, turn]
---

# WebRTPay Signalling Relay

> A stateless WebSocket rendezvous that lets two wallets find each other by
> identity key and exchange encrypted WebRTC signalling, so they can pay each
> other directly over a data channel.

## What it does

The relay runs `@bsv/webrtpay/server` from the published
[`@bsv/webrtpay`](../packages/messaging/webrtpay.md) package. A client opens a
WebSocket, signs the relay's challenge with its BRC-100 identity key, and may
then send signalling envelopes addressed to another identity key. The relay
forwards each envelope to every socket of the recipient, labelled with the
authenticated sender. Envelopes are end-to-end encrypted; the relay cannot read
them and never logs them.

When a TURN provider is configured, authenticated clients can ask for
short-lived TURN credentials (coturn REST, minted from a shared secret, or
Cloudflare Realtime TURN). Payments never pass through the relay: once the
peers are connected, the BEEF transaction travels over the WebRTC data channel.

The wire protocol is specified in the package's
[`docs/protocol.md`](https://github.com/bsv-blockchain/ts-stack/blob/main/packages/messaging/webrtpay/docs/protocol.md).

## When to deploy this

- You run wallets or apps that use `RelaySignaler` for low-latency remote
  payments by identity key.
- You want to issue TURN credentials to your own users from your own TURN
  budget.

Apps that signal through MessageBox (`MessageBoxSignaler`) or face to face
(code exchange) do not need a relay.

## Image

`ghcr.io/bsv-blockchain/webrtpay-relay:v<version>`, linux/amd64, built from
`infra/webrtpay-relay` by the Infra Release workflow, signed, with an SPDX SBOM
and build provenance. The image version is the component's own version
(`infra/webrtpay-relay/package.json`); the release infra-sync patch-bumps it
whenever its locked dependencies move. The bundled `@bsv/webrtpay` version is
recorded in `package-lock.json` and the image SBOM.

## Configuration (env vars)

| Variable                                              | Required                       | Default                          | Notes                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------- | ------------------------------ | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_URLS`                                         | yes, unless `HOST` is loopback | —                                | Comma-separated `wss://` urls clients dial and sign. Set it whenever a proxy fronts the relay.                                                                                                                                                                                                                  |
| `PORT`                                                | no                             | `8787`                           | WebSocket and HTTP probes share this port.                                                                                                                                                                                                                                                                      |
| `HOST`                                                | no                             | `0.0.0.0`                        | Listen address.                                                                                                                                                                                                                                                                                                 |
| `TRUSTED_IP_HEADER`                                   | no                             | —                                | Header the outermost proxy sets to the client's single address, e.g. `cf-connecting-ip`. Only when the listener is reachable solely through that proxy.                                                                                                                                                         |
| `STUN_URLS`                                           | no                             | —                                | STUN urls handed to clients.                                                                                                                                                                                                                                                                                    |
| `TURN_PROVIDER`                                       | no                             | coturn when `TURN_SECRET` is set | `coturn` or `cloudflare`.                                                                                                                                                                                                                                                                                       |
| `TURN_SECRET`, `TURN_URLS`                            | with coturn                    | —                                | `TURN_SECRET` is secret-bearing.                                                                                                                                                                                                                                                                                |
| `CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_TURN_API_TOKEN` | with cloudflare                | —                                | The API token is secret-bearing.                                                                                                                                                                                                                                                                                |
| `TURN_TTL`                                            | no                             | `600`                            | Seconds; Cloudflare caps it at 172800.                                                                                                                                                                                                                                                                          |
| Limit variables                                       | no                             | package defaults                 | `MAX_SOCKETS`, `MAX_UNAUTHENTICATED_SOCKETS`, `SOCKETS_PER_IP`, `CONNECTIONS_PER_IP_PER_MINUTE`, `SOCKETS_PER_48`, `CONNECTIONS_PER_48_PER_MINUTE`, `SIGNALS_PER_RECIPIENT_PER_MINUTE`, `SIGNALS_PER_PAIR_PER_MINUTE`, `MAX_OVER_RATE_FRAMES`, `TURN_PER_IP_PER_HOUR`, `TURN_PER_48_PER_HOUR`, `TURN_PER_HOUR`. |
| `OTEL_*`, `DEPLOY_ENV`, `LOG_LEVEL`                   | no                             | telemetry off                    | See the [service operations contract](../reference/service-operations.md).                                                                                                                                                                                                                                      |

The complete list with defaults is in
[`infra/webrtpay-relay/.env.example`](https://github.com/bsv-blockchain/ts-stack/blob/main/infra/webrtpay-relay/.env.example),
and the meaning of every limit in the
[package README](https://github.com/bsv-blockchain/ts-stack/blob/main/packages/messaging/webrtpay/README.md#relay-server).
Any invalid value, a missing `PUBLIC_URLS`, or a half-configured TURN provider
stops the container at startup with a message naming the variable.

## Run locally

```sh
docker run --rm -p 8787:8787 \
  -e PUBLIC_URLS=ws://localhost:8787 \
  ghcr.io/bsv-blockchain/webrtpay-relay:v0.2.0
curl -fsS http://localhost:8787/health
```

## Deploy to production

- Terminate TLS in front of the container and set `PUBLIC_URLS` to the
  `wss://` urls clients use.
- Behind Cloudflare (proxy or tunnel), set `TRUSTED_IP_HEADER=cf-connecting-ip`
  and keep the listener private (ClusterIP Service, firewall, or loopback) so
  clients cannot reach it directly and choose their own address.
- Keep the proxy's WebSocket idle timeout above the relay's 30 s ping interval.
- Supply `TURN_SECRET`, `CLOUDFLARE_TURN_API_TOKEN` and
  `OTEL_EXPORTER_OTLP_HEADERS` from the deployment secret manager.
- Give a coturn server its own quotas (`--total-quota`, `--max-bps`,
  `--denied-peer-ip` for private ranges): identities are free.

## State, scaling and recovery

The relay is stateless. Sockets, identities and rate-limit buckets live in
memory and are lost on restart; clients reconnect and re-authenticate. There is
nothing to back up or migrate.

Each replica is an independent rendezvous: two clients find each other only
when they are connected to the same replica. Run one replica per public url;
scale vertically (the limit variables) rather than horizontally. Per-source
limits are per replica. On Kubernetes that means `replicas: 1` with
`strategy: Recreate`: a RollingUpdate surge briefly runs two independent
rendezvous behind one url and splits clients between them.

## Health checks

- `GET /health`: liveness, `{"status":"ok"}`.
- `GET /ready`: readiness, used by the image `HEALTHCHECK`. It answers 503 as
  soon as shutdown starts.

Both are public, non-sensitive, and answer with credential-free wildcard CORS.
`SIGTERM` closes every socket and exits 0.

The relay has no CORS allowlist setting (no `WEBRTPAY_RELAY_CORS_*` variables):
its probe CORS is fixed credential-free wildcard, and the `corsPrefixes` value in
`governance/service-operations.json` is only a registry placeholder.

## Telemetry

The image preloads the standard ts-stack OpenTelemetry bootstrap
(`--import ./dist/telemetry.js`). Telemetry is off without
`OTEL_EXPORTER_OTLP_ENDPOINT`; logs are structured pino JSON with the
operations `listen`, `relay.event`, `shutdown` and `config.summary`. Relay
event messages never include signalling payloads, identity secrets or TURN
credentials.

## Source

- Image: [`infra/webrtpay-relay`](https://github.com/bsv-blockchain/ts-stack/tree/main/infra/webrtpay-relay)
- Relay: [`packages/messaging/webrtpay/server`](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/messaging/webrtpay/server)
