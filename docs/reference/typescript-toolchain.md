---
id: typescript-toolchain
title: 'TypeScript Compiler and Tooling Boundary'
kind: reference
version: '1.0.0'
last_updated: '2026-07-27'
last_verified: '2026-07-27'
review_cadence_days: 30
status: stable
tags: [reference, typescript, compiler, testing, toolchain]
---

# TypeScript Compiler and Tooling Boundary

The stack uses TypeScript 7.0.2 as its authoritative command-line compiler. The
repository also installs the official TypeScript 6 compatibility package for
tools that require the JavaScript compiler API.

This is a deliberate side-by-side boundary, not a peer-dependency override.
TypeScript 7.0 is a native compiler and does not expose a stable programmatic
API. The TypeScript team recommends
[this side-by-side layout](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6-0)
until the new API is available:

```json
{
  "devDependencies": {
    "@typescript/native": "npm:typescript@7.0.2",
    "typescript": "npm:@typescript/typescript6@6.0.2"
  }
}
```

The `@typescript/typescript6` package reports compiler identity 6.0.3. Its
package version is 6.0.2, which is the current compatibility release.

## Which compiler runs

| Boundary                     | Command/import                                  | Implementation                      | Purpose                                                                                                   |
| ---------------------------- | ----------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Authoritative CLI            | `tsc`                                           | TypeScript 7.0.2 native compiler    | Builds, project references, declaration emission for direct `tsc` builds, and every workspace `typecheck` |
| Compatibility CLI            | `tsc6`                                          | TypeScript 6 compatibility compiler | Diagnosis only; it is not a required CI build gate                                                        |
| JavaScript API               | `import 'typescript'` / `require('typescript')` | TypeScript 6 compatibility API      | `ts-jest`, `ts-node`, `tsdown`, and other tools that cannot consume a TypeScript 7 API                    |
| Reproducible OpenAPI codegen | isolated `tools/codegen/node` lock              | TypeScript 5.9.3                    | Locked input to `openapi-typescript`; intentionally independent from application compilation              |

Jest continues to use `ts-jest` with a peer-compatible TypeScript 6 API.
Type correctness does not depend on that transform: native TypeScript 7
typechecks the complete workspace before test fan-out. Replacing Jest's
transformer while TypeScript 7 has no API would add a second emitter and risk
changing ESM, CommonJS, JSX, decorator-metadata, mock-hoisting, source-map, and
coverage semantics without improving the authoritative compiler gate.

Packages built with `tsdown` likewise retain the compatibility API for bundled
declaration generation until the tool supports the TypeScript 7 API. Their
source still passes the separate native TypeScript 7 typecheck. Direct `tsc`
builds use TypeScript 7.

## Enforced contract

`node scripts/typescript-toolchain.mjs` scans every tracked package manifest and
requires:

- the exact native/compatibility pair in `devDependencies` for every TypeScript
  project;
- no TypeScript compiler or API package in a public runtime dependency field;
- no ungoverned TypeScript dependency or removed TypeScript 7 option;
- the independently locked TypeScript 5.9.3 codegen boundary; and
- repository-wide fan-out when the toolchain policy or checker changes.

The current governed inventory is 43 native compiler profiles plus one isolated
codegen API profile. The check runs in the repository-health job and locally
through `pnpm typescript:check` or `pnpm health:check`.

## Validation and maintenance

A compiler update is complete only after frozen installs and all existing
build, typecheck, declaration, packed-consumer, Jest/Vitest, conformance,
browser, mobile, infrastructure, CodeQL, audit, and documentation gates pass.
Do not add a peer override, invoke the compatibility `tsc6` from a build script,
or suppress a TypeScript 7 diagnostic.

Routine TypeScript 7 patch and minor updates may flow through the monthly
dependency process. Future compiler majors remain coordinated migrations.
Review the compatibility boundary at least monthly and when TypeScript 7.1 or a
later stable API becomes available. Remove `@typescript/typescript6` only after
every API consumer has a supported native replacement and the full matrix
passes without it.

This migration changes development manifests in all 30 public packages. Record
them for the final coordinated patch release, but do not publish from a
workstation.
