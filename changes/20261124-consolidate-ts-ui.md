---
release:
  '@bsv/amountinator-react': patch
  '@bsv/brc100-ui-react-components': minor
  '@bsv/btms-permission-module-ui': patch
  '@bsv/identity-react': patch
  '@bsv/uhrp-react': major
  metanet-apps: major
---

Moves the UI libraries and their packaging into TS Stack. UHRP React and the
Metanet App Catalog include the SDK 4 work from their original repositories.

## Migration

Keep the existing npm import names, including `metanet-apps`. Consult each
library's README for its supported dependencies and browser usage.
