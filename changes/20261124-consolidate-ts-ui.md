---
release:
  '@bsv/amountinator-react': patch
  '@bsv/brc100-ui-react-components': minor
  '@bsv/btms-permission-module-ui': patch
  '@bsv/identity-react': major
  '@bsv/uhrp-react': major
  metanet-apps: major
---

Moves the UI libraries and their packaging into TS Stack. UHRP React and the
Metanet App Catalog include the SDK 4 work from their original repositories.
Amountinator React handles signs and digit grouping in displayed amounts.

## Migration

Keep the existing npm import names, including `metanet-apps`. Consult each
library's README for its supported dependencies and browser usage.

BRC-100 React UI hosts need SDK 4.1.2 or newer within SDK 4 and wallet-toolbox
client 2.18 or newer within major 2. Identity React hosts supply SDK 4, React,
MUI and Emotion, and the package uses UHRP React 2. Amountinator React shares
React, MUI and Emotion with the host. BTMS permission prompts provide both ESM
and CommonJS entry points with matching TypeScript declarations.
