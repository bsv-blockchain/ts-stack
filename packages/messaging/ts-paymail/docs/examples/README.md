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

The receive examples require Paymail sender verification, verify reference
tokens with an explicit HS512 algorithm, require each accepted transaction to
pay the locking script named by its reference, and record matching outpoints
idempotently. Keep those checks if adapting the fixture. A real service also
needs durable replay state, authenticated persistence, rate limits, and an
application-specific transaction policy; this in-memory example does not
provide those production controls.

The mock wallet treats its configured What's On Chain service as authoritative
for the example's current chain and unspent view; TLS does not turn that view
into an independently verified proof. Its bounded, redirect-free client still
requires canonical results and binds every claimed UTXO to the exact transaction
ID, output index, value, and locally derived locking script. Production wallets
should use their own reviewed chain and storage authorities rather than copying
this in-memory synchronization model.
