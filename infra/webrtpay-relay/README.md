# WebRTPay Signalling Relay

Container image for the [`@bsv/webrtpay`](../../packages/messaging/webrtpay/README.md)
signalling relay, published as `ghcr.io/bsv-blockchain/webrtpay-relay:v<version>`.

The relay is a stateless WebSocket rendezvous for direct wallet-to-wallet WebRTC
payments. It authenticates sockets by BRC-100 identity key, forwards encrypted
signalling envelopes between them, and can issue short-lived TURN credentials
(coturn REST or Cloudflare Realtime TURN). It stores nothing and never logs
payloads or secrets. Payments themselves travel peer to peer over the WebRTC
data channel, never through the relay.

The image runs the relay from the published package (`@bsv/webrtpay/server`)
and adds the standard ts-stack service wrapper: OpenTelemetry preloaded before
application code, structured pino logs, a non-root read-only runtime, and an
image health check. Configuration parsing, the HTTP probes, CORS and the
WebSocket protocol all belong to the package.

- Protocol: [`docs/protocol.md`](../../packages/messaging/webrtpay/docs/protocol.md)
- Relay options and limits in depth: [package README, Relay server](../../packages/messaging/webrtpay/README.md#relay-server)
- Operator guide: [`docs/infrastructure/webrtpay-relay.md`](../../docs/infrastructure/webrtpay-relay.md)

## Run

```sh
docker run --rm -p 8787:8787 \
  -e PUBLIC_URLS=wss://relay.example.com \
  ghcr.io/bsv-blockchain/webrtpay-relay:v0.2.0
```

`PUBLIC_URLS` is required: with the default `HOST=0.0.0.0` the relay refuses to
start without it, because clients would otherwise sign a url built from the
`Host` header they chose. Terminate TLS in front of the container (a load
balancer, Cloudflare tunnel or ingress) and list the `wss://` urls clients dial.

### Behind a Cloudflare tunnel

Add `-e TRUSTED_IP_HEADER=cf-connecting-ip` only when the listener cannot be
reached except through the tunnel: do not publish the port (`-p`), or bind it to
loopback or a cluster-internal Service. A client that can reach the relay
directly can send any `cf-connecting-ip` value and choose its own per-source
admission and TURN limits.

`docker run --rm ghcr.io/bsv-blockchain/webrtpay-relay:v0.2.0 node dist/index.js --help`
prints every variable with its default.

## Configuration

| Variable                                                                                                                                                                                                                                      | Required                       | Default                            | Meaning                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_URLS`                                                                                                                                                                                                                                 | yes, unless `HOST` is loopback | —                                  | Comma-separated `wss://` urls clients dial and sign.                                                                                                                 |
| `PORT`                                                                                                                                                                                                                                        | no                             | `8787`                             | Port for the WebSocket and the HTTP probes.                                                                                                                          |
| `HOST`                                                                                                                                                                                                                                        | no                             | `0.0.0.0`                          | Address to listen on.                                                                                                                                                |
| `TRUSTED_IP_HEADER`                                                                                                                                                                                                                           | no                             | —                                  | Header the outermost proxy sets to the client's single address (`cf-connecting-ip` behind Cloudflare). Set it only when every connection arrives through that proxy. |
| `STUN_URLS`                                                                                                                                                                                                                                   | no                             | —                                  | Comma-separated STUN urls handed to authenticated clients.                                                                                                           |
| `TURN_PROVIDER`                                                                                                                                                                                                                               | no                             | coturn when `TURN_SECRET` is set   | `coturn` or `cloudflare`.                                                                                                                                            |
| `TURN_SECRET`                                                                                                                                                                                                                                 | with coturn                    | —                                  | coturn `static-auth-secret` (secret); requires `TURN_URLS`.                                                                                                          |
| `TURN_URLS`                                                                                                                                                                                                                                   | with coturn                    | —                                  | Comma-separated TURN urls to issue credentials for.                                                                                                                  |
| `CLOUDFLARE_TURN_KEY_ID`                                                                                                                                                                                                                      | with cloudflare                | —                                  | Cloudflare TURN key id.                                                                                                                                              |
| `CLOUDFLARE_TURN_API_TOKEN`                                                                                                                                                                                                                   | with cloudflare                | —                                  | Cloudflare TURN key API token (secret).                                                                                                                              |
| `TURN_TTL`                                                                                                                                                                                                                                    | no                             | `600`                              | Lifetime of issued TURN credentials in seconds (Cloudflare caps it at 172800).                                                                                       |
| `MAX_SOCKETS`, `MAX_UNAUTHENTICATED_SOCKETS`, `SOCKETS_PER_IP`, `CONNECTIONS_PER_IP_PER_MINUTE`, `SOCKETS_PER_48`, `CONNECTIONS_PER_48_PER_MINUTE`, `SIGNALS_PER_RECIPIENT_PER_MINUTE`, `SIGNALS_PER_PAIR_PER_MINUTE`, `MAX_OVER_RATE_FRAMES` | no                             | see [`.env.example`](.env.example) | Admission and rate limits, whole numbers of at least 1.                                                                                                              |
| `TURN_PER_IP_PER_HOUR`, `TURN_PER_48_PER_HOUR`, `TURN_PER_HOUR`                                                                                                                                                                               | no                             | `6`, `24`, `600`                   | TURN credential budgets; require a TURN provider.                                                                                                                    |
| `OTEL_*`, `DEPLOY_ENV`, `LOG_LEVEL`                                                                                                                                                                                                           | no                             | telemetry off                      | Standard ts-stack telemetry and logging; see [`.env.example`](.env.example).                                                                                         |

A half-configured or mixed TURN provider, or any invalid value, stops the
container at startup with a message naming the variable.

## Probes

- `GET /health`: liveness, `{"status":"ok"}`.
- `GET /ready`: readiness; the image `HEALTHCHECK` uses it. It answers 503 as
  soon as shutdown starts.

Both answer with credential-free wildcard CORS. `SIGTERM` closes every socket
and exits 0.

## Development

```sh
npm ci
npm run build
npm test
HOST=127.0.0.1 npm run dev
```

## License

The Open BSV License Version 6 in [`LICENSE.txt`](LICENSE.txt) applies.
Third-party material is listed in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
