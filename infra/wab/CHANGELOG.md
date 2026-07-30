# Changelog

All notable changes to this project will be documented in this file.

## Table of Contents

- [Unreleased](#unreleased)
- [1.1.0 - 2025-08-08](#110---2025-08-08)
- [1.0.0 - 2025](#100---2025)

## [Unreleased]

### Security

- Apply one configurable rate-limit policy to authentication, user, faucet,
  deletion, and share routes. Forwarded client addresses are accepted only
  behind an explicitly bounded trusted-proxy chain.
- Add public-by-default credential-free CORS with exact-allowlist and disabled
  modes, configurable browser response headers, bounded parsing/concurrency,
  and Node connection timeouts.
- Share one development-console OTP provider across authentication and Shamir
  share flows, and prevent that provider from being enabled or advertised
  outside development and test runtimes.
- Remove presentation keys, request payloads, OTP stores, and provider
  exception details from logs and public error responses.
- Bind every Shamir share operation to the account owned by the externally
  verified authentication method, preventing cross-account share access.
- Remove the legacy production OTP bypass and require canonical E.164 phone
  identities for Twilio verification.
- Make authentication identities non-transferable between live users while
  preserving faucet history when an identity is relinked after account
  deletion.
- Replace forgeable account-deletion keys with hashed, expiring, rate-limited,
  single-use sessions bound to the exact authentication method and user.
- Validate presentation keys, user hashes, auth method names, numeric IDs, and
  Shamir share envelopes at every public controller boundary.

### Fixed

- Give account-deletion migration indexes explicit MySQL-compatible names so a
  fresh production schema can migrate successfully.

## [1.1.0] - 2025-08-08

### Changed
- Updated mysql version to 8 and switched to mysql2 client
- Updated docker-compose.yml to use mysql 8, and added environment variables for essentials

## [1.0.0] - 2025

### Added
- Initial release of Wallet Authentication Backend
