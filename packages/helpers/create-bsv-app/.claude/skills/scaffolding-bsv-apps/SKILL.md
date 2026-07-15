---
name: scaffolding-bsv-apps
description: Use when creating a BSV app, choosing a maintained BSV starter, or adding wallet connection, wallet login, or signed-request capabilities with create-bsv-app.
---

# Scaffold BSV apps with create-bsv-app

`create-bsv-app` is the one supported CLI and starter catalogue. Do not use the deprecated `@bsv/app` command. Convo is not part of the catalogue.

## Prefer a named starter

For a new generated app, use one of these direct paths:

```bash
npx create-bsv-app new my-app --starter react --yes
npx create-bsv-app new my-api --starter express --yes
npx create-bsv-app new my-app --starter full-stack --yes
```

Generated full-stack projects run both packages from the root with `npm run dev`. Dependencies install by default; pass `--skip-install` only when another step will install them.

For a complete example, use the same command with one of:

`brc102-frontend`, `brc102-backend`, `pollr`, `meter`, `metamarket`, `todo`, `marscast`, `coinflip`, `postboard`, `locksmith`, `peerpay`, or `atfinder`.

Example starters are copied from their maintained repository/ref and record the exact commit in `bsv-scaffold.json`. Follow the copied README for development commands.

## Custom generated app

Use `custom` to choose the stack and capabilities explicitly:

```bash
npx create-bsv-app new my-app \
  --starter custom \
  --frontend react \
  --backend express \
  --capabilities wallet-login,signed-requests \
  --yes
```

Capabilities:

- `wallet-connect`: default BRC-100 wallet and shared BRC-103 proof baseline.
- `wallet-login`: passwordless server-verified identity proof.
- `signed-requests`: route-and-body-bound per-request authentication.

## Existing project

Run from the existing project or pass `--dir`:

```bash
npx create-bsv-app add --capabilities wallet-login --yes
```

The CLI reuses `bsv-scaffold.json` or detects root React/Express, `client` + `server`, and `frontend` + `backend` layouts. For an ambiguous custom layout, use `--file` with explicit `targets`.

## Deterministic config

For automation, write a complete config and use `--file`:

```json
{
  "mode": "new",
  "name": "my-app",
  "starter": "full-stack",
  "capabilities": ["wallet-login"],
  "install": true,
  "packageManager": "npm",
  "network": "test"
}
```

```bash
npx create-bsv-app --dir my-app --file config.json
```

After generation, read `AGENTS.md` for capability APIs and production notes. The generated nonce store is bounded and replay-safe for one process; replace it with atomic Redis/database storage before horizontal scaling.
