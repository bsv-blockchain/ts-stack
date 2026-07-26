# Paymail examples

These private examples demonstrate the `@bsv/paymail` server and client flows.
They are developer fixtures, not a deployable service or published package.

From the repository root:

```sh
pnpm --filter example-paymail build
pnpm --filter example-paymail server
pnpm --filter example-paymail client
```

The commands that contact a server require an operator-supplied local test
configuration. Do not commit credentials, production keys, or live-user data.
Examples must continue to compile against the workspace package and should be
converted to deterministic automated tests wherever an external service is not
fundamentally required.
