# UHRP UI

This browser application uses the BSV SDK to upload and retrieve
content-addressed files.

From the repository root, install with `pnpm install --frozen-lockfile --ignore-scripts`.
Build the frontend and its workspace dependencies with
`pnpm -r --filter 'uhrp-example-ui...' --if-present build`.
Run `pnpm --filter @bsv/uhrp-ui start` for local development.

The [UI image guide](../README.md#build-and-run-an-image) covers building,
testing and running the `uhrp-ui` image.
