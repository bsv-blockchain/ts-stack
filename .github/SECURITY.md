# Security Policy

## Supported versions

The latest published release of every public package is supported. Older
versions remain available but do not have a blanket backport promise. The
current source package versions and runtime profiles are generated in
[`docs/reference/stack-facts.md`](../docs/reference/stack-facts.md).

Deployable services under `infra/` are supported from reviewed `main` source
and immutable image digests produced by the infrastructure release workflow.
An unreviewed fork, locally built image, or mutable tag is outside the supported
release boundary.

## Report a vulnerability privately

**Do not open a public issue for a suspected vulnerability.**

Use a [private GitHub security advisory](https://github.com/bsv-blockchain/ts-stack/security/advisories/new)
or email **security@bsvblockchain.org**. Include:

- affected package, service, version, source SHA, or image digest;
- practical impact and deployment assumptions;
- reproduction steps or a proof of concept;
- whether exploitation is observed or believed active; and
- a proposed fix, mitigation, or disclosure constraint if known.

Do not include real private keys, production credentials, personal data, or
other unrelated secrets. Use synthetic fixtures or arrange a private handoff.

## Response targets

| Step                                  | Target                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Acknowledge receipt                   | 3 business days                                                                                  |
| Initial severity and scope assessment | 5 business days                                                                                  |
| Remediation plan or next update       | 14 calendar days                                                                                 |
| Critical/high fix                     | As fast as safely practical                                                                      |
| Disclosure                            | Coordinated with the reporter; 90 days is the default maximum, not a reason to delay a ready fix |

Active exploitation, exposed signing material, or a compromised release
boundary may require immediate mitigation and disclosure. Security fixes do not
wait for the normal dependency or feature cadence.

## Scope

In scope:

- all public packages and private package workspaces under `packages/`;
- all deployable services, images, and manifests under `infra/`;
- authentication, payment, wallet, storage, Overlay, messaging, discovery,
  relay, browser, mobile, and cross-origin behavior;
- conformance runners, generators, build/release scripts, and CI workflows;
- npm/GHCR artifacts, SBOMs, provenance, attestations, and release
  reconciliation; and
- exploitable first- or third-party dependency behavior in a supported
  ts-stack artifact.

Especially sensitive boundaries include keys and derivation, signatures and
sighash, encryption/HMAC/ECIES, transactions/BEEF/BUMP/Merkle proofs, script
evaluation, authentication sessions, payments and replay prevention, parsers
of untrusted binary/JSON/network input, URLs/paths/origins, database access,
resource bounds, and release credentials.

Purely theoretical issues without a practical path may be deprioritized, but
they may still be reported privately. Dependency vulnerabilities should also
be reported upstream; they remain in scope here when the supported stack is
exposed or needs a mitigation.

## Implemented controls

Pull requests and releases enforce, as applicable:

- frozen committed locks, denied dependency lifecycle scripts, explicit
  allowlisted rebuilds, dependency review, Socket analysis, and high/critical
  audit gates;
- warning-free lint, strict TypeScript build/typecheck, unit/integration,
  conformance, clean-consumer, browser, mobile, CLI, and WASM package checks;
- governed property tests and mutation targets for implementation trust
  boundaries, with replayable seeds and scheduled long campaigns;
- CodeQL security-extended analysis, secret scanning, OpenSSF Scorecard, and
  Sonar semantic review with an exact-head, zero-new-findings merge gate that
  cannot be bypassed by accepting or marking a new issue false-positive;
- runtime input validation, request/body/rate bounds, replay protection, and
  synchronized service edge policies;
- digest-pinned Linux/amd64 images, Trivy gates, SPDX SBOMs, SLSA provenance,
  immutable tags, keyless signatures/attestations, and verification;
- pack-once npm candidates, CycloneDX SBOMs, vulnerability/license scans,
  GitHub attestations, npm OIDC provenance, and registry digest
  reconciliation; and
- uniform Open BSV License Version 6 checks across package and image artifacts.

Coverage-guided fuzzing, remaining manual/browser/performance review, and the
final QA hardening campaign are deliberately tracked as unfinished in
[issue #324](https://github.com/bsv-blockchain/ts-stack/issues/324). They must
not be described as complete until their preserved branch is finished,
reviewed, merged, and validated.

## Security review and exceptions

Security-relevant changes require an explicit trust-boundary and deployed-impact
review, tests that fail on the old behavior when practical, required analysis,
and exact-head evidence. Maintainers may facilitate an admin merge after
required checks and review-thread resolution; a second reviewer or
last-pusher-independent approval is not an unconditional requirement.

Do not dismiss a finding or add an override merely to make CI green. A genuine
false positive or unavoidable temporary compatibility substitution must be
registered in `governance/repository-health/exceptions.json` with an owner,
rationale, evidence, review deadline, and objective removal condition. Expired
exceptions fail CI.

Public services such as Overlay, Wallet Storage, WAB, Message Box, and Wallet
Relay may need to accept clients from previously unknown domains. Their public
default and opt-in CORS/CSP/origin allowlists are deployment policy, not a
replacement for authentication, authorization, signatures, topic validation,
rate limits, or request bounds. A hosting URL or fallback origin must not
silently become an allowlist.

## Release and incident handling

Never publish from a workstation. Follow the
[npm package](../docs/reference/npm-package-supply-chain.md),
[container](../docs/reference/container-supply-chain.md), and
[release/operations](../docs/reference/release-operations.md) guides.

For a suspected release compromise:

1. stop publication and deployment promotion;
2. preserve workflow, artifact, digest, attestation, and audit evidence;
3. rotate affected credentials and isolate compromised systems;
4. inventory exact package versions and image digests;
5. deprecate and forward-fix immutable npm versions or roll deployments back to
   a previously verified image digest; and
6. coordinate advisory, consumer guidance, and post-incident control changes.
