# AGENTS.md — `@bsv/paymail`

## Purpose

`@bsv/paymail` is the TypeScript stack's Paymail client and Express routing
library. It implements capability discovery and typed flows for profiles, PKI,
P2P transaction delivery, transaction negotiation, and simple ordinals.

## Supported surfaces

- Root: `@bsv/paymail`
- Client: `@bsv/paymail/client`
- Capabilities: `@bsv/paymail/capability`
- Server router: `@bsv/paymail/router`
- Errors: `@bsv/paymail/errors`

The root browser condition intentionally exports the client, capabilities, and
errors without importing Express or server routes. Preserve every declared
subpath and its ESM/CommonJS declaration pairing when changing the build.

## Client contract

Construct `PaymailClient` with optional `HttpClient`, `DNSResolverOptions`, and
localhost port arguments. `getCapabilities` is the public alias for
`getDomainCapabilities`; capabilities are cached per client instance.

The default HTTP transport serializes JSON requests and enforces a 30-second
timeout. Unit tests must use injected HTTP and DNS fakes. Do not add tests that
depend on public DNS, Paymail providers, ARC, or other live services.

P2P signatures use compact Base64 Bitcoin Signed Message encoding. The raw,
BEEF, and ordinal receive routes must accept the same encoding produced by
`PaymailClient.createP2PSignature`. Keep malformed length/header rejection and
transaction-ID signature checks covered. Verify the signature locally before
performing an outbound Paymail ownership lookup.

## Router contract

`domainLogicHandler` receives:

1. a route-parameter object containing `paymail` and any other path parameters;
2. the validated and unknown-field-stripped request body, when present; and
3. an optional public key for route implementations that supply one.

Use `PaymailRoute.getNameAndDomain(params)` to parse the handle. A router's
`baseUrl` is the externally reachable origin advertised by
`/.well-known/bsvalias`; `basePath` is optional.

The package deliberately does not impose CORS or CSP. These endpoints are often
public services called by applications, WUI clients, mobile devices, webviews,
and unknown future origins. Host applications and edge infrastructure must keep
credential-free public access broadly available by default where required,
while allowing explicit origin allowlists or credentialed modes as operator
configuration. Never treat CORS as authorization or combine wildcard origins
with credentials.

## Build and publication

`tsdown.config.ts` produces unbundled ESM and CommonJS files, module-specific
declarations, source maps, and a client-only browser root. Do not restore the
legacy project-reference build or publish source/test/example files.

The package is published only by the repository's coordinated release workflow.
Do not run `npm publish` or `pnpm publish` from a workstation. Preserve Open BSV
License Version 6 through the repository's license synchronization and packed
artifact controls.

## Required verification

Run from the repository root:

```sh
pnpm --filter @bsv/paymail format:check
pnpm --filter @bsv/paymail lint
pnpm --filter @bsv/paymail typecheck
pnpm --filter @bsv/paymail test:coverage
pnpm --filter @bsv/paymail pack:check
pnpm --filter @bsv/paymail test:browser
pnpm --filter example-paymail format:check
pnpm --filter example-paymail lint
pnpm --filter example-paymail test
pnpm --filter example-paymail build
```

Coverage thresholds are enforced in `jest.config.js`. `pack:check` validates
the exact dry-packed tarball in clean ESM and CommonJS consumers. `test:browser`
validates the same tarball with Vite and esbuild against
`browser-budget.json`. Coverage collection must continue to include every
production file under `src`, including modules that no test imports.

## Examples and secrets

`docs/examples` is a private compiled fixture, not a deployable or published
package. External examples accept only operator-supplied
`ARC_API_KEY`, `PAYMAIL_EXAMPLE_SATOSHI_XPRV`,
`PAYMAIL_EXAMPLE_HAL_XPRV`, and `PAYMAIL_EXAMPLE_JWT_SECRET` environment
variables. Never commit credentials, private keys, live-user data, or fallback
secret values. `DOMAIN`, `PORT`, and `PAYMAIL_BASE_URL` configure the manual
server's advertised endpoint.
