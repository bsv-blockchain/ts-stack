---
name: scaffolding-bsv-apps
description: Use when scaffolding a new BSV-enabled web app, or adding BSV capabilities (wallet connection, passwordless wallet login, per-request signed auth) to an existing project — i.e. anything involving the create-bsv-app CLI / `npm create bsv-app`.
---

# Scaffolding BSV apps with create-bsv-app

## Overview

`create-bsv-app` scaffolds web apps with the blockchain *invisible*: it delegates the base project to the official generators (Vite for React, a lean Express skeleton) and layers in **capabilities** — small, role-aware helper files built on the BSV abstraction libs (`@bsv/auth`, `@bsv/sdk`, `@bsv/wallet-relay`) — plus a generated `AGENTS.md` documenting each.

**One flow:** every input *door* produces a single `ProjectConfig`, which one pipeline applies. So the fastest, deterministic path (great for agents) is the `--file` door.

## When to use

- "Scaffold/create a BSV (Bitcoin SV) app", "add wallet login", "passwordless login with a wallet", "sign API requests with a wallet".
- Adding `wallet-connect` / `wallet-login` / `signed-requests` to a project.
- Not for: non-BSV scaffolding, or hand-writing `@bsv/*` integrations from scratch (this tool generates them).

## Fastest path (agents): the `--file` door

Write a `ProjectConfig` JSON and run it — no prompts, fully deterministic:

```bash
npx create-bsv-app --dir my-app --file config.json
```

```jsonc
{
  "mode": "new",                       // "new" | "add"  (see Modes)
  "name": "my-app",
  "stack": {                           // a new project needs at least one of these:
    "frontend": { "framework": "react", "variant": "react-ts" },
    "backend":  { "framework": "express" }
  },
  "bsvDir": "src/bsv",                 // where helpers are written (default)
  "capabilities": ["wallet-login"],    // see table; requires are expanded in new mode
  "glue": true,                        // auto-wire base files (new mode only)
  "packageManager": "npm",             // npm | pnpm | yarn | bun
  "network": "test"                    // test | main
}
```

Unspecified fields default (`dir`→`.`, `bsvDir`→`src/bsv`, `glue`→`false` unless omitted in schema, `packageManager`→`npm`, `network`→`test`).

## Other doors

- **Flags + `--yes`** (non-interactive without a file): `npx create-bsv-app --dir my-app --name my-app --frontend react --backend express --capabilities wallet-login --yes`
- **Interactive**: `npx create-bsv-app` (schema-driven prompts).
- **`--ui`**: `npx create-bsv-app --ui` — opens a local page; **Generate** posts the draft to an ephemeral local server that runs the *same* pipeline. The browser never writes files.

## Flags

| Flag | Notes |
| --- | --- |
| `--dir <path>` | Target dir (also positional). Default `.`. |
| `--file <path>` | Read a complete `ProjectConfig` JSON; skips prompts. |
| `--yes` | Resolve from flags (+ existing manifest), no prompts. |
| `--mode <new\|add>` | Force mode. On the `--file` door this **overrides** the file's `"mode"`. |
| `--name`, `--frontend <react\|none>`, `--backend <express\|none>`, `--variant` | New-project stack. |
| `--bsv-dir <path>` | Helper dir (default `src/bsv`). |
| `--capabilities <a,b,c>` | Comma-separated capability ids. |
| `--package-manager`, `--network <main\|test>` | Defaults npm / test. |
| `--glue` / `--no-glue` | New mode: `--no-glue` skips auto-wiring base files (`AGENTS.md` then prints the snippets to paste). |
| `--ui` | Browser door. |

## Capabilities

