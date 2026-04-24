# CHANGELOG

All notable changes to this project will be documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Table of Contents

- [Unreleased](#unreleased)
- [1.0.1](#101---2024-08-05)
- [1.0.0](#030---2024-07-22)
- [0.3.0](#020)

## [Unreleased]

### Added
- (Include new features or significant user-visible enhancements here.)

### Changed
- (Detail modifications that are non-breaking but relevant to the end-users.)

### Deprecated
- (List features that are in the process of being phased out or replaced.)

### Removed
- (Indicate features or capabilities that were taken out of the project.)

### Fixed
- (Document bugs that were fixed since the last release.)

### Security
- (Notify of any improvements related to security vulnerabilities or potential risks.)

---

## [1.0.1] - 2024-08-05

### Fixed
- Allow 'note' parameter in paymail responses to be null as well as '' and undefined within Joi.

---

## [1.0.0] - 2024-07-22

### Added
- (Include new features or significant user-visible enhancements here.)

### Changed
- Paymail signatures in both Client and Server modules - such that it conforms to existing paymail implementations. They use BS< over the txid not just the txid itself as the msg.
ts-paymail previously used a compact signature over sha256(txid)
go-paymail implementation uses a compact signature over sha256d(Bitcoin Signed Message:\n${txid})
ts-paymail will now conform to go-paymail as this is in line with original documentation hosted by a third party at paymail's launch.
Few people enforce these signatures so no one has noticed until now.

---

## [0.3.0] - YYYY-MM-DD

### Added
- Initial release

---

### Template for New Releases:

Replace `X.X.X` with the new version number and `YYYY-MM-DD` with the release date:

```
## [X.X.X] - YYYY-MM-DD

### Added
- 

### Changed
- 

### Deprecated
- 

### Removed
- 

### Fixed
- 

### Security
- 
```

Use this template as the starting point for each new version. Always update the "Unreleased" section with changes as they're implemented, and then move them under the new version header when that version is released.