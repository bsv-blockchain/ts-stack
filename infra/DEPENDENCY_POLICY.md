# Infrastructure dependency policy

The applications under `infra/` are deliberately independent npm projects.
They are not part of the root pnpm workspace, so each application owns its
`package.json` and `package-lock.json`.

## Supported runtime

- Node.js 24 LTS
- npm 11
- Linux containers built by GitHub Actions

Every application declares this contract in `engines`, and the repository CI
installs, audits, builds, lints, and tests each project on Node 24. CI also
builds every affected Docker image before a change can merge.

## Updating dependencies

Dependabot groups the root workspace, all infrastructure projects, and GitHub
Actions into one monthly maintenance pull request. Security updates remain
eligible immediately. Maintainers should update the grouped pull request
instead of opening one pull request per package.

For an individual infrastructure project:

```sh
npm install
npm audit --audit-level=high
npm run build --if-present
npm run lint --if-present
npm test --if-present
```

Commit the resulting lockfile. Do not use `--legacy-peer-deps`; the lockfile
must preserve the peer-dependency contract used by the BSV packages.

## Overrides

Overrides are a last resort for a transitive security issue that the direct
dependency graph cannot yet resolve. They must:

1. pin one reviewed, non-vulnerable version;
2. have a clean `npm audit`;
3. pass the component's build and tests; and
4. be removed as soon as the parent dependency resolves safely.

The current temporary pins are:

| Package | Version | Reason |
| --- | --- | --- |
| `brace-expansion` | `5.0.8` | Patched release for vulnerable build-tooling ranges. |
| `gaxios` | `7.3.0` | Removes the vulnerable legacy `rimraf`/`glob` chain still pinned by Google metadata packages. |
| `uuid` | `11.1.1` | Keeps Google client transitive resolution on the reviewed non-vulnerable major. |

The notifier does not contain the `brace-expansion` graph and therefore only
uses the two Google-client pins. Old blanket overrides for `tar`, `glob`,
`minimatch`, `cross-spawn`, `form-data`, `picomatch`, `undici`, and related
packages have been removed; current direct dependencies now resolve those
advisories without intervention.

## Releases

Infrastructure releases are OCI images, not npm packages. After changes merge,
tag a commit reachable from `main` with `infra/v<release-id>`. The
`infra-release.yaml` workflow compares each component's `package.json` version
with GHCR and publishes every version that is not already present.

The npm release workflow synchronizes newly published first-party `@bsv/*`
versions into the infrastructure manifests and patch-bumps affected components.
Its follow-up pull request also refreshes all infrastructure lockfiles.
