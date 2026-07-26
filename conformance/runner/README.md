# BSV TypeScript conformance runner

This private workspace validates the generated cross-language conformance
vectors against the TypeScript implementations registered in `ts/registry.ts`.
It is repository tooling and is not published to npm.

From the repository root:

```sh
pnpm conformance
pnpm --filter @bsv/conformance-runner validate
```

`test` executes the required vector suite. `validate` checks vector and
implementation metadata without executing the cases. Generated vectors live
under `conformance/generated`; edit their source specifications and run the
owned generator rather than editing generated output.

See the root contribution and conformance documentation for capability,
skip-ownership, and reporting policy.
