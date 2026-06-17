# Security Policy

## Supported Versions

| Package tier | Supported |
|-------------|-----------|
| Tier 0 (SDK primitives) | Latest release |
| Tier 1 (Wallet, Overlay, Messaging, Broadcast) | Latest release |
| Tier 2 (Apps, UI) | Latest release |
| Tier 3 (Examples, helpers) | Best-effort |

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Report via GitHub Security Advisories:  
**[https://github.com/bsv-blockchain/ts-stack/security/advisories/new](https://github.com/bsv-blockchain/ts-stack/security/advisories/new)**

Or email: **security@bsvblockchain.org**

Include:
- Affected package(s) and version(s)
- Description of the vulnerability and its impact
- Steps to reproduce or proof-of-concept (can be shared privately)
- Whether you have a proposed fix

## Response SLA

| Step | Target |
|------|--------|
| Acknowledge receipt | 3 business days |
| Initial severity assessment | 5 business days |
| Patch plan communicated | 14 calendar days |
| Patch released (P0/P1) | As fast as possible, typically < 30 days |
| Public disclosure | Coordinated — 90-day default window from acknowledgement |

Security fixes bypass the standard 60-day deprecation policy and are released out of band.

## Coordinated Disclosure

We follow a 90-day coordinated disclosure window by default. If a vulnerability is being actively exploited, we reserve the right to release a patch immediately and publish the advisory simultaneously.

Reporters who follow this process responsibly will be credited in the security advisory (unless anonymity is requested).

## Scope

**In scope:**
- All packages in `packages/` (Tier 0 and Tier 1 packages are highest priority)
- Conformance runners and test infrastructure
- CI/CD workflows that handle secrets or produce signed artifacts

**High-risk paths requiring extra scrutiny (see MBGA.md §7.3):**
- Key generation, handling, and derivation
- ECDSA signing, verification, and sighash computation
- Encryption, decryption, HMAC, ECIES
- Transaction construction, BEEF parsing, BUMP/Merkle validation
- Script evaluation
- Authentication and session establishment
- Payment verification
- Any parser of untrusted network input

**Out of scope:**
- Third-party dependencies (report to the upstream maintainer)
- Issues in `Tier 3` examples that have no production impact
- Theoretical vulnerabilities with no practical exploitation path

## Security Hardening Targets

This repository follows the MBGA reliability and security programme:
- Tier 0 packages target RL5 (fuzz/property tests, threat model, signed artifacts, SBOM)
- Tier 1 packages target RL4+ with security findings tracked to closure
- Supply chain: lockfile enforced in CI, Dependabot enabled, license compliance checked

See `specs/reliability/` for per-package security status.
