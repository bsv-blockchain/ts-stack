# Conformance Vectors

Each `.json` file in this directory (or subdirectories) is a suite of test vectors.

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
