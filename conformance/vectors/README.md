# Conformance Vectors

Each `.json` file in this directory (or subdirectories) is a suite of test vectors. `sdk/scripts/evaluation.json` includes normalized SV Node and Teranode script fixtures for cross-library parity, with original source commits and SHA-256 checksums recorded in the file metadata.

## Format

```json
[
  {
    "description": "human-readable test name",
    "input": { ... },
    "expected": { ... }
  }
]
```

Or wrapped:

```json
{
  "vectors": [ ... ]
}
```

## Suites

| Suite | Domain | BRC ref |
|-------|--------|---------|
| (TBD) | SDK | BRC-1 |
| (TBD) | Wallet | BRC-100 |
| (TBD) | Overlay | BRC-45 |
| (TBD) | Messaging | BRC-103 |
| (TBD) | Auth | BRC-31 |

Add vector files here as interface specs are formalised.
