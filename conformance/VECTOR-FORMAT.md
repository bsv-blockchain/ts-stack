# BSV Conformance Vector Format

## Purpose

The conformance corpus is a language-neutral collection of test vectors that any BSV SDK implementation — TypeScript, Go, Rust, Python, etc. — must pass to be considered conformant. Each vector file captures a single behavioural domain (e.g. key derivation, ECDSA signing, BRC-29 message encryption) and provides concrete input/output pairs derived from the TypeScript reference implementation.

Goals:
- Detect cross-language regressions before they reach production.
- Give new SDK authors a single source of truth for expected behaviour.
- Provide traceability from BRC specifications to executable test cases.

---

## File Structure

Vector files live under `conformance/vectors/` and are named after their stable ID, with dots replaced by slashes:

```
conformance/
  META.json                      # corpus-level metadata
  schema/
    vector.schema.json           # JSON Schema (2020-12) for every vector file
  vectors/
    sdk/
      keys/
        key-derivation.json      # id: sdk.keys.key-derivation
      crypto/
        ecdsa.json               # id: sdk.crypto.ecdsa
    wallet/
      brc100/
        interface.json
    ...
  runner/
    src/
      runner.js                  # reference runner (Node.js)
  reports/                       # CI output — gitignored
```

### ID naming convention

The `id` field uses a stable dot-separated namespace that mirrors the directory path:

| Segment  | Examples                      |
|----------|-------------------------------|
| domain   | `sdk`, `wallet`, `overlay`    |
| area     | `keys`, `crypto`, `brc100`    |
| feature  | `key-derivation`, `ecdsa`     |

Full example: `sdk.keys.key-derivation`

Segment rules:
- Lowercase letters and digits only (`[a-z][a-z0-9]*`).
- Hyphens are allowed within the *final* segment (e.g. `key-derivation`) but not between segments.
- Once published, IDs are **permanent**. Rename = new ID + deprecate old.

### `parity_class` values

| Value        | Meaning                                                          |
|--------------|------------------------------------------------------------------|
| `required`   | All conformant implementations MUST pass these vectors.          |
| `intended`   | Strong expectation; failure should be justified and tracked.     |
| `best-effort`| Optional; pass if the language/platform supports it.            |
| `unsupported`| Documented as out-of-scope for this domain (no vectors needed). |

### Tags

Tags are free-form strings attached to individual vectors for filtering:

| Tag example    | Conventional meaning                         |
|----------------|----------------------------------------------|
| `happy-path`   | Nominal, expected-success case               |
| `error-case`   | Input that must produce a specific error     |
| `edge-case`    | Boundary condition                           |
| `brc-42`       | Directly exercises a specific BRC            |
| `slow`         | Long-running; may be excluded from fast CI   |

---

## Vector Format

Each vector file is a JSON object that conforms to `conformance/schema/vector.schema.json`.

### Annotated example

```json
{
  "$schema": "https://bsv-blockchain.github.io/ts-stack/conformance/schema/vector.schema.json",

  // Stable ID — never changes after publication
  "id": "sdk.keys.key-derivation",

  // Human-readable title
  "name": "BRC-42 HD Key Derivation",

  // BRC specs this file exercises
  "brc": ["BRC-42"],

  // Semantic version of THIS vector file (not the SDK)
  "version": "1.0.0",

  // SDK version used to generate expected outputs
  "reference_impl": "ts-sdk@2.0.14",

  // All conformant implementations must pass these
  "parity_class": "required",

  "vectors": [
    {
      // Unique within this file; stable after publication
      "id": "derive-child-key-hardened",

      "description": "Derive hardened child at index 0x80000000 from a known root key",

      // All byte arrays encoded as lowercase hex strings
      "input": {
        "root_private_key_hex": "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
        "path": "m/0'"
      },

      "expected": {
        "child_private_key_hex": "...",
        "child_public_key_hex": "..."
      },

      "tags": ["happy-path", "brc-42"],

      // Optional: set true to skip in CI with a documented reason
      "skip": false
    }
  ]
}
```

