# UHRP Storage UI

Use this browser app to upload and download UHRP content. It detects a
BRC-100 wallet through the SDK and waits for authorization before closing the
connection prompt.

- **Download**. Enter a UHRP URL and select the network that hosts its advertisement.
- **Upload**. Choose a storage provider, a retention period, and a file. Approve
  the storage payment in your wallet, then copy the resulting UHRP URL.
- **Files**. Choose a provider to list your uploads, download them, or renew
  their hosting.

From the repository root, `pnpm --filter uhrp-example-ui typecheck` checks both
the browser app and the Node-side Vite configuration.
`pnpm --filter uhrp-example-ui test` builds and checks the production artifact.

## License

The license for the code in this repository is the Apache License 2.0.
