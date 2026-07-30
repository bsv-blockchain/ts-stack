# Contributing to ts-stack

Thank you for improving the BSV TypeScript stack. This monorepo is one
coordinated system: shared specifications, public packages, infrastructure,
documentation, conformance vectors, quality controls, and release machinery
must evolve without drifting apart.

This is the canonical contribution policy for the entire repository. Package
directories do not define separate conventions. AI agents must also read the
root [`AGENTS.md`](./AGENTS.md).

## Community and security

Follow the [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md). Report vulnerabilities
privately under [the security policy](./.github/SECURITY.md); never put secrets,
exploit details, private keys, tokens, production data, or uncoordinated
vulnerability reports in a public issue or pull request.

Use the root issue forms for reproducible defects and proposals. Discuss a
substantial new capability, new package, specification change, public API
change, or migration before implementing it. A narrowly scoped compatible fix
may proceed directly when its intent and evidence are clear.

## Repository authority

The current sources of truth are:

- `package.json`, `pnpm-workspace.yaml`, and package manifests for toolchain,
  workspace, and package metadata;
- `governance/repository-health/projects.json` for project ownership,
  profiles, criticality, runtime targets, and release routes;
- `specs/` and `conformance/` for portable protocol contracts;
- `docs/` and package READMEs for supported usage and operations;
- `governance/` for machine-enforced policy, exceptions, package release notes,
  service contracts, and artifact ownership; and
- root `.github/` for all issue, pull request, dependency, analysis, CI, and
  release automation.

Historical planning records and imported package files are evidence, not
authority, when they disagree with current code, specifications, governance,
or CI.

## Set up a safe workspace

Use a current branch from `main` and the exact toolchain declared at the root:

```sh
corepack enable
pnpm install --frozen-lockfile --ignore-scripts
pnpm rebuild esbuild
```

The install denies dependency lifecycle scripts, matching CI’s supply-chain
boundary. Rebuild only a repository-audited native tool when an applicable
workflow or package guide requires it.

Before editing:

1. inspect the working tree and preserve unrelated changes;
2. identify all affected packages, dependents, runtimes, specifications,
   generated artifacts, and deployed services;
3. read their README and relevant docs/specs;
4. inspect open issues and pull requests for overlapping work; and
5. determine the project tier and required consumer profiles from governance.

## Design and compatibility rules

The default expectation is no consumer breakage.

- Preserve public exports, declaration shapes, import conditions, supported
  runtime targets, documented inputs, defaults, errors, wire formats,
  serialization, persistence, browser/mobile behavior, and operational
  contracts.
- Prefer additive changes and deprecation over removal. A breaking change
  requires explicit maintainer approval, the appropriate SemVer release,
  before/after migration instructions, cross-package coordination, and a
  rollback or forward-fix plan.
- Treat specifications and conformance vectors as implementation-independent
  contracts. A TypeScript-only convenience must not accidentally make the
  reference behavior incompatible with another conforming implementation.
- Do not make a behavior change solely to appease an analyzer. Determine
  whether the finding is real, fix it safely, and retain a governed,
  evidence-backed exception only when compatibility or correctness genuinely
  requires it.

Tier 0 changes in `@bsv/sdk`, `@bsv/verifast`, and
`@bsv/wallet-toolbox` receive the most rigorous self-review and evidence.
Cryptography, Script/consensus behavior, transaction encodings, WASM/worker
interfaces, wallet persistence/signing, authentication, remote input, and
release controls require explicit trust-boundary and compatibility review.

Public services intentionally support deployed applications, browsers, WUI,
mobile devices, and unknown future domains. Preserve public, credential-free
wildcard CORS where it is the established default. Operators may opt into
allowlists, but CORS/CSP/origin filtering must not replace protocol
authentication, signatures, authorization, validation, rate limits, or bounds.

## Code, tests, and documentation move together

Every change should leave the repository easier to verify:

- keep TypeScript strict and lint output at zero warnings;
- use the root Oxlint and Prettier policies without package-local alternatives;
- add focused regression and negative tests for changed behavior;
- add integration, consumer, conformance, property, mutation, browser, mobile,
  or operational evidence when the boundary warrants it;
- update public JSDoc, READMEs, examples, generated documentation, support
  claims, specifications, and runbooks in the same pull request; and
- regenerate owned artifacts from their source—never edit generated bytes to
  disguise drift.

Tests must contain meaningful assertions. Do not skip, weaken, delete, rename,
or reclassify a test merely to make CI green. Manual, live, resource-intensive,
property, mutation, and conformance gaps follow the governed test-quality
registries and removal conditions.

## Local validation

Run checks locally before opening or updating a pull request whenever feasible.
Start with the invariant repository controls:

