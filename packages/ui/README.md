# TypeScript UI packages

These workspaces contain the UI packages and applications formerly maintained
in [ts-ui](https://github.com/bsv-blockchain/ts-ui). The source import uses
ts-ui commit `f8327d6db6c022935d274f43d0a86877367ee1ff`. UHRP React uses the
[SDK 4 candidate](https://github.com/bsv-blockchain/uhrp-react/pull/83), and the
App Catalog uses the [SDK 4 candidate](https://github.com/bsv-blockchain/metanet-apps/pull/15).
Identity React starts from the standalone source at
`5d79f1add2d61b19fec344374d7ba0ddeb45279b`, matching its published 3.0.0
baseline.

| Project             | Distribution                      |
| ------------------- | --------------------------------- |
| Amountinator React  | `@bsv/amountinator-react`         |
| BRC-100 React UI    | `@bsv/brc100-ui-react-components` |
| BTMS permissions    | `@bsv/btms-permission-module-ui`  |
| Identity React      | `@bsv/identity-react`             |
| Metanet App Catalog | `metanet-apps`                    |
| UHRP React          | `@bsv/uhrp-react`                 |
| BTMS frontend       | Private browser application       |
| Registrant          | Private browser application       |
| UHRP UI and WUI     | CARS deployments                  |

Install from the root with the committed pnpm lockfile. For the UHRP React
example, build the library and run the Vite development server.

```sh
pnpm --filter @bsv/uhrp-react build
pnpm --filter uhrp-react-example start
```

The Registrant workspace includes the BSV-maintained frontend. Its existing
external deployment has a separate owner and release route.

## Publication handoff

The [TS Stack release workflow](../../docs/reference/release-operations.md)
selects governed npm packages, prepares their tarballs, checks their
consumers, and publishes the approved artifacts with npm OIDC. Before the
first release, verify each package's npm trusted publisher points to
`bsv-blockchain/ts-stack` and `release.yaml`. Coordinate disabling publication in
the original repositories with their maintainers before authorizing the first
TS Stack release. Keep the source repositories readable for provenance.

Use the manual [UI CARS workflow](../../.github/workflows/ui-cars-release.yml)
on `main` to stage a release for an existing CARS configuration. The staging
job builds a frontend from the workspace lockfile and retains the exact
tarball and its SHA-256. Selecting publication also requires the protected
release approval and the corresponding project-and-target CARS credential.
Use `CARS_<PROJECT>_<CONFIG_INDEX>_PRIVATE_KEY` in the protected environment,
with project names uppercase and hyphens replaced by underscores. Record
the resulting CARS deployment ID before changing the old release routes.
