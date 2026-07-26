# Paymail examples

These private examples demonstrate the `@bsv/paymail` server and client flows.
They are developer fixtures, not a deployable service or published package.

From the repository root:

```sh
pnpm --filter example-paymail build
pnpm --filter example-paymail server
pnpm --filter example-paymail client
```

The commands that contact external services require operator-supplied test
configuration. Set `ARC_API_KEY`, `PAYMAIL_EXAMPLE_SATOSHI_XPRV`,
`PAYMAIL_EXAMPLE_HAL_XPRV`, and `PAYMAIL_EXAMPLE_JWT_SECRET` only in the local
process environment when running the wallet/broadcast examples. Do not commit
credentials, production keys, or live-user data. Examples must continue to
compile against the workspace package and should be converted to deterministic
automated tests wherever an external service is not fundamentally required.

The server defaults to `DOMAIN=localhost`, `PORT=3000`, and the advertised
origin `http://localhost:3000`. Set `PAYMAIL_BASE_URL` to the externally
reachable origin when a proxy, custom port, or deployed HTTPS endpoint is used.
