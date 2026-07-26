# create-bsv-app

The unified CLI and starter catalogue for BSV applications. It replaces the deprecated `@bsv/app` package and brings its maintained example catalogue into the same tool as the generated React, Express, and full-stack starters. Convo is intentionally not included.

`create-bsv-app` can:

- generate a clean BSV-enabled application;
- copy a complete example from the shared starter catalogue;
- add BSV wallet capabilities to an existing React or Express project; and
- record the exact starter source and target layout in `bsv-scaffold.json`.

## Quick start

Create a full-stack wallet application and run both apps from the repository root:

```bash
npx create-bsv-app new my-app --starter full-stack --yes
cd my-app
npm run dev
```

Create a React-only or Express-only application:

```bash
npx create-bsv-app new my-react-app --starter react --yes
npx create-bsv-app new my-api --starter express --yes
```

Copy a complete example from the catalogue:

```bash
npx create-bsv-app new my-meter-app --starter meter --yes
cd my-meter-app
# Follow the copied starter's README for its development commands.
```

Dependencies are installed before the command finishes. Pass `--skip-install` when another tool or CI job will install them.

## Starter catalogue

The catalogue is defined once in `src/starters.ts` and drives the CLI, interactive prompts, browser UI, validation, and provenance manifest.

### Generated starters

| id           | What it creates                                                           |
| ------------ | ------------------------------------------------------------------------- |
| `custom`     | Choose React, Express, or both and select capabilities yourself.          |
| `react`      | Vite + React + TypeScript with the wallet baseline.                       |
| `express`    | Express + TypeScript with the wallet/auth server baseline.                |
| `full-stack` | Independent `client/` and `server/` packages plus one root `npm run dev`. |

### Complete example starters

| id                | Example                                 | BRC-102 project structure |
| ----------------- | --------------------------------------- | ------------------------- |
| `brc102-frontend` | Frontend project template               | Yes                       |
| `brc102-backend`  | Overlay backend project template        | Yes                       |
| `pollr`           | Blockchain polls backed by overlays     | Yes                       |
| `meter`           | Wallets, sCrypt contracts, and overlays | Yes                       |
| `metamarket`      | Marketplace for 3D objects              | Yes                       |
| `todo`            | Wallet baskets and encryption           | Yes                       |
| `marscast`        | Micropayment-monetized Mars weather     | No                        |
| `coinflip`        | Trustless peer-to-peer interactions     | Yes                       |
| `postboard`       | Public message board on an overlay      | Yes                       |
| `locksmith`       | Lock and unlock coins with a message    | Yes                       |
| `peerpay`         | Identity-backed peer-to-peer payments   | Yes                       |
| `atfinder`        | Alternative PeerPay interface           | No                        |

Complete examples are shallow-cloned from their declared branch, detached from the source repository by removing the copied `.git` directory, and recorded with repository, ref, and commit provenance. BRC-102 is useful deployment metadata, not a requirement for inclusion in the catalogue.

## Generated capabilities

Generated starters can include these composable capabilities:

| id                | What it adds                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `wallet-connect`  | Default baseline: connect a BRC-100 desktop or relay wallet, expose app-wide wallet state, and provide the shared BRC-103 proof primitive. |
| `wallet-login`    | Passwordless login using a proof bound to the server identity and `action: "login"`.                                                       |
| `signed-requests` | Per-request authentication using a proof bound to the route and request body.                                                              |

New generated projects include `wallet-connect` by default. Capability dependencies are expanded in new mode, so selecting `wallet-login` or `signed-requests` also installs the wallet baseline.

The generated development server uses a bounded, expiring, single-use nonce store for replay protection. Replace it with an atomic Redis or database implementation before running multiple server processes.

## Modes

### `new`

Creates a project in an empty directory. The target may contain only `.git` and/or `bsv-scaffold.json` when reproducing a saved configuration.

```bash
npx create-bsv-app new my-app --starter react --yes
```

The project name defaults to the target directory name. Use `--name` to override it.

### `add`

Adds selected capabilities to an existing project without running a base generator:

```bash
cd existing-react-app
npx create-bsv-app add --capabilities wallet-login --yes
```

The tool reuses `bsv-scaffold.json` when present. Otherwise it detects common existing layouts:

- a root React or Express package;
- `client/` + `server/`; or
- `frontend/` + `backend/`.

If one root package contains both React and Express, provide a config file with explicit target paths so the tool does not guess where client and server files belong.

Without an explicit mode, a valid manifest or detected project selects `add`; otherwise the tool selects `new`.

## Input methods

Every input method resolves the same `ProjectConfig` and runs the same pipeline.

### Interactive terminal

```bash
npx create-bsv-app
```

### Non-interactive flags

