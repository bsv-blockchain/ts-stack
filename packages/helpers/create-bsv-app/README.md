# create-bsv-app

Scaffold BSV-enabled apps, or add BSV capabilities to an existing project — without writing key- or transaction-handling code yourself. The tool delegates base-project creation to the official generators (e.g. Vite for React, a lean Express skeleton for the server) and layers in **capabilities**: small, role-aware utility files built on the BSV abstraction libraries, plus an `AGENTS.md` contract describing how to use them.

A new project runs end-to-end on `npm run dev` straight away: the base `main.tsx`/`App.tsx`/server entry are **wired automatically** so you get a working wallet flow — a desktop-wallet-first connect that, on failure, opens a modal offering *Connect with a mobile wallet* (relay QR) or *Install a desktop wallet* ([desktop.bsvb.tech](https://desktop.bsvb.tech)) — plus a routed `/login` page once you add `wallet-login`. Routing uses `react-router-dom`; the `Home` page exposes the connect button and each capability contributes its own page + route.

## One command

```bash
npx create-bsv-app
```

Every run resolves a single `ProjectConfig` and feeds it through one pipeline. There are four ways ("doors") to produce that config — they differ only in *how* the config is gathered:

1. **Interactive CLI** — `npx create-bsv-app` with no `--yes` prompts you through the schema (mode, stack, capabilities, …).
2. **Flags** — pass everything on the command line and add `--yes` to skip prompts entirely.
3. **`--file <config.json>`** — supply a complete config as JSON and skip prompts. Best for automation and AI agents.
4. **`--ui`** — `npx create-bsv-app --ui` opens a local page (sectioned accordions over the same schema). Fill it in, press **Generate**, and the project is scaffolded by the same pipeline; the page also shows the equivalent command. The server is local-only (`127.0.0.1`), single-use, and closes once the project is generated.

## Modes

The config carries a `mode`:

- **`new`** — scaffold a brand-new project. The target directory must be empty. Runs the base generator(s), then installs the selected capabilities and writes the manifest + `AGENTS.md`.
- **`add`** — add capabilities to an existing project. No base generator runs; capability files are placed and the manifest is updated.

When you don't pass `--mode`, the tool infers it: if a `bsv-scaffold.json` manifest already exists in the target directory, it defaults to `add` (re-using the existing stack); otherwise `new`.

## Flags

| Flag | Applies to | Description |
| --- | --- | --- |
| `--dir <path>` | both | Target directory (also accepted as a positional arg). Defaults to `.`. |
| `--file <path>` | both | Read a complete config from a JSON file; skips all prompts. |
| `--yes` | both | Non-interactive: resolve the config from flags (+ existing manifest) without prompting. |
| `--force` | add | Overwrite capability utility files that already exist (glue files and `AGENTS.md` are always rewritten). |
| `--mode <new\|add>` | both | Force the mode instead of inferring it. |
| `--name <string>` | new | Project name. |
| `--frontend <react\|none>` | new | Frontend framework. `react` currently scaffolds via Vite. |
| `--backend <express\|none>` | new | Backend framework. |
| `--variant <string>` | new | Frontend template variant (default `react-ts`). |
| `--bsv-dir <path>` | both | Where capability files are written (default `src/bsv`). |
| `--capabilities <a,b,c>` | both | Comma-separated capability ids to install. |
| `--package-manager <npm\|pnpm\|yarn\|bun>` | new | Package manager for the base generators (default `npm`). |
| `--network <main\|test>` | new | BSV network the capabilities target (default `test`). |
| `--glue` | both | Also emit optional "glue" files (e.g. example wiring) for the capabilities. |
| `--no-glue` | new | Skip auto-wiring the base files (`main.tsx` provider wrap, `App.tsx` routes, server routes). The context/helper/page files are still generated, and `AGENTS.md` prints the exact wiring snippets to paste yourself. |
| `--ui` | both | Open the HTML accordion page in a browser and scaffold on Generate (local single-use server). |

A frontend + backend together produce a **monorepo** layout: `client/` and `server/` are **independent packages** — each has its own `package.json`, `node_modules`, and lockfile, with no root workspace stitching them together. Install and run each app in its own directory (`cd client && npm i`, `cd server && npm i`); neither can resolve the other's dependencies, and each deploys on its own. A single target scaffolds at the root. Shared capability files are duplicated into each target that needs them.

### Capabilities

| id | Description |
| --- | --- |
| `wallet-connect` | Base (auto-selected for new projects): connect any BRC-100 wallet — desktop or mobile/relay — and use it app-wide via React context, plus the `@bsv/auth` proof primitive. In a monorepo it also mounts a `WalletRelayService` on the server (REST `/api/session` + a `/ws` upgrade) so the mobile-QR pairing path works; frontend-only projects get desktop connect only. |
| `wallet-login` | Passwordless login — a signed proof (`action: 'login'`) verified server-side. Builds on `wallet-connect`. |
| `signed-requests` | Per-call authentication — sign API requests bound to a route + body; verify with a framework-agnostic function. Builds on `wallet-connect`. |

New projects include `wallet-connect` by default (with the React contexts always generated); pass `--no-glue` to skip the automatic base-file wiring (the generated `AGENTS.md` then lists the snippets to paste). In `add` mode the base files are never touched — `AGENTS.md` always carries the manual wiring snippets.

#### Configuration & environment

Each target keeps its environment in a single `bsv/config.ts` instead of scattering `process.env` / `import.meta.env` reads (or hard-coded keys) across files:

- **`client/src/bsv/config.ts`** — `API_BASE_URL` (from `VITE_API_URL`, default `http://localhost:3000`). Every client fetch helper (`getServerIdentity`, login, signed requests) targets it. Vite loads `VITE_`-prefixed vars from `client/.env`; set `VITE_API_URL` when the client is served from a different origin than the API in production.
- **`server/src/bsv/config.ts`** — `SERVER_PRIVATE_KEY` (the verify-only `serverWallet`'s key; a random dev fallback is used if unset, so the server's identity changes per restart — set it for a stable identity), `PORT`, and `CLIENT_ORIGIN` (the browser origin allowed by CORS, default `http://localhost:5173`).

```bash
# server/.env (loaded by your process manager / node --env-file)
SERVER_PRIVATE_KEY=<your-private-key>
# client/.env (Vite) — only needed if the API isn't at http://localhost:3000
VITE_API_URL=https://api.example.com
```

Because the dev client (`:5173`) and server (`:3000`) are different origins, the server enables **CORS** for `CLIENT_ORIGIN` so the demos work on `npm run dev` with no extra setup.

#### Home demo hub

In a new glued project, the generated `Home` page shows the connect flow; once a wallet connects it lists every installed capability's demo page (e.g. *Wallet login*, *Signed request demo*), and each demo page has a “← Back to home” link.

## Examples

Scaffold a new React app with wallet login, non-interactively:

```bash
npx create-bsv-app --dir my-app --mode new --name my-app \
  --frontend react --capabilities wallet-login --yes
```

Add wallet login to the project in the current directory (mode inferred from the existing manifest):

```bash
npx create-bsv-app --capabilities wallet-login --yes
```

## Using `--file`

Write the full config as JSON and pass it with `--file`. Example — a new monorepo (React client + Express server) with wallet login:

`config.json`

```json
{
  "mode": "new",
  "name": "my-app",
  "stack": {
    "frontend": { "framework": "react", "variant": "react-ts" },
    "backend": { "framework": "express" }
  },
  "bsvDir": "src/bsv",
  "capabilities": ["wallet-login"],
  "glue": false,
  "packageManager": "pnpm",
  "network": "test"
}
```

```bash
npx create-bsv-app --dir my-app --file config.json
```

Unspecified fields fall back to defaults (`dir`→`.`, `bsvDir`→`src/bsv`, `glue`→`false`, `packageManager`→`npm`, `network`→`test`). A `new` config must declare at least a frontend or a backend.

**Mode with `--file`.** The file is the source of truth, so its `"mode"` field decides new vs. add — set `"mode": "add"` to add capabilities to an existing project via a config file. A `--mode` flag passed alongside `--file` **overrides** the file's mode (resolved through the same validation, so the new-mode baseline still applies). Handy with a saved manifest:

```bash
npx create-bsv-app --dir my-app --file bsv-scaffold.json              # reproduce: mode defaults to new
npx create-bsv-app --dir my-app --file bsv-scaffold.json --mode add   # re-apply the recorded capabilities (add)
```

(For a quick interactive add you don't need `--file` at all — just re-run `npx create-bsv-app` inside a project that already has a `bsv-scaffold.json`; see *Re-running* below.)

## Using `--ui`

```bash
npx create-bsv-app --ui --dir my-app
```

Starts a local server on `127.0.0.1`, opens your browser, and renders the config as accordions. New vs. add mode and the offered capabilities follow the target directory's existing `bsv-scaffold.json` exactly as the CLI prompt does. Press **Generate** to scaffold; the page also displays the equivalent `npx create-bsv-app …` command for scripting/reproducibility.

### Resulting manifest (`bsv-scaffold.json`)

Every run writes a `bsv-scaffold.json` to the target directory. It records what was installed so later `add` runs can re-use the stack and skip already-installed capabilities:

```json
{
  "version": 1,
  "name": "my-app",
  "network": "test",
  "stack": {
    "frontend": { "framework": "react", "variant": "react-ts" },
    "backend": { "framework": "express" }
  },
  "bsvDir": "src/bsv",
  "capabilities": ["wallet-login"]
}
```

## Re-running (add mode)

Run the tool again in a directory that already has a `bsv-scaffold.json` and it switches to `add` mode automatically: it re-uses the recorded stack, offers only capabilities you don't already have, places their files, and merges them into the manifest. Existing utility files are left untouched unless you pass `--force`.

## For AI agents

The fastest path is the `--file` door: translate the user's requirements into a `ProjectConfig` JSON (the shape shown under *Using `--file`* above) and run `npx create-bsv-app --file config.json --dir <target>`. This bypasses all interactive prompts and is fully deterministic. After scaffolding, read the generated `AGENTS.md` — it documents each installed capability's API and how to wire it into the app.

## Project structure

Everything funnels through **one flow**: a *door* produces a single `ProjectConfig`, which `applyConfig` dispatches by mode.

```
door (CLI flags · interactive · --file · --ui)
        │  produces one ProjectConfig
        ▼
applyConfig (pipeline.ts)
        ├── mode 'new' → scaffoldNewProject: base generator(s) → assemble base files → capability files → manifest → deps
        └── mode 'add' → addCapabilities:    capability files → manifest → deps
```

| Path | Responsibility |
| --- | --- |
| `src/index.ts` | Bin entry — runs `run()`, prints the result, formats errors. |
| `src/cli.ts` | `run()` + `parseArgs`: gather a `ProjectConfig` from a door, then call `applyConfig`. |
| `src/pipeline.ts` | `applyConfig` — the mode dispatch (`scaffoldNewProject` / `addCapabilities`) + `RunResult`. |
| `src/config/` | The config layer. `model.ts` (types), `schema.ts` (the **one** field schema that drives both the CLI prompt and the `--ui` page), `validate.ts` (`resolveConfig`), `draft.ts` (`seedDraft`/`resolveDraft`), `file.ts` (`--file`), `project-manifest.ts` (`bsv-scaffold.json`). |
| `src/registry.ts` | The capability list + lookup + `requires` expansion. |
| `src/capabilities/` | **One file per capability** (`wallet-connect`, `wallet-login`, `signed-requests`). This is where you add new ones. |
| `src/engine.ts` | `planPlacement` (maps each capability file's role → target dir, collects deps) + `writeFiles`. |
| `src/scaffold/` | New-project scaffolding: `new-project.ts` (orchestrator), `base-app.ts` (slot-templated `main.tsx`/`App.tsx`/`Home.tsx`/server entry + the `BaseBuilder`/`bsvImport` helpers), `vite.ts` / `express-skeleton.ts` / `base-scaffolder.ts` (base generators), `package-json.ts`, `run-command.ts`. |
| `src/agents-md.ts` | Renders the generated `AGENTS.md` (per-capability docs + wiring snippets). |
| `src/ui/` | The `--ui` door: `ui-server.ts` (ephemeral server), `ui-page.ts` (self-contained HTML), `open-browser.ts`. |
| `src/prompts.ts` | The interactive CLI prompts, driven by `config/schema.ts`. |

## Adding a capability

A capability is one file exporting a `Capability` (see the interface in `src/types.ts`). To contribute one via PR:

1. **Create `src/capabilities/<id>.ts`** exporting a `Capability`:
   - `id`, `title`, `description` — identity and the one-line picker copy.
   - `roles: ('shared' | 'client' | 'server')[]` — where its files belong. `planPlacement` maps roles to targets (in a monorepo: `shared` → both, `client` → `client/`, `server` → `server/`).
   - `requires?` — ids of capabilities that must come too (e.g. `['wallet-connect']`).
   - `defaultSelected?` — pre-selected for new projects (only `wallet-connect` sets this today).
   - `files(ctx)` — the `FileSpec[]` per role, written under `ctx.bsvDir`. Use `bsvImport(ctx, name)` (from `scaffold/base-app.js`) for any import path between generated files so non-default `--bsv-dir` still resolves.
   - `baseEdits?({ builder, ctx })` — *new-project glue only*. Contribute to the assembled base files: `builder.main.{imports,wraps}`, `builder.app.routes` (route descriptors `{ path, component, importPath, label }` — the scaffolder generates the import + `<Route>` and the Home-hub link), `builder.server.{imports,routes}`.
   - `npmDependencies(ctx)` — deps per role, merged into the right `package.json`.
   - `agentsSection(ctx)` — the `AGENTS.md` entry. Follow the existing shape: **How it works / How it's used / Future integrations**.
2. **Register it** in `src/registry.ts`.
3. **Add tests** in `src/capabilities/__tests__/<id>.test.ts` — assert `files`/`roles`/`requires`, the `baseEdits` descriptors, and key content of the generated files.
4. Run `npx jest && npm run lint:ci && npm run build`. The registry-consistency tests will check your capability conforms.

Keep capabilities focused: scaffold the BSV-specific mechanism as working code, and *document* the standard/opinionated extensions (sessions, stores, deployment) in `agentsSection` rather than scaffolding them.
