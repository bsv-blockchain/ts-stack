# TypeScript UI packages

These workspaces contain the UI packages and applications formerly maintained
in [ts-ui](https://github.com/bsv-blockchain/ts-ui). The source import uses
ts-ui commit `f8327d6db6c022935d274f43d0a86877367ee1ff`. UHRP React uses the
[SDK 4 candidate](https://github.com/bsv-blockchain/uhrp-react/pull/83), and the
App Catalog uses the [SDK 4 candidate](https://github.com/bsv-blockchain/metanet-apps/pull/15).
Identity React starts from the standalone source at
`5d79f1add2d61b19fec344374d7ba0ddeb45279b`, matching its published 3.0.0
baseline.

| Project             | Distribution                           |
| ------------------- | -------------------------------------- |
| Amountinator React  | `@bsv/amountinator-react`              |
| BRC-100 React UI    | `@bsv/brc100-ui-react-components`      |
| BTMS permissions    | `@bsv/btms-permission-module-ui`       |
| Identity React      | `@bsv/identity-react`                  |
| Metanet App Catalog | `metanet-apps`                         |
| UHRP React          | `@bsv/uhrp-react`                      |
| BTMS frontend       | `ghcr.io/bsv-blockchain/btms-frontend` |
| Registrant          | `ghcr.io/bsv-blockchain/registrant`    |
| UHRP UI             | `ghcr.io/bsv-blockchain/uhrp-ui`       |
| WUI                 | `ghcr.io/bsv-blockchain/wui`           |

Install from the root with the committed pnpm lockfile. For the UHRP React
example, build the library and run the Vite development server.

```sh
pnpm --filter @bsv/uhrp-react build
pnpm --filter uhrp-react-example start
```

## Publication handoff

The [TS Stack release workflow](../../docs/reference/release-operations.md)
selects governed npm packages, prepares their tarballs, checks their
consumers, and publishes the approved artifacts with npm OIDC. Before the
first release, verify each package's npm trusted publisher points to
`bsv-blockchain/ts-stack` and `release.yaml`. Coordinate disabling publication in
the original repositories with their maintainers before authorizing the first
TS Stack release. Keep the source repositories readable for provenance.

## Build and run an image

Use the repository root as Docker's build context. The build uses the committed
pnpm lockfile and the SDK and wallet packages from the same source revision.

```sh
docker build --platform linux/amd64 -f packages/ui/Dockerfile \
  --build-arg UI_WORKSPACE=@bsv/wui-frontend \
  --build-arg UI_PATH=packages/ui/wui/frontend -t wui:local .
node scripts/check-ui-image.mjs wui:local
docker run --rm --read-only --tmpfs /tmp -p 127.0.0.1:8080:8080 wui:local
```

For another UI, use its workspace selector and path from
[the image registry](../../governance/container-images.json).
The [Infra Release workflow](../../.github/workflows/infra-release.yaml)
publishes the four applications with immutable `rev-<source-commit>` tags.
It checks the exact image's HTTP contract, scans for vulnerabilities, and
attests the published digest. Deploy by that digest using your infrastructure
configuration. The shared server listens on port 8080 and exposes `/health`.
