# Wallet UI

WUI is a browser application for connecting to a BRC-100 wallet and exercising
wallet operations such as viewing outputs, managing certificates, and creating
transactions.

From the repository root, install with `pnpm install --frozen-lockfile --ignore-scripts`.
Build the frontend and its workspace dependencies with
`pnpm -r --filter '@bsv/wui-frontend...' --if-present build`.
Run `pnpm --filter @bsv/wui start` for local development.

The [UI image guide](../README.md#build-and-run-an-image) covers building,
testing and running the `wui` image.
