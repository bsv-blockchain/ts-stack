---
id: pkg-create-bsv-app
title: 'create-bsv-app'
kind: package
domain: helpers
version: '1.3.0'
last_updated: '2026-11-02'
last_verified: '2026-11-02'
review_cadence_days: 30
npm: 'https://www.npmjs.com/package/create-bsv-app'
repo: 'https://github.com/bsv-blockchain/ts-stack/tree/main/packages/helpers/create-bsv-app'
status: stable
tags: [helpers, cli, scaffolding, starters]
---

# create-bsv-app

`create-bsv-app` is the supported CLI and starter catalogue for new BSV
applications. It generates React, Express, and full-stack projects, copies
governed complete examples, and can add wallet capabilities to an existing
project.

## Run

```bash
npx create-bsv-app new my-app --starter full-stack --yes
cd my-app
npm run dev
```

The CLI can also create `react`, `express`, or catalogue starters and supports
interactive, flag, JSON configuration, and local browser-UI inputs. Generated
projects record the resolved starter and layout in `bsv-scaffold.json`.
Interactive and browser-UI runs start new projects from React, Express, and
every capability; deselect what you do not need.

Generated projects use `@bsv/sdk` 4. The `tx-core` capability adds transaction
building blocks (`TransactionBuilder` from `@bsv/wallet-helper`, script support,
BRC-29 self-addresses and payment internalization), helpers that parse and
summarize transactions and BEEF, and a Transactions demo page. Adding a
capability to an existing project raises an outdated dependency range it needs,
leaves `devDependencies` and unrecognized ranges unchanged, and prints both.
Only the `@bsv/*` packages it pins are raised across a major version; any other
package that would need a major upgrade is left and reported for manual review.
It also adds any capability the selected one requires where the layout uses it
(for example `wallet-connect` for `tx-core` when the project has a frontend),
records it in `bsv-scaffold.json`, and says so.
Select TerraTestNet with `--network ttn` or the browser configurator; the
choice is preserved in generated configuration and `bsv-scaffold.json`.

Use `--skip-install` when CI or another tool owns dependency installation.
Review generated authentication and nonce-store configuration before
production; multi-process services need a shared atomic replay store.

The package publishes an installed `create-bsv-app` executable for Node.js 22
or newer. Package checks validate the packed CLI in a clean consumer with
lifecycle scripts disabled. See the
[package README](https://github.com/bsv-blockchain/ts-stack/tree/main/packages/helpers/create-bsv-app#readme)
for the starter catalogue, modes, flags, merge rules, and security boundaries.

## License

Open BSV License Version 6. See the
[package license](https://github.com/bsv-blockchain/ts-stack/blob/main/packages/helpers/create-bsv-app/LICENSE.txt).
