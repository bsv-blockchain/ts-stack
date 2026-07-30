> Keep this pull request in draft until local validation is complete. After
> every push, wait for all applicable checks on the exact head to finish and
> fix every failure before requesting review or calling the work complete.

## Program and scope

- Tracker or issue:
- Program gate(s) advanced:
- Why this change is needed:
- Explicitly out of scope:
- Exact head SHA reviewed:

## Impact

- [ ] No public package source or manifest changed
- [ ] Public package source or manifest changed; affected packages are listed below
- [ ] Infrastructure source, dependency, image, or deployment configuration changed
- [ ] Public API, exports, types, runtime targets, or browser/mobile behavior changed
- [ ] Security-sensitive boundary changed
- [ ] Documentation or examples changed

Affected packages/services and intended patch versions (publication occurs only
through the release workflow after approval):

## Verification

- Local commands and results:
- Hosted CI run:
- Conformance evidence:
- Coverage delta:
- Lint/typecheck delta:
- Browser/mobile/packed-consumer evidence:
- Performance or bundle-size delta:
- [ ] I self-reviewed the complete diff for correctness, security,
      compatibility, public API, artifacts, dependencies, docs, and operations
- [ ] All applicable checks are terminal and successful on the exact head; any
      scope-based skip is expected and validated by the merge gate

## Security and dependencies

- [ ] No dependency or lockfile change
- [ ] Changelog, runtime relevance, peer compatibility, transitive graph, and
      audit results were reviewed
- [ ] CodeQL/negative tests cover any changed trust boundary
- [ ] The exact-head CodeQL analysis has no new alert
- [ ] The exact-head repository quality gate reports zero new Sonar findings
      (including accepted or false-positive issue states) and zero unreviewed hotspots;
      Sonar's aggregate `Quality Gate passed` verdict alone is not merge evidence
- [ ] No new override, advisory dismissal, quality suppression, or skipped test
- [ ] Any temporary exception is registered with owner, evidence, review date,
      and removal condition
- [ ] Workflow permissions and lifecycle-script behavior remain least privilege

## Dependency evidence

Complete every field when a dependency manifest, lockfile, container base, code
generator dependency, Dependabot configuration, or pinned workflow action
changes. Use “Not applicable — <reason>” only when the reason is concrete.

- Release notes and necessity:
- Runtime, build, and peer compatibility:
- Deduplicated lockfile:
- Audit and CodeQL:
- Package and consumer tests:
- Bundle and performance impact:
- Affected public package versions:

## Release and operations

- [ ] No npm publication was performed from a workstation or from this PR
- [ ] Required npm patch bumps are included or intentionally deferred by the
      controlling program
- [ ] Image/SBOM/provenance/deployment/rollback impact is documented
- [ ] Documentation, changelog, migration, and operational guidance are current

## Completion evidence

- [ ] The linked tracker is updated only for work fully proved by merged code,
      passing checks, resolved alerts, measurements, or an approved exception
- [ ] Review conversations are resolved
- [ ] Documentation, changelog, migration notes, release notes, and operator
      guidance are current or concretely not applicable
- [ ] No pending, failed, stale, cancelled, or unexpectedly skipped check is
      being handed to another contributor as “complete”
- [ ] One qualified maintainer approval is sufficient; no last-pusher
      restriction is assumed