```sh
pnpm health:check
pnpm lint
pnpm format:check
pnpm typecheck
pnpm audit:security
```

Then run the checks implied by the change:

```sh
# Workspace build and deterministic tests
pnpm build
pnpm test

# Affected package examples
pnpm --filter @bsv/sdk test
pnpm --filter @bsv/sdk test:coverage
pnpm --filter @bsv/sdk pack:check

# Portable behavior and documentation
pnpm conformance
pnpm docs:facts:check
pnpm docs:examples
pnpm docs:build

# Governed high-risk boundaries
pnpm test:property
pnpm test:mutation --target <target>
```

Use the package’s declared `test:browser`, `test:mobile`, `test:consumers`, or
other profile command when applicable. Root toolchain, SDK, CI, or governance
changes may select the full workspace and mutation registry. Infrastructure or
container changes require their root CI matrix and runtime-contract evidence;
do not substitute a macOS image build for hosted Linux/amd64 validation.

Local checks are necessary evidence, not authority to bypass remote checks.
Record the exact commands and results in the pull request.

## Dependencies and automation

Dependabot identifies candidates; it does not decide that an update is safe.
For every manifest, lockfile, container base, action, or generator dependency
change, review and record:

1. upstream release notes, security relevance, and why the change is needed;
2. Node/browser/mobile/build/runtime and peer compatibility;
3. the complete transitive graph and deduplicated frozen lock;
4. high/critical audit results and CodeQL/security impact;
5. affected package, packed-consumer, conformance, and platform tests;
6. bundle-size and performance effects; and
7. affected public package versions and release notes.

First-party `@bsv/*` dependencies are synchronized through the protected
release-aware graph. Do not re-enable generic automation for unpublished
sibling versions. Major runtime, database, compiler, React Native, build, and
container migrations are coordinated programs, not routine bumps.

Do not introduce a broad override or suppression. If no compatible upstream
fix exists, register the narrowest temporary exception with an owner, evidence,
review date, objective removal condition, and tests. Rehearse removal after
relevant upstream releases.

## Versions, changelogs, and migrations

Follow [`docs/about/versioning.md`](./docs/about/versioning.md).

When a public package’s published bytes or manifest change:

1. choose the SemVer impact from the consumer-visible contract;
2. bump only affected packages and dependents whose packed contract changes;
3. update the exact entry in `governance/package-release-notes.json`;
4. regenerate the package API and migration ledger with
   `pnpm docs:packages`;
5. update the package README, API docs, and examples as needed; and
6. update a package-local `CHANGELOG.md` when that package already has one.

Every release-note entry includes a migration decision. Say explicitly that no
consumer migration is required when behavior is unchanged. An incompatible
change needs before/after examples, deployment and persistence impact,
coordination with first-party dependents and other implementations, and a
rollback or forward-fix plan.

Repository-only policy or documentation that is excluded from a package
artifact does not require a cosmetic version bump.

## Pull request lifecycle

Use the root pull request template and keep the PR draft while work or evidence
is incomplete.

Before pushing, self-review the complete diff for:

- correctness and root cause;
- security and trust-boundary impact;
- public API, wire, persistence, runtime, and cross-implementation
  compatibility;
- tests, coverage, package artifacts, bundle size, and performance;
- dependency and release implications;
- documentation, changelog, migration, and operator impact; and
- accidental generated, vendored, secret, or unrelated changes.

After every push, remain responsible for the exact head:

1. wait for all applicable GitHub checks to reach a terminal state;
2. fix every failure or unexpected skip and rerun it;
3. resolve all review conversations;
4. require zero new Sonar findings, zero unreviewed Sonar hotspots, and zero new
   CodeQL alerts; and
5. verify that the reviewed SHA is still the PR head.

SonarCloud’s aggregate “Quality Gate passed” result is not sufficient. The
repository-owned exact-head zero-finding job and complete merge gate are the
authority. Reclassifying a new issue as accepted or false-positive does not
make it mergeable.

Do not call a PR complete or hand it off with pending or failed CI. If a check
is transient, rerun and continue monitoring. If work must genuinely transfer
to another person, describe the unresolved state explicitly instead of
presenting it as finished.

One qualified maintainer approval is sufficient. Maintainers and admins may
merge after the exact head is green and review threads are resolved; an
independent last-pusher is not required.

## Releases and deployments

Source merge, package publication, image publication, and deployment are
separate states. Do not publish from a workstation or create a release tag
unless an operator explicitly requests that action. Protected root workflows
build immutable candidates, scan them, generate SBOMs, attest provenance, and
reconcile registry state.

For a release or deployed change, retain source SHA, workflow, artifact digest,
version, migration/rollback evidence, and live validation as applicable. Never
claim availability from a local build.