| id | What it adds |
| --- | --- |
| `wallet-connect` | **Base** (auto-included for new projects). Connect any BRC-100 wallet (desktop or mobile/relay), app-wide React context, the `@bsv/auth` proof primitive, and a baseline `GET /api/identity` route. |
| `wallet-login` | Passwordless login: wallet signs a proof, server verifies it → trusted `identityKey`. Adds `/login` page + `/api/login`. Requires `wallet-connect`. |
| `signed-requests` | Per-call auth: sign a proof bound to `{ action, body }`, verify server-side. Adds `/signed-demo` + `/api/echo`. Requires `wallet-connect`. |

## Modes

- **new** — empty target dir; runs the base generator(s), assembles wired base files, installs capabilities, writes the manifest + `AGENTS.md`. A lone `.git` or `bsv-scaffold.json` does **not** count as non-empty.
- **add** — existing project; installs exactly the selected capabilities and updates the manifest. No base generator.
- **Inference (no `--mode`):** a `bsv-scaffold.json` in the dir → `add`; otherwise `new`.
- **add via `--file`:** put `"mode": "add"` in the JSON, *or* pass `--mode add` (overrides the file). Passing the recorded `bsv-scaffold.json` as `--file` reproduces (`new`) — which expects an effectively empty dir (see *new* above), so in an already-populated project it would hit the empty-dir check; use `--mode add` there to re-apply into it.
- **new-mode floor:** new always includes the `defaultSelected` baseline (`wallet-connect`) even if `capabilities: []`.

## How the auth actually works (so you can explain results)

Client connects a wallet → fetches the server's identity key from `GET /api/identity` (via `getServerIdentity()`, the proof `counterparty`) → signs a proof bound to `{ counterparty, action, body? }` → POSTs it. The server verifies the signature with its `serverWallet` + a single-use nonce, yielding a cryptographically trusted `identityKey`. No password, no shared secret. Sessions (JWT, etc.) are **documented, not scaffolded** — see the generated `AGENTS.md`.

## Layout & install

A frontend **and** backend → a monorepo of **independent packages**: `client/` and `server/` each have their own `package.json` / lockfile (no root workspace). Install each: `cd client && npm i`, `cd server && npm i`. In dev they're cross-origin (Vite `:5173` → Express `:3000`), so the server enables CORS and the client reads `API_BASE_URL` from `client/src/bsv/config.ts` (`VITE_API_URL`, default `http://localhost:3000`). Each `config.ts` **reads from the environment with dev fallbacks** — you don't hardcode values in it. Set client vars in `client/.env` (Vite auto-loads `VITE_`-prefixed vars); set server vars (`SERVER_PRIVATE_KEY`, `PORT`, `CLIENT_ORIGIN`, read in `server/src/bsv/config.ts`) via your runtime env / a `.env` loader. Unset server key → a random dev key (identity changes per restart).

After any run, **read the generated `AGENTS.md`** — it documents each installed capability's API and wiring.

## Adding a new capability (contributing to the tool)

A capability is one file in `src/capabilities/<id>.ts` exporting a `Capability` (see `src/types.ts`), registered in `src/registry.ts`. Full step-by-step is in the package README's **"Adding a capability"** section. Essentials: `id`/`title`/`description`, `roles` (`shared`/`client`/`server` → placement), optional `requires`, `files(ctx)` (use `bsvImport(ctx, name)` for cross-file imports so non-default `--bsv-dir` resolves), optional `baseEdits({ builder, ctx })` for new-project glue (route descriptors `{ path, component, importPath, label }`), `npmDependencies(ctx)`, `agentsSection(ctx)`. Then `npx jest && npm run lint:ci && npm run build`.

## Common mistakes

- **Forgetting a target in new mode** — a `new` config must declare a frontend or backend, else it errors.
- **Expecting the manifest to carry `mode`** — `bsv-scaffold.json` has no `mode` field; passing it to `--file` defaults to `new` (reproduce). Use `--mode add` to re-apply.
- **One `npm i` at the root of a monorepo** — there's no root workspace; install in `client/` and `server/` separately.
- **Hardcoding the server identity key** — don't; the client fetches it from `/api/identity` automatically.
