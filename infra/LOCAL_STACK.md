# Local infra stack

Runs the BSV infra components together behind a Traefik reverse proxy that routes
by hostname, so you can hit each service at `<name>.localhost` in the browser.

```sh
export OVERLAY_SERVER_PRIVATE_KEY="$(openssl rand -hex 32)"
export WALLET_SERVER_PRIVATE_KEY="$(openssl rand -hex 32)"
export MESSAGE_BOX_SERVER_PRIVATE_KEY="$(openssl rand -hex 32)"
export WAB_SERVER_PRIVATE_KEY="$(openssl rand -hex 32)"
export UHRP_SERVER_PRIVATE_KEY="$(openssl rand -hex 32)"
export OVERLAY_ADMIN_TOKEN="$(openssl rand -hex 32)"
docker compose -f infra/docker-compose.yaml up --build
```

These identities and the Overlay administrative token are deliberately
generated outside source control for each local environment. Store them in a
gitignored local environment file if they must remain stable across restarts;
never reuse production credentials.

| URL | Component |
|---|---|
| http://overlay.localhost | overlay-server |
| http://wallet.localhost | wallet-infra |
| http://messagebox.localhost | message-box-server |
| http://chaintracks.localhost | chaintracks-server |
| http://wab.localhost | wab |
| http://uhrp.localhost | uhrp-server-basic |
| http://localhost:8080/dashboard/ | Traefik dashboard |

(`uhrp-server-cloud-bucket` is intentionally excluded — it needs a real GCP bucket
+ service-account credentials and can't run locally.)

## Hostname resolution

Chromium-based browsers and Firefox resolve `*.localhost` to `127.0.0.1`
automatically. **Safari and `curl` on macOS do not** — add the hosts once:

```sh
echo "127.0.0.1 overlay.localhost wallet.localhost messagebox.localhost chaintracks.localhost wab.localhost uhrp.localhost traefik.localhost" | sudo tee -a /etc/hosts
```

Quick check without editing hosts:

```sh
curl -H 'Host: chaintracks.localhost' http://127.0.0.1/
```

## What runs

- **traefik** — fronts `:80`, routes by `Host` header using the file provider
  (`local/traefik/dynamic.yml`); dashboard on `:8080`. (File provider, not the
  docker provider: the local daemon rejects Traefik's docker API calls with a 400.)
- **mysql** (shared) — one container, four databases created on first boot
  (`appdb`, `wallet_storage`, `messagebox-backend`, `app`); host port `3307`.
- **mongo** (shared) — for overlay-server; host port `27018`.
- the six app components, built from their own directories.

## Notes / caveats

- Database passwords in the compose file are **throwaway local-dev values
  only**. Service private keys are required from the invoking environment and
  are never checked in.
- `wallet-infra` runs with `BSV_NETWORK=main` (connects to mainnet by default).
- `overlay-server`, `wab`, and `uhrp-server-basic` reach out to external BSV
  services (wallet storage, ARC) at runtime; some operations need network access
  or real backends to fully succeed. Routing + telemetry still work regardless.
- Telemetry: set `OTEL_EXPORTER_OTLP_ENDPOINT` (+ `OTEL_EXPORTER_OTLP_HEADERS`)
  in your environment before `up` to ship traces/metrics/logs to your collector;
  unset falls back to console exporters. See `infra/OBSERVABILITY.md`.
- First `up` builds six images and runs `npm ci` in each — expect a few minutes.
