# Conformance Vectors

Each `.json` file in this directory (or subdirectories) is a suite of test vectors. scripts/evaluation.json now includes 50+ additional vectors (IDs script-021+) from spend.valid.vectors.ts, script.valid.vectors.ts and Bitcoin Script edge cases for cross-library parity.

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