---

## Rules

1. **Stable IDs.** The `id` at file level and each vector `id` within a file are permanent once the file is merged to `main`. Changing them is a breaking change to all downstream runners.

2. **Hex encoding.** All binary data (keys, signatures, hashes, scripts) must be encoded as lowercase hexadecimal strings. Do not use base64, base58, or any other encoding.

3. **No secrets.** Test vectors are public. Never include real private keys, mnemonics, or credentials that control funds or production systems. Use synthetically generated keys.

4. **Append-only after publication.** Existing vectors must not be modified. If an expected value changes (e.g. a bug fix in the reference implementation), deprecate the old vector (`"skip": true, "skip_reason": "superseded by v2"`) and add a new vector with a new ID.

5. **Deterministic inputs.** If a function requires randomness (e.g. ECDSA nonce), use a fixed `nonce` field in `input` and document how the runner should inject it. Never rely on PRNG state.

6. **No implementation code in this directory.** The `conformance/` tree contains only data and the reference runner. SDK-specific test harnesses live in their own packages.

---

## How to Add a New Vector

1. Open the appropriate vector file (e.g. `conformance/vectors/sdk/crypto/ecdsa.json`).
2. Append a new object to the `"vectors"` array.
3. Choose an `id` that is unique within the file and descriptive (`sign-recoverable-low-s`, not `test3`).
4. Run the reference TypeScript implementation to produce the `expected` values.
5. Validate the file: `node conformance/runner/src/runner.js --validate-only`.
6. Open a PR. CI will validate the schema and run all vectors.

---

## How to Add a New Vector File

1. Decide the stable ID (e.g. `sdk.crypto.schnorr`).
2. Create the directory path: `conformance/vectors/sdk/crypto/`.
3. Create `schnorr.json` following the annotated example above.
4. Add the new ID to `conformance/META.json` under the appropriate `brc_coverage` entry.
5. Update `stats.total_files` and `stats.last_updated` in `META.json`.
6. Validate and open a PR.

---

## Runner Contract

The reference runner lives at `conformance/runner/src/runner.js` and is invoked by CI.

### CLI flags

| Flag              | Effect                                                         |
|-------------------|----------------------------------------------------------------|
| `--validate-only` | Parse and schema-validate all vector files; do not execute.    |
| `--filter <glob>` | Run only vector files matching the glob (e.g. `sdk.keys.*`).  |
| `--report`        | Write a JSON summary to `conformance/reports/report.json`.     |
| `--verbose`       | Print per-vector pass/fail lines.                              |

### Exit codes

| Code | Meaning                                              |
|------|------------------------------------------------------|
| `0`  | All executed vectors passed (or validate-only clean). |
| `1`  | One or more vectors failed.                          |
| `2`  | Schema validation error or malformed vector file.    |

### Report format (`conformance/reports/report.json`)

```json
{
  "generated_at": "<ISO-8601>",
  "total": 42,
  "passed": 40,
  "failed": 1,
  "skipped": 1,
  "results": [
    {
      "file": "sdk/keys/key-derivation.json",
      "vector_id": "derive-child-key-hardened",
      "status": "passed"
    }
  ]
}
```

---

## Cross-Language Runner Locations

Each SDK implementation provides its own runner that reads from this shared corpus:

| Repository        | Runner path                                      | Language   |
|-------------------|--------------------------------------------------|------------|
| `ts-stack`        | `conformance/runner/src/runner.js`               | TypeScript |
| `go-sdk` (planned)| `conformance/runner/runner.go`                   | Go         |
| `rust-sdk` (planned)| `conformance/runner/src/main.rs`               | Rust       |

All runners MUST implement the same CLI contract (flags and exit codes) defined above. The CI job in each repository pins the conformance corpus via a git submodule or a direct checkout of this repository at a tagged commit.
