# create-bsv-app

Scaffold BSV-enabled apps, or add BSV capabilities to an existing project — without writing key- or transaction-handling code yourself. The tool delegates base-project creation to the official generators (e.g. Vite for React, a lean Express skeleton for the server) and layers in **capabilities**: small, role-aware utility files built on the BSV abstraction libraries, plus an `AGENTS.md` contract describing how to use them.

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
| `--package-manager <npm\|pnpm\|yarn\|bun>` | new | Package manager for the base generator + workspace files (default `npm`). |
| `--network <main\|test>` | new | BSV network the capabilities target (default `test`). |
| `--glue` | both | Also emit optional "glue" files (e.g. example wiring) for the capabilities. |
| `--ui` | both | Open the HTML accordion page in a browser and scaffold on Generate (local single-use server). |

A frontend + backend together produce a **monorepo** layout (`client/` + `server/` with workspace files); a single target scaffolds at the root. Shared capability files are placed into each target that needs them.

### Capabilities

| id | Description |
| --- | --- |
| `wallet-login` | Cryptographically secure login against any BRC-100 wallet, via the BSV auth helpers. |

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