```bash
npx create-bsv-app new my-app \
  --starter custom \
  --frontend react \
  --backend express \
  --capabilities wallet-login,signed-requests \
  --yes
```

### Config file

```json
{
  "mode": "new",
  "name": "my-app",
  "starter": "custom",
  "stack": {
    "frontend": { "framework": "react", "variant": "react-ts" },
    "backend": { "framework": "express" }
  },
  "targets": { "client": "client", "server": "server" },
  "bsvDir": "src/bsv",
  "capabilities": ["wallet-login"],
  "glue": true,
  "install": true,
  "packageManager": "pnpm",
  "network": "test"
}
```

```bash
npx create-bsv-app --dir my-app --file config.json
```

The file is authoritative except that an explicit `--mode` flag overrides its mode.

### Local browser UI

```bash
npx create-bsv-app --ui --dir my-app
```

The UI listens only on `127.0.0.1`, shows the same registry-backed choices, and submits to the same pipeline.

## Flags

| Flag                                       | Description                                                                 |
| ------------------------------------------ | --------------------------------------------------------------------------- |
| `new` / `add`                              | Optional mode subcommand.                                                   |
| `--dir <path>`                             | Target directory; also accepted as the one positional argument.             |
| `--starter <id>`                           | Generated or complete-example starter from the unified catalogue.           |
| `--name <name>`                            | Project name; defaults to the target directory in non-interactive new mode. |
| `--frontend <react\|none>`                 | Custom generated frontend.                                                  |
| `--backend <express\|none>`                | Custom generated backend.                                                   |
| `--variant <name>`                         | Vite template variant; defaults to `react-ts`.                              |
| `--capabilities <a,b>`                     | Comma-separated generated capability ids.                                   |
| `--bsv-dir <path>`                         | Capability helper directory; defaults to `src/bsv`.                         |
| `--package-manager <npm\|pnpm\|yarn\|bun>` | Generator and install package manager.                                      |
| `--network <main\|test>`                   | Generated BSV network default.                                              |
| `--install` / `--skip-install`             | Enable or skip dependency installation; enabled by default.                 |
| `--glue` / `--no-glue`                     | Enable or skip automatic generated app wiring.                              |
| `--force`                                  | In add mode, overwrite existing capability utility files.                   |
| `--file <path>`                            | Read a complete JSON configuration.                                         |
| `--ui`                                     | Use the local browser interface.                                            |
| `--yes`                                    | Resolve from flags without prompting.                                       |

Unknown options, missing flag values, invalid enum values, conflicting modes, and extra positional arguments are rejected.

## Generated project ergonomics

Single-app generated starters run from their project root. A generated full-stack project keeps `client/` and `server/` independently installable and deployable, while its small private root package provides:

```bash
npm run dev          # run client and server together
npm run build        # build both packages
npm run install:apps # install both packages again
```

Use the selected package manager in place of `npm` when applicable.

The generated client reads `VITE_API_URL` and `VITE_BSV_NETWORK`. The generated server reads `SERVER_PRIVATE_KEY`, `PORT`, `CLIENT_ORIGIN`, and `BSV_NETWORK`. Development defaults work locally; set a stable private key and explicit production values before deployment.

## Manifest and provenance

Every run writes `bsv-scaffold.json`. Version 2 records target paths and starter provenance while remaining able to read version 1 manifests from earlier builds:

```json
{
  "version": 2,
  "name": "my-app",
  "network": "test",
  "stack": {
    "frontend": { "framework": "react", "variant": "react-ts" },
    "backend": { "framework": "express" }
  },
  "targets": { "client": "client", "server": "server" },
  "bsvDir": "src/bsv",
  "capabilities": ["wallet-connect", "wallet-login"],
  "starter": { "id": "full-stack", "kind": "generated" }
}
```

Repository starters additionally record `repository`, `ref`, and the cloned `commit`.

## For AI agents

Use `--file` for deterministic automation, or select a starter directly with flags. After generation, read `AGENTS.md` for exact capability APIs and wiring. For a copied example, read its own README and inspect `bsv-scaffold.json` for source provenance.

## Contributing

- Add or update catalogue entries only in `src/starters.ts`.
- Add generated capabilities in `src/capabilities/` and register them in `src/registry.ts`.
- Keep generated files runnable and document production boundaries in their generated `AGENTS.md` sections.
- Validate with:

```bash
pnpm --filter create-bsv-app test
pnpm --filter create-bsv-app lint:ci
pnpm --filter create-bsv-app build
```

The package is maintained in the [`bsv-blockchain/ts-stack`](https://github.com/bsv-blockchain/ts-stack) monorepo. The former `@bsv/app` package exists only as a deprecation redirect to this CLI.
